// index.ts
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { triggerExport } from './exporter';
import { downloadLatestSavCsv } from './emailDownload';

dotenv.config();

// 将环境变量字符串解析为布尔开关
function parseBooleanEnv(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true';
}

// 获取本地会话状态文件路径，默认存放在项目根目录
function getStorageStatePath(): string {
  const configuredPath = process.env.SAV_STORAGE_STATE_PATH;
  return configuredPath && configuredPath.trim().length > 0
    ? path.resolve(configuredPath)
    : path.resolve(process.cwd(), '.sav-storage-state.json');
}

// 读取并校验必需环境变量，缺失则立即抛错终止
function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`缺少必需环境变量: ${name}`);
  }
  return value;
}

// 启动前统一校验运行时配置，避免执行到中途才失败
function validateRuntimeConfig(): void {
  const storageStatePath = getStorageStatePath();
  const forceRelogin = parseBooleanEnv(process.env.SAV_FORCE_RELOGIN);
  const hasReusableSession = !forceRelogin && fs.existsSync(storageStatePath);

  // 会话可复用时可跳过账号密码登录，但邮箱配置仍必须存在
  if (hasReusableSession) {
    console.log(`[INFO] 已检测到会话状态文件，将优先复用: ${storageStatePath}`);
  } else {
    // 首次运行或强制重登时要求提供 SAV 登录凭据
    getRequiredEnv('SAV_USERNAME');
    getRequiredEnv('SAV_PASSWORD');
    console.log('[INFO] 未检测到可复用会话，将使用账号密码登录。');
  }

  // 邮箱下载链路必需配置
  getRequiredEnv('EMAIL_USER');
  getRequiredEnv('EMAIL_PASSWORD');
  getRequiredEnv('EMAIL_HOST');
}

async function main() {
  try {
    // 0. 启动前配置检查
    validateRuntimeConfig();

    // 1. 去网页触发导出
    const exportConfirmedAt = await triggerExport();
    
    // 2. 登录邮箱并校验“最新邮件是否来自本次导出”后再下载
    await downloadLatestSavCsv(exportConfirmedAt);
    
  } catch (error) {
    // 捕获到错误，优雅终止程序
    console.error('[ERROR] 前置任务失败，后续流程已终止。', error);
    process.exit(1); // 强制结束 Node.js 进程并返回错误状态码
  }
}

main();