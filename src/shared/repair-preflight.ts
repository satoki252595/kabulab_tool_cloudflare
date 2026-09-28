/**
 * 市場系 Source 修復の full-input preflight (D1 REST batch 先頭文)。
 *
 * 優待の `buildStockPreflightStatement` (atomic-apply.ts) と同じ約束:
 * batch 内の先頭文で「計画時と 1 列も違わない」ことを SQL エラー化する
 * (不一致 → `json('')` が throw → batch 全体 rollback)。
 * 出力列の旧値だけを WHERE で比べる CAS では、計算入力の drift
 * (別 writer が入力を書き換えた後の旧 plan 適用) を検知できないため、
 * 計算入力の全列 + 行の同一性 + 保存出力も同一 batch の先頭で検証する。
 * ドリフト行の除外はしない。不一致の銘柄は batch を作らず STOP する。
 */
import type { D1BatchStatement } from "./db/d1-http-client.js";

/**
 * ATR 3bool 修復の full preimage。`diffStaleScreeningFlags` の入力 6 列 +
 * 行の同一性 (銘柄 ID・コード・active・区分) + 保存出力 3 列 + 最新日。
 * スナップショットは再計算と同一読取でなければならない
 * (別 fresh 読みの代用は drift の見逃しになる)。
 */
export type AtrPreimage = {
  stockId: number;
  code: string;
  isActive: boolean;
  instrumentType: string | null;
  avgTurnover20d: number | null;
  volumeRatio: number | null;
  atrPct: number | null;
  sma5: number | null;
  sma20: number | null;
  latestClose: number | null;
  latestDate: string | null;
  volatilityOk: boolean;
  allPassedLong: boolean;
  allPassedShort: boolean;
};

/** drizzle boolean 列 (INTEGER 0/1) との `IS` 照合は数値 0/1 で行う。 */
const bit = (v: boolean): number => (v ? 1 : 0);

/**
 * 1 銘柄の ATR preflight 文を作る (純関数・副作用なし)。
 * `swing_stock_indicators` 1 行 + `core_stocks` の銘柄同一性を全列 `IS`
 * 照合 (NULL-safe) する。bind は 14 (D1 上限 100/文に収まる)。
 */
export function buildAtrPreflightStatement(snap: AtrPreimage): D1BatchStatement {
  const sql = [
    "-- preflight: ATR再計算の全入力+銘柄同一性+保存3boolが計画時と一致しなければ SQL エラーで batch 全体 rollback",
    "SELECT json(CASE WHEN EXISTS (",
    "  SELECT 1 FROM swing_stock_indicators i JOIN core_stocks s ON s.id = i.stock_id",
    "  WHERE i.stock_id = ?",
    "  AND s.code IS ? AND s.is_active IS ? AND s.instrument_type IS ?",
    "  AND i.avg_turnover_20d IS ? AND i.volume_ratio IS ? AND i.atr_pct IS ?",
    "  AND i.sma_5 IS ? AND i.sma_20 IS ? AND i.latest_close IS ? AND i.latest_date IS ?",
    "  AND i.volatility_ok IS ? AND i.all_passed_long IS ? AND i.all_passed_short IS ?",
    ") THEN 'null' ELSE '' END)",
  ].join("\n");
  return {
    sql,
    params: [
      snap.stockId,
      snap.code,
      bit(snap.isActive),
      snap.instrumentType,
      snap.avgTurnover20d,
      snap.volumeRatio,
      snap.atrPct,
      snap.sma5,
      snap.sma20,
      snap.latestClose,
      snap.latestDate,
      bit(snap.volatilityOk),
      bit(snap.allPassedLong),
      bit(snap.allPassedShort),
    ],
  };
}

/**
 * 年次 2 列修復の full preimage。選定の入力範囲は `pickAnnualSeries` と同一:
 * asof 以前の commercial-ok 本決算の**全 scope** (`eligible`) +
 * `evaluateBlueChip` の TTM 入力 + 行の per-row 日付 + 選定結果の記録
 * (asof・scope・series) + 保存出力 2 列。
 *
 * 選定済み scope だけを照合してはならない: 非選定 scope に最新期が追加
 * されると最新期末が動き scope 選定自体が変わるため、入力範囲の不一致に
 * なる。eligible 全集合を件数 + 双方向 EXCEPT で照合し (追加・削除・値の
 * 書き換えを全て検知。NULL は集合意味で等価)、選定外 scope への最新期
 * 追加も STOP する。集合が一致すれば選定の導出入力が同一なので scope も
 * 固定される (`scope`/`series` は選定結果の記録として保持する)。
 */
export type AnnualPreimage = {
  stockId: number;
  code: string;
  /** 銘柄の凍結状態。非 active 行への誤適用 (凍結破り) を preflight で止める。 */
  isActive: boolean;
  /** 銘柄区分 (equity/ETF 等。内国普通株以外への適用も止める)。 */
  instrumentType: string | null;
  /** `core_stock_financials.data_date` (銘柄の per-row 日付)。 */
  dataDate: string;
  /** 保存済み TTM 営業利益率 (再計算の入力)。 */
  operatingMargin: number | null;
  /** 系列選定の基準日。 */
  asof: string;
  /** 選定 scope (連結/単体/不明。系列なしは "(no-series)")。選定結果の記録。 */
  scope: string;
  /** 選定済み系列 (古い→新しい順)。選定結果の記録。 */
  series: { fiscalPeriodEnd: string; consolidated: string; revenue: number | null }[];
  /**
   * 選定の入力範囲の全集合: asof 以前の commercial-ok 本決算の全 scope。
   * preflight が集合照合する対象。順序は問わない (集合比較のため)。
   */
  eligible: { fiscalPeriodEnd: string; consolidated: string; revenue: number | null }[];
  isBlueChip: boolean;
  revenueTrend: number | null;
};

/**
 * 1 銘柄の年次 preflight 文を作る (純関数・副作用なし)。
 * eligible 全集合の照合 (snapshot JSON 1 bind) + 財務行・rsi 行・銘柄対応
 * (active・区分つき) の `IS` 照合。bind は snapshot JSON 1 + 値 10 の計 11。
 */
export function buildAnnualPreflightStatement(snap: AnnualPreimage): D1BatchStatement {
  const sql = [
    "-- preflight: 年次選定の入力全集合(全scope)+TTM+日付+銘柄対応(active/区分)+保存2列が計画時と一致しなければ SQL エラーで batch 全体 rollback",
    "WITH snap(j) AS (VALUES (?)),",
    "exp_ben(fiscal_period_end, consolidated, revenue) AS (",
    "  SELECT json_extract(value, '$.fiscalPeriodEnd'), json_extract(value, '$.consolidated'), json_extract(value, '$.revenue') FROM json_each(json_extract((SELECT j FROM snap), '$.eligible'))",
    "),",
    "act_ben(fiscal_period_end, consolidated, revenue) AS (",
    "  SELECT fiscal_period_end, consolidated, net_sales FROM jss_financials WHERE code = ? AND disclosure_type = '本決算' AND license_tag = 'commercial-ok' AND fiscal_period_end <= ?",
    ")",
    "SELECT json(CASE WHEN (SELECT count(*) FROM act_ben) = (SELECT count(*) FROM exp_ben) AND NOT EXISTS (SELECT * FROM act_ben EXCEPT SELECT * FROM exp_ben) AND NOT EXISTS (SELECT * FROM exp_ben EXCEPT SELECT * FROM act_ben)",
    "  AND EXISTS (SELECT 1 FROM core_stocks WHERE id = ? AND code IS ? AND is_active IS ? AND instrument_type IS ?)",
    "  AND EXISTS (SELECT 1 FROM core_stock_financials WHERE stock_id = ? AND data_date IS ? AND operating_margin IS ?)",
    "  AND EXISTS (SELECT 1 FROM rsi_percentile WHERE stock_id = ? AND is_blue_chip IS ? AND revenue_trend IS ?)",
    "  THEN 'null' ELSE '' END)",
  ].join("\n");
  return {
    sql,
    params: [
      JSON.stringify({ eligible: snap.eligible }),
      snap.code,
      snap.asof,
      snap.stockId,
      snap.code,
      bit(snap.isActive),
      snap.instrumentType,
      snap.stockId,
      snap.dataDate,
      snap.operatingMargin,
      snap.stockId,
      bit(snap.isBlueChip),
      snap.revenueTrend,
    ],
  };
}
