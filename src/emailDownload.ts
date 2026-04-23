import imaps from 'imap-simple';
import { simpleParser } from 'mailparser';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

const ALLOWED_TIME_SKEW_MS = 5000;

/**
 * 连接邮箱，寻找最新的 Sav 邮件，提取链接并下载 CSV
 */
export async function downloadLatestSavCsv(exportConfirmedAt: Date) {
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

  try {
    // 1) 连接邮箱并打开收件箱
    console.log('[INFO] 正在连接邮箱...');
    const connection = await imaps.connect(config);
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
      markSeen: true // 读取后标记为已读
    };

    const messages = await connection.search(searchCriteria, fetchOptions);

    if (messages.length === 0) {
      console.log('[WARN] 没有找到来自 Sav 的邮件。');
      connection.end();
      return;
    }

    // 4) 按时间排序后取最新一封邮件
    const latestMessage = messages.sort((a, b) => {
      return b.attributes.date.getTime() - a.attributes.date.getTime();
    })[0];

    const latestMessageDate = latestMessage.attributes.date;
    const latestMessageTime = latestMessageDate.getTime();
    const exportConfirmedTime = exportConfirmedAt.getTime();

    // 允许 5 秒时间偏差，避免邮箱服务器时间与本机时间轻微不同步
    if (latestMessageTime + ALLOWED_TIME_SKEW_MS < exportConfirmedTime) {
      console.log(
        `[WARN] 最新邮件时间(${latestMessageDate.toISOString()})早于本次导出确认时间(${exportConfirmedAt.toISOString()})超过 ${ALLOWED_TIME_SKEW_MS}ms，本次流程终止。`
      );
      connection.end();
      return;
    }

    console.log('[INFO] 找到最新邮件，正在解析内容...');
    const all = latestMessage.parts.find(part => part.which === '');
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

    // 10) 结束邮箱连接
    connection.end();

  } catch (error) {
    // 向控制台输出失败原因，便于排查
    console.error('[ERROR] 脚本执行失败:', error);
  }
}

// 如果你想直接测试这个文件，可以取消注释下面这行：
// downloadLatestSavCsv();