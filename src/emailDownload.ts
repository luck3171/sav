import imaps from 'imap-simple';
import { simpleParser } from 'mailparser';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

const ALLOWED_TIME_SKEW_MS = 5000;
const MAIL_WAIT_TIMEOUT_MS = 20 * 1000;
const MAIL_POLL_INTERVAL_MS = 1000;

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 连接邮箱，寻找最新的 Sav 邮件，提取链接并下载 CSV
 */
export async function downloadLatestSavCsv(exportConfirmedAt: Date): Promise<boolean> {
  // IMAP 连接配置，使用环境变量读取邮箱凭据
  const config = {
    imap: {
      user: process.env.EMAIL_USER as string,
      password: process.env.EMAIL_PASSWORD as string,
      host: process.env.EMAIL_HOST as string,
      port: 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: false }, // 如果遇到证书问题可以保留这个
      authTimeout: 10000
    }
  };

  let connection: imaps.ImapSimple | null = null;

  try {
    // 1) 连接邮箱并打开收件箱
    console.log('[INFO] 正在连接邮箱...');
    connection = await imaps.connect(config);
    await connection.openBox('INBOX');

    console.log('[INFO] 正在搜索来自 Sav 的最新邮件...');
    // 2) 搜索来自 SAV 官方地址的邮件
    const searchCriteria = [
      ['FROM', 'support@sav.com']
      // 如果你想更精确，可以加上未读条件：['UNSEEN'], ['FROM', 'support@sav.com']
    ];
    
    // 3) 获取完整邮件内容用于后续解析
    const fetchOptions = {
      bodies: [''], // 获取完整邮件源
      struct: true,
      markSeen: false // 轮询等待阶段不主动修改邮件已读状态
    };

    const exportConfirmedTime = exportConfirmedAt.getTime();

    console.log('[INFO] 开始轮询邮件：总时长 20 秒，每 1 秒查询一次。');
    const deadline = Date.now() + MAIL_WAIT_TIMEOUT_MS;
    let latestMessage: imaps.Message | undefined;
    let latestSeenMessageDate: Date | null = null;
    let pollRound = 0;

    while (Date.now() <= deadline) {
      pollRound += 1;
      const messages = await connection.search(searchCriteria, fetchOptions);

      if (messages.length > 0) {
        const sortedMessages = [...messages].sort((a, b) => {
          return b.attributes.date.getTime() - a.attributes.date.getTime();
        });

        latestSeenMessageDate = sortedMessages[0].attributes.date;
        latestMessage = sortedMessages.find(message => {
          const messageTime = message.attributes.date.getTime();
          return messageTime + ALLOWED_TIME_SKEW_MS >= exportConfirmedTime;
        });

        if (latestMessage) {
          console.log(
            `[SUCCESS] 第 ${pollRound} 次查询命中新邮件，邮件时间: ${latestMessage.attributes.date.toISOString()}`
          );
          break;
        }
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        break;
      }

      console.log(`[INFO] 第 ${pollRound} 次未命中，1 秒后继续查询...`);
      await wait(Math.min(MAIL_POLL_INTERVAL_MS, remainingMs));
    }

    if (!latestMessage) {
      console.log('[WARN] 20 秒内未查询到本次导出对应的新邮件，流程结束。');
      if (latestSeenMessageDate) {
        console.log(
          `[WARN] 最近一封 Sav 邮件时间: ${latestSeenMessageDate.toISOString()}，导出确认时间: ${exportConfirmedAt.toISOString()}`
        );
      }
      return false;
    }

    console.log('[INFO] 找到最新邮件，正在解析内容...');
    const all = latestMessage.parts.find(part => part.which === '');
    if (!all?.body) {
      throw new Error('无法读取邮件原始内容');
    }
    const id = latestMessage.attributes.uid;
    const idHeader = 'Imap-Id: ' + id + '\r\n';
    
    // 使用 mailparser 解析复杂的邮件体
    const parsedMail = await simpleParser(idHeader + all?.body);
    const htmlBody = parsedMail.html || parsedMail.textAsHtml || parsedMail.text;

    if (!htmlBody) {
      throw new Error('无法读取邮件正文内容');
    }

    console.log('[INFO] 正在提取下载链接...');
    // 5) 从邮件正文中提取 Download CSV File 的下载地址
    const linkRegex = /href="([^"]+)".*?>\s*Download CSV File/i;
    const match = htmlBody.match(linkRegex);

    if (!match || !match[1]) {
      throw new Error('未在邮件正文中找到 "Download CSV File" 的有效链接');
    }

    const downloadUrl = match[1];
    console.log(`[SUCCESS] 找到下载链接: ${downloadUrl}`);

    console.log('[INFO] 正在下载 CSV 文件...');
    // 6) 下载 CSV 文件内容
    const response = await fetch(downloadUrl);
    
    if (!response.ok) {
      throw new Error(`下载失败，HTTP 状态码: ${response.status}`);
    }

    // 7) 确保本地保存目录存在
    const downloadDir = path.join(__dirname, 'downloads');
    if (!fs.existsSync(downloadDir)) {
      fs.mkdirSync(downloadDir);
    }

    // 8) 生成时间戳文件名，避免覆盖历史文件
    const now = new Date();
    const timestampStr = now.getFullYear() +
      '-' + String(now.getMonth() + 1).padStart(2, '0') +
      '-' + String(now.getDate()).padStart(2, '0') +
      '_' + String(now.getHours()).padStart(2, '0') +
      '-' + String(now.getMinutes()).padStart(2, '0') +
      '-' + String(now.getSeconds()).padStart(2, '0');
    const fileName = `sav_auctions_${timestampStr}.csv`;
    const filePath = path.join(downloadDir, fileName);

    // 9) 将下载内容写入本地 CSV 文件
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    
    fs.writeFileSync(filePath, buffer);
    console.log(`[SUCCESS] 任务圆满完成！文件已成功保存至: ${filePath}`);
    return true;

  } catch (error) {
    // 向控制台输出失败原因，便于排查
    console.error('[ERROR] 脚本执行失败:', error);
    throw error;
  } finally {
    if (connection) {
      connection.end();
    }
  }
}

// 如果你想直接测试这个文件，可以取消注释下面这行：
// downloadLatestSavCsv();