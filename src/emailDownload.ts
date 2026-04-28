import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import * as cheerio from 'cheerio';
import * as fs from 'fs';
import * as path from 'path';
import { type config } from './index';

const TIME_CONSTANTS = {
  ALLOWED_SKEW_MS: 5000,
  WAIT_TIMEOUT_MS: 20 * 1000,
  POLL_INTERVAL_MS: 1000,
};

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function downloadLatestSavCsv(exportConfirmedAt: Date, appConfig: typeof config): Promise<boolean> {
  const client = new ImapFlow({
    host: appConfig.EMAIL_HOST,
    port: 993,
    secure: true,
    auth: {
      user: appConfig.EMAIL_USER,
      pass: appConfig.EMAIL_PASSWORD
    },
    tls: { rejectUnauthorized: false }, 
    logger: false 
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    
    try {
      const deadline = Date.now() + TIME_CONSTANTS.WAIT_TIMEOUT_MS;
      const exportConfirmedTime = exportConfirmedAt.getTime();
      let targetUid: number | undefined;

      while (Date.now() <= deadline) {
        const uids = await client.search({ from: 'support@sav.com' });

        // 类型守卫：确保 uids 是数组且不为空
        if (Array.isArray(uids) && uids.length > 0) {
          const messages = [];
          for await (let msg of client.fetch(uids, { envelope: true })) {
            messages.push(msg);
          }
          
          // 处理 envelope 或 date 可能为 undefined 的情况
          const sorted = messages.sort((a, b) => {
            const timeA = a.envelope?.date?.getTime() || 0;
            const timeB = b.envelope?.date?.getTime() || 0;
            return timeB - timeA;
          });
          
          const latestMsg = sorted[0];

          // 确保 date 存在后再进行时间比对
          if (
            latestMsg.envelope?.date && 
            latestMsg.envelope.date.getTime() + TIME_CONSTANTS.ALLOWED_SKEW_MS >= exportConfirmedTime
          ) {
            targetUid = latestMsg.uid;
            break;
          }
        }
        
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break;
        await wait(Math.min(TIME_CONSTANTS.POLL_INTERVAL_MS, remainingMs));
      }

      if (!targetUid) return false;

      const message = await client.fetchOne(targetUid.toString(), { source: true });
      if (!message || !message.source) throw new Error('无法读取邮件源码内容');

      const parsedMail = await simpleParser(message.source);
      const htmlBody = parsedMail.html || parsedMail.textAsHtml || parsedMail.text;
      if (!htmlBody) throw new Error('无法读取邮件正文内容');

      // 使用 Cheerio 稳定解析 DOM
      const $ = cheerio.load(htmlBody);
      const downloadUrl = $('a:contains("Download CSV File"), a:contains("Download")').first().attr('href');

      if (!downloadUrl) throw new Error('未在邮件正文中找到有效的 CSV 下载链接');

      const response = await fetch(downloadUrl);
      if (!response.ok) throw new Error(`下载失败: ${response.status}`);

      const downloadDir = path.join(process.cwd(), 'downloads');
      fs.mkdirSync(downloadDir, { recursive: true });

      const timestampStr = new Date().toISOString().replace(/[:.]/g, '-');
      const filePath = path.join(downloadDir, `sav_auctions_${timestampStr}.csv`);

      const arrayBuffer = await response.arrayBuffer();
      fs.writeFileSync(filePath, Buffer.from(arrayBuffer));
      
      console.log(`[SUCCESS] 文件已保存: ${filePath}`);
      return true;

    } finally {
      // 确保无论如何释放邮箱锁
      lock.release();
    }

  } catch (error) {
    console.error('[ERROR] 邮件处理流程失败:', error);
    throw error;
  } finally {
    // 确保登出，避免占用服务端连接
    try { await client.logout(); } catch {}
  }
}