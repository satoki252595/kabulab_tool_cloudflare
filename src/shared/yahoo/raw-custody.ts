/** Yahooの同一応答原文を固定サイズのgzipにまとめ、Notion物理照合後だけ保存を許す。 */
import { recordPrimaryData, verifyArchivedAttachments } from "../notion-archive/index.js";
import { sha256HexBytes } from "../sha256.js";
import { MAX_YAHOO_RAW_BYTES, redactYahooDiagnostic, type YahooRawCapture } from "./client.js";
import { readFileSync } from "node:fs";
import { writeSummaryLocal } from "../../../scripts/vwap/lib/ingest-guard.js";

export interface YahooRawAttempt { api: string; attempt: number; capture: YahooRawCapture }
export interface YahooRawMissing { api: string; symbol: string; attempt: number; error: string; failedAt: string }
export interface YahooRawBatchInput {
  service: "stock-sync" | "vwap-analysis";
  runId: string;
  stage: string;
  expectedDate?: string;
  captures: readonly YahooRawAttempt[];
  missing?: readonly YahooRawMissing[];
}

interface RawMember {
  api: string; symbol: string; attempt: number; status: number; receivedAt: string;
  url: string; headers: YahooRawCapture["headers"]; byteLength: number; sha256: string; bodyBase64: string;
}
const SINGLE_PART_CAP = 20 * 1024 * 1024;
const NAME_RE = /^[A-Za-z0-9._-]+$/;
export const YAHOO_RAW_LOCAL_DIR = ".yahoo-raw-custody";
function actualClock(value: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error("Yahoo原本の実取得clockがありません");
}
function attemptKey(api: string, symbol: string, attempt: number): string {
  if (!NAME_RE.test(api) || symbol.length === 0 || !Number.isSafeInteger(attempt) || attempt < 0) {
    throw new Error("Yahoo原本のAPI/銘柄/attemptが不正です");
  }
  return `${api}\0${symbol}\0${attempt}`;
}
function toBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 8192) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
  return btoa(chunks.join(""));
}
function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}
async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const body = new Blob([Uint8Array.from(bytes)]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(body).arrayBuffer());
}

/** 取得なしは呼ばない。transport失敗だけならmissingを実診断として保管する。 */
export async function archiveYahooRawBatch(input: YahooRawBatchInput): Promise<{
  pages: string[]; rawBytes: number; compressedBytes: number;
}> {
  if (!NAME_RE.test(input.runId) || !NAME_RE.test(input.stage)) throw new Error("Yahoo原本のrun/stageが不正です");
  const missing = input.missing === undefined ? [] : input.missing.map((item) => ({
    ...item, error: redactYahooDiagnostic(item.error),
  }));
  if (input.captures.length === 0 && missing.length === 0) throw new Error("Yahoo原本attemptが空です (取得なし)");
  const keys = new Set<string>();
  const captures = input.captures.map((item) => {
    const key = attemptKey(item.api, item.capture.symbol, item.attempt);
    if (keys.has(key)) throw new Error("Yahoo原本attemptが重複しています");
    keys.add(key);
    actualClock(item.capture.receivedAt);
    if (!(item.capture.bytes instanceof Uint8Array) || item.capture.bytes.length > MAX_YAHOO_RAW_BYTES) {
      throw new Error("Yahoo単一原本の8MiB上限超過またはbytes不明のためSTOP");
    }
    if (!Number.isSafeInteger(item.capture.status) || item.capture.status < 100 || item.capture.status > 599) {
      throw new Error("Yahoo原本HTTP statusが不正です");
    }
    return { ...item, capture: { ...item.capture, bytes: new Uint8Array(item.capture.bytes) } };
  });
  for (const item of missing) {
    const key = attemptKey(item.api, item.symbol, item.attempt);
    if (keys.has(key)) throw new Error("Yahoo原本と未取得attemptが重複しています");
    keys.add(key);
    actualClock(item.failedAt);
    if (item.error.trim() === "") throw new Error("Yahoo未取得理由がありません");
  }
  const chunks: typeof captures[] = [];
  let chunk: typeof captures = [];
  let size = 0;
  for (const item of captures) {
    if (size + item.capture.bytes.length > MAX_YAHOO_RAW_BYTES && chunk.length > 0) {
      chunks.push(chunk); chunk = []; size = 0;
    }
    chunk.push(item); size += item.capture.bytes.length;
  }
  if (chunk.length > 0 || chunks.length === 0) chunks.push(chunk);
  const pages: string[] = [];
  let rawBytes = 0, compressedBytes = 0;
  const prepared: Array<{ key: string; filename: string; path: string; sha256: string;
    fetchedAt: string; metadata: Record<string, unknown> }> = [];
  for (const [index, part] of chunks.entries()) {
    const members: RawMember[] = [];
    for (const item of part) {
      const c = item.capture;
      const headers: YahooRawCapture["headers"] = {};
      if (c.headers.contentType !== undefined) headers.contentType = c.headers.contentType;
      if (c.headers.upstreamStatus !== undefined) headers.upstreamStatus = c.headers.upstreamStatus;
      if (c.headers.retryAfter !== undefined) headers.retryAfter = c.headers.retryAfter;
      members.push({ api: item.api, attempt: item.attempt, symbol: c.symbol,
        status: c.status, receivedAt: c.receivedAt, url: redactYahooDiagnostic(c.url), headers,
        byteLength: c.bytes.length, sha256: await sha256HexBytes(c.bytes), bodyBase64: toBase64(c.bytes) });
      rawBytes += c.bytes.length;
    }
    const partMissing = index === 0 ? missing : [];
    const wrapper = { version: 1, service: input.service, runId: input.runId, stage: input.stage,
      expectedDate: input.expectedDate, part: index, parts: chunks.length, members, missing: partMissing };
    const bytes = await gzip(new TextEncoder().encode(JSON.stringify(wrapper)));
    if (bytes.length > SINGLE_PART_CAP) throw new Error("Yahoo gzipが20MiB上限を超過したためSTOP");
    // gzipを一度展開し、内部の全memberを原文SHAへ照合してからNotionへ送る。
    const unzipped = new Blob([Uint8Array.from(bytes)]).stream().pipeThrough(new DecompressionStream("gzip"));
    const replay = JSON.parse(await new Response(unzipped).text()) as typeof wrapper;
    if (replay.members.length !== members.length) throw new Error("Yahoo gzipのmember件数不一致");
    for (const [i, member] of replay.members.entries()) {
      const original = members[i];
      const decoded = fromBase64(member.bodyBase64);
      if (member.api !== original.api || member.symbol !== original.symbol || member.attempt !== original.attempt ||
          decoded.length !== original.byteLength || await sha256HexBytes(Uint8Array.from(decoded)) !== original.sha256) {
        throw new Error("Yahoo gzipの内部原文照合不一致");
      }
    }
    const key = `yahoo-raw-${input.runId}-${input.stage}-part-${index}`;
    const filename = `${key}.json.gz`;
    const clocks = [...members.map((m) => m.receivedAt), ...partMissing.map((m) => m.failedAt)].sort();
    const fetchedAt = clocks.at(-1);
    if (fetchedAt === undefined) throw new Error("Yahoo原本batchの実clockが空です");
    const metadata = { runId: input.runId, stage: input.stage, expectedDate: input.expectedDate,
        part: index, parts: chunks.length, captures: members.length, missing: partMissing.length,
        rawBytes: part.reduce((sum, item) => sum + item.capture.bytes.length, 0), compressedBytes: bytes.length };
    const local = writeSummaryLocal({ key, files: [{ filename, bytes, contentType: "application/gzip" }] }, YAHOO_RAW_LOCAL_DIR);
    if (!local.ok) throw new Error(`Yahoo原本のprivate local保存失敗 (${local.reason})。Notion送信前STOP`);
    prepared.push({ key, filename, path: local.path, sha256: await sha256HexBytes(Uint8Array.from(bytes)), fetchedAt, metadata });
    compressedBytes += bytes.length;
  }
  // 全partsを0700/wx0600/fsyncで先に残す。後半POSTがunknownでも原本を再取得・再送しない。
  // CI runnerのlocal diskはjob終了後の永続回収を保証しない (公開artifactへは出さない)。
  for (const part of prepared) {
    const bytes = Uint8Array.from(readFileSync(part.path));
    if (await sha256HexBytes(bytes) !== part.sha256) throw new Error("Yahoo原本のprivate local bytes不一致。STOP");
    const result = await recordPrimaryData({ service: input.service, key: part.key,
      source: "Yahoo final response bytes (same fetch; gzip lossless)", fetchedAt: part.fetchedAt,
      metadata: part.metadata, files: [{ filename: part.filename, bytes, contentType: "application/gzip" }], force: false });
    if (result.outcome !== "recorded" || result.fileTooLarge) {
      throw new Error("Yahoo原本の物理保管が新規確定しません。再送せずSTOP");
    }
    await verifyArchivedAttachments(result.pageId, [{ filename: part.filename, bytes }], "Yahoo原本batch");
    pages.push(result.pageId);
  }
  return { pages, rawBytes, compressedBytes };
}
