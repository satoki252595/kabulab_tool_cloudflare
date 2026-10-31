// R2アクセス層。
//   LOCAL_OUT=<dir> なら ローカルFS（dry-run/検証用・認証不要）。
//   それ以外は R2 の S3互換API（GitHub Actions 本番）。大量書込でもプロセス起動が無く高速。
// 必要env(本番): R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET(任意)
import { promises as fs } from "node:fs";
import path from "node:path";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { sharedEnv } from "../../../src/shared/env.js";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";

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

/** PUTのACKはunknownのまま、同じ価格POST状態を完全GETで確認した証拠。 */
export interface PricePutReadback {
  putAcknowledgement: "unknown";
  state: "exact-post-observed";
  checkedAt: string;
  etag: string;
  bodyBytes: number;
  bodySha256: string;
  metadataSha256: string;
  contentType: "application/json";
  complete: true;
}

/**
 * 価格CLIだけがPUTのcatchから明示使用する。PUT/再送は行わない。
 * 同processが送った全bytes/全metadata/形式だけを1回読む。旧値・不在・
 * 読取不明では元unknownを保持し、過去runのunknownをこの入口で解除しない。
 */
export async function confirmUnknownPricePut(error: unknown, key: string, body: string,
  metadata: Record<string, string> | undefined, assertActive: () => void, opts?: Pick<R2ReadOptions, "abortSignal">): Promise<PricePutReadback> {
  if (!(error instanceof R2PutUnknownError) || LOCAL_OUT !== undefined || !/^(?:daily|intra)\/[^/]+\.json$/.test(key)) throw error;
  const expected = Buffer.from(body, "utf8");
  // S3のcustom metadataなしは、応答のundefined/空bagを同じ空集合へ正規化する。
  const canonicalMetadata = (value: Record<string, string> | undefined): string =>
    JSON.stringify(value === undefined ? [] : Object.entries(value).sort(([a], [b]) => a < b ? -1 : 1));
  let readAttempted = false;
  let readFinished = false;
  try {
    assertActive();
    if (expected.length === 0) throw error;
    const timeout = AbortSignal.timeout(30_000);
    readAttempted = true;
    const current = await r2GetBytesVersion(key, sharedEnv.R2_BUCKET(), { singleAttempt: true,
      maxBytes: expected.length, abortSignal: opts?.abortSignal === undefined ? timeout : AbortSignal.any([timeout, opts.abortSignal]), beforeAttempt: assertActive });
    readFinished = true;
    try { logUnknownPriceReadback(key, expected, current); } catch { /* 計測だけ。一致判定には使わない。 */ }
    assertActive();
    if (current === null || !expected.equals(current.body) || current.contentType !== "application/json" ||
        canonicalMetadata(current.metadata) !== canonicalMetadata(metadata)) throw error;
    return { putAcknowledgement: "unknown", state: "exact-post-observed", checkedAt: new Date().toISOString(),
      etag: current.etag, bodyBytes: current.body.length, bodySha256: createHash("sha256").update(current.body).digest("hex"),
      metadataSha256: createHash("sha256").update(canonicalMetadata(current.metadata)).digest("hex"),
      contentType: "application/json", complete: true };
  } catch (caught) {
    if (readAttempted && !readFinished && caught !== error) {
      try { logUnknownPriceReadbackError(key, caught); } catch { /* 計測だけ。元unknownは変えない。 */ }
    }
    throw error; // GET失敗や期限切れをPUT拒否/成功へ変えず、同じunknownを返す。
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

const R2_PUT_FAILURE_LOG = "[INC-20261013-kabulab_tool_cloudflare-vwap-r2-put-unknown]";

type PutOutcome = "ok" | "unknown" | "fail";
type PutCond = "IfMatch" | "IfNoneMatch";
type PutRecord = {
  seq: number;
  key: string;
  status: string;
  durMs: number;
  outcome: PutOutcome;
  startedMs: number;
  neighborEmitted: boolean;
};

const putRecords: PutRecord[] = [];
const unknownSeqs = new Map<string, number[]>();
let putSeq = 0;
let inflightPuts = 0;
let fatalNote: { site: string; reason: string } | undefined;

/** 1 run の計測を空にする。ingest の開始時とテストから呼ぶ。例外は出さない。 */
export function beginR2PutDiagRun(): void {
  try {
    putRecords.length = 0;
    unknownSeqs.clear();
    putSeq = 0;
    inflightPuts = 0;
    fatalNote = undefined;
  } catch {
    // 計測の初期化失敗は取込を止めない。
  }
}

/** 最初に fatal になった分岐だけ残す。例外は出さない。 */
export function noteR2PutFatal(site: string, reason: unknown): void {
  try {
    if (fatalNote !== undefined) return;
    const raw = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
    fatalNote = { site: logToken(site), reason: logToken(redactDiagnostic(raw).slice(0, 200)) };
  } catch {
    // 計測の記録失敗は fatal 代入を止めない。
  }
}

function takeUnknownSeq(key: string): number | "none" {
  const queue = unknownSeqs.get(key);
  if (queue === undefined || queue.length === 0) return "none";
  const seq = queue.shift();
  return seq === undefined ? "none" : seq;
}

function readCauseToken(error: unknown): string {
  if (error === null || typeof error !== "object" || !("cause" in error)) return "none";
  const cause = (error as { cause?: unknown }).cause;
  if (cause === undefined) return "none";
  if (typeof cause === "string") return cause.length > 0 ? cause : "none";
  return readExceptionName(cause);
}

function headerValue(response: { headers?: unknown } | null | undefined, headerName: string): string | undefined {
  if (response === null || response === undefined || typeof response !== "object") return undefined;
  const headers = response.headers;
  if (headers === null || typeof headers !== "object") return undefined;
  for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
    if (name.toLowerCase() === headerName && typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function pushId(parts: string[], name: string, value: string | undefined): void {
  if (value === undefined || value === "") return;
  parts.push(`${name}=${value === "<unreadable>" ? "<unreadable>" : logToken(value)}`);
}

/**
 * PUT 1件の計測1行。成功も不明も明示拒否もここだけ。分類・再送・投げる例外は変えない。
 * この関数から例外を出さない。
 */
function logR2PutMeasure(input: {
  seq: number;
  key: string;
  startedMs: number;
  endedMs: number;
  bytes: number;
  sha8: string;
  cond: PutCond;
  inflight: number;
  status: number | "none";
  source: unknown;
  signal: AbortSignal | undefined;
  outcome: PutOutcome;
}): void {
  try {
    const durMs = input.endedMs - input.startedMs;
    putRecords.push({
      seq: input.seq,
      key: input.key,
      status: String(input.status),
      durMs,
      outcome: input.outcome,
      startedMs: input.startedMs,
      neighborEmitted: false,
    });
    if (input.outcome === "unknown") {
      const queue = unknownSeqs.get(input.key) ?? [];
      queue.push(input.seq);
      unknownSeqs.set(input.key, queue);
    }
  } catch {
    // 集計の失敗は PUT の例外に影響させない。
  }
  try {
    const failure = input.outcome === "ok" ? undefined : input.source;
    const name = failure === undefined ? "none" : readOr("<unreadable>", () => readExceptionName(failure));
    const code = failure === undefined ? "none" : readOr("<unreadable>", () => readExceptionCode(failure));
    const cause = failure === undefined ? "none" : readOr("<unreadable>", () => readCauseToken(failure));
    const body = failure === undefined ? "none" : readOr("<unreadable>", () => readPutFailureBodyHead(failure));
    const requestId = readOr("<unreadable>", () => readRequestId(input.source) ?? "");
    const abort = input.signal?.aborted === true;
    const abortReason = abort ? readOr("<unreadable>", () => readExceptionName(input.signal?.reason)) : "none";
    const parts = [
      R2_PUT_FAILURE_LOG,
      "put",
      `seq=${input.seq}`,
      `key=${logToken(input.key)}`,
      `startMs=${input.startedMs}`,
      `endMs=${input.endedMs}`,
      `durMs=${input.endedMs - input.startedMs}`,
      `bytes=${input.bytes}`,
      `sha8=${logToken(input.sha8)}`,
      `cond=${input.cond}`,
      `inflight=${input.inflight}`,
      `status=${logToken(String(input.status))}`,
      `name=${logToken(name)}`,
      `code=${logToken(code)}`,
      `cause=${logToken(cause)}`,
      `abort=${abort ? "1" : "0"}`,
      `abortReason=${logToken(abortReason)}`,
      `attempts=${readAttempts(input.source)}`,
    ];
    pushId(parts, "requestId", requestId);
    pushId(parts, "extendedRequestId", readOr(undefined, () => readMetadataString(input.source, "extendedRequestId")));
    pushId(parts, "cfId", readOr(undefined, () => readCfId(input.source)));
    const httpStatusCode = readOr(undefined, () => readMetadataNumber(input.source, "httpStatusCode"));
    if (httpStatusCode !== undefined) parts.push(`httpStatusCode=${httpStatusCode}`);
    pushId(parts, "cfRay", readOr(undefined, () => headerValue(responseOf(input.source), "cf-ray")));
    pushId(parts, "amzRequestId", readOr(undefined, () => headerValue(responseOf(input.source), "x-amz-request-id")));
    parts.push(`body=${body.replace(/[\r\n\u2028\u2029]/g, " ")}`);
    console.error(parts.join(" "));
  } catch {
    // 計測行の出力失敗は PUT の例外に影響させない。
  }
  try { flushNeighborLines(false); } catch {
    // 前後要約の失敗は PUT の例外に影響させない。
  }
}

function responseOf(source: unknown): { headers?: unknown } | null | undefined {
  if (source === null || typeof source !== "object") return undefined;
  return (source as { $response?: { headers?: unknown } | null }).$response;
}

function readMetadataString(source: unknown, field: "extendedRequestId"): string | undefined {
  if (source === null || typeof source !== "object") return undefined;
  const metadata = (source as { $metadata?: { extendedRequestId?: unknown } | null }).$metadata;
  if (metadata === null || typeof metadata !== "object") return undefined;
  const value = metadata[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readMetadataNumber(source: unknown, field: "httpStatusCode" | "attempts"): number | undefined {
  if (source === null || typeof source !== "object") return undefined;
  const metadata = (source as { $metadata?: { httpStatusCode?: unknown; attempts?: unknown } | null }).$metadata;
  if (metadata === null || typeof metadata !== "object") return undefined;
  const value = metadata[field];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readAttempts(source: unknown): string {
  const attempts = readOr(undefined, () => readMetadataNumber(source, "attempts"));
  return attempts === undefined ? "none" : String(attempts);
}

function readCfId(source: unknown): string | undefined {
  if (source !== null && typeof source === "object") {
    const metadata = (source as { $metadata?: { cfId?: unknown } | null }).$metadata;
    if (metadata !== null && typeof metadata === "object" && typeof metadata.cfId === "string" && metadata.cfId.length > 0) {
      return metadata.cfId;
    }
  }
  return headerValue(responseOf(source), "cf-id");
}

function logUnknownPriceReadback(key: string, expected: Buffer, current: { body: Uint8Array; etag: string; lastModified?: string } | null): void {
  try {
    const seq = takeUnknownSeq(key);
    let sentSha8 = "none";
    let gotSha8 = "none";
    let shaMatch = "0";
    try {
      sentSha8 = createHash("sha256").update(expected).digest("hex").slice(0, 8);
      if (current !== null) {
        gotSha8 = createHash("sha256").update(current.body).digest("hex").slice(0, 8);
        shaMatch = expected.equals(current.body) ? "1" : "0";
      }
    } catch {
      shaMatch = "none";
    }
    console.error([
      R2_PUT_FAILURE_LOG,
      "confirm",
      `seq=${seq}`,
      `key=${logToken(key)}`,
      `present=${current === null ? "0" : "1"}`,
      `etag=${current === null ? "none" : logToken(current.etag)}`,
      `bytes=${current === null ? "none" : String(current.body.byteLength)}`,
      `lastModified=${current?.lastModified === undefined ? "none" : logToken(current.lastModified)}`,
      `shaMatch=${shaMatch}`,
      `sentSha8=${sentSha8}`,
      `gotSha8=${gotSha8}`,
    ].join(" "));
  } catch {
    // 読み戻しログの失敗は unknown の再送出に影響させない。
  }
}

function logUnknownPriceReadbackError(key: string, readError: unknown): void {
  try {
    console.error([
      R2_PUT_FAILURE_LOG,
      "confirm",
      `seq=${takeUnknownSeq(key)}`,
      `key=${logToken(key)}`,
      "present=none",
      "etag=none",
      "bytes=none",
      "lastModified=none",
      "shaMatch=none",
      "read=error",
      `name=${logToken(readOr("<unreadable>", () => readExceptionName(readError)))}`,
    ].join(" "));
  } catch {
    // 読み戻し失敗ログの失敗は unknown の再送出に影響させない。
  }
}

function neighborBrief(rec: PutRecord): string {
  return `${logToken(rec.key)}:${logToken(rec.status)}:${rec.durMs}`;
}

function flushNeighborLines(final: boolean): void {
  for (const [index, rec] of putRecords.entries()) {
    if (rec.outcome !== "unknown" || rec.neighborEmitted) continue;
    const afterCount = putRecords.length - index - 1;
    if (!final && afterCount < 5) continue;
    try {
      const before = putRecords.slice(Math.max(0, index - 5), index).map(neighborBrief);
      const after = putRecords.slice(index + 1, index + 6).map(neighborBrief);
      console.error([
        R2_PUT_FAILURE_LOG,
        "neighbors",
        `seq=${rec.seq}`,
        `key=${logToken(rec.key)}`,
        `before=${before.length === 0 ? "none" : before.join(";")}`,
        `after=${after.length === 0 ? "none" : after.join(";")}`,
      ].join(" "));
      rec.neighborEmitted = true;
    } catch {
      // この1行の失敗で残りの要約を落とさない。
    }
  }
}

function percentileNearestRank(sorted: number[], p: number): number {
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(sorted.length, Math.max(1, rank)) - 1;
  return sorted[idx]!;
}

function minuteKey(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}Z`;
}

function diagGithub(which: "GITHUB_SHA" | "GITHUB_RUN_ID"): string {
  try {
    const value = which === "GITHUB_SHA" ? sharedEnv.GITHUB_SHA() : sharedEnv.GITHUB_RUN_ID();
    if (value === undefined || value.trim() === "") return "none";
    return logToken(value);
  } catch {
    return "none";
  }
}

/** run 末の計測1行。fatal フラグは呼び出し側の値をそのまま書く。例外は出さない。 */
export function logR2PutRunSummary(fatal: boolean): void {
  try {
    flushNeighborLines(true);
    const total = putRecords.length;
    const ok = putRecords.filter((rec) => rec.outcome === "ok").length;
    const unknown = putRecords.filter((rec) => rec.outcome === "unknown").length;
    const fail = putRecords.filter((rec) => rec.outcome === "fail").length;
    const durs = putRecords.map((rec) => rec.durMs).sort((a, b) => a - b);
    const minutes = new Map<string, number>();
    for (const rec of putRecords) minutes.set(minuteKey(rec.startedMs), (minutes.get(minuteKey(rec.startedMs)) ?? 0) + 1);
    const perMinute = minutes.size === 0 ? "none" : [...minutes.entries()].sort(([a], [b]) => a < b ? -1 : 1).map(([key, count]) => `${key}=${count}`).join(",");
    console.error([
      R2_PUT_FAILURE_LOG,
      "summary",
      `total=${total}`,
      `ok=${ok}`,
      `unknown=${unknown}`,
      `fail=${fail}`,
      `p50=${durs.length === 0 ? "none" : String(percentileNearestRank(durs, 50))}`,
      `p95=${durs.length === 0 ? "none" : String(percentileNearestRank(durs, 95))}`,
      `max=${durs.length === 0 ? "none" : String(durs[durs.length - 1])}`,
      `perMinute=${perMinute}`,
      `fatal=${fatal ? "1" : "0"}`,
      `site=${fatal && fatalNote !== undefined ? fatalNote.site : "none"}`,
      `reason=${fatal && fatalNote !== undefined ? fatalNote.reason : "none"}`,
      `sha=${diagGithub("GITHUB_SHA")}`,
      `runId=${diagGithub("GITHUB_RUN_ID")}`,
    ].join(" "));
  } catch {
    // run 要約の失敗は終了コードに影響させない。
  }
}

function readOr<T>(fallback: T, read: () => T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

function readExceptionName(error: unknown): string {
  if (error === null || typeof error !== "object") return "none";
  const name = (error as { name?: unknown }).name;
  return typeof name === "string" && name.length > 0 ? name : "none";
}

/** Node の `code` と S3/R2 XML の `Code` は同じ例外の別綴り。無いときは none。name では埋めない。 */
function readExceptionCode(error: unknown): string {
  if (error === null || typeof error !== "object") return "none";
  const record = error as { code?: unknown; Code?: unknown };
  if (typeof record.code === "string" && record.code.length > 0) return record.code;
  if (typeof record.Code === "string" && record.Code.length > 0) return record.Code;
  return "none";
}

function readRequestId(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const record = error as {
    RequestId?: unknown;
    $metadata?: { requestId?: unknown; extendedRequestId?: unknown } | null;
    $response?: { headers?: unknown } | null;
  };
  const metadata = record.$metadata;
  if (metadata !== null && typeof metadata === "object") {
    if (typeof metadata.requestId === "string" && metadata.requestId.length > 0) return metadata.requestId;
    if (typeof metadata.extendedRequestId === "string" && metadata.extendedRequestId.length > 0) return metadata.extendedRequestId;
  }
  const header = requestIdHeader(record.$response);
  if (header !== undefined) return header;
  if (typeof record.RequestId === "string" && record.RequestId.length > 0) return record.RequestId;
  return undefined;
}

function requestIdHeader(response: { headers?: unknown } | null | undefined): string | undefined {
  if (response === null || response === undefined || typeof response !== "object") return undefined;
  const headers = response.headers;
  if (headers === null || typeof headers !== "object") return undefined;
  for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
    if (name.toLowerCase() === "x-amz-request-id" && typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function readPutFailureBodyHead(error: unknown): string {
  const read = readPutFailureBody(error);
  if (read.kind === "unreadable") return "<unreadable>";
  if (read.kind === "absent") return "<absent>";
  const collapsed = read.text.replace(/[\r\n\u2028\u2029]+/g, " ");
  const redacted = redactDiagnostic(collapsed.length > 8192 ? collapsed.slice(0, 8192) : collapsed);
  const head = Array.from(redacted).slice(0, 200).join("");
  return head.trim().length > 0 ? head : "<absent>";
}

/** `$response.body` → 例外の raw body → message。各読み取りの例外は次のソースへ進め、全部失敗したときだけ unreadable。 */
function readPutFailureBody(error: unknown): { kind: "text"; text: string } | { kind: "absent" } | { kind: "unreadable" } {
  if (error === null || typeof error !== "object") return { kind: "absent" };
  let unreadable = false;
  for (const read of [responseBodyText, rawBodyText, messageText]) {
    try {
      const text = read(error);
      if (text !== undefined && text.length > 0) return { kind: "text", text };
    } catch {
      unreadable = true;
    }
  }
  return unreadable ? { kind: "unreadable" } : { kind: "absent" };
}

function responseBodyText(error: object): string | undefined {
  const response = (error as { $response?: { body?: unknown } | null }).$response;
  if (response === null || typeof response !== "object") return undefined;
  return textOf(response.body);
}

function rawBodyText(error: object): string | undefined {
  return textOf((error as { body?: unknown }).body);
}

function messageText(error: object): string | undefined {
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && message.length > 0 ? message : undefined;
}

function textOf(value: unknown): string | undefined {
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  if (value instanceof Uint8Array) {
    if (value.byteLength === 0) return undefined;
    return new TextDecoder("utf-8", { fatal: false }).decode(value.subarray(0, 8192));
  }
  if (value instanceof ArrayBuffer) return textOf(new Uint8Array(value));
  return undefined;
}

/** 計測文面だけ。sanitizeLogText と同じ URL / secret= 除去に、認証ヘッダー・署名・アクセスキーを足す。 */
function redactDiagnostic(value: string): string {
  let out = value
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/secret\s*=\s*\S+/gi, "secret=<redacted>")
    .replace(/(?:authorization|x-amz-security-token|x-amz-credential|x-amz-signature|x-amz-algorithm)\s*[:=]\s*\S+/gi, "<redacted>")
    .replace(/X-Amz-(?:Signature|Credential|Security-Token|Algorithm)=[^&\s]+/gi, "<redacted>")
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "<redacted>");
  try {
    for (const secret of [sharedEnv.R2_ACCESS_KEY_ID(), sharedEnv.R2_SECRET_ACCESS_KEY()]) {
      if (secret.length >= 8) out = out.split(secret).join("<redacted>");
    }
  } catch {
    // 計測の秘匿置換だけ。鍵が読めなくても本文の残りは出す。
  }
  return out;
}

function logToken(value: string): string {
  const redacted = [...redactDiagnostic(value)].filter(char => !/\s/u.test(char) && char.codePointAt(0)! >= 32).join("");
  return redacted.length > 0 ? redacted : "none";
}

const R2_ABORT_LOG = "[INC-20261025-kabulab_tool_cloudflare-vwap-abort]";

/**
 * 要求ごと60秒と呼び出し側 signal（予算）のどちらが中断したかを1行残す。
 * 60秒・retry・投げる例外は変えない。この関数から例外を出さない。
 */
function logR2Abort(input: {
  key: string;
  error: unknown;
  phase: "ヘッダ受信前" | "本文読み取り中";
  timeout: AbortSignal;
  budget: AbortSignal | undefined;
  signal: AbortSignal;
  startedAt: number;
}): void {
  try {
    const timeoutAborted = input.timeout.aborted === true;
    const budgetAborted = input.budget?.aborted === true;
    const signalAborted = input.signal.aborted === true;
    if (!timeoutAborted && !budgetAborted && !signalAborted && readExceptionName(input.error) !== "AbortError") return;
    // 片方だけが aborted のときだけ帰属する。両方、またはどちらでもない AbortError は不明。
    let fired: "要求ごと60秒" | "予算" | "不明";
    if (timeoutAborted && !budgetAborted) fired = "要求ごと60秒";
    else if (budgetAborted && !timeoutAborted) fired = "予算";
    else fired = "不明";
    const reason = signalAborted ? input.signal.reason : undefined;
    const cause = input.error !== null && typeof input.error === "object" && "cause" in input.error
      ? (input.error as { cause?: unknown }).cause
      : undefined;
    const elapsedMs = Date.now() - input.startedAt;
    console.error([
      R2_ABORT_LOG,
      `signal=${logToken(fired)}`,
      `phase=${logToken(input.phase)}`,
      `reason=${logToken(readExceptionName(reason))}`,
      `cause=${logToken(readExceptionName(cause))}`,
      `elapsedMs=${elapsedMs}`,
      `key=${logToken(input.key)}`,
    ].join(" "));
  } catch {
    // 計測行の出力失敗は要求の例外に影響させない。
  }
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
export async function r2Put(key: string, body: string, observedVersion: string | null, metadata?: Record<string, string>, opts?: Pick<R2ReadOptions, "abortSignal" | "beforeAttempt">): Promise<void> {
  return r2PutBytes(key, new TextEncoder().encode(body), observedVersion, LOCAL_OUT ? undefined : sharedEnv.R2_BUCKET(), "application/json", metadata, opts);
}

/** 原本バイナリも同じ単発/CAS契約で保存する。bucketはcallerが明示する。 */
export async function r2PutBytes(key: string, body: Uint8Array, observedVersion: string | null, bucket: string | undefined, contentType: string, metadata?: Record<string, string>, opts?: Pick<R2ReadOptions, "abortSignal" | "beforeAttempt">): Promise<void> {
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
  if (opts?.beforeAttempt !== undefined) await opts.beforeAttempt();
  opts?.abortSignal?.throwIfAborted();
  const putTimeout = AbortSignal.timeout(60_000);
  const putSignal = opts?.abortSignal === undefined ? putTimeout : AbortSignal.any([opts.abortSignal, putTimeout]);
  const putStartedAt = Date.now();
  const cond: PutCond = observedVersion === null ? "IfNoneMatch" : "IfMatch";
  let sha8 = "none";
  try { sha8 = createHash("sha256").update(body).digest("hex").slice(0, 8); } catch { /* 計測だけ */ }
  let putSeqForLog = 0;
  let inflightForLog = 0;
  let putCounted = false;
  let endedMs = putStartedAt;
  try {
    inflightPuts += 1;
    putCounted = true;
    putSeqForLog = ++putSeq;
    inflightForLog = inflightPuts;
    res = await client().send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType,
      ...(observedVersion === null ? { IfNoneMatch: "*" } : { IfMatch: observedVersion }),
      ...(metadata === undefined ? {} : { Metadata: metadata }),
    }), { abortSignal: putSignal });
    endedMs = Date.now();
  } catch (e) {
    endedMs = Date.now();
    logR2Abort({ key, error: e, phase: "ヘッダ受信前", timeout: putTimeout, budget: opts?.abortSignal, signal: putSignal, startedAt: putStartedAt });
    const { code, status } = r2CauseOf(e);
    if (putCounted) {
      try {
        logR2PutMeasure({ seq: putSeqForLog, key, startedMs: putStartedAt, endedMs, bytes: body.byteLength, sha8, cond,
          inflight: inflightForLog, status, source: e, signal: putSignal, outcome: isExplicitRejection(code, status) ? "fail" : "unknown" });
      } catch { /* 計測だけ */ }
    }
    if (isExplicitRejection(code, status)) throw new R2PutRejectedError(key, code, status, e);
    throw new R2PutUnknownError(key, code, status, e);
  } finally {
    if (putCounted) inflightPuts -= 1;
  }
  const r = res as { ETag?: unknown; $metadata?: { httpStatusCode?: unknown } } | null;
  const status = r?.$metadata?.httpStatusCode;
  const etag = r?.ETag;
  const statusOk = typeof status === "number" && Number.isFinite(status) && status >= 200 && status < 300;
  const etagOk = typeof etag === "string" && etag.length > 0;
  const loggedStatus = typeof status === "number" && Number.isFinite(status) ? status : "none";
  if (!statusOk || !etagOk) {
    try {
      logR2PutMeasure({ seq: putSeqForLog, key, startedMs: putStartedAt, endedMs, bytes: body.byteLength, sha8, cond,
        inflight: inflightForLog, status: loggedStatus, source: res, signal: putSignal, outcome: "unknown" });
    } catch { /* 計測だけ */ }
    // 成功 schema を満たさない応答は結果不明 (known 失敗にしない)。
    throw new R2PutUnknownError(key, "bad-response", statusOk ? (status as number) : "none", {
      statusType: typeof status,
      hasETag: etagOk,
    });
  }
  try {
    logR2PutMeasure({ seq: putSeqForLog, key, startedMs: putStartedAt, endedMs, bytes: body.byteLength, sha8, cond,
      inflight: inflightForLog, status: loggedStatus, source: res, signal: putSignal, outcome: "ok" });
  } catch { /* 計測だけ */ }
}

export async function r2Get(key: string): Promise<string | null> {
  const result = await r2GetVersion(key);
  return result === null ? null : result.body;
}

export interface R2ReadOptions {
  singleAttempt?: boolean;
  maxBytes?: number;
  /** Callerの絶対期限。SDK headersとbody末尾に同じsignalを適用する。 */
  abortSignal?: AbortSignal;
  /** 各SDK send直前の予算予約。SDK内部retryは常に1試行。 */
  beforeAttempt?: () => void | Promise<void>;
  /** 200応答の全body、または失敗時のbounded prefix。complete=falseは成功ではない。 */
  onRead?: (read: { status: 200; etag: string; contentLength: number | undefined;
    body: Uint8Array; receivedBytes: number; complete: boolean }) => void | Promise<void>;
}
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
export async function r2GetBytesVersion(key: string, bucket: string | undefined, opts?: R2ReadOptions): Promise<{ body: Uint8Array; etag: string; metadata?: Record<string, string>; contentType?: string; lastModified?: string } | null> {
  if (opts?.maxBytes !== undefined && (!Number.isSafeInteger(opts.maxBytes) || opts.maxBytes < 1)) throw new Error("R2 read byte budget is invalid");
  if (opts?.onRead !== undefined && opts.maxBytes === undefined) throw new Error("R2 observed read requires a byte budget");
  opts?.abortSignal?.throwIfAborted();
  if (LOCAL_OUT) {
    if (opts?.beforeAttempt !== undefined || opts?.onRead !== undefined) throw new Error("R2 native read observation cannot use LOCAL_OUT");
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
  let abortDiag: { timeout: AbortSignal; signal: AbortSignal; startedAt: number; headersReceived: boolean } | undefined;
  try {
    // GET は mutation と異なり再読しても適用結果が曖昧にならない。
    // 既知5xx・名前解決失敗・自分のheader待機期限だけ既存backoffへ接続する。
    // caller期限・観測付きread・body不完全・認可/404/未知schemaは再読対象に広げない。
    let signal: AbortSignal;
    let attemptTimeout: AbortSignal | undefined;
    const attempt = async () => {
      attemptTimeout = undefined;
      abortDiag = undefined;
      opts?.abortSignal?.throwIfAborted();
      await opts?.beforeAttempt?.();
      opts?.abortSignal?.throwIfAborted();
      attemptTimeout = AbortSignal.timeout(60_000);
      signal = opts?.abortSignal === undefined ? attemptTimeout : AbortSignal.any([attemptTimeout, opts.abortSignal]);
      const diag = { timeout: attemptTimeout, signal, startedAt: Date.now(), headersReceived: false };
      abortDiag = diag;
      try {
        const response = await client().send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: signal });
        diag.headersReceived = true;
        return response;
      } catch (error) {
        logR2Abort({ key, error, phase: "ヘッダ受信前", timeout: diag.timeout, budget: opts?.abortSignal, signal: diag.signal, startedAt: diag.startedAt });
        throw error;
      }
    };
    const r = opts?.singleAttempt === true ? await attempt() : await retry(attempt, 3, 1000, (e) => {
        const { code, status } = r2CauseOf(e);
        const dns = e as { code?: unknown; syscall?: unknown } | null;
        // SDKのAbortErrorだけではcaller中断と区別できない。自分のtimeout reasonへ束縛する。
        const ownHeaderTimeout = e instanceof Error && e.name === "AbortError" && status === "none" &&
          opts?.onRead === undefined && attemptTimeout?.aborted === true &&
          e.cause === attemptTimeout.reason && opts?.abortSignal?.aborted !== true;
        return ownHeaderTimeout || (e instanceof Error && status === "none" && dns?.syscall === "getaddrinfo" &&
          ["ENOTFOUND", "EAI_AGAIN"].includes(dns.code as string)) ||
          (["InternalError", "InternalServerError", "ServiceUnavailable", "SlowDown"].includes(code) &&
          [500, 502, 503, 504].includes(status as number));
      });
    const status = (r as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode;
    const etag = r.ETag;
    if (status !== 200 || !r.Body || typeof etag !== "string" || etag.length === 0) {
      throw new Error(`R2 GET 応答が不完全です: ${key}`);
    }
    let body: Uint8Array;
    if (opts?.maxBytes !== undefined || opts?.abortSignal !== undefined) {
      const parts: Uint8Array[] = [];
      let receivedBytes = 0, preservedBytes = 0;
      const stream = r.Body;
      let onAbort: (() => void) | undefined;
      try {
        if (opts.maxBytes !== undefined && (!Number.isSafeInteger(r.ContentLength) || r.ContentLength! < 0 || r.ContentLength! > opts.maxBytes)) {
          throw new Error("R2 object length is unknown or exceeds read byte budget");
        }
        if (r.Metadata !== undefined) assertMetadata(r.Metadata);
        if (!(stream instanceof Readable)) throw new Error("R2 bounded read requires a native Node stream");
        const aborted = new Promise<never>((_resolve, reject) => {
          onAbort = () => { stream.destroy(); reject(signal.reason); };
          signal.addEventListener("abort", onAbort, { once: true });
        });
        signal!.throwIfAborted();
        await Promise.race([aborted, (async () => {
          for await (const chunk of stream) {
            if (!(chunk instanceof Uint8Array)) throw new Error("R2 body chunk is not bytes");
            receivedBytes += chunk.length;
            const available = opts.maxBytes === undefined ? chunk.length : Math.min(chunk.length, opts.maxBytes - preservedBytes);
            if (available > 0) { parts.push(Buffer.from(chunk.subarray(0, available))); preservedBytes += available; }
            if (opts.maxBytes !== undefined && receivedBytes > opts.maxBytes) throw new Error("R2 object exceeds read byte budget");
            signal!.throwIfAborted();
          }
          if (opts.maxBytes !== undefined && receivedBytes !== r.ContentLength) throw new Error("R2 object body length differs from ContentLength");
        })()]);
        signal!.throwIfAborted();
        body = Buffer.concat(parts, preservedBytes);
      } catch (error) {
        (stream as { destroy?: () => void }).destroy?.();
        await opts.onRead?.({ status: 200, etag, contentLength: r.ContentLength, body: Buffer.concat(parts, preservedBytes), receivedBytes, complete: false });
        throw error;
      } finally {
        if (onAbort !== undefined) signal!.removeEventListener("abort", onAbort);
      }
      await opts.onRead?.({ status: 200, etag, contentLength: r.ContentLength, body, receivedBytes, complete: true });
    } else {
      if (r.Metadata !== undefined) assertMetadata(r.Metadata);
      body = await r.Body.transformToByteArray();
    }
    let lastModified: string | undefined;
    try {
      const lm = (r as { LastModified?: unknown }).LastModified;
      if (lm instanceof Date && Number.isFinite(lm.getTime())) lastModified = lm.toISOString();
    } catch { /* 計測フィールドだけ。読めなくても GET の戻り値は変えない。 */ }
    return { body, etag, ...(r.Metadata === undefined ? {} : { metadata: r.Metadata }),
      ...(r.ContentType === undefined ? {} : { contentType: r.ContentType }),
      ...(lastModified === undefined ? {} : { lastModified }) };
  } catch (e) {
    // header中断はattempt内で記録済み。ここは本文読み取り中だけ（再試行の最終throwと二重に出さない）。
    if (abortDiag?.headersReceived === true) {
      logR2Abort({
        key,
        error: e,
        phase: "本文読み取り中",
        timeout: abortDiag.timeout,
        budget: opts?.abortSignal,
        signal: abortDiag.signal,
        startedAt: abortDiag.startedAt,
      });
    }
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
