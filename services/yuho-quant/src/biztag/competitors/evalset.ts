/**
 * 競合他社判定の較正用ラベル付き評価セット。
 * 設計: docs/005-yuho-quant-business-tags.md「競合他社」節 §3 較正セット。
 *
 * `evalset/v1.json` は**人手でキュレーションした評価セット**であり、単語帳の
 * ゴールデンセット (golden.ts) と同じ精神で作る:
 *   - 各社の `quote` は実在する有報「事業の内容」からの引用そのもの
 *     (作成時に `services/yuho-quant/data-scripts/_tmp_explore.ts` 相当の読取で
 *     取得した実文からの厳密な部分文字列であることを検証済み。捏造データ禁止・ルール1)。
 *   - 各組 (`pairs[]`) の `reason` は、両社の実際の開示内容 (`quote`/セグメント構成)
 *     に基づく判断根拠を明記する。
 *   - `category` は判断の型を明示する:
 *     - `same_market_substitute` (正例。同じ顧客層・市場に代替可能な製品/サービスを売る)
 *     - `supplier_customer` (負例。仕入先・販売先の関係)
 *     - `same_sector_different_product` (負例。同じ大分類業種だが製品が異なる)
 *     - `peripheral_overlap` (負例。重なりがどちらかの周辺事業に留まる)
 *     - `unrelated` (負例。事業の重なりが無い)
 *   - `same_market_substitute` は必ず `label=true`、他のカテゴリは必ず `label=false`
 *     (カテゴリの定義そのものが正負を決めるため。`assertEvalSetInvariants` が検査する)。
 */
import { readFileSync } from "node:fs";
import { z } from "../../../../../src/shared/zod-mini.js";
import { STOCK_CODE_REGEX } from "../../../../../src/shared/jpx/stock-code.js";

const nonEmpty = () => z.string().check(z.minLength(1));
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const EVAL_CATEGORIES = [
  "same_market_substitute",
  "supplier_customer",
  "same_sector_different_product",
  "peripheral_overlap",
  "unrelated",
] as const;
export type EvalCategory = (typeof EVAL_CATEGORIES)[number];

export const EvalCompanySchema = z.strictObject({
  name: nonEmpty(),
  sector33: z.nullable(z.string()),
  docId: nonEmpty(),
  periodEnd: nonEmpty(),
  /** 手動でまとめたクラスタ名 (自動導出には使わない。人が読むための注記)。 */
  group: z.nullable(z.string()),
  /** 実在する有報「事業の内容」からの引用 (厳密な部分文字列)。 */
  quote: z.string().check(z.minLength(10)),
});
export type EvalCompany = z.infer<typeof EvalCompanySchema>;

export const EvalPairSchema = z.strictObject({
  a: z.string().check(z.regex(STOCK_CODE_REGEX)),
  b: z.string().check(z.regex(STOCK_CODE_REGEX)),
  label: z.boolean(),
  category: z.enum(EVAL_CATEGORIES),
  reason: z.string().check(z.minLength(10)),
});
export type EvalPair = z.infer<typeof EvalPairSchema>;

export const CompetitorEvalSetSchema = z.strictObject({
  version: nonEmpty(),
  createdAt: z.string().check(z.regex(DATE_PATTERN)),
  companies: z.record(z.string().check(z.regex(STOCK_CODE_REGEX)), EvalCompanySchema),
  pairs: z.array(EvalPairSchema).check(z.minLength(1)),
});
export type CompetitorEvalSet = z.infer<typeof CompetitorEvalSetSchema>;

/** 組の向きに依らない一意キー (`a<b` の順に正規化)。 */
export function evalPairKey(pair: Pick<EvalPair, "a" | "b">): string {
  const [x, y] = [pair.a, pair.b].sort();
  return `${x}:${y}`;
}

/**
 * `assertGoldenSetInvariants` (golden.ts) と同じ精神の入力検査。
 * 黙って矛盾した入力を通さない (ルール2)。
 */
export function assertEvalSetInvariants(evalSet: CompetitorEvalSet): void {
  const seen = new Set<string>();
  for (const pair of evalSet.pairs) {
    if (pair.a === pair.b) {
      throw new Error(`assertEvalSetInvariants: 自己参照の組です (${pair.a})`);
    }
    if (!(pair.a in evalSet.companies)) {
      throw new Error(`assertEvalSetInvariants: companies に無い銘柄コードが pairs で参照されています (${pair.a})`);
    }
    if (!(pair.b in evalSet.companies)) {
      throw new Error(`assertEvalSetInvariants: companies に無い銘柄コードが pairs で参照されています (${pair.b})`);
    }
    const key = evalPairKey(pair);
    if (seen.has(key)) {
      throw new Error(`assertEvalSetInvariants: 組が重複しています (${key})`);
    }
    seen.add(key);
    if (pair.category === "same_market_substitute" && pair.label !== true) {
      throw new Error(
        `assertEvalSetInvariants: category=same_market_substitute は label=true でなければなりません (${key})`
      );
    }
    if (pair.category !== "same_market_substitute" && pair.label !== false) {
      throw new Error(
        `assertEvalSetInvariants: category=${pair.category} は label=false でなければなりません (${key})`
      );
    }
  }
  // quote が実在の引用であることの機械検証はここでは行わない (実文はこの JSON に
  // 持たない。作成時に quote を実データの部分文字列として検証済み — 上のコメント
  // 参照。将来のセット拡張時も同じ手順 (作成スクリプトでの厳密な substring 検証)
  // を踏むこと)。
}

/** `evalset/v1.json` を読む。 */
export function loadCompetitorEvalSet(): CompetitorEvalSet {
  const path = new URL("./evalset/v1.json", import.meta.url);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (e) {
    throw new Error(
      "services/yuho-quant/src/biztag/competitors/evalset/v1.json が見つかりません。" +
        "人手でキュレーションした評価セットを用意してから実行してください。",
      { cause: e }
    );
  }
  const evalSet = CompetitorEvalSetSchema.parse(JSON.parse(raw));
  assertEvalSetInvariants(evalSet);
  return evalSet;
}
