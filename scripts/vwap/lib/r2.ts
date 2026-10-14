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
export async function r2Put(key: string, body: string, observedVersion: string | null, metadata?: Record<string, string>): Promise<void> {
  return r2PutBytes(key, new TextEncoder().encode(body), observedVersion, LOCAL_OUT ? undefined : sharedEnv.R2_BUCKET(), "application/json", metadata);
}

/** 原本バイナリも同じ単発/CAS契約で保存する。bucketはcallerが明示する。 */
export async function r2PutBytes(key: string, body: Uint8Array, observedVersion: string | null, bucket: string | undefined, contentType: string, metadata?: Record<string, string>): Promise<void> {
  if (!contentType.trim()) throw new Error("R2 content type must be explicit");
  if (observedVersion !== null && (typeof observedVersion !== "string" || observedVersion.trim().length === 0 || observedVersion.trim() === "*")) {
    throw new Error("R2 write requires an observed ETag or explicit missing-object null");
  }
  if (metadata !== undefined) assertMetadata(metadata);
  if (LOCAL_OUT) {
    // Local output is a preview, never evidence of the remote server's CAS guarantee.
    const p = path.join(LOCAL_OUT, key);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, body);
    // LOCAL_OUT is a preview, not evidence of remote atomic body+metadata/CAS semantics.
    if (metadata !== undefined) await fs.writeFile(`${p}.s3-metadata.json`, JSON.stringify(metadata));
    else await fs.rm(`${p}.s3-metadata.json`, { force: true });
    return;
  }
  if (typeof bucket !== "string" || !bucket.trim()) throw new Error("R2 bucket must be explicit");
  let res: unknown;
  try {
    res = await client().send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType,
      ...(observedVersion === null ? { IfNoneMatch: "*" } : { IfMatch: observedVersion }),
      ...(metadata === undefined ? {} : { Metadata: metadata }),
    }), { abortSignal: AbortSignal.timeout(60_000) });
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

export interface R2ReadOptions { singleAttempt?: boolean; maxBytes?: number }
export async function r2GetVersion(key: string, opts?: R2ReadOptions): Promise<{ body: string; etag: string; metadata?: Record<string, string> } | null> {
  const found = await r2GetBytesVersion(key, LOCAL_OUT ? undefined : sharedEnv.R2_BUCKET(), opts);
  return found === null ? null : { body: new TextDecoder().decode(found.body), etag: found.etag,
    ...(found.metadata === undefined ? {} : { metadata: found.metadata }) };
}

function assertMetadata(metadata: unknown): asserts metadata is Record<string, string> {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata) ||
      Object.entries(metadata).some(([key, value]) => !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(key) ||
        typeof value !== "string" || !/^[\x20-\x7e]*$/.test(value)) ||
      Object.entries(metadata).reduce((bytes, [key, value]) => bytes + key.length + (value as string).length, 0) > 2048) {
    throw new Error("R2 custom metadata contract is invalid");
  }
}

/** 原本をUTF-8へ変換せず全bytesで読む。missing/unknown契約はJSON経路と共通。 */
export async function r2GetBytesVersion(key: string, bucket: string | undefined, opts?: R2ReadOptions): Promise<{ body: Uint8Array; etag: string; metadata?: Record<string, string> } | null> {
  if (opts?.maxBytes !== undefined && (!Number.isSafeInteger(opts.maxBytes) || opts.maxBytes < 1)) throw new Error("R2 read byte budget is invalid");
  if (LOCAL_OUT) {
    try {
      const p = path.join(LOCAL_OUT, key);
      if (opts?.maxBytes !== undefined && (await fs.stat(p)).size > opts.maxBytes) throw new Error("R2 object exceeds read byte budget");
      const body = await fs.readFile(p);
      let metadata: Record<string, string> | undefined;
      try { const value: unknown = JSON.parse(await fs.readFile(`${path.join(LOCAL_OUT, key)}.s3-metadata.json`, "utf8")); assertMetadata(value); metadata = value; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      return { body, etag: createHash("sha256").update(body).digest("hex"), ...(metadata === undefined ? {} : { metadata }) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }
  if (typeof bucket !== "string" || !bucket.trim()) throw new Error("R2 bucket must be explicit");
  // 正常 bootstrap は明示 NoSuchKey + service 404 のみ。汎用 404
  // (bucket/endpoint 誤り等)・矛盾メタは missing-object の証明に
  // ならないため fault として throw する。
  // 成功 envelope は strict 200 + body + nonempty ETag を要求する。
  try {
    // GET は mutation と異なり再読しても適用結果が曖昧にならない。
    // nativeな既知5xx familyだけ既存backoffへ接続し、認可/404/未知schemaは即STOP。
    const r = await retry(() => client().send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: AbortSignal.timeout(60_000) }),
      opts?.singleAttempt === true ? 1 : 3, 1000, (e) => {
        const { code, status } = r2CauseOf(e);
        return ["InternalError", "InternalServerError", "ServiceUnavailable", "SlowDown"].includes(code) &&
          [500, 502, 503, 504].includes(status as number);
      });
    const status = (r as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode;
    const etag = r.ETag;
    if (status !== 200 || !r.Body || typeof etag !== "string" || etag.length === 0) {
      throw new Error(`R2 GET 応答が不完全です: ${key}`);
    }
    if (opts?.maxBytes !== undefined && (!Number.isSafeInteger(r.ContentLength) || r.ContentLength! < 0 || r.ContentLength! > opts.maxBytes)) {
      (r.Body as { destroy?: () => void }).destroy?.();
      throw new Error("R2 object length is unknown or exceeds read byte budget");
    }
    if (r.Metadata !== undefined) assertMetadata(r.Metadata);
    const body = await r.Body.transformToByteArray();
    if (opts?.maxBytes !== undefined && body.length > opts.maxBytes) throw new Error("R2 object exceeds read byte budget");
    return { body, etag, ...(r.Metadata === undefined ? {} : { metadata: r.Metadata }) };
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
