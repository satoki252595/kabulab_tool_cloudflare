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
 *   (2) instrument_type が equity 以外の行 — otakara-yutai / rsi-screening / cron の
 *       テストフィクスチャ。equity 以外を持つ行に実在コードを当てると「実在の普通株に
 *       非普通株の区分を付ける」事実誤りになるので、こちらは許容リストを空にする
 *       (どの実在コードも equity 以外の行には使わない)。
 *   (3) 「合成コード」と注記したコード例 — classify.test.ts / stock-code.ts の
 *       docstring・コメント。区分値の形は取らないが、注記した値そのものが規約に
 *       違反していたら (= 実は合成でない) fail する。
 *
 * (1)〜(3) いずれも「同じ物理行」「同じ最小外側 `{ … }`」「直前のコメント/docstring
 * ブロック + 続く 1 行」のいずれかが一致すれば対応させる (詳細は下の findMarkerCodeViolations
 * のコメント)。オブジェクトリテラルを複数行に書いても (prettier 等で改行されても) 検出
 * でき、かつ配列の他の要素や無関係な it()/describe() へは波及しないようにするため。
 *
 * どれも 1300 未満は合成コードの領域として無条件に許容する (JPX 未割当であることを
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
 * マーカー (区分値・「合成コード」注記) とコードを「同じ検査単位」にあるときだけ
 * 対応させるための、3 種類の検査単位。1 つでも一致すれば同じ単位とみなす:
 *
 *   1. 同じ物理行 (行番号)。
 *   2. 同じ最小外側 `{ … }` (オブジェクトリテラルが複数行に整形されても、
 *      prettier 等で改行されても崩れない。配列の他の要素や外側の it()/describe()
 *      本体まで広がらないよう「最小」= 最も内側のものだけを使う)。
 *   3. 直前から連続するコメント/docstring 行 + それに続く 1 行 (comment block)。
 *      コメントで「先頭 4 文字の 1202 (合成コード) は…」と説明し、コードそのものは
 *      次の行の `expect(...)` にある、という書き方に対応する。空行またはコード行を
 *      1 つ消費すると新しいブロックへ切り替わるので、配列の要素同士が誤って
 *      1 つの単位に混ざることはない。
 */
interface Span {
  start: number;
  end: number;
}

/** 文字列・コメントの中身を読み飛ばしつつ、対応する `{ … }` の区間をすべて集める。 */
function findBraceSpans(source: string): Span[] {
  const spans: Span[] = [];
  const stack: number[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (ch === "{") {
      stack.push(i);
      i++;
      continue;
    }
    if (ch === "}") {
      const start = stack.pop();
      if (start !== undefined) spans.push({ start, end: i });
      i++;
      continue;
    }
    i++;
  }
  return spans;
}

/**
 * `{ … }` の中身が `;` を含まないか (= 関数本体やブロック文ではなく、値だけの
 * オブジェクトリテラルらしいか)。`it()`/`beforeEach()` などの本体は複数の
 * `;` 終端の文を持つので除外し、`{ code: "…", instrumentType: "…" }` のような
 * データだけの行だけを検査単位として使う (シブリング行への波及を防ぐ)。
 */
function isDataBrace(source: string, span: Span): boolean {
  return !source.slice(span.start + 1, span.end).includes(";");
}

/**
 * `pos` を含む「データだけの」`{ … }` (`isDataBrace`) のうち最も内側 (最小) の
 * ものを返す。無ければ null。
 */
function innermostBrace(source: string, spans: Span[], pos: number): Span | null {
  let best: Span | null = null;
  for (const s of spans) {
    if (
      s.start <= pos &&
      pos <= s.end &&
      isDataBrace(source, s) &&
      (!best || s.end - s.start < best.end - best.start)
    ) {
      best = s;
    }
  }
  return best;
}

/**
 * 各行に「コメントブロック ID」を振る。連続するコメント/docstring 行は同じ ID を保ち、
 * 空行またはコード行を 1 つ消費すると次の行から新しい ID になる (兄弟要素の混入防止)。
 */
function commentBlockIds(lines: string[], isCommentLine: (line: string) => boolean): number[] {
  const ids: number[] = [];
  let id = 0;
  for (const line of lines) {
    if (line.trim() === "") {
      ids.push(id);
      id++;
      continue;
    }
    ids.push(id);
    if (!isCommentLine(line)) id++;
  }
  return ids;
}

/** JS/TS のコメント行 (`//`, `/*`, `*` 継続行) を判定する。 */
function isJsCommentLine(line: string): boolean {
  return /^\s*(\/\/|\/\*|\*)/.test(line);
}

function lineIndexAt(source: string, pos: number): number {
  return source.slice(0, pos).split("\n").length - 1;
}

/**
 * `source` の中で `marker` にマッチする位置と `codePattern` にマッチする位置が
 * 上記 3 種類の検査単位のいずれかで一致し、かつそのコードが `violatesSyntheticCodePolicy`
 * に違反する場合に `"<行番号(1始まり)>: <コード>"` を返す。
 */
function findMarkerCodeViolations(source: string, marker: RegExp, codePattern: RegExp): string[] {
  const lines = source.split("\n");
  const braceSpans = findBraceSpans(source);
  const commentIds = commentBlockIds(lines, isJsCommentLine);

  function unitKeys(pos: number): string[] {
    const lineIndex = lineIndexAt(source, pos);
    const keys = [`line:${lineIndex}`, `comment:${commentIds[lineIndex]}`];
    const brace = innermostBrace(source, braceSpans, pos);
    if (brace) keys.push(`brace:${brace.start}-${brace.end}`);
    return keys;
  }

  const markerUnitKeys = new Set<string>();
  const markerRe = new RegExp(marker.source, marker.flags.includes("g") ? marker.flags : `${marker.flags}g`);
  for (const m of source.matchAll(markerRe)) {
    for (const key of unitKeys(m.index ?? 0)) markerUnitKeys.add(key);
  }

  const offenders: string[] = [];
  for (const m of source.matchAll(codePattern)) {
    const code = m[1];
    if (!violatesSyntheticCodePolicy(code)) continue;
    const pos = m.index ?? 0;
    if (unitKeys(pos).some((key) => markerUnitKeys.has(key))) {
      offenders.push(`${lineIndexAt(source, pos) + 1}: ${code}`);
    }
  }
  return offenders;
}

/**
 * instrument_type が equity 以外の行を持つテストフィクスチャ。
 * 「1300 以上の数字コード」と「equity 以外の区分値」が同じ検査単位にあると fail。
 */
const NON_EQUITY_SCAN_TARGETS = [
  "services/rsi-screening/src/tests/integration/screening-freshness.test.ts",
  "services/otakara-yutai/src/tests/screening-pagination.test.ts",
  "services/otakara-yutai/src/tests/yutai-full-import.test.ts",
  "services/otakara-yutai/src/tests/yutai-stock-universe.test.ts",
  "services/yuho-quant/src/tests/active-equity-universe.test.ts",
  "src/cron/daily-sector-aggregate.test.ts",
  "src/cron/momentum-projection.test.ts",
  "src/cron/universe.test.ts",
] as const;

/** クォート付きの 4〜5 桁の数字コード。 */
const QUOTED_NUMERIC_CODE = /"(\d{4,5})"/g;
/** 区分値らしきクォート付きの英小文字 (+アンダースコア) 語。equity は除く。 */
const NON_EQUITY_MARKER = /"(?!equity")[a-z][a-z_]*"/;

function nonEquityRowViolations(relPath: string): string[] {
  const abs = fileURLToPath(new URL(`../../../${relPath}`, import.meta.url));
  const source = readFileSync(abs, "utf-8");
  return findMarkerCodeViolations(source, NON_EQUITY_MARKER, QUOTED_NUMERIC_CODE).map(
    (v) => `${relPath}:${v}`
  );
}

describe("equity 以外の instrument_type を持つ行に実在コードが無い", () => {
  it("走査対象が空振りしていない (ガード自体の健全性)", () => {
    for (const relPath of NON_EQUITY_SCAN_TARGETS) {
      const abs = fileURLToPath(new URL(`../../../${relPath}`, import.meta.url));
      expect(NON_EQUITY_MARKER.test(readFileSync(abs, "utf-8")), relPath).toBe(true);
    }
  });

  it("検出器が区分値とコードだけを拾う", () => {
    expect(NON_EQUITY_MARKER.test('code: "1201", instrumentType: "reit_fund"')).toBe(true);
    expect(NON_EQUITY_MARKER.test('code: "7203", instrumentType: "equity"')).toBe(false);
    expect(NON_EQUITY_MARKER.test('code: "9999", instrumentType: null')).toBe(false);
  });

  it("複数行に整形されたオブジェクトリテラルからも拾う (prettier 等での再整形対策)", () => {
    const reformatted = [
      "await seed({",
      '  code: "4001",',
      "  minPercentile: 2,",
      "  computedAt: stale,",
      '  instrumentType: "reit_fund",',
      "});",
    ].join("\n");
    expect(findMarkerCodeViolations(reformatted, NON_EQUITY_MARKER, QUOTED_NUMERIC_CODE)).toEqual([
      "2: 4001",
    ]);
  });

  it("配列の兄弟要素には波及しない (誤検知しない)", () => {
    const source = [
      "const STOCKS = [",
      '  { id: 1, code: "9999", instrumentType: null },',
      '  { id: 2, code: "1201", instrumentType: "reit_fund" },',
      '  { id: 3, code: "6501", instrumentType: "equity" },',
      "];",
    ].join("\n");
    expect(findMarkerCodeViolations(source, NON_EQUITY_MARKER, QUOTED_NUMERIC_CODE)).toEqual([]);
  });

  it.each(NON_EQUITY_SCAN_TARGETS)("%s に違反が無い", (relPath) => {
    expect(nonEquityRowViolations(relPath)).toEqual([]);
  });
});

/**
 * 「合成コード」と注記した値が実際に規約 (1300 未満 or 許容リスト) を満たしているかの
 * 検査。classify.test.ts / stock-code.ts は区分値 (instrumentType) の形を取らず、
 * コメント・docstring で「合成コード」と明記する形で実在コードとの置換を記録している。
 * 注記だけ残してコードを実在値へ書き戻す (雑な revert) を検出する。
 */
const SYNTHETIC_MARKER_SCAN_TARGETS = [
  "services/ir-catalog/src/tests/classify.test.ts",
  "src/shared/jpx/stock-code.ts",
] as const;

/** クォートまたはバッククォート付きの 4〜5 桁の数字コード。 */
const CODE_LITERAL = /[`"](\d{4,5})[`"]/g;
/** 「合成コード」の注記。区分値と違い自然文なので "合成" の有無だけを見る。 */
const SYNTHETIC_MARKER = /合成/;

function syntheticMarkerViolations(relPath: string): string[] {
  const abs = fileURLToPath(new URL(`../../../${relPath}`, import.meta.url));
  const source = readFileSync(abs, "utf-8");
  return findMarkerCodeViolations(source, SYNTHETIC_MARKER, CODE_LITERAL).map(
    (v) => `${relPath}:${v}`
  );
}

describe("「合成コード」と注記した値が実際に合成コード規約を満たす", () => {
  it("走査対象が空振りしていない (ガード自体の健全性)", () => {
    for (const relPath of SYNTHETIC_MARKER_SCAN_TARGETS) {
      const abs = fileURLToPath(new URL(`../../../${relPath}`, import.meta.url));
      expect(SYNTHETIC_MARKER.test(readFileSync(abs, "utf-8")), relPath).toBe(true);
    }
  });

  it("注記のある行から離れた、続く文のコードも拾う (comment block)", () => {
    const source = [
      "  // 先頭 4 文字の 1202 (合成コード) は core_stocks に無いため、",
      "  // 旧実装でも次行の codeToId 突合で落ちていた。",
      '  expect(companyCodeToTicker("40015")).toBeNull();',
    ].join("\n");
    expect(findMarkerCodeViolations(source, SYNTHETIC_MARKER, CODE_LITERAL)).toEqual(["3: 40015"]);
  });

  it("無関係な手前の it() ブロックには波及しない (誤検知しない)", () => {
    const source = [
      'it("別のテスト", () => {',
      '  expect(companyCodeToTicker("6549")).toBe("6549");',
      "});",
      "",
      'it("合成コードのテスト", () => {',
      '  // 合成コード 1202',
      '  expect(companyCodeToTicker("12024")).toBeNull();',
      "});",
    ].join("\n");
    expect(findMarkerCodeViolations(source, SYNTHETIC_MARKER, CODE_LITERAL)).toEqual([]);
  });

  it.each(SYNTHETIC_MARKER_SCAN_TARGETS)("%s に違反が無い", (relPath) => {
    expect(syntheticMarkerViolations(relPath)).toEqual([]);
  });
});
