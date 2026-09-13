/**
 * 銘柄コード契約の言語横断テスト。
 *
 * 期待値は `tests/fixtures/contracts/stock-code-vectors.json` にあり、同一バイト列の
 * ファイルを stockStock (Python) 側のテストも読む。**この JSON を直すと相手リポジトリの
 * 実装も直す必要がある** (CI の cross-repo-contract ジョブが両リポの JSON を diff する)。
 *
 * ここで押さえるのは 3 操作の区別:
 *   - normalize         … 表現揺れの吸収のみ (妥当性は見ない)
 *   - parse             … 4 文字の正準形か (取込済みデータ・URL パラメータ用)
 *   - source_to_ticker  … TDnet/EDINET の 5 文字形式 → 4 文字ティッカー
 *   - margin_to_key     … JPX 信用残 PDF の 5 文字形式 → rows[].code (種類株は 5 文字のまま)
 * この 3 つを 1 つの関数で兼ねようとして各実装が割れていた。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  STOCK_CODE_REGEX,
  marginCodeToKey,
  normalizeStockCode,
  parseStockCode,
  sourceCodeToTicker,
} from "./stock-code.js";
import { companyCodeToTicker } from "../../../services/ir-catalog/src/services/tdnet/types.js";
import { secCodeToTicker } from "../../../services/yuho-quant/src/services/edinet/types.js";

interface Vector {
  id: string;
  input: string | null;
  normalize: string;
  parse: string | null;
  source_to_ticker: string | null;
  margin_to_key: string | null;
  note: string;
}

const VECTORS_PATH = fileURLToPath(
  new URL("../../../tests/fixtures/contracts/stock-code-vectors.json", import.meta.url)
);
const fixture = JSON.parse(readFileSync(VECTORS_PATH, "utf8")) as {
  canonical_regex: string;
  vectors: Vector[];
};

describe("共有テストベクタ", () => {
  it("読み込めて空でない", () => {
    expect(fixture.vectors.length).toBeGreaterThan(15);
  });

  // パターン自体を両言語で固定する。正規表現リテラルを `\d` ではなく `[0-9]`
  // で書いているのは、Python の `re` パターン文字列と 1 文字ずつ一致させるため。
  it("正準パターンがベクタファイルの宣言と一致する", () => {
    expect(STOCK_CODE_REGEX.source).toBe(fixture.canonical_regex);
  });

  it("ベクタ id が重複していない", () => {
    const ids = fixture.vectors.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe.each(fixture.vectors)("ベクタ $id ($input)", (v: Vector) => {
  it(`normalize → ${JSON.stringify(v.normalize)}`, () => {
    expect(normalizeStockCode(v.input)).toBe(v.normalize);
  });

  it(`parse → ${JSON.stringify(v.parse)}`, () => {
    expect(parseStockCode(v.input)).toBe(v.parse);
  });

  it(`source_to_ticker → ${JSON.stringify(v.source_to_ticker)}`, () => {
    expect(sourceCodeToTicker(v.input)).toBe(v.source_to_ticker);
  });

  it(`margin_to_key → ${JSON.stringify(v.margin_to_key)}`, () => {
    expect(marginCodeToKey(v.input)).toBe(v.margin_to_key);
  });

  // 4 文字を返すなら source_to_ticker と同じ値。種類株を普通株のコードへ潰さない
  // (取り違え) ことの一般形。
  it("margin_to_key は別のティッカーの 4 文字を返さない", () => {
    const key = marginCodeToKey(v.input);
    if (key !== null && key.length === 4) expect(key).toBe(v.source_to_ticker);
  });

  // 取込 2 系統 (TDnet / EDINET) が共有ヘルパへ委譲しきっていることを、
  // 委譲先ではなく公開 API 側から確認する。片方だけ独自実装に戻ると落ちる。
  it(`companyCodeToTicker / secCodeToTicker も同じ答えを返す`, () => {
    expect(companyCodeToTicker(v.input)).toBe(v.source_to_ticker);
    expect(secCodeToTicker(v.input)).toBe(v.source_to_ticker);
  });
});
