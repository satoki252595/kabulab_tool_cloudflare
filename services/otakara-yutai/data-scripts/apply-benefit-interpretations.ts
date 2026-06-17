/**
 * 解釈済みJSONL (chunk-*.jsonl) を読み込み、yutai_benefits の
 * short_summary と estimated_value を更新する。
 *
 * 入力 (このスクリプト位置基準の data/):
 *   - data/benefit-descriptions.jsonl  (idx -> ids配列の対応)
 *   - data/interpreted/chunk-*.jsonl   (idx -> shortSummary/estimatedValue)
 */
import "dotenv/config";
import { createDb } from "../src/db/client.js";
import { yutaiBenefits } from "../src/db/schema.js";
import { inArray } from "drizzle-orm";
import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// パスはこのスクリプトの位置基準で解決する (cwd 依存だと export/interpret と
// 出力先がズレてパイプラインが silent に繋がらなくなるため)。
const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "data");

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is not set");

const db = createDb(databaseUrl);

type SourceEntry = {
  idx: number;
  stockCode: string;
  stockName: string;
  description: string;
  minSharesList: number[];
  ids: number[];
  existingValues: (number | null)[];
};

type InterpretedEntry = {
  idx: number;
  shortSummary: string;
  estimatedValue: number | null;
};

async function main() {
  // 1. 元データ読み込み (idx -> ids)
  const sourcePath = join(DATA_DIR, "benefit-descriptions.jsonl");
  const sourceLines = readFileSync(sourcePath, "utf-8").trim().split("\n");
  const idxToIds = new Map<number, number[]>();
  for (const line of sourceLines) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line) as SourceEntry;
    idxToIds.set(entry.idx, entry.ids);
  }
  console.log(`Loaded ${idxToIds.size} source entries`);

  // 2. 解釈済みchunk全ファイル読み込み
  const interpretedDir = join(DATA_DIR, "interpreted");
  const chunkFiles = readdirSync(interpretedDir)
    .filter((f) => f.startsWith("chunk-") && f.endsWith(".jsonl"))
    .sort();
  console.log(`Found ${chunkFiles.length} chunk files`);

  const interpreted = new Map<number, InterpretedEntry>();
  for (const file of chunkFiles) {
    const content = readFileSync(join(interpretedDir, file), "utf-8");
    for (const line of content.trim().split("\n")) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line) as InterpretedEntry;
      interpreted.set(entry.idx, entry);
    }
  }
  console.log(`Loaded ${interpreted.size} interpretations`);

  // 3. idx -> {ids[], shortSummary, estimatedValue} の形で更新対象を構築
  const updateGroups: {
    ids: number[];
    shortSummary: string;
    estimatedValue: number | null;
  }[] = [];

  let missingIdxCount = 0;
  for (const [idx, entry] of interpreted) {
    const ids = idxToIds.get(idx);
    if (!ids) {
      missingIdxCount++;
      continue;
    }
    updateGroups.push({
      ids,
      shortSummary: entry.shortSummary,
      estimatedValue: entry.estimatedValue,
    });
  }
  if (missingIdxCount > 0) {
    console.warn(`Warning: ${missingIdxCount} interpretations had no matching source idx`);
  }
  console.log(`Update groups: ${updateGroups.length}`);

  // 4. バッチUPDATE実行
  let updatedRows = 0;
  let groupCount = 0;
  for (const group of updateGroups) {
    await db
      .update(yutaiBenefits)
      .set({
        shortSummary: group.shortSummary,
        estimatedValue: group.estimatedValue,
      })
      .where(inArray(yutaiBenefits.id, group.ids));
    updatedRows += group.ids.length;
    groupCount++;
    if (groupCount % 500 === 0) {
      console.log(`Progress: ${groupCount}/${updateGroups.length} groups, ${updatedRows} rows`);
    }
  }

  console.log(`Done. Updated ${updatedRows} rows across ${groupCount} groups.`);

  // 5. 推定不能率メトリクス (interpret 出力のドリフト早期検知用)
  //   estimated_value=NULL は「商品名から金額を機械推定できない」優待を
  //   素直に表現したもの (ルール1/2 整合: 捏造せず未取得を明示)。ただし
  //   割合が異常に高ければ system prompt 劣化やモデル劣化の兆候なので
  //   閾値超で warn を出す。
  let nullCount = 0;
  let totalCount = 0;
  for (const entry of interpreted.values()) {
    totalCount++;
    if (entry.estimatedValue === null) nullCount++;
  }
  const nullRatio = totalCount > 0 ? nullCount / totalCount : 0;
  const pct = (nullRatio * 100).toFixed(1);
  console.log(
    `推定不能率: ${nullCount}/${totalCount} (${pct}%) ※null は「金額推定不能」の正直表示`
  );
  const NULL_RATIO_WARN_THRESHOLD = 0.6;
  if (nullRatio > NULL_RATIO_WARN_THRESHOLD) {
    console.warn(
      `[apply] WARNING: 推定不能率が閾値 ${(NULL_RATIO_WARN_THRESHOLD * 100).toFixed(0)}% を超過。SYSTEM_PROMPT 劣化 / モデル劣化 / 入力データ品質悪化の可能性。chunk-*.jsonl をサンプルチェック推奨。`
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
