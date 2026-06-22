/**
 * 解釈済みJSONL (chunk-*.jsonl) を読み込み、yutai_benefits の
 * short_summary と estimated_value を更新する。
 *
 * 入力 (このスクリプト位置基準の data/):
 *   - data/benefit-descriptions.jsonl  (key -> ids配列の対応)
 *   - data/interpreted/chunk-*.jsonl   (key -> shortSummary/estimatedValue)
 *
 * 結合キーは内容アドレス `key` (benefitKey)。旧実装は位置 idx で結合していたが、
 * idx は再フェッチで振り直されるため別銘柄に解釈が貼り付く破損が起きた。key は
 * (stockCode, description) 由来で再フェッチを跨いで安定する。
 */
import "dotenv/config";
import { createD1HttpDb } from "../../../src/shared/db/d1-http-client.js";
import * as schema from "../src/db/schema.js";
import { yutaiBenefits } from "../src/db/schema.js";
import { inArray } from "drizzle-orm";
import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { benefitKey } from "./benefit-key.js";

// パスはこのスクリプトの位置基準で解決する (cwd 依存だと export/interpret と
// 出力先がズレてパイプラインが silent に繋がらなくなるため)。
const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "data");

const db = createD1HttpDb(schema);

type SourceEntry = {
  idx: number;
  key?: string;
  stockCode: string;
  stockName: string;
  description: string;
  minSharesList: number[];
  ids: number[];
  existingValues: (number | null)[];
};

type InterpretedEntry = {
  key: string;
  idx?: number;
  shortSummary: string;
  estimatedValue: number | null;
};

async function main() {
  // 1. 元データ読み込み (key -> ids)。key はファイル上の値に依存せず
  //    (stockCode, description) から再計算する (旧 source も読める)。
  const sourcePath = join(DATA_DIR, "benefit-descriptions.jsonl");
  const sourceLines = readFileSync(sourcePath, "utf-8").trim().split("\n");
  const keyToIds = new Map<string, number[]>();
  for (const line of sourceLines) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line) as SourceEntry;
    keyToIds.set(benefitKey(entry.stockCode, entry.description), entry.ids);
  }
  console.log(`Loaded ${keyToIds.size} source entries`);

  // 2. 解釈済みchunk全ファイル読み込み (key -> 解釈)
  const interpretedDir = join(DATA_DIR, "interpreted");
  const chunkFiles = readdirSync(interpretedDir)
    .filter((f) => f.startsWith("chunk-") && f.endsWith(".jsonl"))
    .sort();
  console.log(`Found ${chunkFiles.length} chunk files`);

  const interpreted = new Map<string, InterpretedEntry>();
  for (const file of chunkFiles) {
    const content = readFileSync(join(interpretedDir, file), "utf-8");
    for (const line of content.trim().split("\n")) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line) as InterpretedEntry;
      // 内容アドレス化後の chunk は必ず key を持つ。旧形式 (idx のみ) が残って
      // いたら整合の崩れた適用になるので黙って続けず throw (ルール2)。
      if (typeof entry.key !== "string" || entry.key.length === 0) {
        throw new Error(
          `${file} に key を持たない旧形式の行があります。先に salvage-realign-interpretations.ts で再整合してください。`
        );
      }
      interpreted.set(entry.key, entry);
    }
  }
  console.log(`Loaded ${interpreted.size} interpretations`);

  // 3. key -> {ids[], shortSummary, estimatedValue} の形で更新対象を構築
  const updateGroups: {
    ids: number[];
    shortSummary: string;
    estimatedValue: number | null;
  }[] = [];

  let missingKeyCount = 0;
  for (const [key, entry] of interpreted) {
    const ids = keyToIds.get(key);
    if (!ids) {
      missingKeyCount++;
      continue;
    }
    updateGroups.push({
      ids,
      shortSummary: entry.shortSummary,
      estimatedValue: entry.estimatedValue,
    });
  }
  if (missingKeyCount > 0) {
    console.warn(
      `Warning: ${missingKeyCount} interpretations had no matching source key (旧文言の解釈。現 source に無いので適用しない)`
    );
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
