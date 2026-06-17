/**
 * 共有型定義 — 日次/月次 sync オーケストレータで使う中間型。
 *
 * ここで定義する型はサービスまたぎで流通する。各サービスの DB スキーマ型は
 * そのサービスの db/schema.ts から import する (core スキーマのみ共有)。
 */

/** 単一日の OHLCV (null 許容) */
export interface DailyOhlcv {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
}

/** 年度財務データ (売上高のみ) */
export interface AnnualFinancial {
  fiscalYear: number;
  revenue: number | null;
}

/** Yahoo から取得した 1 銘柄分の生データ (chart + quoteSummary を統合) */
export interface StockRawData {
  price: number | null;
  per: number | null;
  pbr: number | null;
  dividendYield: number | null;
  eps: number | null;
  bps: number | null;
  roe: number | null;
  roa: number | null;
  marketCap: number | null;
  /** 営業利益率 TTM (0.1234 = 12.34%) */
  operatingMarginTtm: number | null;
  dataDate: string;
  ohlcv: DailyOhlcv[];
  annualFinancials: AnnualFinancial[];
}

/** マクロ指数 1 シンボルの取得結果 */
export interface MacroQuote {
  price: number | null;
  previousClose: number | null;
}
