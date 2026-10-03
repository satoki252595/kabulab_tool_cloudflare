/**
 * EDINET API v2 クライアント。
 *
 * - 書類一覧 API:  GET /documents.json?date=YYYY-MM-DD&type=2&Subscription-Key
 * - 書類取得 API:  GET /documents/{docID}?type=N&Subscription-Key
 *     type=1: 提出本文書 (XBRL) ZIP / type=5: CSV ZIP
 *
 * 設計方針 (CLAUDE.md):
 *   - ルール2: HTTP 非 2xx・API status≠200・schema 不一致は throw。
 *     取得失敗を空配列やデフォルト値で握りつぶさない。404 は専用エラーで
 *     呼び出し側に判断を委ねる (型で「未取得」を表現)。
 *   - ルール3: API キーは yuhoEnv 経由でのみ取得 (process.env 直参照しない)。
 */
import { yuhoEnv } from "../../env.js";
import { gzipSync } from "node:zlib";
import { recordPrimaryData, verifyArchivedAttachments } from "../../../../../src/shared/notion-archive/index.js";
import { sha256HexBytes } from "../../../../../src/shared/sha256.js";
import {
  edinetListResponseSchema,
  type EdinetListResponse,
} from "./types.js";

const API_BASE = "https://api.edinet-fsa.go.jp/api/v2";

/**
 * 1 要求あたりの待機上限。一覧は小さな JSON のため外部 fetch の社内先例
 * (15s。`src/shared/notion-archive/dataset.ts` 等) と同水準。
 */
export const EDINET_LIST_TIMEOUT_MS = 15_000;
/**
 * 1 要求あたりの待機上限 (書類取得)。実測 3602 件の XBRL ZIP は最大 5.1MB・
 * 中央値 671KB のため、100KB/s の低速線でも最大級が収まる 60s とする。
 * 同時に Worker 取込予算 300s (`src/cron/yuho-edinet.ts` TIME_BUDGET_MS) の
 * 1/5・トリガ予算 600s (#134) の 1/10 であり、1 件の停滞が実行全体の
 * 打ち切りを無力化しない (#98: 2026-09-28 の定期実行は 15 件を ~20s/件で
 * 進めた後に 5 分超停滞し、トリガの 600s 期限切れで失敗した。予算検査は
 * await 間でしか発火しないため、fetch 自体に期限が要る)。
 * 次回再開は呼び出し側の保存済み進捗 + docId 冪等に委ね、ここではしない
 * (単発 GET に副作用は無く、次回実行が未完了分を拾う)。
 */
export const EDINET_DOWNLOAD_TIMEOUT_MS = 60_000;

export interface EdinetRequestOpts {
  /** 要求全体の期限ms (既定は用途別の定数)。テストは短縮可 (#134 の postCatchup と同形)。 */
  timeoutMs?: number;
}

/** 源GETの既知失敗。受信済み失敗原文がある場合は全文物理保管後だけ返す。 */
export class EdinetDocumentFetchError extends Error {
  constructor(public readonly docId: string, public readonly docType: number,
    message: string, options?: ErrorOptions) {super(message, options); this.name = "EdinetDocumentFetchError";}
}
/** 失敗原文の物理保管が未確定。sourceだけの失敗と混同して再送しない。 */
export class EdinetDocumentArchiveError extends Error {
  constructor(options: ErrorOptions) {super("EDINET失敗原応答の保管未完 (再送なし)", options); this.name = "EdinetDocumentArchiveError";}
}
/** EDINET が当該書類タイプを保持していない (404) ことを表す型付きエラー */
export class EdinetNotFoundError extends EdinetDocumentFetchError {
  constructor(
    docId: string,
    docType: number
  ) {
    super(docId, docType, `EDINET 書類が存在しません docID=${docId} type=${docType}`);
    this.name = "EdinetNotFoundError";
  }
}

function withKey(url: URL): URL {
  url.searchParams.set("Subscription-Key", yuhoEnv.EDINET_API_KEY());
  return url;
}

/**
 * 指定日 (JST, YYYY-MM-DD) に提出された全書類のメタデータ一覧を取得。
 * その日に提出が無い場合は results が空配列 (これは欠損ではなく事実)。
 */
export async function listDocuments(
  date: string,
  opts: EdinetRequestOpts = {}
): Promise<EdinetListResponse> {
  const observation = await observeDocuments(date, opts);
  if (observation.httpStatus !== 200) throw new Error(`EDINET 書類一覧 HTTP status=${observation.httpStatus} date=${date}`);
  const parsed = edinetListResponseSchema.parse(JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(observation.bytes)));
  if (parsed.metadata.status !== "200" || parsed.metadata.resultset.count !== parsed.results.length) {
    throw new Error(`EDINET 書類一覧のAPI status/件数が不一致 date=${date}`);
  }
  return parsed;
}

export interface EdinetListObservation {
  date: string;
  fetchedAt: string;
  bytes: Uint8Array<ArrayBuffer>;
  httpStatus: number;
}

/** 副作用のない一覧GETが完了しなかった。取得済bytesは存在せず、同run再送禁止。 */
export class EdinetListFetchError extends Error {
  constructor(message: string, options?: ErrorOptions) {super(message, options); this.name = "EdinetListFetchError";}
}

/** 成功・失敗HTTPとも型付け前の本文全bytes/状態/受信時計を保持。APIキーは返さない。 */
export async function observeDocuments(
  date: string,
  opts: EdinetRequestOpts = {}
): Promise<EdinetListObservation> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`listDocuments: 日付形式が不正です: ${date}`);
  }
  const url = withKey(new URL(`${API_BASE}/documents.json`));
  url.searchParams.set("date", date);
  url.searchParams.set("type", "2"); // メタデータ + 提出書類一覧

  const timeoutMs = opts.timeoutMs ?? EDINET_LIST_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);
  const timeoutMessage = `EDINET 書類一覧 API タイムアウト date=${date} timeoutMs=${timeoutMs}`;
  let res: Response;
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    res = await fetch(url, {headers: {Accept: "application/json"}, signal, redirect: "manual"});
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    throw new EdinetListFetchError(signal.aborted ? timeoutMessage
      : `EDINET 書類一覧 GET未完 date=${date} (同run再送なし)`, {cause: e});
  }
  return {date, fetchedAt: new Date().toISOString(), bytes, httpStatus: res.status};
}

/**
 * 書類取得 API から ZIP バイト列を取得する。
 * @param docType 1=XBRL ZIP, 5=CSV ZIP
 * @throws EdinetNotFoundError 404 (当該タイプ未提供)
 */
export async function downloadDocument(
  docId: string,
  docType: 1 | 5,
  opts: EdinetRequestOpts = {}
): Promise<Buffer> {
  if (!/^S[0-9A-Z]+$/.test(docId)) {
    throw new Error(`downloadDocument: docID 形式が不正です: ${docId}`);
  }
  const url = withKey(new URL(`${API_BASE}/documents/${docId}`));
  url.searchParams.set("type", String(docType));

  const timeoutMs = opts.timeoutMs ?? EDINET_DOWNLOAD_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);
  const timeoutMessage = `EDINET 書類取得 API タイムアウト docID=${docId} type=${docType} timeoutMs=${timeoutMs}`;
  let res: Response;
  let raw: ArrayBuffer;
  try {
    res = await fetch(url, { signal, redirect: "manual" });
    raw = await res.arrayBuffer();
  } catch (e) {
    throw new EdinetDocumentFetchError(docId, docType, signal.aborted ? timeoutMessage
      : `EDINET 書類GET未完 docID=${docId} type=${docType} (同run再送なし)`, {cause: e});
  }
  const buf = Buffer.from(raw);
  const ct = res.headers.get("content-type");
  if (!res.ok || ct?.includes("application/json") || buf.length === 0) {
    const fetchedAt = new Date().toISOString();
    const rawSha256 = await sha256HexBytes(buf);
    const filename = `${docId}-type${docType}-failed-http.response.bin.gz`;
    const file = {filename, bytes: new Uint8Array(gzipSync(buf)), contentType: "application/gzip"};
    // 非ZIPの失敗本文をZIPと偽らず、全caller共通で型エラーより前に実体保管する。
    try {
      const saved = await recordPrimaryData({service: "yuho-quant",
        key: `${docId}:type${docType}:failed-http:${fetchedAt}:${rawSha256}`,
        source: `EDINET API v2 /documents/${docId}?type=${docType} (失敗HTTP原本文)`, fetchedAt,
        metadata: {docID: docId, edinetDocType: docType, httpStatus: res.status,
          sourceContentType: ct, rawBytes: buf.length, rawSha256}, files: [file], force: false});
      if (saved.fileTooLarge || saved.manifestMatch === "unknown") throw new Error("失敗原文保管未証明");
      await verifyArchivedAttachments(saved.pageId, [file], "EDINET失敗原応答");
    } catch (cause) {
      throw new EdinetDocumentArchiveError({cause});
    }
    if (res.status === 404) throw new EdinetNotFoundError(docId, docType);
    throw new EdinetDocumentFetchError(docId, docType,
      `EDINET 書類取得のHTTP/本文資格未成立 docID=${docId} type=${docType} status=${res.status} (原応答保管済み)`);
  }
  return buf;
}
