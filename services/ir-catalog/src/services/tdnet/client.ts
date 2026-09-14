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
 *   - 一過性失敗 (5xx/429/ネットワーク) は指数バックオフで再試行
 *   - 恒久的失敗 (4xx) は throw (ルール2: 既定値で握りつぶさない)
 *   - 1 日が DAY_LIMIT 以上 = API 仕様変更の疑い → 黙って切り捨てず throw
 */
import type { TdnetItemRaw } from "./types.js";
import { normalizeTdnetItem } from "./types.js";

const API_BASE = "https://webapi.yanoshin.jp/webapi/tdnet/list";
/** 1 日あたり取得上限。実測の最繁忙日 (~2,300) を大きく上回る安全値 */
const DAY_LIMIT = 8000;
/** サイト負荷軽減のためのリクエスト間最小間隔 */
const MIN_INTERVAL_MS = 750;
const MAX_RETRY = 5;

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
    let attempt = 0;
    for (;;) {
      attempt++;
      let res: Response;
      try {
        res = await fetch(url, {
          headers: {
            "User-Agent":
              "kabulab-ir-catalog/1.0 (+https://kabulab-cf.satoki252595.workers.dev/ir-catalog/)",
          },
        });
      } catch (e) {
        if (attempt > MAX_RETRY) {
          throw new Error(
            `TDnet 通信失敗 ${ymd} ${MAX_RETRY} 回再試行後も失敗: ${(e as Error).message}`,
            { cause: e }
          );
        }
        await sleep(Math.min(20_000, 800 * 2 ** attempt));
        continue;
      }
      if (res.ok) {
        const json = (await res.json()) as RawResponse;
        if (!Array.isArray(json.items)) {
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
      }
      // 4xx (429 除く) は恒久エラー
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `TDnet API エラー ${ymd} status=${res.status} ${body.slice(0, 200)}`
        );
      }
      if (attempt > MAX_RETRY) {
        throw new Error(
          `TDnet API ${ymd} status=${res.status} ${MAX_RETRY} 回再試行後も失敗`
        );
      }
      await sleep(Math.min(20_000, 800 * 2 ** attempt));
    }
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
