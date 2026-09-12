/**
 * 【一回限りの移行スクリプト】既存の解釈 chunk を内容アドレス key へ再整合する。
 *
 * 背景: 旧パイプラインは位置 idx をキャッシュ/結合キーに流用していた。idx は
 * 再フェッチ (`fetch-yutai-full.ts` の全削除→再INSERT) で振り直されるため、
 * 現 source の idx と既存 chunk の idx が指す (銘柄, 文言) はもはや別物になり、
 * apply が旧 idx の解釈を別銘柄へ適用する破損が起きていた (円金額の一致率 5.8%)。
 *
 * 救済の根拠: 既存 chunk は **その当時の source (= git HEAD のコミット済み
 * benefit-descriptions.jsonl) と同じ idx で生成された**。したがって
 *   旧 source: oldIdx -> (stockCode, description)
 *   既存 chunk : oldIdx -> {shortSummary, estimatedValue}
 * を idx で突き合わせれば、当時の (銘柄, 文言) と解釈の対応 (= これは常に正しい)
 * を復元できる。これを内容アドレス key に変換し、現 source に存在する key の分
 * だけ新フォーマット (key 付き) の chunk へ書き直す。LLM 再実行は不要。
 *
 * 手順:
 *   1. 現 source (ディスク) を読み、有効な key 集合を作る。
 *   2. 旧 source を `git show HEAD:<path>` で取得し oldIdx -> key を作る。
 *   3. 既存 chunk (idx 形式) を読み oldIdx -> 解釈 を作る。
 *   4. key -> 解釈 を構築し、現 source に存在する key だけ採用。
 *   5. 既存 chunk-*.jsonl を全削除し、救済分を data/interpreted/chunk-salvaged.jsonl
 *      に新フォーマットで書き出す。
 *
 * 実行後: `pnpm interpret:yutai` で現 source の未解釈 key (新規/変更文言) だけが
 * 補完され、`apply-benefit-interpretations.ts` が key 結合で正しく反映する。
 *
 * ルール2 整合: 旧 source が取得できない / 既存 chunk が旧形式でない 等の前提
 * 崩れは黙って続行せず throw する。捏造や部分適用はしない。
 *
 * 実行: pnpm exec tsx services/otakara-yutai/data-scripts/salvage-realign-interpretations.ts
 */
import { execFileSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { benefitKey } from "./benefit-key.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(SCRIPT_DIR, "data");
const SOURCE_PATH = join(DATA_DIR, "benefit-descriptions.jsonl");
const INTERPRETED_DIR = join(DATA_DIR, "interpreted");
/** git HEAD 上の旧 source の相対パス (リポジトリルート基準)。 */
const SOURCE_REPO_RELPATH =
  "services/otakara-yutai/data-scripts/data/benefit-descriptions.jsonl";
/** 救済分の出力先 (1 ファイルに集約)。 */
const SALVAGED_OUT = join(INTERPRETED_DIR, "chunk-salvaged.jsonl");

type SourceRow = {
  idx: number;
  stockCode: string;
  description: string;
};
type ChunkRow = {
  idx: number;
  key?: string;
  shortSummary: string;
  estimatedValue: number | null;
};

function parseJsonl<T>(content: string): T[] {
  const out: T[] = [];
  for (const line of content.trim().split("\n")) {
    if (!line.trim()) continue;
    out.push(JSON.parse(line) as T);
  }
  return out;
}

function main(): void {
  if (!existsSync(SOURCE_PATH)) {
    throw new Error(`${SOURCE_PATH} が見つかりません。先に export を実行してください。`);
  }
  if (!existsSync(INTERPRETED_DIR)) {
    throw new Error(`${INTERPRETED_DIR} が見つかりません。救済対象がありません。`);
  }

  // 1. 現 source: key -> 件数 (有効 key 集合)。同じ (銘柄, 文言) は 1 key。
  const currentRows = parseJsonl<SourceRow>(readFileSync(SOURCE_PATH, "utf-8"));
  const validKeys = new Set<string>();
  for (const r of currentRows) {
    validKeys.add(benefitKey(r.stockCode, r.description));
  }
  console.log(`現 source: ${currentRows.length} 行 / ユニーク key ${validKeys.size}`);

  // 2. 旧 source (git HEAD): oldIdx -> key
  let oldSourceRaw: string;
  try {
    oldSourceRaw = execFileSync(
      "git",
      ["show", `HEAD:${SOURCE_REPO_RELPATH}`],
      { encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 }
    );
  } catch (e) {
    throw new Error(
      `git HEAD から旧 source を取得できませんでした (${SOURCE_REPO_RELPATH})。` +
        `救済は旧 source に依存します: ${(e as Error).message}`,
      { cause: e }
    );
  }
  const oldRows = parseJsonl<SourceRow>(oldSourceRaw);
  const oldIdxToKey = new Map<number, string>();
  for (const r of oldRows) {
    oldIdxToKey.set(r.idx, benefitKey(r.stockCode, r.description));
  }
  console.log(`旧 source (git HEAD): ${oldRows.length} 行`);

  // 3. 既存 chunk (idx 形式) を読む。key 付き (= 既に新形式) の行は別経路で
  //    そのまま採用する (二重移行に耐える)。
  const chunkFiles = readdirSync(INTERPRETED_DIR).filter(
    (f) => f.startsWith("chunk-") && f.endsWith(".jsonl")
  );
  if (chunkFiles.length === 0) {
    throw new Error(`${INTERPRETED_DIR} に chunk-*.jsonl がありません。`);
  }

  // key -> 解釈。新形式 (key 付き) と、旧形式 (idx→旧source→key) の両方を収集。
  const byKey = new Map<string, { shortSummary: string; estimatedValue: number | null }>();
  let fromKeyed = 0;
  let fromIdx = 0;
  let idxNoOldSource = 0; // 旧 source に該当 idx が無い (説明不能。throw 対象)
  for (const f of chunkFiles) {
    const rows = parseJsonl<ChunkRow>(readFileSync(join(INTERPRETED_DIR, f), "utf-8"));
    for (const r of rows) {
      if (typeof r.key === "string" && r.key.length > 0) {
        byKey.set(r.key, {
          shortSummary: r.shortSummary,
          estimatedValue: r.estimatedValue,
        });
        fromKeyed++;
        continue;
      }
      // 旧形式: idx を旧 source で key に変換
      const key = oldIdxToKey.get(r.idx);
      if (!key) {
        idxNoOldSource++;
        continue;
      }
      byKey.set(key, {
        shortSummary: r.shortSummary,
        estimatedValue: r.estimatedValue,
      });
      fromIdx++;
    }
  }
  console.log(
    `既存 chunk: ${chunkFiles.length} ファイル / key付き採用 ${fromKeyed} / idx→key 変換 ${fromIdx}`
  );
  if (idxNoOldSource > 0) {
    // 旧 source に存在しない idx の解釈。前提 (chunk は git HEAD と同 idx で生成)
    // が崩れている。黙って捨てず明示的に失敗させる。
    throw new Error(
      `旧 source に該当 idx が無い chunk 行が ${idxNoOldSource} 件あります。` +
        `git HEAD の benefit-descriptions.jsonl が chunk 生成時と一致していない可能性。`
    );
  }

  // 4. 現 source に存在する key だけ採用
  const salvaged: ChunkRow[] = [];
  let droppedObsolete = 0;
  for (const [key, v] of byKey) {
    if (!validKeys.has(key)) {
      droppedObsolete++; // 現 source に無い旧文言 → 採用しない
      continue;
    }
    salvaged.push({
      idx: -1, // idx は参考値。救済分は元 idx を持たないので -1 で明示。
      key,
      shortSummary: v.shortSummary,
      estimatedValue: v.estimatedValue,
    });
  }
  const coverage = validKeys.size > 0 ? (100 * salvaged.length) / validKeys.size : 0;
  console.log(
    `救済: ${salvaged.length} 件を現 source に再整合 (現 source の ${coverage.toFixed(1)}% をカバー) / 旧文言で破棄 ${droppedObsolete} 件`
  );
  console.log(
    `残り未解釈 (interpret で補完される新規/変更文言): ${validKeys.size - salvaged.length} 件`
  );

  // 5. 既存 chunk を全削除し、救済分を 1 ファイルに書き出す。
  if (!existsSync(INTERPRETED_DIR)) mkdirSync(INTERPRETED_DIR, { recursive: true });
  for (const f of chunkFiles) {
    unlinkSync(join(INTERPRETED_DIR, f));
  }
  const out = salvaged.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(SALVAGED_OUT, out, "utf-8");
  console.log(`書き出し: ${SALVAGED_OUT} (${salvaged.length} 行)`);
  console.log(
    "完了。次は: pnpm interpret:yutai (新規分のみ補完) → apply-benefit-interpretations.ts (key 結合で反映)"
  );
}

main();
