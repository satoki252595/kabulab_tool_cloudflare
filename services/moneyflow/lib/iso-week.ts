/**
 * ISO 8601 週番号 (`YYYY-Www`、月曜始まり) の変換ユーティリティ (純関数・依存ゼロ)。
 *
 * Worker 側 (`src/routes/moneyflow-sector.ts`) と Node 側
 * (`scripts/moneyflow/ingest.ts`) の両方から使うため、Hono/D1 に依存しない
 * この場所に置く。
 */

/** 日付の ISO 8601 週番号・週年を返す (標準アルゴリズム。木曜基準)。 */
function isoWeekOf(date: Date): { isoYear: number; isoWeek: number } {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7; // 1(月)〜7(日)
  d.setUTCDate(d.getUTCDate() + 4 - dayNum); // 同じ ISO 週の木曜へ
  const isoYear = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const isoWeek = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return { isoYear, isoWeek };
}

/** 日付を `YYYY-Www` ラベルに変換する (Notion 観測ログの「対象期間」表示用)。 */
export function isoWeekLabelOf(date: Date): string {
  const { isoYear, isoWeek } = isoWeekOf(date);
  return `${isoYear}-W${String(isoWeek).padStart(2, "0")}`;
}

/**
 * ISO 8601 週番号 (`YYYY-Www`、月曜始まり) を月曜〜日曜の日付範囲に変換する。
 * 週番号が実在しない (例: 大半の年に無い 53 週) 場合は throw する (推測しない)。
 */
export function isoWeekToDateRange(week: string): { from: string; to: string } {
  const m = /^(\d{4})-W(\d{2})$/.exec(week);
  if (!m) {
    throw new Error(`week は YYYY-Www 形式で指定してください (例 2026-W38): ${week}`);
  }
  const year = Number(m[1]);
  const weekNum = Number(m[2]);
  if (weekNum < 1 || weekNum > 53) {
    throw new Error(`week の週番号は 01〜53 の範囲にしてください: ${week}`);
  }
  // ISO 8601: 1月4日を含む週が第1週。週は月曜始まり。
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Iso = jan4.getUTCDay() === 0 ? 7 : jan4.getUTCDay(); // 1(月)〜7(日)
  const week1Monday = new Date(jan4.getTime() - (jan4Iso - 1) * 86_400_000);
  const monday = new Date(week1Monday.getTime() + (weekNum - 1) * 7 * 86_400_000);
  const sunday = new Date(monday.getTime() + 6 * 86_400_000);

  // 実在検証: 計算結果を ISO 週番号へ逆変換し、要求した (year, weekNum) と
  // 一致するかを見る (52 週しかない年に第53週を指定した等の誤りを検知)。
  const roundTrip = isoWeekOf(monday);
  if (roundTrip.isoYear !== year || roundTrip.isoWeek !== weekNum) {
    throw new Error(`${year}年に第${weekNum}週は存在しません (実在しない週番号)`);
  }

  return { from: monday.toISOString().slice(0, 10), to: sunday.toISOString().slice(0, 10) };
}

/** 直近の月曜 (今日を含む週の月曜) を `YYYY-MM-DD` で返す。 */
export function mostRecentMondayOf(date: Date): string {
  const dayNum = date.getUTCDay() || 7; // 1(月)〜7(日)
  const monday = new Date(date.getTime() - (dayNum - 1) * 86_400_000);
  return monday.toISOString().slice(0, 10);
}
