/**
 * 銘柄コード契約フィクスチャが「合成コードは 1300 未満」の規約を守っているかの静的検査。
 *
 * 2 系統ある:
 *   (1) 銘柄コード契約そのもの — tests/fixtures/contracts/stock-code-vectors.json
 *       (両リポ共有・CI cross-repo-contract の突合対象。stock-code-vectors.test.ts が
 *       実装の入出力を検証する側で、こちらはフィクスチャの値そのものを検査する) と
 *       services/vwap-analysis/lib/margin.test.ts (stockStock tests/test_jpx_margin.py
 *       と手動で値を揃えている合成 PDF フィクスチャ)。この 2 つが「種類株契約の根拠
 *       として実在コードを意図的に使う」場所そのものなので、許容リストもこの契約例
 *       (先頭 4 桁) に絞る。
 *   (2) instrument_type が equity 以外の行 — otakara-yutai / rsi-screening のテスト
 *       フィクスチャ。equity 以外を持つ行に実在コードを当てると「実在の普通株に
 *       非普通株の区分を付ける」事実誤りになるので、こちらは許容リストを空にする
 *       (どの実在コードも equity 以外の行には使わない)。
 *
 * どちらも 1300 未満は合成コードの領域として無条件に許容する (JPX 未割当であることを
 * 実測済み: 配信用 stocks.json の最小コードは 1301、D1 core_stocks の MIN(code) も
 * 1301)。新しく equity 以外の行を足すときは合成コード (1000〜1299) を使うこと。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 許容する実在コードの先頭 4 桁。この 2 ファイルが種類株契約の根拠として使っている
 * 「普通株の基本例 + それに紐づく優先株・種類株」の組だけを載せる。区分の語や会社名は
 * ここに書かない (許容リストは数値だけを見る)。
 */
const ALLOWED_REAL_PREFIXES = new Set([7203, 2593, 9434]);

/** 数字のみ・4〜5 文字のコードで、先頭 4 桁が 1300 以上かつ許容リスト外なら true。 */
function violatesSyntheticCodePolicy(code: string): boolean {
  if (!/^\d{4,5}$/.test(code)) return false; // 英字混じりコード (130A 系) は対象外
  const prefix = Number(code.slice(0, 4));
  if (prefix < 1300) return false;
  return !ALLOWED_REAL_PREFIXES.has(prefix);
}

interface Vector {
  input: string | null;
  normalize: string;
  parse: string | null;
  source_to_ticker: string | null;
  margin_to_key: string | null;
}

const VECTORS_PATH = fileURLToPath(
  new URL("../../../tests/fixtures/contracts/stock-code-vectors.json", import.meta.url)
);
const MARGIN_TEST_PATH = fileURLToPath(
  new URL("../../../services/vwap-analysis/lib/margin.test.ts", import.meta.url)
);
const VECTOR_FIELDS = ["input", "normalize", "parse", "source_to_ticker", "margin_to_key"] as const;

function loadVectors(): Vector[] {
  return (JSON.parse(readFileSync(VECTORS_PATH, "utf-8")) as { vectors: Vector[] }).vectors;
}

function vectorFieldViolations(): string[] {
  const offenders: string[] = [];
  for (const vector of loadVectors()) {
    for (const field of VECTOR_FIELDS) {
      const value = vector[field];
      if (typeof value === "string" && violatesSyntheticCodePolicy(value)) {
        offenders.push(`${field}="${value}"`);
      }
    }
  }
  return offenders;
}

/** margin.test.ts の `code: "…"` / `code === "…"` を拾う (プロパティ名 code のみ)。 */
const CODE_ASSIGNMENT = /\bcode\b\s*[:=]{1,3}\s*"(\d{4,5})"/g;

function marginTestCodeViolations(): string[] {
  const source = readFileSync(MARGIN_TEST_PATH, "utf-8");
  const offenders: string[] = [];
  for (const match of source.matchAll(CODE_ASSIGNMENT)) {
    if (violatesSyntheticCodePolicy(match[1])) offenders.push(match[1]);
  }
  return offenders;
}

describe("violatesSyntheticCodePolicy (検出器)", () => {
  it("1300 未満は合成コードの領域として許容する", () => {
    expect(violatesSyntheticCodePolicy("1299")).toBe(false);
    expect(violatesSyntheticCodePolicy("1202")).toBe(false);
    expect(violatesSyntheticCodePolicy("12024")).toBe(false);
  });

  it("1300 以上は許容リストに無ければ fail", () => {
    expect(violatesSyntheticCodePolicy("1300")).toBe(true);
    expect(violatesSyntheticCodePolicy("4001")).toBe(true);
    expect(violatesSyntheticCodePolicy("40015")).toBe(true);
  });

  it("先頭 4 桁が許容リストにあれば 5 文字目の検査文字によらず許容する", () => {
    expect(violatesSyntheticCodePolicy("7203")).toBe(false);
    expect(violatesSyntheticCodePolicy("72030")).toBe(false);
    expect(violatesSyntheticCodePolicy("25935")).toBe(false);
    expect(violatesSyntheticCodePolicy("94346")).toBe(false);
  });

  it("英字混じりコードは対象外 (数字コードだけを見る)", () => {
    expect(violatesSyntheticCodePolicy("130A")).toBe(false);
    expect(violatesSyntheticCodePolicy("130A5")).toBe(false);
  });

  it("先頭 0 は 1300 未満として扱う (leading-zero-5-char ベクタとの整合)", () => {
    expect(violatesSyntheticCodePolicy("07203")).toBe(false);
  });
});

describe("共有ベクタと margin フィクスチャが合成コード規約を守っている", () => {
  it("走査対象が空振りしていない (ガード自体の健全性)", () => {
    expect(loadVectors().length).toBeGreaterThan(10);
    expect(
      [...readFileSync(MARGIN_TEST_PATH, "utf-8").matchAll(CODE_ASSIGNMENT)].length
    ).toBeGreaterThan(3);
  });

  it("stock-code-vectors.json に許容リスト外の 1300 以上コードが無い", () => {
    expect(vectorFieldViolations()).toEqual([]);
  });

  it("margin.test.ts の code に許容リスト外の 1300 以上コードが無い", () => {
    expect(marginTestCodeViolations()).toEqual([]);
  });
});

/**
 * instrument_type が equity 以外の行を持つテストフィクスチャ。
 * 1 行に「1300 以上の数字コード」と「equity 以外の区分値」が同じ行で揃うと fail。
 */
const NON_EQUITY_SCAN_TARGETS = [
  "services/rsi-screening/src/tests/integration/screening-freshness.test.ts",
  "services/otakara-yutai/src/tests/screening-pagination.test.ts",
  "services/otakara-yutai/src/tests/yutai-full-import.test.ts",
  "services/otakara-yutai/src/tests/yutai-stock-universe.test.ts",
] as const;

/** 行内の 4〜5 桁の数字コード (クォート付き)。 */
const QUOTED_NUMERIC_CODE = /"(\d{4,5})"/g;
/** 行内の区分値らしきクォート付きの英小文字 (+アンダースコア) 語。equity は除く。 */
const NON_EQUITY_MARKER = /"(?!equity")[a-z][a-z_]*"/;

function nonEquityRowViolations(relPath: string): string[] {
  const abs = fileURLToPath(new URL(`../../../${relPath}`, import.meta.url));
  const offenders: string[] = [];
  readFileSync(abs, "utf-8")
    .split("\n")
    .forEach((line, i) => {
      if (!NON_EQUITY_MARKER.test(line)) return;
      for (const match of line.matchAll(QUOTED_NUMERIC_CODE)) {
        if (violatesSyntheticCodePolicy(match[1])) {
          offenders.push(`${relPath}:${i + 1}: ${match[1]}`);
        }
      }
    });
  return offenders;
}

describe("equity 以外の instrument_type を持つ行に実在コードが無い", () => {
  it("走査対象が空振りしていない (ガード自体の健全性)", () => {
    for (const relPath of NON_EQUITY_SCAN_TARGETS) {
      const abs = fileURLToPath(new URL(`../../../${relPath}`, import.meta.url));
      expect(NON_EQUITY_MARKER.test(readFileSync(abs, "utf-8")), relPath).toBe(true);
    }
  });

  it("検出器が同じ行の区分値とコードだけを拾う", () => {
    expect(NON_EQUITY_MARKER.test('code: "1201", instrumentType: "reit_fund"')).toBe(true);
    expect(NON_EQUITY_MARKER.test('code: "7203", instrumentType: "equity"')).toBe(false);
    expect(NON_EQUITY_MARKER.test('code: "9999", instrumentType: null')).toBe(false);
  });

  it.each(NON_EQUITY_SCAN_TARGETS)("%s に違反行が無い", (relPath) => {
    expect(nonEquityRowViolations(relPath)).toEqual([]);
  });
});
