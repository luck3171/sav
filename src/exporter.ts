import { type BrowserContext, type Locator, type Page } from 'playwright-core';
import * as fs from 'fs';
import * as path from 'path';
import { type config } from './index';

const SAV_LOGIN_URL = 'https://v2.sav.com/login';
const SAV_AUCTIONS_URL = 'https://v2.sav.com/domains/auctions';

const TIMEOUTS = {
  NETWORK_IDLE: 10000,
  CF_WAIT: 30000,
  ELEMENT_VISIBLE: 3000,
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---- Phase 3: Cloudflare detection utilities ----

async function detectCloudflare(page: Page): Promise<boolean> {
  const title = (await page.title()).toLowerCase();
  if (title.includes('just a moment') || title.includes('cloudflare') || title.includes('verify')) return true;

  const url = page.url().toLowerCase();
  if (url.includes('/cdn-cgi/') || url.includes('__cf_challenge')) return true;

  const cfElements = page.locator(
    '#cf-wrapper, #challenge-running, #challenge-stage, #cf-please-wait, ' +
    '[id^="cf-"], iframe[src*="challenge"], iframe[src*="challenges.cloudflare.com"], ' +
    '#cf-turnstile'
  );
  try {
    return (await cfElements.count()) > 0;
  } catch {
    return false;
  }
}

async function tryClickTurnstile(page: Page): Promise<void> {
  const turnstileFrame = page.locator('iframe[src*="challenges.cloudflare.com"]').first();
  try {
    if (await turnstileFrame.isVisible({ timeout: 2000 })) {
      console.log('[INFO] 检测到 Turnstile 验证框，尝试点击...');
      await turnstileFrame.click({ timeout: 3000 });
      await sleep(2000);
    }
  } catch {
    // Turnstile not present or not interactable
  }
}

async function waitForCloudflare(page: Page): Promise<void> {
  const isCloudflare = await detectCloudflare(page);
  if (!isCloudflare) return;

  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt > 1) {
      console.log('[INFO] 刷新页面重新处理 Cloudflare 挑战...');
      await page.reload({ waitUntil: 'domcontentloaded' });
    }

    const deadline = Date.now() + TIMEOUTS.CF_WAIT;
    while (Date.now() < deadline) {
      const stillBlocked = await detectCloudflare(page);
      if (!stillBlocked) {
        console.log('[INFO] Cloudflare challenge passed');
        await page.waitForLoadState('networkidle', { timeout: TIMEOUTS.NETWORK_IDLE }).catch(() => {});
        return;
      }

      await tryClickTurnstile(page);
      await sleep(1000);
    }
  }

  console.warn('[WARN] Cloudflare challenge could not be resolved after retry');
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
  if (appConfig.SAV_FINGERPRINT_SEED) {
    args.push(`--fingerprint=${appConfig.SAV_FINGERPRINT_SEED}`);
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

// ---- Page content readiness ----

async function waitForAuctionsPageReady(page: Page, timeout: number): Promise<boolean> {
  const knownContent = page.getByText(/Fetching your latest auctions/i)
    .or(page.locator('div[class*="export-div"]'))
    .or(page.locator('table'))
    .or(page.getByRole('table'))
    .first();
  try {
    await knownContent.waitFor({ state: 'visible', timeout });
    return true;
  } catch {
    console.warn('[WARN] Auctions page known content did not appear within timeout');
    return false;
  }
}

// ---- Phase 2: Event-driven login flow ----

async function tryFillLoginForm(page: Page, username: string, password: string): Promise<boolean> {
  // 用组合选择器等待最多 12 秒，给模态框足够渲染时间
  const emailInput = page.getByPlaceholder(/enter your email/i).first()
    .or(page.getByPlaceholder(/email/i).first())
    .or(page.locator('input[type="email"]').first())
    .or(page.locator('input[name="email"]').first())
    .or(page.locator('input[autocomplete="email"]').first());

  try {
    await emailInput.waitFor({ state: 'visible', timeout: 12000 });
  } catch {
    return false;
  }

  console.log('[INFO] 找到邮箱输入框，开始填写...');
  await emailInput.click();
  await emailInput.pressSequentially(username, { delay: 50 });

  console.log('[INFO] 提交邮箱...');
  const submitBtn = page.getByRole('button', { name: /sign in|continue|next|log in/i, exact: false }).last();
  try {
    await submitBtn.waitFor({ state: 'visible', timeout: 5000 });
    await submitBtn.click();
  } catch {
    // 如果按钮不可见，尝试回车提交
    await page.keyboard.press('Enter');
  }

  console.log('[INFO] 等待密码输入框...');
  const passwordInput = page.locator('input[type="password"]').first();
  await passwordInput.waitFor({ state: 'visible', timeout: 15000 });
  await passwordInput.click();
  await passwordInput.pressSequentially(password, { delay: 50 });

  console.log('[INFO] 提交密码...');
  try {
    await submitBtn.waitFor({ state: 'visible', timeout: 5000 });
    await submitBtn.click();
  } catch {
    await page.keyboard.press('Enter');
  }

  console.log('[INFO] 等待登录完成（页面跳转或弹窗消失）...');

  // 密码提交后会触发 SPA 页面刷新/跳转，等待页面稳定
  try {
    await page.waitForURL(
      (url) => !url.href.includes('/login') && !url.href.includes('/auth'),
      { timeout: 30000 }
    );
    console.log('[INFO] 登录成功，页面已跳转');
  } catch {
    // URL 没变说明可能是模态框关闭但没跳转，退而检查弹窗是否消失
    try {
      await passwordInput.waitFor({ state: 'hidden', timeout: 8000 });
    } catch {
      console.warn('[WARN] 登录后页面未跳转，弹窗也未关闭，继续执行');
    }
  }

  return true;
}

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

  // 停留 20 秒后再操作，提升 reCAPTCHA v3 评分（文档建议至少 15 秒）
  console.log('[INFO] 等待 20 秒以提升 reCAPTCHA 评分...');
  await sleep(20000);

  // Strategy 1: Click Sign In button and look for login modal
  console.log('[INFO] 尝试点击 Sign In 唤起登录面板...');
  const topSignInBtn = page.getByText(/sign in/i).first();
  try {
    await topSignInBtn.click({ timeout: 8000 });
    console.log('[INFO] 已点击 Sign In');
  } catch {
    console.log('[INFO] 未发现 Sign In 按钮');
  }

  let filled = await tryFillLoginForm(page, username, password);

  // Strategy 2: If modal didn't appear, navigate directly to login page
  if (!filled) {
    console.log('[INFO] 当前页面未找到登录表单，直接导航到登录页...');
    await navigateGuarded(page, SAV_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: globalTimeout });
    filled = await tryFillLoginForm(page, username, password);
  }

  // Strategy 3: Last resort — try alternate known login paths
  if (!filled) {
    console.log('[INFO] 尝试备用登录地址...');
    const altUrls = [
      'https://v2.sav.com/login',
      'https://sav.com/login',
      'https://app.sav.com/login',
    ];
    for (const url of altUrls) {
      if (page.url().includes(url)) continue;
      await navigateGuarded(page, url, { waitUntil: 'domcontentloaded', timeout: globalTimeout });
      filled = await tryFillLoginForm(page, username, password);
      if (filled) break;
    }
  }

  if (!filled) {
    throw new Error('无法定位登录表单，可能是页面结构已变更。');
  }

  // 登录成功后等待 Cloudflare 和页面稳定
  await waitForCloudflare(page);
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {
    console.warn('[WARN] Post-login network idle timeout');
  });
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
  const {
    SAV_FORCE_RELOGIN: forceRelogin,
    SAV_EXPORT_TIMEOUT_MS: globalTimeout,
    SAV_EXPORT_TOAST_TIMEOUT_MS: toastTimeoutConfig,
    SAV_USER_DATA_DIR: userDataDir,
  } = appConfig;

  const toastTimeout = toastTimeoutConfig ?? globalTimeout;
  const toastTimeoutSeconds = Math.ceil(toastTimeout / 1000);

  if (forceRelogin && fs.existsSync(userDataDir)) {
    fs.rmSync(userDataDir, { recursive: true, force: true });
    console.log(`[INFO] 已清理用户数据目录，强制重新登录: ${userDataDir}`);
  }

  const headless = appConfig.SAV_HEADLESS;
  let context: BrowserContext | null = null;

  try {
    // CloakBrowser 是 ESM-only，这里用运行时 import 避免被 TS 转成 require。
    const dynamicImport = new Function(
      'specifier',
      'return import(specifier)'
    ) as (specifier: string) => Promise<typeof import('cloakbrowser')>;
    const { launchPersistentContext } = await dynamicImport('cloakbrowser');
    context = await launchPersistentContext({
      userDataDir,
      headless,
      args: getLaunchArgs(appConfig),
      humanize: true,
      viewport: { width: 1920, height: 1080 },
      contextOptions: {
        ignoreHTTPSErrors: true,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const lowered = message.toLowerCase();
    if (
      lowered.includes('no "exports" main defined') ||
      lowered.includes('err_require_esm') ||
      lowered.includes('cannot use import statement outside a module')
    ) {
      throw new Error(
        `CloakBrowser 为 ESM-only 包，当前运行环境为 CommonJS。请使用运行时 import 或改用 ESM。原始错误: ${message}`
      );
    }
    if (
      lowered.includes('download') ||
      lowered.includes('cloakbrowser') ||
      lowered.includes('checksum') ||
      lowered.includes('etimedout') ||
      lowered.includes('enotfound') ||
      lowered.includes('econnrefused')
    ) {
      throw new Error(
        `CloakBrowser 二进制下载失败，请检查网络/代理或设置 CLOAKBROWSER_BINARY_PATH。原始错误: ${message}`
      );
    }
    throw error;
  }

  if (!context) {
    throw new Error('CloakBrowser 启动失败，未能创建浏览器上下文。');
  }

  context.setDefaultTimeout(globalTimeout);
  const page = await context.newPage();

  try {
    // Phase 3: use navigateGuarded to auto-handle CF after every navigation
    await navigateGuarded(page, SAV_AUCTIONS_URL, { waitUntil: 'domcontentloaded', timeout: globalTimeout });

    let sessionReady = await isSessionValid(page);

    if (!sessionReady) {
      await performLogin(page, appConfig);

      console.log(`[DEBUG] 登录后当前 URL: ${page.url()}`);
      if (!page.url().includes('/domains/auctions')) {
        console.log('[INFO] 不在拍卖页，导航到拍卖页...');
        await navigateGuarded(page, SAV_AUCTIONS_URL, { waitUntil: 'domcontentloaded', timeout: globalTimeout });
      } else {
        console.log('[INFO] 已在拍卖页，等待页面稳定...');
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      }

      console.log(`[DEBUG] 会话验证前 URL: ${page.url()}`);
      sessionReady = await isSessionValid(page);
      console.log(`[DEBUG] 会话验证结果: ${sessionReady}`);
    }

    if (!sessionReady) throw new Error('登录状态不可用，未能进入可导出页面。');

    // ---- Retry loop: auctions page readiness + export button ----
    const maxPageLoadRetries = 3;
    let exportBtnReady = false;

    for (let attempt = 1; attempt <= maxPageLoadRetries; attempt++) {
      console.log(`[INFO] 拍卖页就绪检查 (第 ${attempt}/${maxPageLoadRetries} 次)...`);

      await waitForAuctionsPageReady(page, globalTimeout);

      const loadingBanner = page.getByText(/Fetching your latest auctions/i);
      try {
        await loadingBanner.waitFor({ state: 'hidden', timeout: 45000 });
      } catch {
        console.warn(`[WARN] Loading banner 45s 未消失 (attempt ${attempt}), 重新加载页面...`);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await waitForCloudflare(page);
        continue;
      }

      const btn = getExportButtonLocator(page);
      try {
        await btn.waitFor({ state: 'visible', timeout: globalTimeout });
        exportBtnReady = true;
        console.log('[INFO] Export 按钮已就绪。');
        break;
      } catch (err) {
        console.warn(`[WARN] Export 按钮未找到 (attempt ${attempt}/${maxPageLoadRetries}):`,
          err instanceof Error ? err.message : err);
        if (attempt < maxPageLoadRetries) {
          console.log('[INFO] 重新导航到拍卖页重试...');
          await navigateGuarded(page, SAV_AUCTIONS_URL, { waitUntil: 'domcontentloaded', timeout: globalTimeout });
        }
      }
    }

    if (!exportBtnReady) {
      throw new Error(`Export 按钮在 ${maxPageLoadRetries} 次重试后仍未找到，页面可能结构已变更或 CF 验证未通过。`);
    }

    const exportBtn = getExportButtonLocator(page);
    try {
      await exportBtn.scrollIntoViewIfNeeded({ timeout: 10000 });
    } catch (err) {
      console.warn('[WARN] scrollIntoViewIfNeeded failed:', err instanceof Error ? err.message : err);
    }

    await sleep(1000);

    const successToast = page.getByText(/successfully generated and sent/i);
    let isExportSuccessful = false;
    
    // 因为生成过程漫长，我们将重试次数降为 2，避免频繁干扰页面
    const maxRetries = 2; 

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`[INFO] 尝试点击 Export 按钮 (第 ${attempt}/${maxRetries} 次)...`);
        
        await successToast.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {});

        try {
          await exportBtn.click({ timeout: 5000 });
        } catch (normalClickErr) {
          console.warn(`[WARN] 常规点击受阻，降级尝试强制点击...`);
          await exportBtn.click({ force: true, timeout: 5000 });
        }

        console.log(`[INFO] 点击已触发，系统可能正在生成数据文件，耐心等待 Toast 出现...`);
        
        await successToast.waitFor({ state: 'visible', timeout: toastTimeout });
        
        console.log(`[INFO] 成功捕获 Export 成功提示！`);
        isExportSuccessful = true;
        break; 

      } catch (clickErr) {
        console.warn(`[WARN] 第 ${attempt} 次等待 Toast 超时或失败。具体异常:`, clickErr instanceof Error ? clickErr.message : clickErr);
        
        if (attempt < maxRetries) {
          console.log('[INFO] 检查是否仍处于 Loading 状态...');
          
          // 核心修改 2：在重试之前，检查一下是不是还在生成中。如果还在生成，再多等一会，而不是盲目重点
          const loadingOverlay = page.locator('div:has-text("Fetching"), [class*="loading"]').first();
          if (await loadingOverlay.isVisible().catch(() => false)) {
                console.log(`[INFO] 页面仍在生成中，追加 ${toastTimeoutSeconds} 秒等待时间...`);
              try {
                  await successToast.waitFor({ state: 'visible', timeout: toastTimeout });
                  isExportSuccessful = true;
                  break; // 追加等待成功了，直接跳出
              } catch (e) {
                  console.warn('[WARN] 追加等待依然超时。');
              }
          }
            
          console.log('[INFO] 等待 3 秒后进行下一次点击尝试...');
          await sleep(3000);
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
    // Phase 5: explicit context cleanup
    await context.close().catch(() => {});
  }
}
