import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import { type BrowserContext, type Locator, type Page } from 'playwright'; 
import * as fs from 'fs';
import * as path from 'path';
import { type config } from './index';

chromium.use(stealth());

const SAV_LOGIN_URL = 'https://v2.sav.com/login';
const SAV_AUCTIONS_URL = 'https://v2.sav.com/domains/auctions';

// 集中管理所有的超时“魔法数字”
const TIMEOUTS = {
  EMAIL_INPUT_QUICK: 600,
  EMAIL_INPUT_LONG: 25000,
  PASSWORD_INPUT_QUICK: 800,
  PASSWORD_INPUT_MEDIUM: 3000,
  PASSWORD_INPUT_LONG: 18000,
  NETWORK_IDLE: 10000,
  CF_WAIT: 30000,
  ELEMENT_VISIBLE: 3000,
};

async function waitForCloudflare(page: Page): Promise<void> {
  const isCloudflare = await page.evaluate(() => {
    const title = document.title.toLowerCase();
    const hasCfElements = !!document.querySelector('#cf-wrapper, #challenge-running, #challenge-stage, #cf-please-wait');
    return title.includes('just a moment') || title.includes('cloudflare') || hasCfElements;
  });

  if (!isCloudflare) return;

  try {
    await page.waitForFunction(() => {
      return !document.title.toLowerCase().includes('just a moment');
    }, { timeout: TIMEOUTS.CF_WAIT }).catch(() => {});
    await page.waitForLoadState('networkidle').catch(() => {});
  } catch {}
}

function getLaunchArgs(appConfig: typeof config): string[] {
  const args = ['--disable-dev-shm-usage'];
  // 假设 index.ts 中的 Zod schema 已经添加了 SAV_NO_SANDBOX 的布尔解析
  if (appConfig.SAV_NO_SANDBOX) {
    args.push('--no-sandbox');
  }
  return args;
}

async function isSessionValid(page: Page): Promise<boolean> {
  const lowerUrl = page.url().toLowerCase();
  if (lowerUrl.endsWith('/login') || lowerUrl.includes('/users/login')) return false;

  const loginEmailInput = page.getByPlaceholder('Enter your email').first();
  try {
    await loginEmailInput.waitFor({ state: 'visible', timeout: TIMEOUTS.ELEMENT_VISIBLE });
    return false;
  } catch {
    return true;
  }
}

async function performLogin(page: Page, appConfig: typeof config): Promise<void> {
  const username = appConfig.SAV_USERNAME;
  const password = appConfig.SAV_PASSWORD;
  const globalTimeout = appConfig.SAV_EXPORT_TIMEOUT_MS;

  if (!username || !password) {
    throw new Error('缺少 SAV_USERNAME 或 SAV_PASSWORD，无法执行登录。');
  }

  const waitForEmailInput = async (timeoutMs: number): Promise<Locator | null> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const candidates = [
        page.getByPlaceholder('Enter your email').first(),
        page.getByPlaceholder(/email/i).first(),
        page.locator('input[type="email"]').first(),
      ];
      for (const candidate of candidates) {
        try {
          if ((await candidate.count()) > 0 && await candidate.isVisible({ timeout: TIMEOUTS.EMAIL_INPUT_QUICK })) {
            return candidate;
          }
        } catch {}
      }
      await page.waitForTimeout(250);
    }
    return null;
  };

  const submitEmailStep = async (): Promise<void> => {
    const signInButtons = page.getByRole('button', { name: /^sign in$/i });
    for (let i = 0; i < await signInButtons.count(); i++) {
      try {
        if (await signInButtons.nth(i).isVisible({ timeout: TIMEOUTS.PASSWORD_INPUT_QUICK })) {
          await signInButtons.nth(i).click();
          return;
        }
      } catch {}
    }
    await page.keyboard.press('Enter');
  };

  const waitForPasswordInput = async (timeoutMs: number): Promise<Locator | null> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const candidates = [
        page.locator('input[type="password"]').first(),
        page.getByPlaceholder(/password/i).first(),
      ];
      for (const candidate of candidates) {
        try {
          if ((await candidate.count()) > 0 && await candidate.isVisible({ timeout: TIMEOUTS.PASSWORD_INPUT_QUICK })) {
            return candidate;
          }
        } catch {}
      }
      await page.waitForTimeout(250);
    }
    return null;
  };

  const switchToLegacyLogin = async (reason: string): Promise<boolean> => {
    const legacyEntry = page.getByText(/legacy sign in page/i).first();
    if ((await legacyEntry.count()) > 0) {
      console.log(`[INFO] ${reason}，尝试切换到 Legacy 登录页...`);
      await legacyEntry.click();
      await page.waitForLoadState('domcontentloaded');
      return true;
    }
    return false;
  };

  console.log('[INFO] 正在填写邮箱和密码...');
  await page.goto(SAV_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: globalTimeout });

  try { await page.waitForLoadState('networkidle', { timeout: TIMEOUTS.NETWORK_IDLE }); } catch {}

  const emailInput = await waitForEmailInput(TIMEOUTS.EMAIL_INPUT_LONG);
  if (!emailInput) throw new Error(`未找到邮箱输入框，当前页面: ${page.url()}`);

  const recaptchaError = page.getByText(/invalid site key|recaptcha/i).first();
  if ((await recaptchaError.count()) > 0) {
    await switchToLegacyLogin('检测到 reCAPTCHA 异常');
  }

  const activeEmailInput = await waitForEmailInput(TIMEOUTS.NETWORK_IDLE) || emailInput;
  await activeEmailInput.fill(username);
  
  let passwordInput = await waitForPasswordInput(TIMEOUTS.PASSWORD_INPUT_MEDIUM);
  if (!passwordInput) {
    await submitEmailStep();
    passwordInput = await waitForPasswordInput(TIMEOUTS.PASSWORD_INPUT_LONG);
  }

  if (!passwordInput) {
    if (await switchToLegacyLogin('未检测到密码框')) {
      const legacyEmailInput = await waitForEmailInput(15000);
      if (legacyEmailInput) {
        await legacyEmailInput.fill(username);
        passwordInput = await waitForPasswordInput(TIMEOUTS.PASSWORD_INPUT_MEDIUM);
        if (!passwordInput) {
          await submitEmailStep();
          passwordInput = await waitForPasswordInput(TIMEOUTS.PASSWORD_INPUT_LONG);
        }
      }
    }
  }

  if (!passwordInput) throw new Error('登录流程未出现密码输入框，请检查站点登录步骤或风控。');
  await passwordInput.fill(password);
  await submitEmailStep();

  try {
    await page.waitForURL('**/domains/auctions', { timeout: globalTimeout });
  } catch {
    await page.goto(SAV_AUCTIONS_URL, { waitUntil: 'domcontentloaded', timeout: globalTimeout });
  }
}

async function saveStorageState(context: BrowserContext, storageStatePath: string): Promise<void> {
  fs.mkdirSync(path.dirname(storageStatePath), { recursive: true });
  await context.storageState({ path: storageStatePath });
}

export async function triggerExport(appConfig: typeof config): Promise<Date> {
  const { SAV_STORAGE_STATE_PATH: storageStatePath, SAV_FORCE_RELOGIN: forceRelogin, SAV_EXPORT_TIMEOUT_MS: globalTimeout } = appConfig;
  const canReuseState = !forceRelogin && fs.existsSync(storageStatePath);

  const browser = await chromium.launch({ headless: true, args: getLaunchArgs(appConfig) });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    ...(canReuseState ? { storageState: storageStatePath } : {})
  });
  context.setDefaultTimeout(globalTimeout);
  const page = await context.newPage();

  try {
    await page.goto(SAV_AUCTIONS_URL, { waitUntil: 'domcontentloaded', timeout: globalTimeout });
    await waitForCloudflare(page);

    let sessionReady = await isSessionValid(page);

    if (!sessionReady) {
      await performLogin(page, appConfig);
      await saveStorageState(context, storageStatePath);
      await page.goto(SAV_AUCTIONS_URL, { waitUntil: 'domcontentloaded', timeout: globalTimeout });
      sessionReady = await isSessionValid(page);
    }

    if (!sessionReady) throw new Error('登录状态不可用，未能进入可导出页面。');

    const exportBtn = page.locator('div[class*="export-div"]:has-text("Export")').last();
    try { await exportBtn.scrollIntoViewIfNeeded({ timeout: TIMEOUTS.NETWORK_IDLE }); } catch {}
    await exportBtn.waitFor({ state: 'visible', timeout: globalTimeout });
    await exportBtn.click();

    const successToast = page.getByText(/successfully generated and sent/i);
    await successToast.waitFor({ state: 'visible', timeout: globalTimeout });
    
    return new Date();
  } catch (error) {
    try {
      const screenshotPath = path.join(process.cwd(), 'logs', `sav_export_error_${Date.now()}.png`);
      fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
      await page.screenshot({ path: screenshotPath, fullPage: true });
    } catch {}
    throw error;
  } finally {
    await browser.close();
  }
}