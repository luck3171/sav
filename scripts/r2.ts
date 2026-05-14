import { S3Client, GetObjectCommand, PutObjectCommand, NoSuchKey } from '@aws-sdk/client-s3';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const CMD = process.argv[2]; // restore | upload-profile | upload-csv

const {
  R2_ENDPOINT = '',
  R2_ACCESS_KEY_ID = '',
  R2_SECRET_ACCESS_KEY = '',
  R2_BUCKET = 'domains-storage',
} = process.env;

function getClient() {
  return new S3Client({
    region: 'auto',
    endpoint: R2_ENDPOINT,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  });
}

async function restore() {
  const profileDir = path.resolve(process.env.SAV_USER_DATA_DIR || '.sav-profile');
  fs.mkdirSync(profileDir, { recursive: true });

  console.log('[INFO] Downloading profile cache from R2...');
  const client = getClient();
  try {
    const resp = await client.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: 'profile-cache.tar.gz' }));
    const tmpFile = 'profile-cache.tar.gz';
    const ws = fs.createWriteStream(tmpFile);
    await new Promise<void>((resolve, reject) => {
      (resp.Body as NodeJS.ReadableStream).pipe(ws);
      ws.on('finish', resolve);
      ws.on('error', reject);
    });
    execSync(`tar -xzf "${tmpFile}" -C "${profileDir}"`, { stdio: 'inherit' });
    fs.unlinkSync(tmpFile);
    console.log('[INFO] Profile restored.');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof NoSuchKey || msg.includes('404') || msg.includes('NoSuchKey')) {
      console.log('[INFO] No cached profile, will create fresh.');
    } else {
      console.warn('[WARN] Failed to restore profile:', msg);
    }
  }
}

async function uploadProfile() {
  const profileDir = path.resolve(process.env.SAV_USER_DATA_DIR || '.sav-profile');
  if (!fs.existsSync(profileDir) || fs.readdirSync(profileDir).length === 0) {
    console.log('[INFO] No profile to cache.');
    return;
  }

  console.log('[INFO] Packing and uploading profile...');
  execSync(`tar -czf profile-cache.tar.gz -C "${profileDir}" .`, { stdio: 'inherit' });
  const client = getClient();
  await client.send(new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: 'profile-cache.tar.gz',
    Body: fs.createReadStream('profile-cache.tar.gz'),
  }));
  fs.unlinkSync('profile-cache.tar.gz');
  console.log('[INFO] Profile cached.');
}

async function uploadCsv() {
  const dir = path.resolve('downloads');
  if (!fs.existsSync(dir)) { console.log('[INFO] No downloads dir.'); return; }

  const files = fs.readdirSync(dir).filter(f => fs.statSync(path.join(dir, f)).isFile());
  if (files.length === 0) { console.log('[INFO] No CSVs to upload.'); return; }

  console.log(`[INFO] Uploading ${files.length} file(s)...`);
  const client = getClient();
  for (const file of files) {
    await client.send(new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: `downloads/${file}`,
      Body: fs.createReadStream(path.join(dir, file)),
    }));
  }
  console.log('[INFO] CSVs uploaded.');
}

async function main() {
  if (!CMD || !['restore', 'upload-profile', 'upload-csv'].includes(CMD)) {
    console.error('Usage: npx ts-node scripts/r2.ts <restore|upload-profile|upload-csv>');
    process.exit(1);
  }
  if (!R2_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    console.log('[INFO] R2 not configured, skipping.');
    return;
  }
  if (CMD === 'restore') await restore();
  else if (CMD === 'upload-profile') await uploadProfile();
  else await uploadCsv();
}

main().catch((err) => {
  console.warn('[WARN] R2 operation failed:', err instanceof Error ? err.message : err);
  process.exit(0);
});
