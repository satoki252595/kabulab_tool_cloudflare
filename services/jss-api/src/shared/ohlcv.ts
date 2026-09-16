/**
 * 日足 OHLCV の取得と全系列調整（正規化）。
 *
 * 調整の基準は Yahoo の調整終値（D1 `swing_daily_ohlcv.adj`）。
 * バーごとの係数 factor = adj / close を O/H/L/C に掛け、出来高は割る。
 * Yahoo の Adj Close は分割・併合・配当落ち込みなので、この係数で
 * 全系列が配当・分割調整済みになる。R2 の splits を読まないのは、
 * 係数を D1 の 1 行から決定的に決めるため（R2 側の欠落に左右されない）。
 *
 * adj が無い・close が 0 のバーは係数 1（無調整）で返す。欠落を例外に
 * すると、adj 未 backfill の古い行がある銘柄の全期間取得が壊れる。
 * 調整の有無はバーごとの `adjusted` フラグで明示する。
 */

export interface OhlcvRow {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  adj: number | null;
}

export interface AdjustedBar {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  adj_close: number | null;
  adj_open: number | null;
  adj_high: number | null;
  adj_low: number | null;
  adj_volume: number | null;
  /** 係数が 1 以外（＝調整が効いた）か。 */
  adjusted: boolean;
}

function round4(n: number | null): number | null {
  return n === null ? null : Math.round(n * 10000) / 10000;
}

/** 係数を決める。adj/close が両方あり close != 0 のときだけ調整する。 */
export function adjustmentFactor(close: number | null, adj: number | null): number {
  if (close === null || adj === null || close === 0) return 1;
  if (!Number.isFinite(close) || !Number.isFinite(adj)) return 1;
  return adj / close;
}

export function adjustBar(row: OhlcvRow): AdjustedBar {
  const factor = adjustmentFactor(row.close, row.adj);
  const scaled = (n: number | null): number | null =>
    n === null ? null : round4(n * factor);
  return {
    date: row.date,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
    adj_close: row.adj,
    adj_open: scaled(row.open),
    adj_high: scaled(row.high),
    adj_low: scaled(row.low),
    adj_volume: row.volume === null ? null : round4(row.volume / factor),
    adjusted: factor !== 1,
  };
}

export interface OhlcvRange {
  from?: string;
  to?: string;
  limit: number;
}

/**
 * 1銘柄の日足を D1 から取り、調整済みで返す。
 * 銘柄自体が無ければ null（→ 404）。銘柄はあるが範囲内バーが無ければ
 * 空配列（→ 200 空）。呼び出し側で区別すること。
 */
export async function fetchAdjustedOhlcv(
  db: D1Database,
  code: string,
  range: OhlcvRange,
): Promise<{ code: string; bars: AdjustedBar[] } | null> {
  const stock = await db.prepare(
    "SELECT id FROM core_stocks WHERE code = ?",
  ).bind(code).first<{ id: number }>();
  if (!stock) return null;
  const conds = ["stock_id = ?1"];
  const params: unknown[] = [stock.id];
  if (range.from) {
    params.push(range.from);
    conds.push(`date >= ?${params.length}`);
  }
  if (range.to) {
    params.push(range.to);
    conds.push(`date <= ?${params.length}`);
  }
  params.push(range.limit);
  const limitPh = `?${params.length}`;
  const { results } = await db.prepare(
    "SELECT date, open, high, low, close, volume, adj FROM swing_daily_ohlcv" +
      ` WHERE ${conds.join(" AND ")} ORDER BY date ASC LIMIT ${limitPh}`,
  ).bind(...params).all<OhlcvRow>();
  return { code, bars: results.map(adjustBar) };
}
