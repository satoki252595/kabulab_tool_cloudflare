/**
 * 優待description をユニークに抽出して JSONL ファイルに出力する
 *
 * 出力: data/benefit-descriptions.jsonl (このスクリプト位置基準)
 * 各行: { "id": number, "description": string, "existingValue": number | null }
 */
import "dotenv/config";
import { createD1HttpDb } from "../../../src/shared/db/d1-http-client.js";
import * as schema from "../src/db/schema.js";
import { yutaiBenefits, stocks } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import { writeFileSync, mkdirSync, readFileSync } from "fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { recordPrimaryData } from "../../../src/shared/notion-archive/index.js";
import { benefitKey } from "./benefit-key.js";

// cwd 依存だと interpret/apply と入出力パスがズレるためスクリプト位置基準で解決
const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "data");

const db = createD1HttpDb(schema);

async function main() {
  const rows = await db
    .select({
      id: yutaiBenefits.id,
      description: yutaiBenefits.description,
      estimatedValue: yutaiBenefits.estimatedValue,
      minShares: yutaiBenefits.minShares,
      stockCode: stocks.code,
      stockName: stocks.name,
    })
    .from(yutaiBenefits)
    .innerJoin(stocks, eq(yutaiBenefits.stockId, stocks.id));

  console.log(`Total benefit rows: ${rows.length}`);

  // (stockCode, description) でグルーピング
  // 同じ銘柄の同じ文言は1つにまとめてIDリストを保持
  const byKey = new Map<
    string,
    {
      description: string;
      stockCode: string;
      stockName: string;
      ids: number[];
      existingValues: (number | null)[];
      minSharesList: number[];
    }
  >();
  for (const r of rows) {
    const key = `${r.stockCode}::${r.description}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        description: r.description,
        stockCode: r.stockCode,
        stockName: r.stockName,
        ids: [],
        existingValues: [],
        minSharesList: [],
      });
    }
    const entry = byKey.get(key)!;
    entry.ids.push(r.id);
    entry.existingValues.push(r.estimatedValue);
    entry.minSharesList.push(r.minShares);
  }

  console.log(`Unique (stock, description) pairs: ${byKey.size}`);

  // 出力ディレクトリ作成
  const outDir = DATA_DIR;
  mkdirSync(outDir, { recursive: true });

  // 決定的順序で出力する。旧実装は Map 挿入順 (= DB クエリ返却順、ORDER BY
  // 無し) に依存し idx がラン間で揺れたため、(stockCode, description) で安定
  // ソートして idx を再現可能にする。ただし interpret/apply の同一性判定は
  // idx ではなく内容ハッシュ key を正とするので、idx は人間可読の参考値。
  const sorted = [...byKey.values()].sort((a, b) => {
    if (a.stockCode !== b.stockCode)
      return a.stockCode < b.stockCode ? -1 : 1;
    return a.description < b.description
      ? -1
      : a.description > b.description
        ? 1
        : 0;
  });

  // JSONL で出力
  const outPath = join(outDir, "benefit-descriptions.jsonl");
  const lines: string[] = [];
  let idx = 0;
  for (const entry of sorted) {
    lines.push(
      JSON.stringify({
        idx: idx++,
        // 内容アドレスキー。再フェッチ (id 振り直し) を跨いで安定し、
        // interpret のキャッシュ再開と apply の結合の正キーになる。
        key: benefitKey(entry.stockCode, entry.description),
        stockCode: entry.stockCode,
        stockName: entry.stockName,
        description: entry.description,
        minSharesList: entry.minSharesList,
        ids: entry.ids,
        existingValues: entry.existingValues,
      }),
    );
  }
  writeFileSync(outPath, lines.join("\n") + "\n", "utf-8");
  console.log(`Wrote ${lines.length} lines to ${outPath}`);

  // ルール6: 優待一次データの確定スナップショット (JSONL) を物理ファイルとして
  // Notion へ実体アップロード。日付キーで冪等 (同日再実行は skip)。これは
  // 「取得バッチ単位の確定ファイル」粒度の記録 (per-stock JSON は DB が正本)。
  const day = new Date().toISOString().slice(0, 10);
  const bytes = readFileSync(outPath);
  await recordPrimaryData({
    service: "otakara-yutai",
    key: `benefit-descriptions-${day}`,
    source:
      "otakara-yutai/data-scripts/export-benefit-descriptions.ts (DB→JSONL 確定スナップショット)",
    metadata: {
      day,
      lineCount: lines.length,
      uniquePairs: byKey.size,
      totalBenefitRows: rows.length,
      bytes: bytes.byteLength,
    },
    files: [
      {
        bytes: new Uint8Array(bytes),
        filename: `benefit-descriptions-${day}.jsonl`,
        contentType: "application/x-ndjson",
      },
    ],
  });
  console.log(`Notion: benefit-descriptions-${day} を一次データ DB に記録`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
