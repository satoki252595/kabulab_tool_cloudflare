/**
 * yanoshin TDnet WebAPI クライアント (依存ゼロ・fetch 直叩き)。
 *
 * yanoshin の実挙動 (2026-05 実測):
 *   - `?page=N` は **無視される** (page を変えても常に最新 limit 件が返る)。
 *     よってページングは不可。代わりに **1 日単位** で取得する。
 *   - `?limit=N` は上限で、範囲指定だと「最新 N 件」で切られる。1 日内の
 *     全市場開示は最繁忙日 (5/15 等) でも ~2,300 件で、DAY_LIMIT(8,000) を
 *     超えないため 1 日 = 1 リクエストで取りこぼし無く全件取れる。
 *   - レスポンス各要素は `{ "Tdnet": {...} }` だが、limit によっては
 *     ラッパ無しの素フィールドで返ることがある。**両表現を正規化** する
 *     (同一データの符号化揺れの吸収 = ルール2 の正規化例外に該当)。
 *
 * サイトに負荷をかけない方針 (ユーザ要件):
 *   - 全リクエストをプロセス内で直列化し最小間隔を強制
 *   - 受信原 bytes を物理保管・読戻し照合してから parse。未知失敗は後続取得を停止
 *   - 恒久的失敗 (4xx) は throw (ルール2: 既定値で握りつぶさない)
 *   - 1 日が DAY_LIMIT 以上 = API 仕様変更の疑い → 黙って切り捨てず throw
 */
import type { TdnetItemRaw } from "./types.js";
import { recordPrimaryData, verifyArchivedAttachments } from "../../../../../src/shared/notion-archive/index.js";
import { notionEnv } from "../../../../../src/shared/notion-archive/env.js";
import { sha256HexBytes } from "../../../../../src/shared/sha256.js";
import { normalizeTdnetItem } from "./types.js";

const API_BASE = "https://webapi.yanoshin.jp/webapi/tdnet/list";
/** 1 日あたり取得上限。実測の最繁忙日 (~2,300) を大きく上回る安全値 */
const DAY_LIMIT = 8000;
/** サイト負荷軽減のためのリクエスト間最小間隔 */
const MIN_INTERVAL_MS = 750;

let chain: Promise<unknown> = Promise.resolve();
let lastStart = 0;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 全 TDnet 通信を直列化 + 最小間隔を強制するゲート */
function schedule<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const wait = MIN_INTERVAL_MS - (Date.now() - lastStart);
    if (wait > 0) await sleep(wait);
    lastStart = Date.now();
    return task();
  });
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

interface RawResponse {
  items?: unknown[];
}

/** 1 日 (YYYYMMDD) の全開示を取得する。 */
async function fetchDay(ymd: string): Promise<TdnetItemRaw[]> {
  return schedule(async () => {
    const url = `${API_BASE}/${ymd}.json?limit=${DAY_LIMIT}`;
    const res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
      headers: {
        "User-Agent":
          "kabulab-ir-catalog/1.0 (+https://kabulab-cf.satoki252595.workers.dev/ir-catalog/)",
      },
    });
    const bytes = new Uint8Array(await res.arrayBuffer());
    const fetchedAt = new Date().toISOString();
    const sha256 = await sha256HexBytes(bytes);
    const key = `tdnet-source-${ymd}-${res.status}-${sha256}`;
    const files = [{ bytes, filename: `${key}.txt`, contentType: "text/plain" }];
    // HTTP 原文 (ラッパ・未解釈 fields・空白も含む) は DTO に代替しない。
    // 非200も保管し、保管未知は HTTP 再取得せずこのまま throw。
    const archive = await recordPrimaryData({
      service: "ir-catalog",
      key,
      source: url,
      fetchedAt,
      metadata: {
        ymd, status: res.status, responseUrl: res.url,
        contentType: res.headers.get("content-type"), sha256, byteLength: bytes.length,
      },
      files,
    });
    if (archive.fileTooLarge) throw new Error("TDnet HTTP 原文が容量上限で未保管のため停止");
    await verifyArchivedAttachments(archive.pageId, files, "TDnet HTTP 原文");
    if (res.status !== 200) throw new Error(`TDnet API エラー ${ymd} status=${res.status}`);
    let json: RawResponse;
    try {
      json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as RawResponse;
    } catch {
      throw new Error(`TDnet HTTP 原文を JSON として解釈できないため停止 ${ymd}`);
    }
    if (!json || !Array.isArray(json.items)) {
      throw new Error(
        `TDnet レスポンス形式が不正 ${ymd}: items が配列でない`
      );
    }
    const raw = json.items.length;
    const items: TdnetItemRaw[] = [];
    for (const it of json.items) {
      const n = normalizeTdnetItem(it, ymd);
      if (n) items.push(n);
    }
    const skipped = raw - items.length;
    if (skipped > 0) {
      // 異常入力を黙殺せず件数を運用者に可視化 (ルール2)。バッチ全体は
      // 落とさない (1 件の異常で日/月を失わない)。
      console.warn(
        `[tdnet] ${ymd}: ${skipped}/${raw} 件を異常入力として除外`
      );
    }
    // 上限到達は取りこぼしの可能性。捏造/切り捨てせず throw (ルール2)。
    if (raw >= DAY_LIMIT) {
      throw new Error(
        `TDnet ${ymd} が DAY_LIMIT(${DAY_LIMIT}) に到達 (${raw})。` +
          `API 仕様変更の疑い — 黙って切り捨てない (ルール2)`
      );
    }
    return items;
  });
}

/** "YYYYMMDD" を Date(UTC) に */
function ymdToDate(ymd: string): Date {
  return new Date(
    Date.UTC(
      Number(ymd.slice(0, 4)),
      Number(ymd.slice(4, 6)) - 1,
      Number(ymd.slice(6, 8))
    )
  );
}
function dateToYmd(d: Date): string {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(
    2,
    "0"
  )}${String(d.getUTCDate()).padStart(2, "0")}`;
}

/**
 * 範囲 ("YYYYMMDD" または "YYYYMMDD-YYYYMMDD") の適時開示を **1 日ずつ**
 * 取得して 1 配列で返す。yanoshin は page 無効・範囲は最新 limit 件で
 * 切られるため、取りこぼさない唯一の確実な方法が日次取得。
 */
export async function listRange(range: string): Promise<TdnetItemRaw[]> {
  // normal/backfill とも原文保管の設定を源取得より前に検査する。
  notionEnv.NOTION_TOKEN();
  notionEnv.NOTION_ARCHIVE_PAGE_ID();
  const m = /^(\d{8})(?:-(\d{8}))?$/.exec(range.trim());
  if (!m) {
    throw new Error(
      `TDnet range 形式が不正: "${range}" (YYYYMMDD または YYYYMMDD-YYYYMMDD)`
    );
  }
  const start = ymdToDate(m[1]);
  const end = ymdToDate(m[2] ?? m[1]);
  if (end.getTime() < start.getTime()) {
    throw new Error(`TDnet range の開始>終了: ${range}`);
  }

  const out: TdnetItemRaw[] = [];
  for (
    let d = new Date(start);
    d.getTime() <= end.getTime();
    d.setUTCDate(d.getUTCDate() + 1)
  ) {
    const day = await fetchDay(dateToYmd(d));
    for (const it of day) out.push(it);
  }
  return out;
}
