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
  if (appConfig.SAV_NO_SANDBOX) {
    args.push('--no-sandbox');
  }
  return args;
}

// 修改点 1：修复会话校验，直接识别 Sign In 文本避免假阳性
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

// 修改点 2：彻底重构登录流程，模拟真人点击弹窗与顺次输入
async function performLogin(page: Page, appConfig: typeof config): Promise<void> {
  const username = appConfig.SAV_USERNAME;
  const password = appConfig.SAV_PASSWORD;
  const globalTimeout = appConfig.SAV_EXPORT_TIMEOUT_MS;

  if (!username || !password) {
    throw new Error('缺少 SAV_USERNAME 或 SAV_PASSWORD，无法执行登录。');
  }

  console.log('[INFO] 页面加载中，强行等待 3 秒，防止过快触碰导致幽灵刷新...');
  await page.waitForTimeout(3000);

  console.log('[INFO] 尝试唤起登录面板...');
  const topSignInBtn = page.getByText(/sign in/i).first();
  try {
    if (await topSignInBtn.isVisible({ timeout: 5000 })) {
      console.log('[INFO] 发现页面右上角 Sign In 按钮，直接点击唤起登录...');
      await topSignInBtn.click();
      await page.waitForTimeout(1500); 
    } else {
      console.log('[INFO] 未发现 Sign In 按钮，尝试跳转登录页...');
      await page.goto(SAV_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: globalTimeout });
    }
  } catch {
    await page.goto(SAV_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: globalTimeout });
  }

  try {
    console.log('[INFO] 等待邮箱输入框...');
    const emailInput = page.getByPlaceholder(/enter your email/i).first();
    
    try {
      await emailInput.waitFor({ state: 'visible', timeout: 8000 });
    } catch {
      console.log('[INFO] 弹窗疑似被页面刷新吞掉，尝试重新点击 Sign In...');
      await topSignInBtn.click().catch(() => {});
      await emailInput.waitFor({ state: 'visible', timeout: 8000 });
    }

    await emailInput.pressSequentially(username, { delay: 50 }); 
    
    console.log('[INFO] 提交邮箱...');
    // 修复 1：稍微停顿 0.5 秒，让框架把邮箱的值同步进去，确保按钮处于可点击状态
    await page.waitForTimeout(500);

    // 修复 2：将 .first() 改为 .last()，或者通过精确匹配。
    // 因为弹窗通常在 DOM 树的最后，用 last() 可以完美避开背景页面上可能残留的同名按钮
    const modalSubmitBtn = page.getByRole('button', { name: /sign in|continue|next/i, exact: false }).last();
    
    // 确保这个黑色按钮真的可见并且可交互后再点
    await modalSubmitBtn.waitFor({ state: 'visible', timeout: 5000 });
    await modalSubmitBtn.click();

    console.log('[INFO] 等待密码输入框...');
    const passwordInput = page.locator('input[type="password"]').first();
    // 必须确保密码框变为 visible 后，才能填入密码
    await passwordInput.waitFor({ state: 'visible', timeout: 15000 });
    await passwordInput.pressSequentially(password, { delay: 50 });

    console.log('[INFO] 提交密码...');
    await modalSubmitBtn.click();

    console.log('[INFO] 抛弃网络静默，等待弹窗消失（视觉确认）...');
    // 等待密码框彻底从画面中消失，代表前端处理完毕关闭了弹窗
    await passwordInput.waitFor({ state: 'hidden', timeout: 15000 });

    console.log('[INFO] 弹窗已消失，等待状态同步落盘...');
    // 强制等待 3 秒，等 Cookie 写入
    await page.waitForTimeout(3000);

  } catch (error) {
    console.error('[ERROR] 填写账号密码时发生异常:', error);
    throw error;
  }
}
  
async function saveStorageState(context: BrowserContext, storageStatePath: string): Promise<void> {
  fs.mkdirSync(path.dirname(storageStatePath), { recursive: true });
  await context.storageState({ path: storageStatePath });
}

export async function triggerExport(appConfig: typeof config): Promise<Date> {
  const { SAV_STORAGE_STATE_PATH: storageStatePath, SAV_FORCE_RELOGIN: forceRelogin, SAV_EXPORT_TIMEOUT_MS: globalTimeout } = appConfig;
  const canReuseState = !forceRelogin && fs.existsSync(storageStatePath);

  // 核心改动：在服务器环境(GITHUB_ACTIONS)下强制使用 headless: false 配合 xvfb-run
  const isServer = process.env.GITHUB_ACTIONS === 'true';
  const browser = await chromium.launch({ 
    headless: isServer ? false : true, // 服务器端必须为 false 配合 Xvfb
    args: getLaunchArgs(appConfig) 
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 }, // 固定分辨率防止 UI 变形[cite: 10]
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
      // 登录完成后重载页面，确保 Export 按钮被渲染出来
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