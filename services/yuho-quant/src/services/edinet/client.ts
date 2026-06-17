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
import {
  edinetListResponseSchema,
  type EdinetListResponse,
} from "./types.js";

const API_BASE = "https://api.edinet-fsa.go.jp/api/v2";

/** EDINET が当該書類タイプを保持していない (404) ことを表す型付きエラー */
export class EdinetNotFoundError extends Error {
  constructor(
    public readonly docId: string,
    public readonly docType: number
  ) {
    super(`EDINET 書類が存在しません docID=${docId} type=${docType}`);
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
  date: string
): Promise<EdinetListResponse> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`listDocuments: 日付形式が不正です: ${date}`);
  }
  const url = withKey(new URL(`${API_BASE}/documents.json`));
  url.searchParams.set("date", date);
  url.searchParams.set("type", "2"); // メタデータ + 提出書類一覧

  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(
      `EDINET 書類一覧 API エラー date=${date} status=${res.status} ${res.statusText}`
    );
  }
  const json: unknown = await res.json();
  const parsed = edinetListResponseSchema.parse(json);
  if (parsed.metadata.status !== "200") {
    throw new Error(
      `EDINET 書類一覧 API status=${parsed.metadata.status} message=${parsed.metadata.message} (date=${date})`
    );
  }
  return parsed;
}

/**
 * 書類取得 API から ZIP バイト列を取得する。
 * @param docType 1=XBRL ZIP, 5=CSV ZIP
 * @throws EdinetNotFoundError 404 (当該タイプ未提供)
 */
export async function downloadDocument(
  docId: string,
  docType: 1 | 5
): Promise<Buffer> {
  if (!/^S[0-9A-Z]+$/.test(docId)) {
    throw new Error(`downloadDocument: docID 形式が不正です: ${docId}`);
  }
  const url = withKey(new URL(`${API_BASE}/documents/${docId}`));
  url.searchParams.set("type", String(docType));

  const res = await fetch(url);
  if (res.status === 404) {
    throw new EdinetNotFoundError(docId, docType);
  }
  if (!res.ok) {
    throw new Error(
      `EDINET 書類取得 API エラー docID=${docId} type=${docType} status=${res.status} ${res.statusText}`
    );
  }
  const ct = res.headers.get("content-type") ?? "";
  // 正常時は application/octet-stream (ZIP)。JSON が返るのは API エラー応答。
  if (ct.includes("application/json")) {
    const body = await res.text();
    throw new Error(
      `EDINET 書類取得が JSON エラーを返しました docID=${docId} type=${docType}: ${body.slice(0, 300)}`
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) {
    throw new Error(
      `EDINET 書類取得が空応答 docID=${docId} type=${docType}`
    );
  }
  return buf;
}
