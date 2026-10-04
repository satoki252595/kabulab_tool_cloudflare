// R2アクセス層。
//   LOCAL_OUT=<dir> なら ローカルFS（dry-run/検証用・認証不要）。
//   それ以外は R2 の S3互換API（GitHub Actions 本番）。大量書込でもプロセス起動が無く高速。
// 必要env(本番): R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET(任意)
import { promises as fs } from "node:fs";
import path from "node:path";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { sharedEnv } from "../../../src/shared/env.js";
import { createHash } from "node:crypto";

const LOCAL_OUT = sharedEnv.LOCAL_OUT();

let s3: S3Client | null = null;
function client(): S3Client {
  if (!s3) {
    s3 = new S3Client({
      region: "auto",
      // SDK 内部 retry を止める。read の既知一過性障害だけ下記の明示3試行。
      // 呼び出し側の retry() 包みも禁止 (mutation)。
      maxAttempts: 1,
      endpoint: `https://${sharedEnv.R2_ACCOUNT_ID()}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: sharedEnv.R2_ACCESS_KEY_ID(),
        secretAccessKey: sharedEnv.R2_SECRET_ACCESS_KEY(),
      },
    });
  }
  return s3;
}

/**
 * R2 PUT が明示拒否された (適用なし確定。例: 412 PreconditionFailed)。
 * 呼び出し側は rejected を正直計数し、新規送信を止めて fatal 終了する。
 */
export class R2PutRejectedError extends Error {
  constructor(key: string, code: string, status: number | "none", cause: unknown) {
    super(`R2 PUT 拒否 (適用なし確定。再送なし): ${key} cause=${code}/${status}`, { cause });
    this.name = "R2PutRejectedError";
  }
}

/**
 * R2 PUT の結果が確定しなかった (応答なし/5xx/timeout/応答 schema 不正等)。
 * 適用有無不明のため呼び出し側は新規送信を止め、既知 inflight を正直計数して
 * summary 保管後に fatal 終了する。再送しない。
 */
export class R2PutUnknownError extends Error {
  constructor(key: string, code: string, status: number | "none", cause: unknown) {
    super(`R2 PUT 結果不明 (適用有無が確定しません。再送なし): ${key} cause=${code}/${status}`, { cause });
    this.name = "R2PutUnknownError";
  }
}

/** 生 cause から sanitized (code/status) のみ抜く。URL/秘密は文面に出さない。 */
function r2CauseOf(e: unknown): { code: string; status: number | "none" } {
  const err = e as { name?: unknown; $metadata?: { httpStatusCode?: unknown } } | null;
  const code = typeof err?.name === "string" && err.name.length > 0 ? err.name : "unknown";
  const raw = err?.$metadata?.httpStatusCode;
  const status = typeof raw === "number" && Number.isFinite(raw) ? raw : "none";
  return { code, status };
}

/**
 * 明示拒否 (適用なし確定) の判定。412 前提失敗と retry 不能な確定 4xx のみ。
 * 408/429 (retryable)・5xx・status なしは適用有無が曖昧なため unknown。
 */
function isExplicitRejection(code: string, status: number | "none"): boolean {
  if (code === "PreconditionFailed" || status === 412) return true;
  if (status === "none") return false;
  if (status === 408 || status === 429) return false;
  return status >= 400 && status < 500;
}

/**
 * R2 へ 1 試行だけ PUT する (SDK 内部 retry なし。呼び出し側の retry() 包み禁止)。
 * 成功契約: 2xx + nonempty ETag。満たさない応答・例外は
 * R2PutRejectedError (明示拒否) か R2PutUnknownError (結果不明) のいずれかで
 * throw する。どちらも呼び出し側は新規送信を止めて fatal 終了する。
 * observedVersion は同じ object の GET で得た不透明 ETag。明示 NoSuchKey
 * の null は IfNoneMatch:* で作成する。取得後の競合は 412 で停止する。
 */
export async function r2Put(key: string, body: string, observedVersion: string | null): Promise<void> {
  if (observedVersion !== null && (typeof observedVersion !== "string" || observedVersion.trim().length === 0 || observedVersion.trim() === "*")) {
    throw new Error("R2 write requires an observed ETag or explicit missing-object null");
  }
  if (LOCAL_OUT) {
    // Local output is a preview, never evidence of the remote server's CAS guarantee.
    const p = path.join(LOCAL_OUT, key);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, body);
    return;
  }
  let res: unknown;
  try {
    res = await client().send(new PutObjectCommand({ Bucket: sharedEnv.R2_BUCKET(), Key: key, Body: body, ContentType: "application/json",
      ...(observedVersion === null ? { IfNoneMatch: "*" } : { IfMatch: observedVersion }),
    }));
  } catch (e) {
    const { code, status } = r2CauseOf(e);
    if (isExplicitRejection(code, status)) throw new R2PutRejectedError(key, code, status, e);
    throw new R2PutUnknownError(key, code, status, e);
  }
  const r = res as { ETag?: unknown; $metadata?: { httpStatusCode?: unknown } } | null;
  const status = r?.$metadata?.httpStatusCode;
  const etag = r?.ETag;
  const statusOk = typeof status === "number" && Number.isFinite(status) && status >= 200 && status < 300;
  const etagOk = typeof etag === "string" && etag.length > 0;
  if (!statusOk || !etagOk) {
    // 成功 schema を満たさない応答は結果不明 (known 失敗にしない)。
    throw new R2PutUnknownError(key, "bad-response", statusOk ? (status as number) : "none", {
      statusType: typeof status,
      hasETag: etagOk,
    });
  }
}

export async function r2Get(key: string): Promise<string | null> {
  const result = await r2GetVersion(key);
  return result === null ? null : result.body;
}

export async function r2GetVersion(key: string): Promise<{ body: string; etag: string } | null> {
  if (LOCAL_OUT) {
    try {
      const body = await fs.readFile(path.join(LOCAL_OUT, key), "utf8");
      return { body, etag: createHash("sha256").update(body).digest("hex") };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }
  // 正常 bootstrap は明示 NoSuchKey + service 404 のみ。汎用 404
  // (bucket/endpoint 誤り等)・矛盾メタは missing-object の証明に
  // ならないため fault として throw する。
  // 成功 envelope は strict 200 + body + nonempty ETag を要求する。
  try {
    // GET は mutation と異なり再読しても適用結果が曖昧にならない。
    // nativeな既知5xx familyだけ既存backoffへ接続し、認可/404/未知schemaは即STOP。
    const r = await retry(() => client().send(new GetObjectCommand({ Bucket: sharedEnv.R2_BUCKET(), Key: key })),
      3, 1000, (e) => {
        const { code, status } = r2CauseOf(e);
        return ["InternalError", "InternalServerError", "ServiceUnavailable", "SlowDown"].includes(code) &&
          [500, 502, 503, 504].includes(status as number);
      });
    const status = (r as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode;
    const etag = r.ETag;
    if (status !== 200 || !r.Body || typeof etag !== "string" || etag.length === 0) {
      throw new Error(`R2 GET 応答が不完全です: ${key}`);
    }
    return { body: await r.Body.transformToString(), etag };
  } catch (e) {
    const err = e as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
    if (err?.name === "NoSuchKey" && err?.$metadata?.httpStatusCode === 404) return null;
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
export async function retry<T>(fn: () => Promise<T>, n = 3, base = 1000, shouldRetry?: (error: unknown) => boolean): Promise<T> {
  let last: unknown;
  for (let i = 0; i < n; i++) {
    try { return await fn(); }
    catch (e) {
      last = e;
      // callerがrun-level STOPを検知した後は、残り試行へ進まない。
      if (shouldRetry !== undefined && !shouldRetry(e)) throw e;
      if ((e as { name?: string })?.name === "YahooRateLimitError") throw e;
      // Yahoo 404 (上場廃止・コード変更) は待っても直らないので即 throw (L-57)。
      // 形状は src/shared/yahoo/client.ts の `yahoo ${status}`。
      if (/^yahoo 404\b/.test((e as Error)?.message ?? "")) throw e;
      await sleep(base * Math.pow(2, i));
    }
  }
  throw last;
}
