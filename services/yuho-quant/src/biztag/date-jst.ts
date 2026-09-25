/**
 * JST (UTC+9) の壁時計日付。実行環境 (GitHub Actions) は UTC のため、
 * 再試行期日・見直し関門の期限判定 (docs/005-yuho-quant-business-tags.md
 * §5.2・§6.3) は必ずこのモジュール経由で JST に揃えてから比較する。
 *
 * `routes/vocabulary.ts` の `formatProposalRecord` と同じ素朴なオフセット変換
 * (UTC+9 固定。うるう秒等は考慮しない — 運用上問題にならない粒度)。
 */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** JST の「今日」(YYYY-MM-DD)。`now` は UTC ミリ秒 (テストで固定できる)。 */
export function todayJst(now: () => number = Date.now): string {
  const jst = new Date(now() + JST_OFFSET_MS);
  return `${jst.getUTCFullYear()}-${pad2(jst.getUTCMonth() + 1)}-${pad2(jst.getUTCDate())}`;
}

/** YYYY-MM-DD (JST 前提) に日数を加減する。 */
export function addDaysJst(dateJst: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateJst);
  if (!m) throw new Error(`addDaysJst: 日付の形式が不正です (YYYY-MM-DD 必須): ${dateJst}`);
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  dt.setUTCDate(dt.getUTCDate() + days);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}
