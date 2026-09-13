/**
 * 一度きりの cutover: Neon(全サービス + 共有 core) → Cloudflare D1 へ実データ移送
 * (ADR-0001 §7)。型変換は Postgres 側で投影して決定論的に行う:
 *   timestamptz → epoch 秒(integer) / date → text 'YYYY-MM-DD' / boolean → 0|1
 * FK 整合のため Neon の serial id をそのまま D1 へ持ち込む。
 *
 * 生成物: drizzle/d1/_cutover-data.sql（DELETE → INSERT 群。冪等再実行可）。
 * 適用は呼び出し側で `wrangler d1 execute kabulab-cf --remote --file=...`。
 *
 * 実行例:
 *   npx tsx scripts/migrate/yuho-neon-to-d1.ts                       # 全テーブル
 *   npx tsx scripts/migrate/yuho-neon-to-d1.ts --only=rsi_percentile  # 一部だけ
 *   npx tsx scripts/migrate/yuho-neon-to-d1.ts --only=swing_daily_ohlcv \
 *     --out=drizzle/d1/_cutover-swing-ohlcv.sql --maxRowsPerFile=60000
 *
 * 大きいテーブル (swing_daily_ohlcv ~337k) は --maxRowsPerFile で
 * <out>.part01.sql, part02.sql ... に分割し、wrangler 1 回当たりのサイズを抑える。
 * finmath_daily_ohlcv (~1.8M) は再生成可能な遅延キャッシュだったので cutover 対象外
 * (ADR-0001 正規化方針)。finmath_* の 2 表はその後 drizzle/d1/0012 で DROP した。
 */
import "dotenv/config";
import { promises as fs } from "node:fs";
import { neon } from "@neondatabase/serverless";

const DEFAULT_OUT = "drizzle/d1/_cutover-data.sql";
const ROWS_PER_INSERT = 50; // 1 文の行数（bind ではなく生 SQL だが小さく保つ）

type Col = { name: string; type: "int" | "real" | "text" };

/** 1 テーブル分の移送定義。select は変換投影込みの SQL を返す */
type Table = {
  d1: string;
  cols: Col[];
  select: string;
};

const sqlLit = (v: unknown, type: Col["type"]): string => {
  if (v === null || v === undefined) return "NULL";
  if (type === "text") return `'${String(v).replace(/'/g, "''")}'`;
  // int/real は Postgres から string で来る場合がある(bigint 等)ので数値化
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`非数値 ${type}: ${String(v)}`);
  return String(n);
};

async function main() {
  const sql = neon(process.env.DATABASE_URL!);

  // 依存順（親→子）。DELETE は逆順で先頭にまとめる。
  const tables: Table[] = [
    {
      d1: "core_stocks",
      cols: [
        { name: "id", type: "int" }, { name: "code", type: "text" },
        { name: "name", type: "text" }, { name: "market", type: "text" },
        { name: "sector", type: "text" }, { name: "is_active", type: "int" },
        { name: "is_yutai", type: "int" }, { name: "created_at", type: "int" },
        { name: "updated_at", type: "int" },
      ],
      select: `SELECT id, code, name, market, sector,
        is_active::int AS is_active, is_yutai::int AS is_yutai,
        extract(epoch from created_at)::bigint AS created_at,
        extract(epoch from updated_at)::bigint AS updated_at
        FROM core.stocks ORDER BY id`,
    },
    {
      d1: "core_stock_financials",
      cols: [
        { name: "id", type: "int" }, { name: "stock_id", type: "int" },
        { name: "price", type: "real" }, { name: "per", type: "real" },
        { name: "pbr", type: "real" }, { name: "dividend_yield", type: "real" },
        { name: "eps", type: "real" }, { name: "bps", type: "real" },
        { name: "roe", type: "real" }, { name: "roa", type: "real" },
        { name: "market_cap", type: "real" }, { name: "operating_margin", type: "real" },
        { name: "data_date", type: "text" }, { name: "fetched_at", type: "int" },
      ],
      select: `SELECT id, stock_id, price, per, pbr, dividend_yield, eps, bps, roe, roa,
        market_cap, operating_margin, to_char(data_date,'YYYY-MM-DD') AS data_date,
        extract(epoch from fetched_at)::bigint AS fetched_at
        FROM core.stock_financials ORDER BY id`,
    },
    {
      d1: "core_stock_annual_financials",
      cols: [
        { name: "id", type: "int" }, { name: "stock_id", type: "int" },
        { name: "fiscal_year", type: "int" }, { name: "revenue", type: "real" },
      ],
      select: `SELECT id, stock_id, fiscal_year, revenue
        FROM core.stock_annual_financials ORDER BY id`,
    },
    {
      d1: "yuho_documents",
      cols: [
        { name: "id", type: "int" }, { name: "stock_id", type: "int" },
        { name: "edinet_code", type: "text" }, { name: "doc_id", type: "text" },
        { name: "doc_type_code", type: "text" }, { name: "filer_name", type: "text" },
        { name: "period_start", type: "text" }, { name: "period_end", type: "text" },
        { name: "submitted_at", type: "int" }, { name: "parse_status", type: "text" },
        { name: "honbun_file", type: "text" }, { name: "ingested_at", type: "int" },
      ],
      select: `SELECT id, stock_id, edinet_code, doc_id, doc_type_code, filer_name,
        to_char(period_start,'YYYY-MM-DD') AS period_start,
        to_char(period_end,'YYYY-MM-DD') AS period_end,
        extract(epoch from submitted_at)::bigint AS submitted_at,
        parse_status, honbun_file,
        extract(epoch from ingested_at)::bigint AS ingested_at
        FROM yuho_quant.documents ORDER BY id`,
    },
    {
      d1: "yuho_order_facts",
      cols: [
        { name: "id", type: "int" }, { name: "document_id", type: "int" },
        { name: "stock_id", type: "int" }, { name: "fiscal_year_end", type: "text" },
        { name: "segment_name", type: "text" }, { name: "segment_kind", type: "text" },
        { name: "is_consolidated", type: "int" }, { name: "unit_label", type: "text" },
        { name: "orders_received_raw", type: "real" }, { name: "order_backlog_raw", type: "real" },
        { name: "orders_received_yen", type: "int" }, { name: "order_backlog_yen", type: "int" },
        { name: "pattern", type: "text" },
      ],
      select: `SELECT id, document_id, stock_id,
        to_char(fiscal_year_end,'YYYY-MM-DD') AS fiscal_year_end,
        segment_name, segment_kind, is_consolidated::int AS is_consolidated,
        unit_label, orders_received_raw, order_backlog_raw,
        orders_received_yen, order_backlog_yen, pattern
        FROM yuho_quant.order_facts ORDER BY id`,
    },
    {
      d1: "ir_disclosures",
      cols: [
        { name: "id", type: "int" }, { name: "stock_id", type: "int" },
        { name: "tdnet_id", type: "text" }, { name: "company_code", type: "text" },
        { name: "company_name", type: "text" }, { name: "title", type: "text" },
        { name: "pubdate", type: "int" }, { name: "document_url", type: "text" },
        { name: "xbrl_url", type: "text" }, { name: "markets_string", type: "text" },
        { name: "tags", type: "text" }, { name: "primary_tag", type: "text" },
        { name: "notion_page_id", type: "text" }, { name: "pdf_sentiment", type: "text" },
        { name: "pdf_sentiment_method", type: "text" }, { name: "pdf_sentiment_score", type: "real" },
        { name: "pdf_sentiment_at", type: "int" }, { name: "ingested_at", type: "int" },
      ],
      // tags(text[]) は array_to_json で JSON 文字列化（D1 は text({mode:'json'}) で
      // 受け、読取時に JSON.parse される）。timestamp は epoch 秒へ。
      select: `SELECT id, stock_id, tdnet_id, company_code, company_name, title,
        extract(epoch from pubdate)::bigint AS pubdate, document_url, xbrl_url, markets_string,
        array_to_json(tags)::text AS tags, primary_tag, notion_page_id,
        pdf_sentiment, pdf_sentiment_method, pdf_sentiment_score,
        extract(epoch from pdf_sentiment_at)::bigint AS pdf_sentiment_at,
        extract(epoch from ingested_at)::bigint AS ingested_at
        FROM ir_catalog.disclosures ORDER BY id`,
    },
    // -------- ADR-0001 第2弾 cluster: 001/002/003/004 --------
    {
      d1: "rsi_percentile",
      cols: [
        { name: "id", type: "int" }, { name: "stock_id", type: "int" },
        { name: "rsi_10", type: "real" }, { name: "rsi_10_percentile", type: "real" },
        { name: "rsi_40", type: "real" }, { name: "rsi_40_percentile", type: "real" },
        { name: "rsi_120", type: "real" }, { name: "rsi_120_percentile", type: "real" },
        { name: "rsi_min_percentile", type: "real" }, { name: "is_blue_chip", type: "int" },
        { name: "operating_margin_ttm", type: "real" }, { name: "revenue_trend", type: "int" },
        { name: "computed_at", type: "int" },
      ],
      select: `SELECT id, stock_id, rsi_10, rsi_10_percentile, rsi_40, rsi_40_percentile,
        rsi_120, rsi_120_percentile, rsi_min_percentile,
        is_blue_chip::int AS is_blue_chip, operating_margin_ttm, revenue_trend,
        extract(epoch from computed_at)::bigint AS computed_at
        FROM rsi.stock_rsi_percentile ORDER BY id`,
    },
    {
      d1: "swing_stock_indicators",
      cols: [
        { name: "stock_id", type: "int" },
        { name: "avg_turnover_20d", type: "real" }, { name: "volume_20d", type: "real" },
        { name: "volume_ratio", type: "real" }, { name: "atr_14", type: "real" },
        { name: "atr_pct", type: "real" }, { name: "sma_5", type: "real" },
        { name: "sma_20", type: "real" }, { name: "sma_25", type: "real" },
        { name: "sma_60", type: "real" }, { name: "sma_75", type: "real" },
        { name: "trend_long", type: "int" }, { name: "trend_short", type: "int" },
        { name: "perfect_order_long", type: "int" }, { name: "perfect_order_short", type: "int" },
        { name: "rsi_14", type: "real" }, { name: "macd", type: "real" },
        { name: "macd_signal", type: "real" }, { name: "macd_hist", type: "real" },
        { name: "range_20d_high", type: "real" }, { name: "range_20d_low", type: "real" },
        { name: "range_width", type: "real" }, { name: "fib_high", type: "real" },
        { name: "fib_low", type: "real" }, { name: "fib_382", type: "real" },
        { name: "fib_500", type: "real" }, { name: "fib_618", type: "real" },
        { name: "latest_close", type: "real" }, { name: "latest_volume", type: "real" },
        { name: "latest_date", type: "text" }, { name: "pct_change_1d", type: "real" },
        { name: "computed_at", type: "int" },
      ],
      select: `SELECT stock_id, avg_turnover_20d, volume_20d, volume_ratio, atr_14, atr_pct,
        sma_5, sma_20, sma_25, sma_60, sma_75,
        trend_long::int AS trend_long, trend_short::int AS trend_short,
        perfect_order_long::int AS perfect_order_long, perfect_order_short::int AS perfect_order_short,
        rsi_14, macd, macd_signal, macd_hist,
        range_20d_high, range_20d_low, range_width, fib_high, fib_low, fib_382, fib_500, fib_618,
        latest_close, latest_volume, to_char(latest_date,'YYYY-MM-DD') AS latest_date, pct_change_1d,
        extract(epoch from computed_at)::bigint AS computed_at
        FROM swing.stock_indicators ORDER BY stock_id`,
    },
    {
      d1: "swing_stock_screening",
      cols: [
        { name: "stock_id", type: "int" }, { name: "liquidity_ok", type: "int" },
        { name: "volatility_ok", type: "int" }, { name: "trend_ok_long", type: "int" },
        { name: "trend_ok_short", type: "int" }, { name: "supply_note", type: "text" },
        { name: "catalyst_note", type: "text" }, { name: "all_passed_long", type: "int" },
        { name: "all_passed_short", type: "int" }, { name: "computed_at", type: "int" },
      ],
      select: `SELECT stock_id, liquidity_ok::int AS liquidity_ok, volatility_ok::int AS volatility_ok,
        trend_ok_long::int AS trend_ok_long, trend_ok_short::int AS trend_ok_short,
        supply_note, catalyst_note,
        all_passed_long::int AS all_passed_long, all_passed_short::int AS all_passed_short,
        extract(epoch from computed_at)::bigint AS computed_at
        FROM swing.stock_screening ORDER BY stock_id`,
    },
    {
      d1: "swing_entry_signals",
      cols: [
        { name: "id", type: "int" }, { name: "stock_id", type: "int" },
        { name: "pattern", type: "text" }, { name: "direction", type: "text" },
        { name: "entry_price", type: "real" }, { name: "stop_loss", type: "real" },
        { name: "target_1", type: "real" }, { name: "target_2", type: "real" },
        { name: "risk_reward_ratio", type: "real" }, { name: "signal_strength", type: "real" },
        { name: "note", type: "text" }, { name: "computed_at", type: "int" },
      ],
      select: `SELECT id, stock_id, pattern, direction, entry_price, stop_loss,
        target_1, target_2, risk_reward_ratio, signal_strength, note,
        extract(epoch from computed_at)::bigint AS computed_at
        FROM swing.entry_signals ORDER BY id`,
    },
    {
      d1: "swing_market_context",
      cols: [
        { name: "date", type: "text" }, { name: "nikkei_close", type: "real" },
        { name: "nikkei_pct", type: "real" }, { name: "nikkei_vi", type: "real" },
        { name: "topix_turnover_ratio", type: "real" }, { name: "futures_gap", type: "real" },
        { name: "vix", type: "real" }, { name: "sp500_pct", type: "real" },
        { name: "judgment", type: "text" }, { name: "judgment_reason", type: "text" },
        { name: "computed_at", type: "int" },
      ],
      select: `SELECT to_char(date,'YYYY-MM-DD') AS date, nikkei_close, nikkei_pct, nikkei_vi,
        topix_turnover_ratio, futures_gap, vix, sp500_pct, judgment, judgment_reason,
        extract(epoch from computed_at)::bigint AS computed_at
        FROM swing.market_context ORDER BY date`,
    },
    {
      d1: "swing_sector_daily",
      cols: [
        { name: "id", type: "int" }, { name: "date", type: "text" },
        { name: "sector", type: "text" }, { name: "pct_1d", type: "real" },
        { name: "pct_5d", type: "real" }, { name: "stock_count", type: "int" },
        { name: "rank_1d", type: "int" },
      ],
      select: `SELECT id, to_char(date,'YYYY-MM-DD') AS date, sector, pct_1d, pct_5d,
        stock_count, rank_1d FROM swing.sector_daily ORDER BY id`,
    },
    {
      d1: "yutai_genres",
      cols: [
        { name: "id", type: "int" }, { name: "name", type: "text" },
        { name: "slug", type: "text" }, { name: "description", type: "text" },
        { name: "created_at", type: "int" },
      ],
      select: `SELECT id, name, slug, description,
        extract(epoch from created_at)::bigint AS created_at
        FROM public.yutai_genres ORDER BY id`,
    },
    {
      d1: "yutai_benefits",
      cols: [
        { name: "id", type: "int" }, { name: "stock_id", type: "int" },
        { name: "genre_id", type: "int" }, { name: "description", type: "text" },
        { name: "short_summary", type: "text" }, { name: "min_shares", type: "int" },
        { name: "record_month", type: "int" }, { name: "estimated_value", type: "int" },
        { name: "created_at", type: "int" }, { name: "updated_at", type: "int" },
      ],
      select: `SELECT id, stock_id, genre_id, description, short_summary, min_shares,
        record_month, estimated_value,
        extract(epoch from created_at)::bigint AS created_at,
        extract(epoch from updated_at)::bigint AS updated_at
        FROM public.yutai_benefits ORDER BY id`,
    },
    {
      d1: "otakara_stock_financials",
      cols: [
        { name: "id", type: "int" }, { name: "stock_id", type: "int" },
        { name: "price", type: "real" }, { name: "per", type: "real" },
        { name: "pbr", type: "real" }, { name: "dividend_yield", type: "real" },
        { name: "eps", type: "real" }, { name: "bps", type: "real" },
        { name: "roe", type: "real" }, { name: "roa", type: "real" },
        { name: "market_cap", type: "real" }, { name: "ma_5", type: "real" },
        { name: "ma_25", type: "real" }, { name: "ma_75", type: "real" },
        { name: "rsi_14", type: "real" }, { name: "macd", type: "real" },
        { name: "macd_signal", type: "real" }, { name: "yutai_yield", type: "real" },
        { name: "fetched_at", type: "int" }, { name: "data_date", type: "text" },
      ],
      select: `SELECT id, stock_id, price, per, pbr, dividend_yield, eps, bps, roe, roa,
        market_cap, ma_5, ma_25, ma_75, rsi_14, macd, macd_signal, yutai_yield,
        extract(epoch from fetched_at)::bigint AS fetched_at,
        to_char(data_date,'YYYY-MM-DD') AS data_date
        FROM public.stock_financials ORDER BY id`,
    },
    {
      d1: "otakara_stock_scores",
      cols: [
        { name: "id", type: "int" }, { name: "stock_id", type: "int" },
        { name: "fundamental_score", type: "real" }, { name: "technical_score", type: "real" },
        { name: "total_score", type: "real" }, { name: "scored_at", type: "int" },
      ],
      select: `SELECT id, stock_id, fundamental_score, technical_score, total_score,
        extract(epoch from scored_at)::bigint AS scored_at
        FROM public.stock_scores ORDER BY id`,
    },
    // 注: finmath_price_snapshot は drizzle/d1/0012 で D1 から DROP した。
    // 移送先の表が無いので定義を外す (残すと全表実行が DELETE の時点で落ちる)。
    {
      d1: "swing_daily_ohlcv",
      cols: [
        { name: "id", type: "int" }, { name: "stock_id", type: "int" },
        { name: "date", type: "text" }, { name: "open", type: "real" },
        { name: "high", type: "real" }, { name: "low", type: "real" },
        { name: "close", type: "real" }, { name: "volume", type: "real" },
      ],
      select: `SELECT id, stock_id, to_char(date,'YYYY-MM-DD') AS date,
        open, high, low, close, volume FROM swing.daily_ohlcv ORDER BY id`,
    },
    // 注: finmath_daily_ohlcv (~1.8M) は再生成可能な遅延キャッシュのため cutover 対象外。
  ];

  // --only=table1,table2 で対象テーブルを限定（既存の正本を再投入せず安全に追加移送）。
  const onlyArg = process.argv.find((a) => a.startsWith("--only="));
  const onlySet = onlyArg ? new Set(onlyArg.slice("--only=".length).split(",")) : null;
  const activeTables = onlySet ? tables.filter((t) => onlySet.has(t.d1)) : tables;
  if (activeTables.length === 0) throw new Error("--only に一致するテーブルがありません");

  const outArg = process.argv.find((a) => a.startsWith("--out="));
  const OUT = outArg ? outArg.slice("--out=".length) : DEFAULT_OUT;

  const maxRowsArg = process.argv.find((a) => a.startsWith("--maxRowsPerFile="));
  const maxRowsPerFile = maxRowsArg
    ? Number(maxRowsArg.slice("--maxRowsPerFile=".length))
    : 0;
  if (maxRowsPerFile && activeTables.length !== 1) {
    throw new Error("--maxRowsPerFile は単一テーブル (--only=<1つ>) のときのみ使えます");
  }

  const counts: Record<string, number> = {};

  // --- 分割モード (単一テーブル・巨大データ用) ---
  if (maxRowsPerFile) {
    const t = activeTables[0];
    const rows = (await sql.query(t.select)) as Record<string, unknown>[];
    counts[t.d1] = rows.length;
    const colList = t.cols.map((c) => c.name).join(", ");
    const outFiles: string[] = [];
    let part = 0;
    for (let start = 0; start < rows.length; start += maxRowsPerFile) {
      const fileRows = rows.slice(start, start + maxRowsPerFile);
      const parts: string[] = ["PRAGMA foreign_keys=OFF;"];
      // DELETE は最初の part だけ (全 part を順に適用する前提)
      if (part === 0) parts.push(`DELETE FROM ${t.d1};`);
      for (let i = 0; i < fileRows.length; i += ROWS_PER_INSERT) {
        const chunk = fileRows.slice(i, i + ROWS_PER_INSERT);
        const values = chunk
          .map((r) => "(" + t.cols.map((c) => sqlLit(r[c.name], c.type)).join(",") + ")")
          .join(",\n");
        parts.push(`INSERT INTO ${t.d1} (${colList}) VALUES\n${values};`);
      }
      parts.push("PRAGMA foreign_keys=ON;");
      const partPath = OUT.replace(/\.sql$/, "") + `.part${String(part + 1).padStart(2, "0")}.sql`;
      await fs.writeFile(partPath, parts.join("\n") + "\n");
      outFiles.push(partPath);
      part++;
    }
    console.log("OUT(split):", JSON.stringify(outFiles));
    console.log("COUNTS:", JSON.stringify(counts));
    return;
  }

  // --- 通常モード (単一ファイル) ---
  const parts: string[] = ["PRAGMA foreign_keys=OFF;"];
  // DELETE は子→親の逆順（FK OFF だが念のため）
  for (const t of [...activeTables].reverse()) parts.push(`DELETE FROM ${t.d1};`);

  for (const t of activeTables) {
    const rows = (await sql.query(t.select)) as Record<string, unknown>[];
    counts[t.d1] = rows.length;
    const colList = t.cols.map((c) => c.name).join(", ");
    for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
      const chunk = rows.slice(i, i + ROWS_PER_INSERT);
      const values = chunk
        .map(
          (r) =>
            "(" + t.cols.map((c) => sqlLit(r[c.name], c.type)).join(",") + ")"
        )
        .join(",\n");
      parts.push(`INSERT INTO ${t.d1} (${colList}) VALUES\n${values};`);
    }
  }
  parts.push("PRAGMA foreign_keys=ON;");

  await fs.writeFile(OUT, parts.join("\n") + "\n");
  console.log("OUT:", OUT);
  console.log("COUNTS:", JSON.stringify(counts));
}

main().catch((e) => {
  console.error("ERR:", e?.message ?? e);
  process.exit(1);
});
