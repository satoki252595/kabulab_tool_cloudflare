/**
 * 解釈済みJSONL (chunk-*.jsonl) を読み込み、yutai_benefits の
 * short_summary と estimated_value を更新する。
 *
 * 入力 (このスクリプト位置基準の data/):
 *   - data/benefit-descriptions.jsonl  (key -> ids配列の対応)
 *   - data/interpreted/chunk-*.jsonl   (key -> shortSummary/estimatedValue)
 *   - data/web-enriched/web-*.jsonl    (任意。key -> web推定値/出典URL。
 *     enrich-from-web.ts が金額表記なし自社商品について楽天市場API+ローカルLLM
 *     で推定したもの。interpret が null にした key のみ補填する)
 *
 * 値の出典は estimate_value_source 列で機械可読に分離する (ルール1):
 *   "company"=本文の企業公表/確定額, "web"=楽天由来の参考推定 (UIで「WEB推定」
 *   バッジ), null=推定不能。"web" のとき estimate_source_url に出典を残す。
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
import { readFileSync, readdirSync, existsSync } from "fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { benefitKey } from "./benefit-key.js";
import { checkSummary, formatViolations } from "./summary-contract.js";

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

  // 2.5 web 推定 (enrich-from-web.ts) の取り込み。金額表記なし自社商品について
  //     楽天市場 API + ローカル LLM が推定した参考値を、interpret が null にした
  //     key にだけ補填する。ディレクトリが無ければ Part B 未実行としてスキップ
  //     (Part A 単体でも apply は成立する)。
  //     ルール1: web 推定は estimate_value_source="web" + URL で企業公表値と
  //     機械可読に分離する。company 値を web で上書きはしない。
  const webDir = join(DATA_DIR, "web-enriched");
  const webByKey = new Map<
    string,
    { estimatedValue: number; estimateSourceUrl: string | null }
  >();
  if (existsSync(webDir)) {
    let webFiles = 0;
    for (const file of readdirSync(webDir).filter(
      (f) => f.startsWith("web-") && f.endsWith(".jsonl")
    )) {
      webFiles++;
      for (const line of readFileSync(join(webDir, file), "utf-8")
        .trim()
        .split("\n")) {
        if (!line.trim()) continue;
        const e = JSON.parse(line) as {
          key?: string;
          estimatedValue: number | null;
          estimateValueSource?: "web" | null;
          estimateSourceUrl?: string | null;
        };
        // 値が付いた web 推定 (estimateValueSource==="web") のみ採用。null 据え置き
        // (非物販/ヒット無し/根拠不足) は補填しないので無視する。
        if (
          typeof e.key === "string" &&
          e.estimateValueSource === "web" &&
          typeof e.estimatedValue === "number"
        ) {
          webByKey.set(e.key, {
            estimatedValue: e.estimatedValue,
            estimateSourceUrl: e.estimateSourceUrl ?? null,
          });
        }
      }
    }
    console.log(`Loaded web-enriched: ${webFiles} files / ${webByKey.size} 推定値`);
  }

  // 3. key -> 更新内容 を構築。値の出典を estimate_value_source で分離 (ルール1):
  //   - interpret が非 null  → "company" (本文の企業公表額/確定額)
  //   - interpret が null かつ web 推定あり → "web" (+ estimate_source_url)
  //   - どちらも無し → null (推定不能を正直表示)
  const updateGroups: {
    ids: number[];
    shortSummary: string;
    estimatedValue: number | null;
    estimateValueSource: "company" | "web" | null;
    estimateSourceUrl: string | null;
  }[] = [];

  let missingKeyCount = 0;
  let webFilledCount = 0;
  for (const [key, entry] of interpreted) {
    const ids = keyToIds.get(key);
    if (!ids) {
      missingKeyCount++;
      continue;
    }
    let estimatedValue = entry.estimatedValue;
    let estimateValueSource: "company" | "web" | null =
      entry.estimatedValue !== null ? "company" : null;
    let estimateSourceUrl: string | null = null;
    if (entry.estimatedValue === null) {
      const web = webByKey.get(key);
      if (web) {
        estimatedValue = web.estimatedValue;
        estimateValueSource = "web";
        estimateSourceUrl = web.estimateSourceUrl;
        webFilledCount++;
      }
    }
    updateGroups.push({
      ids,
      shortSummary: entry.shortSummary,
      estimatedValue,
      estimateValueSource,
      estimateSourceUrl,
    });
  }
  if (missingKeyCount > 0) {
    console.warn(
      `Warning: ${missingKeyCount} interpretations had no matching source key (旧文言の解釈。現 source に無いので適用しない)`
    );
  }
  console.log(
    `Update groups: ${updateGroups.length} (うち web 推定で補填 ${webFilledCount} 件)`
  );

  // 3.5 公開表示契約の最終ゲート。short_summary は公開面に出る唯一の優待内容
  //     テキストなので、掲載文の注記ブロックや説明文を持ち込んだものを DB へ
  //     入れない。違反は黙って直さず、該当を列挙して中止する (ルール2)。
  //     生成側 (interpret-benefits.ts) にも上限チェックはあるが lenientLength の
  //     退路があり、実測で 35 行がすり抜けていた。
  const violations: string[] = [];
  for (const group of updateGroups) {
    const found = checkSummary(group.shortSummary);
    if (found.length > 0) {
      violations.push(
        `  ids=[${group.ids.slice(0, 3).join(",")}${group.ids.length > 3 ? ",…" : ""}] ` +
          `${formatViolations(found)} :: ${group.shortSummary.slice(0, 70)}`
      );
    }
  }
  if (violations.length > 0) {
    const allowed = process.argv.includes("--allow-contract-violations");
    const head = `公開表示契約に違反する shortSummary が ${violations.length} 群あります:\n${violations.slice(0, 20).join("\n")}`;
    if (!allowed) {
      throw new Error(
        `${head}\n\n該当を再解釈 (pnpm interpret:yutai) してから再実行してください。` +
          `意図して流す場合のみ --allow-contract-violations を付けます。`
      );
    }
    console.warn(`[apply] WARNING (--allow-contract-violations 指定): ${head}`);
  }

  // 4. バッチUPDATE実行
  //   注: estimate_value_source / estimate_source_url 列は migration
  //   drizzle/d1/0005_*.sql の適用が前提。未適用だと D1 がカラム不在で
  //   エラーを返す (ルール2: 黙って続けず明示的に失敗する)。
  let updatedRows = 0;
  let groupCount = 0;
  for (const group of updateGroups) {
    await db
      .update(yutaiBenefits)
      .set({
        shortSummary: group.shortSummary,
        estimatedValue: group.estimatedValue,
        estimateValueSource: group.estimateValueSource,
        estimateSourceUrl: group.estimateSourceUrl,
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
