// 1. 修改依赖引入方式：使用 playwright-extra 代替原生的 playwright
import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
// 依然从 playwright 引入类型定义，保证 TypeScript 不报错
import { type BrowserContext, type Locator, type Page } from 'playwright'; 

import * as fs from 'fs';
import * as path from 'path';

// 2. 核心操作：为 chromium 挂载隐身插件，抹去无头浏览器机器人特征
chromium.use(stealth());
// SAV 站点关键地址
const SAV_LOGIN_URL = 'https://v2.sav.com/login';
const SAV_AUCTIONS_URL = 'https://v2.sav.com/domains/auctions';

// 导出流程统一超时，支持通过环境变量覆盖
const DEFAULT_TIMEOUT_MS = Number(process.env.SAV_EXPORT_TIMEOUT_MS || 30000);

// 将环境变量字符串解析为布尔值，便于开关配置
function parseBooleanEnv(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true';
}

// 获取会话状态文件路径，未配置时使用项目根目录默认文件
function getStorageStatePath(): string {
  const configuredPath = process.env.SAV_STORAGE_STATE_PATH;
  return configuredPath && configuredPath.trim().length > 0
    ? path.resolve(configuredPath)
    : path.resolve(process.cwd(), '.sav-storage-state.json');
}

// 组装 Chromium 启动参数，默认加入服务器常用参数
function getLaunchArgs(): string[] {
  const args = ['--disable-dev-shm-usage'];
  if (parseBooleanEnv(process.env.SAV_NO_SANDBOX)) {
    args.push('--no-sandbox');
  }
  return args;
}

// 检测当前页面会话是否有效（用于复用会话判定）
async function isSessionValid(page: Page): Promise<boolean> {
  const currentUrl = page.url();
  const lowerUrl = currentUrl.toLowerCase();

  // URL 以 /login 结尾，或包含 /users/login，判定为未登录
  if (lowerUrl.endsWith('/login') || lowerUrl.includes('/users/login')) {
    return false;
  }

  // 若 3000ms 内能看到邮箱输入框，说明被重定向到登录态
  const loginEmailInput = page.getByPlaceholder('Enter your email').first();
  try {
    await loginEmailInput.waitFor({ state: 'visible', timeout: 3000 });
    return false;
  } catch {
    // 超时表示未看到登录输入框，继续按会话有效处理。
  }

  return true;
}

// 执行账号密码登录流程，仅在首次登录或会话失效时调用
async function performLogin(page: Page): Promise<void> {
  const username = process.env.SAV_USERNAME;
  const password = process.env.SAV_PASSWORD;

  // 登录必须凭据校验
  if (!username || !password) {
    throw new Error('缺少 SAV_USERNAME 或 SAV_PASSWORD，无法执行登录。');
  }

  // 轮询查找可见邮箱输入框（兼容不同登录页结构与慢加载）
  const waitForEmailInput = async (timeoutMs: number): Promise<Locator | null> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const candidates: Locator[] = [
        page.getByPlaceholder('Enter your email').first(),
        page.getByPlaceholder(/email/i).first(),
        page.locator('input[type="email"]').first(),
        page.getByLabel(/email/i).first(),
        page.locator('input[name*="email" i]').first()
      ];

      for (const candidate of candidates) {
        try {
          if ((await candidate.count()) > 0 && await candidate.isVisible({ timeout: 600 })) {
            return candidate;
          }
        } catch {
          // Try next candidate.
        }
      }

      await page.waitForTimeout(250);
    }

    return null;
  };

  // 第一步：提交邮箱（必须先点 Sign In 才会出现密码框）
  const submitEmailStep = async (): Promise<void> => {
    const signInButtons = page.getByRole('button', { name: /^sign in$/i });
    const buttonCount = await signInButtons.count();

    for (let i = 0; i < buttonCount; i += 1) {
      const button = signInButtons.nth(i);
      try {
        if (await button.isVisible({ timeout: 800 })) {
          await button.click();
          return;
        }
      } catch {
        // Continue scanning buttons.
      }
    }

    // 兜底：无可见按钮时尝试回车提交
    await page.keyboard.press('Enter');
  };

  // 等待第二步密码框出现（支持多选择器）
  const waitForPasswordInput = async (timeoutMs: number): Promise<Locator | null> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const candidates: Locator[] = [
        page.locator('input[type="password"]').first(),
        page.getByPlaceholder(/password/i).first(),
        page.getByLabel(/password/i).first(),
        page.locator('input[name*="password" i]').first()
      ];

      for (const candidate of candidates) {
        try {
          if ((await candidate.count()) > 0 && await candidate.isVisible({ timeout: 800 })) {
            return candidate;
          }
        } catch {
          // Continue probing.
        }
      }

      await page.waitForTimeout(250);
    }

    return null;
  };

  // 发现新登录页异常时，自动切换到 Legacy 登录页
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
  await page.goto(SAV_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT_MS });

  // 给 SPA 登录页额外渲染时间，避免页面未完成就开始查找控件
  try {
    await page.waitForLoadState('networkidle', { timeout: 10000 });
  } catch {
    // networkidle 可能达不到，继续走输入框轮询。
  }

  const emailInput = await waitForEmailInput(25000);
  if (!emailInput) {
    const pageTitle = await page.title().catch(() => 'unknown');
    throw new Error(`未找到邮箱输入框，当前页面: ${page.url()}，标题: ${pageTitle}`);
  }

  // 新登录页若出现 reCAPTCHA 配置异常，优先转到 Legacy 页面
  const recaptchaError = page.getByText(/invalid site key|recaptcha/i).first();
  if ((await recaptchaError.count()) > 0) {
    await switchToLegacyLogin('检测到 reCAPTCHA 异常');
  }

  // 如果已经切到 Legacy，重新定位邮箱输入框
  const activeEmailInput = await waitForEmailInput(10000);
  if (!activeEmailInput) {
    throw new Error(`切换登录页后仍未找到邮箱输入框，当前页面: ${page.url()}`);
  }

  await activeEmailInput.fill(username);
  console.log('[STEP] 第一步：提交邮箱（点击 Sign In）...');
  let passwordInput = await waitForPasswordInput(3000);
  if (!passwordInput) {
    await submitEmailStep();
    console.log('[STEP] 第二步：等待密码输入框出现...');
    passwordInput = await waitForPasswordInput(18000);
  }

  // 若当前流程没出现密码框，尝试切到 legacy 登录页再走一遍
  if (!passwordInput) {
    const switched = await switchToLegacyLogin('未检测到密码框');
    if (switched) {
      const legacyEmailInput = await waitForEmailInput(15000);
      if (!legacyEmailInput) {
        throw new Error(`切换 Legacy 后未找到邮箱输入框，当前页面: ${page.url()}`);
      }

      await legacyEmailInput.fill(username);
      passwordInput = await waitForPasswordInput(3000);
      if (!passwordInput) {
        await submitEmailStep();
        passwordInput = await waitForPasswordInput(18000);
      }
    }
  }

  if (!passwordInput) {
    throw new Error(`登录流程未出现密码输入框，请检查站点登录步骤或风控。当前页面: ${page.url()}`);
  }

  await passwordInput.fill(password);

  console.log('[INFO] 提交登录信息...');
  await submitEmailStep();

  console.log('[INFO] 正在等待登录成功并自动跳转...');
  try {
    await page.waitForURL('**/domains/auctions', { timeout: DEFAULT_TIMEOUT_MS });
  } catch {
    await page.goto(SAV_AUCTIONS_URL, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT_MS });
  }
}

// 将最新登录态写入本地文件，供下次运行直接复用
async function saveStorageState(context: BrowserContext, storageStatePath: string): Promise<void> {
  const stateDir = path.dirname(storageStatePath);
  fs.mkdirSync(stateDir, { recursive: true });
  await context.storageState({ path: storageStatePath });
}


/**
 * 任务 1：模拟浏览器去点导出
 */
export async function triggerExport(): Promise<Date> {
  // 读取会话复用相关配置
  const storageStatePath = getStorageStatePath();
  const forceRelogin = parseBooleanEnv(process.env.SAV_FORCE_RELOGIN);
  const canReuseState = !forceRelogin && fs.existsSync(storageStatePath);

  console.log('[INFO] 正在启动浏览器...');
  // 服务器统一使用无头模式，避免依赖 UI
  const browser = await chromium.launch({
    headless: true,
    args: getLaunchArgs()
  });

  // 存在历史会话时优先注入 storageState
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    ...(canReuseState ? { storageState: storageStatePath } : {})
  });
  context.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
  const page = await context.newPage();

  try {
    // 先进入目标业务页，后续根据页面状态决定是否需要登录
    console.log('[INFO] 正在访问 SAV 拍卖页...');
    await page.goto(SAV_AUCTIONS_URL, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT_MS });

    if (canReuseState) {
      console.log('[INFO] 检测到会话状态文件，正在验证是否可复用...');
    }

    // 判断当前会话是否已经可直接导出
    let sessionReady = await isSessionValid(page);

    if (!sessionReady) {
      // 会话不可用时自动回退到账号密码登录
      if (canReuseState) {
        console.log('[WARN] 旧会话状态已失效，回退到账号密码登录...');
      } else {
        console.log('[INFO] 未检测到会话状态，执行首次登录...');
      }
      await performLogin(page);

      // 登录成功后刷新状态文件，供后续运行直接复用
      await saveStorageState(context, storageStatePath);
      console.log(`[INFO] 登录状态已更新: ${storageStatePath}`);

      // 回到拍卖页并再次验证是否就绪
      await page.goto(SAV_AUCTIONS_URL, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT_MS });
      sessionReady = await isSessionValid(page);
    } else {
      console.log('[INFO] 复用会话成功，无需重复登录。');
    }

    // 二次校验失败则直接终止，防止误触发后续流程
    if (!sessionReady) {
      throw new Error('登录状态不可用，未能进入可导出页面。');
    }

    // --- 第三步：点击 Export 并等待成功提示 ---
    console.log('[INFO] 正在抓取 Export 按钮...');
    const exportBtn = page.locator('div[class*="export-div"]:has-text("Export")').last();
    
    // 🚨 核心保障：让 Playwright 自动寻找元素并将其滚动到可视区域内
    try {
        await exportBtn.scrollIntoViewIfNeeded({ timeout: 10000 });
      } catch {
        console.log('[WARN] 自动滚动辅助超时，继续尝试等待元素...');
    }

    // 等待元素最终可见
      await exportBtn.waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT_MS });
    
    console.log('[INFO] 成功锁定，执行点击...');
    await exportBtn.click();

    // --- 第四步：等待网页弹出成功的文案 ---
    console.log('[INFO] 正在等待系统处理并发送邮件...');
    const successToast = page.getByText(/successfully generated and sent/i);
    await successToast.waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT_MS });
    const exportConfirmedAt = new Date();
    console.log('[SUCCESS] 收到网站确认：CSV 文件已成功发送至邮箱！浏览器任务圆满结束。');

    return exportConfirmedAt;

  } catch (error) {
    // 异常时尽量保存截图，便于服务器环境排错
    try {
      const screenshotDir = path.resolve(process.cwd(), 'logs');
      fs.mkdirSync(screenshotDir, { recursive: true });
      const screenshotPath = path.join(screenshotDir, `sav_export_error_${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.error(`[ERROR] 失败现场截图已保存: ${screenshotPath}`);
    } catch {
      console.error('[WARN] 失败截图保存失败。');
    }

    console.error('[ERROR] 浏览器操作失败:', error);
    throw error;
  } finally {
    // 无论成功失败都关闭浏览器，避免进程泄漏
    await browser.close();
  }
}
