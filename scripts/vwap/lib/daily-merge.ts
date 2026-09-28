/**
 * R2 `daily/{code}.json` の splits マージ (純関数)。
 *
 * bars は日付キーでマージされるのに splits だけ 1mo 応答で全置換され、
 * 窓外の分割履歴が消える (F-09。7203/9984 とも `splits: []` まで縮退)。
 * 日付キーの窓マージにする: 窓外の既存イベントは保持し、窓内は fresh を
 * 正とする (窓内の新規分割・訂正が反映され、窓内の偽イベントも落ちる)。
 *
 * 空応答の扱いは raw 契約で区別する:
 * - bars なし (欠損) → 呼出側 (`ingest-daily.ts`) が書込自体を見送る。
 *   ここには来ない。
 * - bars あり + splits なし (窓内に分割なし) → 窓内の既存イベントを落とす
 *   (fresh が正)。窓外は保持する。
 * - 窓外の既存イベント → 常に保持 (fresh の窓が語らない範囲を消さない)。
 *
 * 勝手な preserve/補完はしない: 保持するのは窓外の既存イベントだけで、
 * 窓内は fresh の有無に従う。偽イベントの除去 (#152/#154) は別途 CAS 修復の
 * 仕事であり、このマージで undo しない (窓内 fresh が正なため再混入もしない)。
 */

export interface DailySplit {
  /** 'YYYY-MM-DD' (JST) */
  date: string;
  /** 分割比率 (例: 5 = 1:5) */
  ratio: number;
}

/**
 * 既存 splits と fresh splits を取得窓でマージする。
 *
 * @param existing - 保存済み splits (欠落時は空扱い。窓外だけ残る)
 * @param fresh - 今回応答の splits (窓内の正本)
 * @param windowStart - fresh bars の先頭日 (この日を含む)
 * @param windowEnd - fresh bars の末尾日 (この日を含む)
 * @returns 日付昇順・日付一意 (同日は fresh 優先) の splits
 */
export function mergeDailySplits(
  existing: DailySplit[],
  fresh: DailySplit[],
  windowStart: string,
  windowEnd: string
): DailySplit[] {
  const byDate = new Map<string, number>();
  for (const s of existing ?? []) {
    // 窓外の既存イベントだけ保持する。窓内は fresh が語るので捨てる。
    if ((s.date < windowStart || s.date > windowEnd) && !byDate.has(s.date)) {
      byDate.set(s.date, s.ratio);
    }
  }
  for (const s of fresh ?? []) {
    byDate.set(s.date, s.ratio);
  }
  return [...byDate.entries()]
    .map(([date, ratio]) => ({ date, ratio }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
