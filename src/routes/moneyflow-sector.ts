/**
 * moneyflow (008・計画 notion-velvet-goose.md) 向けの内部読取エンドポイントが
 * 使う集約ロジック。既存 D1 (`swing_daily_ohlcv` × `core_stocks.sector`) から
 * JPX 33 業種別の売買代金・時価総額を集計する。
 *
 * ⚠️ `core_stocks.sector` は JPX 33 業種区分で **personal-only** (公開面は
 * `sector33`=EDINET 業種を使う。src/shared/db/core-stocks-license-boundary.test.ts
 * 参照)。本モジュールは Worker 内部の認証付きエンドポイント (`verifyCronSecret`)
 * からのみ呼ばれ、無認証の公開面には出さない。計画書「JPX の業種分類と EDINET の
 * 業種は別の分類。この機能は JPX 側に統一する（個人利用のため personal-only の
 * 列を使える）」に基づく明示的な設計判断。
 *
 * D1 は 1 クエリ 100 バインド変数まで (メモリ: d1-bound-param-limit)。本モジュールは
 * `IN (...)` へ JS 配列の ID を展開せず、`core_stocks` との JOIN + WHERE の範囲指定
 * だけで完結させているため、対象銘柄数に関わらずバインド数は一定 (date 2 個 + JOIN
 * 条件の定数)。
 */
import { and, eq, gte, lte, type SQL } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { activeEquityCondition } from "../shared/db/active-equity.js";
import * as coreSchema from "../shared/db/core-schema.js";
import * as swingSchema from "../../services/swing-trading/src/db/schema.js";
import { isoWeekToDateRange } from "../../services/moneyflow/lib/iso-week.js";
import { MONEYFLOW_UNCLASSIFIED_SECTOR } from "../../services/moneyflow/lib/sector-names.js";

export { isoWeekToDateRange };

/** `core_stocks` / `swing_daily_ohlcv` / `core_stock_financials` を select できれば足りる最小の drizzle db 型。 */
export type MoneyflowSectorDb = BaseSQLiteDatabase<"async", unknown, Record<string, unknown>>;

export interface SectorTurnoverRow {
  sector: string;
  /** 売買代金合計 (close × volume の合計。円)。 */
  turnover: number;
  /** 全業種合計に占めるシェア (0〜1)。 */
  /** 全業種合計に占める割合 (0〜1)。全業種の売買代金合計が 0 (対象週のデータ未取込等) なら null。 */
  turnoverShare: number | null;
  /** 前日比で上昇した日の売買代金合計。前日値が無い日は含まない。 */
  upTurnover: number;
  /** 前日比で下落した日の売買代金合計。前日値が無い日は含まない。 */
  downTurnover: number;
  /** 期間中に日足データを持つ銘柄数 (active かつ equity)。 */
  stockCount: number;
  /** 業種別時価総額合計 (円)。`marketCapStockCount` 銘柄分の合計 (欠損銘柄は含まない)。 */
  marketCap: number;
  /** `marketCap` の集計に実際に寄与した銘柄数 (`core_stock_financials.market_cap` が非 NULL の銘柄)。 */
  marketCapStockCount: number;
}

export interface MoneyflowSectorResult {
  from: string;
  to: string;
  /** 時価総額は取得時点のスナップショット (対象期間の値ではない)。 */
  marketCapAsOf: "snapshot_at_fetch";
  sectors: SectorTurnoverRow[];
}

/** 前日比計算のための遡り日数 (カレンダー日。週末・祝日を跨いでも直前の営業日を拾える幅)。 */
const LOOKBACK_DAYS = 7;

function addDaysUtc(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

interface OhlcvRow {
  stockId: number;
  sector: string | null;
  date: string;
  close: number | null;
  volume: number | null;
}

/**
 * `from`〜`to` の業種別集計を返す。
 *
 * @throws `from > to` 等の呼び出し側の不正はしない前提 (呼び出し元の
 *   ルートハンドラが検証してから呼ぶ)。DB 例外はそのまま throw する (ルール2)。
 */
export async function aggregateMoneyflowSector(
  db: MoneyflowSectorDb,
  range: { from: string; to: string }
): Promise<MoneyflowSectorResult> {
  const extendedFrom = addDaysUtc(range.from, -LOOKBACK_DAYS);

  // 1) 売買代金の元データ (前日比計算のため from の LOOKBACK_DAYS 日前から取得)。
  //    バインドは extendedFrom/to の 2 個のみ (IN 句を使わない)。
  const ohlcvRows = (await db
    .select({
      stockId: swingSchema.dailyOhlcv.stockId,
      sector: coreSchema.stocks.sector,
      date: swingSchema.dailyOhlcv.date,
      close: swingSchema.dailyOhlcv.close,
      volume: swingSchema.dailyOhlcv.volume,
    })
    .from(swingSchema.dailyOhlcv)
    .innerJoin(
      coreSchema.stocks,
      and(eq(coreSchema.stocks.id, swingSchema.dailyOhlcv.stockId), activeEquityCondition()) as SQL
    )
    .where(and(gte(swingSchema.dailyOhlcv.date, extendedFrom), lte(swingSchema.dailyOhlcv.date, range.to)))
    .orderBy(swingSchema.dailyOhlcv.stockId, swingSchema.dailyOhlcv.date)) as OhlcvRow[];

  // 2) 業種別時価総額 (取得時点のスナップショット。対象期間の値ではない)。
  const capRows = (await db
    .select({
      sector: coreSchema.stocks.sector,
      marketCap: coreSchema.stockFinancials.marketCap,
    })
    .from(coreSchema.stockFinancials)
    .innerJoin(
      coreSchema.stocks,
      and(eq(coreSchema.stocks.id, coreSchema.stockFinancials.stockId), activeEquityCondition()) as SQL
    )) as Array<{ sector: string | null; marketCap: number | null }>;

  interface Agg {
    turnover: number;
    upTurnover: number;
    downTurnover: number;
    stockIds: Set<number>;
    marketCap: number;
    marketCapStockCount: number;
  }
  const bySector = new Map<string, Agg>();
  const ensure = (sector: string): Agg => {
    const cur = bySector.get(sector);
    if (cur) return cur;
    const fresh: Agg = {
      turnover: 0,
      upTurnover: 0,
      downTurnover: 0,
      stockIds: new Set(),
      marketCap: 0,
      marketCapStockCount: 0,
    };
    bySector.set(sector, fresh);
    return fresh;
  };

  // stockId ごとに日付順 (SQL 側の ORDER BY で既に整列済み) に前日比を追う。
  let prevStockId: number | null = null;
  let prevClose: number | null = null;
  for (const row of ohlcvRows) {
    if (row.stockId !== prevStockId) {
      prevStockId = row.stockId;
      prevClose = null;
    }
    // 欠損 (close/volume が NULL) は turnover に計上しない (捏造しない — ルール2)。
    const rowTurnover = row.close !== null && row.volume !== null ? row.close * row.volume : null;

    if (row.date >= range.from && row.date <= range.to) {
      const sector = row.sector ?? MONEYFLOW_UNCLASSIFIED_SECTOR;
      const agg = ensure(sector);
      agg.stockIds.add(row.stockId);
      if (rowTurnover !== null) {
        agg.turnover += rowTurnover;
        if (prevClose !== null && row.close !== null) {
          if (row.close > prevClose) agg.upTurnover += rowTurnover;
          else if (row.close < prevClose) agg.downTurnover += rowTurnover;
          // 前日と同値の日はどちらにも計上しない (上昇でも下落でもない)。
        }
      }
    }
    if (row.close !== null) prevClose = row.close;
  }

  for (const cap of capRows) {
    if (cap.marketCap === null) continue;
    const sector = cap.sector ?? MONEYFLOW_UNCLASSIFIED_SECTOR;
    const agg = ensure(sector);
    agg.marketCap += cap.marketCap;
    agg.marketCapStockCount += 1;
  }

  const totalTurnover = [...bySector.values()].reduce((sum, a) => sum + a.turnover, 0);

  const sectors: SectorTurnoverRow[] = [...bySector.entries()]
    .map(([sector, a]) => ({
      sector,
      turnover: a.turnover,
      turnoverShare: totalTurnover > 0 ? a.turnover / totalTurnover : null,
      upTurnover: a.upTurnover,
      downTurnover: a.downTurnover,
      stockCount: a.stockIds.size,
      marketCap: a.marketCap,
      marketCapStockCount: a.marketCapStockCount,
    }))
    .sort((x, y) => y.turnover - x.turnover);

  return { from: range.from, to: range.to, marketCapAsOf: "snapshot_at_fetch", sectors };
}
