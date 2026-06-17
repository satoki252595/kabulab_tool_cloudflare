/**
 * 簡易な DB 状態確認スクリプト。core / rsi / public スキーマのテーブル一覧と
 * 主要テーブルの行数を表示する。
 */
import "dotenv/config";
import { neon } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");
const sql = neon(url);

const tables = await sql.query(
  `SELECT table_schema, table_name FROM information_schema.tables
   WHERE table_schema IN ('core','rsi','public') AND table_type='BASE TABLE'
   ORDER BY table_schema, table_name`
);

console.log("=== tables ===");
for (const row of tables) {
  const fq = `"${row.table_schema}"."${row.table_name}"`;
  try {
    const r = await sql.query(`SELECT COUNT(*)::int AS c FROM ${fq}`);
    console.log(`  ${row.table_schema}.${row.table_name}  (${r[0].c} rows)`);
  } catch (e) {
    console.log(`  ${row.table_schema}.${row.table_name}  (count failed: ${e.message})`);
  }
}
