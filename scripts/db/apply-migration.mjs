/**
 * 任意の Drizzle 生成 SQL ファイルを Neon に直接適用する一時スクリプト。
 *
 * `pnpm db:push:*` が drizzle-kit の TTY 要求でうまく動かない環境向け。
 * `--> statement-breakpoint` で区切って 1 文ずつ Neon HTTP 経由で実行する。
 *
 *   node scripts/apply-migration.mjs services/rsi-screening/drizzle/0000_known_harrier.sql
 */
import "dotenv/config";
import { neon } from "@neondatabase/serverless";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const arg = process.argv[2];
if (!arg) {
  console.error("Usage: node scripts/apply-migration.mjs <path-to-sql>");
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");

const sql = neon(url);
const filePath = resolve(process.cwd(), arg);
const content = readFileSync(filePath, "utf-8");

const statements = content
  .split("--> statement-breakpoint")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

console.log(`Applying ${statements.length} statements from ${arg}...`);

for (let i = 0; i < statements.length; i++) {
  const stmt = statements[i];
  const preview = stmt.replace(/\s+/g, " ").slice(0, 80);
  try {
    // 1.0+ Neon serverless では引数なし SQL は sql.query() を使う
    await sql.query(stmt);
    console.log(`  [${i + 1}/${statements.length}] OK: ${preview}`);
  } catch (e) {
    console.error(`  [${i + 1}/${statements.length}] FAIL: ${preview}`);
    console.error(`    ${e.message}`);
    process.exit(1);
  }
}

console.log("\nDone.");
