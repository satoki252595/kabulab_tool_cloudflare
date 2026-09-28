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
 * 再試行は呼び出し側の 60 日窓 + docId 冪等に委ね、ここではしない
 * (単発 GET に副作用は無く、次回実行が未完了分を拾う)。
 */
export const EDINET_DOWNLOAD_TIMEOUT_MS = 60_000;

export interface EdinetRequestOpts {
  /** 要求全体の期限ms (既定は用途別の定数)。テストは短縮可 (#134 の postCatchup と同形)。 */
  timeoutMs?: number;
}

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
  date: string,
  opts: EdinetRequestOpts = {}
): Promise<EdinetListResponse> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`listDocuments: 日付形式が不正です: ${date}`);
  }
  const url = withKey(new URL(`${API_BASE}/documents.json`));
  url.searchParams.set("date", date);
  url.searchParams.set("type", "2"); // メタデータ + 提出書類一覧

  const timeoutMs = opts.timeoutMs ?? EDINET_LIST_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal,
    });
  } catch (e) {
    // 期限切れだけ文脈を付けて投げ直す (握りつぶさない — ルール2。cause は
    // timer 由来の TimeoutError で秘密を含まない)。それ以外の fetch 失敗は
    // 従来どおり素通しし、呼び出し側の既存の分類を変えない。
    if (signal.aborted) {
      throw new Error(
        `EDINET 書類一覧 API タイムアウト date=${date} timeoutMs=${timeoutMs}`,
        { cause: e }
      );
    }
    throw e;
  }
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
  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch (e) {
    // 期限切れだけ文脈を付けて投げ直す (listDocuments と同一方針)。
    if (signal.aborted) {
      throw new Error(
        `EDINET 書類取得 API タイムアウト docID=${docId} type=${docType} timeoutMs=${timeoutMs}`,
        { cause: e }
      );
    }
    throw e;
  }
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
