import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import { type BrowserContext, type Locator, type Page } from 'playwright'; 
import * as fs from 'fs';
import * as path from 'path';
import { type config } from './index';

chromium.use(stealth());

const SAV_LOGIN_URL = 'https://v2.sav.com/login';
const SAV_AUCTIONS_URL = 'https://v2.sav.com/domains/auctions';

const TIMEOUTS = {
  NETWORK_IDLE: 10000,
  CF_WAIT: 30000,
  ELEMENT_VISIBLE: 3000,
};

// ---- Phase 3: Cloudflare detection utilities ----

async function detectCloudflare(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const title = document.title.toLowerCase();
    const hasCfElements = !!document.querySelector('#cf-wrapper, #challenge-running, #challenge-stage, #cf-please-wait');
    return title.includes('just a moment') || title.includes('cloudflare') || hasCfElements;
  });
}

async function waitForCloudflare(page: Page): Promise<void> {
  const isCloudflare = await detectCloudflare(page);
  if (!isCloudflare) return;

  try {
    await page.waitForFunction(() => {
      return !document.title.toLowerCase().includes('just a moment');
    }, { timeout: TIMEOUTS.CF_WAIT });

    console.log('[INFO] Cloudflare challenge passed');
    await page.waitForLoadState('networkidle');
  } catch (err) {
    console.warn('[WARN] Cloudflare wait state failed, proceeding anyway:', err instanceof Error ? err.message : err);
  }
}

async function navigateGuarded(page: Page, url: string, options?: Parameters<Page['goto']>[1]): Promise<void> {
  await page.goto(url, options);
  await waitForCloudflare(page);
}

// ---- Browser launch helpers ----

function getLaunchArgs(appConfig: typeof config): string[] {
  const args = ['--disable-dev-shm-usage'];
  if (appConfig.SAV_NO_SANDBOX) {
    args.push('--no-sandbox');
  }
  return args;
}

// ---- Session validation ----

async function isSessionValid(page: Page): Promise<boolean> {
  const lowerUrl = page.url().toLowerCase();
  if (lowerUrl.includes('/login')) return false;

  const signInBtn = page.getByText(/sign in/i).first();
  try {
    await signInBtn.waitFor({ state: 'visible', timeout: TIMEOUTS.ELEMENT_VISIBLE });
    return false;
  } catch {
    return true;
  }
}

// ---- Phase 2: Event-driven login flow ----

async function performLogin(page: Page, appConfig: typeof config): Promise<void> {
  const username = appConfig.SAV_USERNAME;
  const password = appConfig.SAV_PASSWORD;
  const globalTimeout = appConfig.SAV_EXPORT_TIMEOUT_MS;

  if (!username || !password) {
    throw new Error('缺少 SAV_USERNAME 或 SAV_PASSWORD，无法执行登录。');
  }

  console.log('[INFO] 等待页面完成初始渲染...');
  await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {
    console.warn('[WARN] Page load event did not fire, continuing');
  });

  console.log('[INFO] 尝试唤起登录面板...');
  const topSignInBtn = page.getByText(/sign in/i).first();
  try {
    await topSignInBtn.click({ timeout: 8000 });
    console.log('[INFO] 已点击 Sign In，等待登录弹窗出现...');
  } catch {
    console.log('[INFO] 未发现 Sign In 按钮，跳转登录页...');
    await navigateGuarded(page, SAV_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: globalTimeout });
  }

  try {
    console.log('[INFO] 等待邮箱输入框...');
    const emailInput = page.getByPlaceholder(/enter your email/i).first();

    try {
      await emailInput.waitFor({ state: 'visible', timeout: 8000 });
    } catch {
      console.log('[INFO] 弹窗疑似被页面刷新吞掉，尝试重新点击 Sign In...');
      await topSignInBtn.click();
      await emailInput.waitFor({ state: 'visible', timeout: 8000 });
    }

    await emailInput.pressSequentially(username, { delay: 50 });

    console.log('[INFO] 提交邮箱...');
    const modalSubmitBtn = page.getByRole('button', { name: /sign in|continue|next/i, exact: false }).last();
    await modalSubmitBtn.waitFor({ state: 'visible', timeout: 5000 });
    await modalSubmitBtn.click();

    console.log('[INFO] 等待密码输入框...');
    const passwordInput = page.locator('input[type="password"]').first();
    await passwordInput.waitFor({ state: 'visible', timeout: 15000 });
    await passwordInput.pressSequentially(password, { delay: 50 });

    console.log('[INFO] 提交密码...');
    await modalSubmitBtn.click();

    console.log('[INFO] 抛弃网络静默，等待弹窗消失（视觉确认）...');
    await passwordInput.waitFor({ state: 'hidden', timeout: 15000 });

    console.log('[INFO] 弹窗已消失，等待重定向或页面状态更新...');
    await Promise.race([
      page.waitForURL((url) => !url.href.includes('/login'), { timeout: 10000 }),
      page.waitForLoadState('networkidle', { timeout: 10000 }),
    ]).catch(() => {
      console.warn('[WARN] Post-login page transition timed out, proceeding');
    });

  } catch (error) {
    console.error('[ERROR] 填写账号密码时发生异常:', error);
    throw error;
  }
}

async function saveStorageState(context: BrowserContext, storageStatePath: string): Promise<void> {
  fs.mkdirSync(path.dirname(storageStatePath), { recursive: true });
  await context.storageState({ path: storageStatePath });
}

// ---- Phase 4: Robust Export button locator ----

function getExportButtonLocator(page: Page): Locator {
  return page.locator('div[class*="export-div"]:has-text("Export")').last()
    .or(page.getByRole('button', { name: /export/i }))
    .or(page.getByText(/export csv/i))
    .first();
}

// ---- Main export workflow ----

export async function triggerExport(appConfig: typeof config): Promise<Date> {
  const { SAV_STORAGE_STATE_PATH: storageStatePath, SAV_FORCE_RELOGIN: forceRelogin, SAV_EXPORT_TIMEOUT_MS: globalTimeout } = appConfig;
  const canReuseState = !forceRelogin && fs.existsSync(storageStatePath);

  // Phase 5: headless controlled by env var instead of hardcoded GITHUB_ACTIONS check
  const headless = process.env.SAV_HEADLESS !== 'false';
  const browser = await chromium.launch({
    headless,
    args: getLaunchArgs(appConfig),
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    ignoreHTTPSErrors: true,
    ...(canReuseState ? { storageState: storageStatePath } : {}),
  });

  context.setDefaultTimeout(globalTimeout);
  const page = await context.newPage();

  try {
    // Phase 3: use navigateGuarded to auto-handle CF after every navigation
    await navigateGuarded(page, SAV_AUCTIONS_URL, { waitUntil: 'domcontentloaded', timeout: globalTimeout });

    let sessionReady = await isSessionValid(page);

    if (!sessionReady) {
      await performLogin(page, appConfig);
      await saveStorageState(context, storageStatePath);
      await navigateGuarded(page, SAV_AUCTIONS_URL, { waitUntil: 'domcontentloaded', timeout: globalTimeout });
      sessionReady = await isSessionValid(page);
    }

    if (!sessionReady) throw new Error('登录状态不可用，未能进入可导出页面。');

    const loadingBanner = page.getByText(/Fetching your latest auctions/i);
    try {
      await loadingBanner.waitFor({ state: 'hidden', timeout: 45000 });
    } catch {
      console.warn('[WARN] Loading banner stuck over 45s, reloading page...');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await loadingBanner.waitFor({ state: 'hidden', timeout: globalTimeout });
    }

    const exportBtn = getExportButtonLocator(page);
    try {
      await exportBtn.scrollIntoViewIfNeeded({ timeout: globalTimeout });
    } catch (err) {
      console.warn('[WARN] scrollIntoViewIfNeeded failed:', err instanceof Error ? err.message : err);
    }
    
    // 1. 等待按钮在 DOM 中不仅可见，而且不处于 disabled 状态
    await exportBtn.waitFor({ state: 'visible', timeout: globalTimeout });
    // 如果业务上有特定的网络请求表示加载完成，可以在这里 wait 一下那个接口，或者稍微给一点 buffer 兜底 Hydration
    await page.waitForTimeout(1000); 

    const successToast = page.getByText(/successfully generated and sent/i);
    let isExportSuccessful = false;
    const maxRetries = 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`[INFO] 尝试点击 Export 按钮 (第 ${attempt}/${maxRetries} 次)...`);
        
        // 3. 防御性清理：确保旧的 Toast 已经不在页面上
        await successToast.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {});

        // 2. 优雅降级的点击策略
        try {
          // 优先尝试常规点击，享受 Playwright 的安全性检查
          await exportBtn.click({ timeout: 5000 });
        } catch (normalClickErr) {
          console.warn(`[WARN] 常规点击受阻，降级尝试强制点击...`);
          // 兜底：无视客服气泡等图层遮挡，直击 DOM
          await exportBtn.click({ force: true, timeout: 5000 });
        }

        // 等待新的 Toast 出现
        await successToast.waitFor({ state: 'visible', timeout: 20000 });
        
        console.log(`[INFO] 成功捕获 Export 成功提示！`);
        isExportSuccessful = true;
        break; // 成功触发，跳出循环

      } catch (clickErr) {
        // 4. 打印真实的异常堆栈，方便排查是 detached、timeout 还是 intercept
        console.warn(`[WARN] 第 ${attempt} 次点击循环未能确认成功。具体异常:`, clickErr instanceof Error ? clickErr.message : clickErr);
        
        if (attempt < maxRetries) {
          console.log('[INFO] 等待 3 秒后进行下一次尝试...');
          await page.waitForTimeout(3000); 
        }
      }
    }

    if (!isExportSuccessful) {
      throw new Error(`[ERROR] 经过 ${maxRetries} 次重试点击，仍未能检测到导出成功提示。页面可能已卡死或发生结构变更。`);
    }

    return new Date();
  } catch (error) {
    try {
      const screenshotPath = path.join(process.cwd(), 'logs', `sav_export_error_${Date.now()}.png`);
      fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.warn('[WARN] Error screenshot saved to:', screenshotPath);
    } catch (screenshotErr) {
      console.warn('[WARN] Failed to save error screenshot:', screenshotErr instanceof Error ? screenshotErr.message : screenshotErr);
    }
    throw error;
  } finally {
    // Phase 5: explicit context cleanup before browser close
    await context.close().catch(() => {});
    await browser.close();
  }
}
