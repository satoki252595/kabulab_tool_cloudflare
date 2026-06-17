/**
 * セクター騰落ランキング集計 — swing-trading の sector.ts からの純粋移植
 *
 * 全銘柄の当日前日比と sector 情報から、業種別の平均騰落率を集計する。
 * sector が null の銘柄は "未分類" にまとめる。pct1d が null の銘柄は個別にスキップ。
 * ソート: 当日騰落率の降順 (rank_1d = 1 が最も上昇)
 */

export interface StockChangeInput {
  sector: string | null;
  pct1d: number | null;
  pct5d: number | null;
}

export interface SectorAggregate {
  sector: string;
  pct1d: number;
  pct5d: number | null;
  stockCount: number;
  rank1d: number;
}

export function aggregateSectors(
  stocks: ReadonlyArray<StockChangeInput>
): SectorAggregate[] {
  const buckets = new Map<
    string,
    { sum1d: number; sum5d: number; count1d: number; count5d: number }
  >();

  for (const s of stocks) {
    if (s.pct1d === null || !Number.isFinite(s.pct1d)) continue;
    const key = s.sector ?? "未分類";
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { sum1d: 0, sum5d: 0, count1d: 0, count5d: 0 };
      buckets.set(key, bucket);
    }
    bucket.sum1d += s.pct1d;
    bucket.count1d += 1;
    if (s.pct5d !== null && Number.isFinite(s.pct5d)) {
      bucket.sum5d += s.pct5d;
      bucket.count5d += 1;
    }
  }

  const aggregates: Omit<SectorAggregate, "rank1d">[] = [];
  for (const [sector, b] of buckets) {
    if (b.count1d === 0) continue;
    aggregates.push({
      sector,
      pct1d: b.sum1d / b.count1d,
      pct5d: b.count5d > 0 ? b.sum5d / b.count5d : null,
      stockCount: b.count1d,
    });
  }

  aggregates.sort((a, b) => b.pct1d - a.pct1d);
  return aggregates.map((a, i) => ({ ...a, rank1d: i + 1 }));
}
