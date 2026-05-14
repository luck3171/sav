import * as dotenv from 'dotenv';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import { triggerExport } from './exporter';
import { downloadLatestSavCsv } from './emailDownload';

// 必须在所有环境变量解析之前调用
dotenv.config();

// 1. 定义环境变量的 Schema
const envSchema = z.object({
  // 邮箱配置：严格校验必填项和邮箱格式
  EMAIL_USER: z.string().email("EMAIL_USER 必须是有效的邮箱地址"),
  EMAIL_PASSWORD: z.string().min(1, "缺少 EMAIL_PASSWORD"),
  EMAIL_HOST: z.string().min(1, "缺少 EMAIL_HOST"),

  // SAV 登录配置：设为可选，因为有 Session 缓存时不需要
  SAV_USERNAME: z.string().email("SAV_USERNAME 必须是有效的邮箱地址").optional(),
  SAV_PASSWORD: z.string().optional(),

  // 高级配置：利用 preprocess 自动处理 'true'/'1' 的布尔转换
  SAV_FORCE_RELOGIN: z.preprocess(
    (val) => val === '1' || String(val).toLowerCase() === 'true',
    z.boolean()
  ).default(false),

  SAV_USER_DATA_DIR: z.string()
    .trim()
    .min(1)
    .default(path.resolve(process.cwd(), '.sav-profile')),

  SAV_FINGERPRINT_SEED: z.preprocess(
    (val) => {
      const seed = String(val ?? '').trim();
      return seed === '' ? undefined : seed;
    },
    z.string().regex(/^\d+$/, 'SAV_FINGERPRINT_SEED 必须为数字字符串')
  ).optional(),

  SAV_NO_SANDBOX: z.preprocess(
    (val) => val === '1' || String(val).toLowerCase() === 'true',
    z.boolean()
  ).default(false),

  SAV_HEADLESS: z.preprocess(
    (val) => {
      if (val === undefined) return undefined;
      const raw = String(val).toLowerCase();
      return raw === '1' || raw === 'true';
    },
    z.boolean()
  ).default(true),

  // 超时配置：自动将字符串数字转换为 number
  SAV_EXPORT_TIMEOUT_MS: z.coerce.number().default(120000),

  // Export toast 超时
  SAV_EXPORT_TOAST_TIMEOUT_MS: z.preprocess(
    (val) => {
      const raw = String(val ?? '').trim();
      return raw === '' ? undefined : raw;
    },
    z.coerce.number()
  ).optional(),

}).superRefine((data, ctx) => {
  // 2. 复杂的跨字段级联校验 (Business Logic Validation)
  const hasReusableSession = !data.SAV_FORCE_RELOGIN && fs.existsSync(data.SAV_USER_DATA_DIR);
  
  if (!hasReusableSession) {
    if (!data.SAV_USERNAME) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "未检测到可用会话或强制重登时，必须配置 SAV_USERNAME",
        path: ["SAV_USERNAME"]
      });
    }
    if (!data.SAV_PASSWORD) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "未检测到可用会话或强制重登时，必须配置 SAV_PASSWORD",
        path: ["SAV_PASSWORD"]
      });
    }
  }
});

// 3. 执行解析，如果失败 Zod 会抛出详细的错误并终止程序
export const config = envSchema.parse(process.env);

// 此时如果通过校验，可以安全地输出启动信息
const hasReusableSession = !config.SAV_FORCE_RELOGIN && fs.existsSync(config.SAV_USER_DATA_DIR);
if (hasReusableSession) {
  console.log(`[INFO] 已检测到用户数据目录，将优先复用: ${config.SAV_USER_DATA_DIR}`);
} else {
  console.log('[INFO] 未检测到可复用会话，将使用账号密码登录。');
}

if (config.SAV_FINGERPRINT_SEED) {
  console.log(`[INFO] 使用固定指纹种子: ${config.SAV_FINGERPRINT_SEED}`);
}


async function main() {
  try {
    // 4. 将验证后的 config 传递给 downstream 模块，解耦了对 process.env 的直接依赖
    const exportConfirmedAt = await triggerExport(config);
    
    const downloaded = await downloadLatestSavCsv(exportConfirmedAt, config);
    if (!downloaded) {
      console.log('[INFO] 轮询结束：未收到本次导出的邮件，程序正常结束。');
    }
    
  } catch (error) {
    console.error('[ERROR] 任务执行失败。', error);
    process.exit(1); 
  }
}

main();