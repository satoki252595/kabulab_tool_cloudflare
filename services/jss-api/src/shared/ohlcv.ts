/**
 * 日足 OHLCV の取得と調整価格の付与。
 *
 * 価格基盤は提供元の OHLCV (分割調整済み)。adj_* は Yahoo Adj Close
 * (split+配当の total-return) に基づく調整価格であり、「分割調整済み」とは
 * 呼ばない。R2 の splits を読まないのは、係数を D1 の 1 行から決定的に
 * 決めるため (R2 側の欠落に左右されない)。event 比率の二重適用はしない。
 *
 * 係数 factor = adj / close は両値が既知の有限正値のときのみ確定する。
 * unknown (欠落・非有限・非正・比の非有限・非正) は null を返し、偽の 1
 * で無調整に見せない。unknown 行の調整価格は全て null (adj_close 含む)。
 * 提供元の OHLCV は保持する。adj_volume は legacy field として残すが
 * 常に null: 出来高の現株数補正は split 出来高意味論が未確認のため
 * 行わない (no divide adj/close)。SOURCE の volume は不変。
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
  /** 係数既知かつ 1 以外（＝調整が効いた）か。unknown は false。 */
  adjusted: boolean;
}

function round4(n: number | null): number | null {
  return n === null ? null : Math.round(n * 10000) / 10000;
}

/**
 * 係数を決める。両値が既知の有限正値で比が有限正のときのみ値を返す。
 * それ以外 (unknown) は null。偽の 1 を返さない。
 */
export function adjustmentFactor(close: number | null, adj: number | null): number | null {
  if (close === null || adj === null) return null;
  if (!Number.isFinite(close) || !Number.isFinite(adj)) return null;
  if (close <= 0 || adj <= 0) return null;
  const f = adj / close;
  if (!Number.isFinite(f) || f <= 0) return null;
  return f;
}

export function adjustBar(row: OhlcvRow): AdjustedBar {
  const factor = adjustmentFactor(row.close, row.adj);
  // 入力・積・丸め結果の全段で有限正を要求する (overflow/0 丸めも null)。
  const scaled = (n: number | null): number | null => {
    if (factor === null || n === null) return null;
    if (!Number.isFinite(n) || n <= 0) return null;
    const p = n * factor;
    if (!Number.isFinite(p) || p <= 0) return null;
    const r = round4(p);
    if (r === null || !Number.isFinite(r) || r <= 0) return null;
    return r;
  };
  return {
    date: row.date,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
    adj_close: factor === null ? null : row.adj,
    adj_open: scaled(row.open),
    adj_high: scaled(row.high),
    adj_low: scaled(row.low),
    // legacy field: 常に null (split 出来高意味論未確認のため補正しない)。
    adj_volume: null,
    adjusted: factor !== null && factor !== 1,
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
