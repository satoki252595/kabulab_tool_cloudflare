/**
 * 一度きりの cutover: Neon(yuho 系 + 共有 core) → Cloudflare D1 へ実データ移送
 * (ADR-0001 §7)。型変換は Postgres 側で投影して決定論的に行う:
 *   timestamptz → epoch 秒(integer) / date → text 'YYYY-MM-DD' / boolean → 0|1
 * FK 整合のため Neon の serial id をそのまま D1 へ持ち込む。
 *
 * 生成物: drizzle/d1/_cutover-data.sql（DELETE → INSERT 群。冪等再実行可）。
 * 適用は呼び出し側で `wrangler d1 execute kabulab-cf --remote --file=...`。
 *
 * 実行: npx tsx scripts/migrate/yuho-neon-to-d1.ts
 */
import "dotenv/config";
import { promises as fs } from "node:fs";
import { neon } from "@neondatabase/serverless";

const OUT = "drizzle/d1/_cutover-data.sql";
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
  ];

  // --only=table1,table2 で対象テーブルを限定（既存の正本を再投入せず安全に追加移送）。
  const onlyArg = process.argv.find((a) => a.startsWith("--only="));
  const onlySet = onlyArg ? new Set(onlyArg.slice("--only=".length).split(",")) : null;
  const activeTables = onlySet ? tables.filter((t) => onlySet.has(t.d1)) : tables;
  if (activeTables.length === 0) throw new Error("--only に一致するテーブルがありません");

  const parts: string[] = ["PRAGMA foreign_keys=OFF;"];
  // DELETE は子→親の逆順（FK OFF だが念のため）
  for (const t of [...activeTables].reverse()) parts.push(`DELETE FROM ${t.d1};`);

  const counts: Record<string, number> = {};
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
