import "dotenv/config";
import { createDb } from "../db/client.js";
import { stocks } from "../db/core-schema.js";
import { sql } from "drizzle-orm";
import {
  isValidStockCode,
  normalizeStockCode,
} from "../../../../src/shared/jpx/stock-code.js";

/**
 * 銘柄マスタ投入スクリプト
 *
 * JPX公開の「上場銘柄一覧」CSVを想定したシード投入。
 * 本番では https://www.jpx.co.jp/markets/statistics-equities/misc/01.html の
 * Excelファイルをパースした結果を投入する。
 *
 * 初期投入としてはユーザーが指定したCSV/TSVファイルを読み込む想定。
 * パス: scripts/data/stocks.tsv (code<TAB>name<TAB>market<TAB>sector)
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not configured");
  }

  const filePath = resolve(process.cwd(), "scripts/data/stocks.tsv");
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    throw new Error(
      `銘柄マスタファイルが見つかりません: ${filePath}\n` +
        `scripts/data/stocks.tsv を code<TAB>name<TAB>market<TAB>sector 形式で用意してください。`
    );
  }

  const rows = content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => {
      const [rawCode, name, market, sector] = line.split("\t");
      // コードは正準形 (大文字・半角) に正規化して保存。数字 4 桁と JPX
      // 英数字コード (例: 130A) の両方を受理する。
      return { code: normalizeStockCode(rawCode), name, market, sector: sector || null };
    })
    .filter((r) => isValidStockCode(r.code) && r.name && r.market);

  if (rows.length === 0) {
    throw new Error("有効な銘柄データが見つかりません");
  }

  const db = createDb(databaseUrl);
  console.info(`[seed-stocks] ${rows.length}銘柄を投入中...`);

  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db
      .insert(stocks)
      .values(rows.slice(i, i + CHUNK))
      .onConflictDoUpdate({
        target: stocks.code,
        set: {
          name: sql`excluded.name`,
          market: sql`excluded.market`,
          sector: sql`excluded.sector`,
          updatedAt: sql`now()`,
        },
      });
  }

  console.info(`[seed-stocks] 完了: ${rows.length}件投入`);
}

main().catch((e) => {
  console.error("[seed-stocks] エラー:", e);
  process.exit(1);
});
