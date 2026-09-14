// R2アクセス層。
//   LOCAL_OUT=<dir> なら ローカルFS（dry-run/検証用・認証不要）。
//   それ以外は R2 の S3互換API（GitHub Actions 本番）。大量書込でもプロセス起動が無く高速。
// 必要env(本番): R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET(任意)
import { promises as fs } from "node:fs";
import path from "node:path";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";

const LOCAL_OUT = process.env.LOCAL_OUT;
const BUCKET = process.env.R2_BUCKET || "vwap-data";

let s3: S3Client | null = null;
function client(): S3Client {
  if (!s3) {
    s3 = new S3Client({
      region: "auto",
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID || "",
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || "",
      },
    });
  }
  return s3;
}

export async function r2Put(key: string, body: string): Promise<void> {
  if (LOCAL_OUT) {
    const p = path.join(LOCAL_OUT, key);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, body);
    return;
  }
  await client().send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: "application/json" }));
}

export async function r2Get(key: string): Promise<string | null> {
  if (LOCAL_OUT) {
    try { return await fs.readFile(path.join(LOCAL_OUT, key), "utf8"); } catch { return null; }
  }
  try {
    const r = await client().send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    return await (r.Body as any).transformToString();
  } catch (e: any) {
    if (e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
}

// 簡易スロットル付き並列実行（Yahooレート制限対策）
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 指数バックオフ付きリトライ（一過性エラー用）。
// レート制限 (YahooRateLimitError = 429/503) は即リトライで叩き返さず再スローし、
// 呼び出し側 (ingest) がサーキットブレークで全体を中断する。Retry-After 無視の
// 短時間リトライがブロックを延長していたため (低負荷化)。
export async function retry<T>(fn: () => Promise<T>, n = 3, base = 1000): Promise<T> {
  let last: unknown;
  for (let i = 0; i < n; i++) {
    try { return await fn(); }
    catch (e) {
      last = e;
      if ((e as { name?: string })?.name === "YahooRateLimitError") throw e;
      // Yahoo 404 (上場廃止・コード変更) は待っても直らないので即 throw (L-57)。
      // 形状は services/vwap-analysis/lib/yahoo.ts の `yahoo ${status}`。
      if (/^yahoo 404\b/.test((e as Error)?.message ?? "")) throw e;
      await sleep(base * Math.pow(2, i));
    }
  }
  throw last;
}
