/**
 * `core_stocks` のライセンス境界ガード。
 *
 * `core_stocks` の `market` / `sector17` / `sector33` / `instrument_type` /
 * `license_tag` / `src_source` / `quality` は `personal-only` で、公開面へ
 * **新たに**出してはいけない。
 *
 * 危ないのは列名を書いた漏れではなく、**列名を一度も書かない漏れ**である。
 * drizzle の既定 select は全列返しなので、`db.select().from(stocks)` は
 * 宣言に列を足した瞬間から `personal-only` 列を含んだ行を返し始める。
 * 呼び出し側が必要フィールドだけ詰め替えていれば今日は漏れないが、
 * 行を spread した / JSON にそのまま流した 1 箇所で崩れ、型でも lint でも
 * 検出できない。2026-09-12 時点では 12 列すべて本番で全行 NULL なので実害は
 * 無いが、移行 P4b が値を入れた瞬間に経路が開く。
 *
 * そこで**クエリの形**を検査する: 非テストのソースに
 * 「列指定なし select + from(stocks)」を 1 件も置かない。許可リストを持たない
 * のは、例外を 1 件認めるとその 1 件が「行をどこへ渡しているか」の追跡を
 * 永久に要求し、追跡は人にしかできない（= いつか外れる）ため。id だけ要る
 * writer 経路も `select({ id: stocks.id })` と書けば済む。
 *
 * 併せて、公開面のファイルに `personal-only` 列の識別子が現れないことも見る
 * (列を明示して出してしまう素直な漏れ方を塞ぐ)。
 *
 * **`market` は検査対象から外している。** `personal-only` だが銘柄詳細ページ /
 * API が以前から市場区分を表示しており、既存の公開を止めるのはこのガードの
 * 仕事ではない (制約は「新たに出さない」)。ここへ足すなら公開面の表示を
 * 落とす PR と一緒にやること。外してある理由を書かずに消すと、次の人が
 * 「market は personal-only ではない」と読む。
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** リポジトリルート (src/shared/db/ から 3 階層上)。 */
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/**
 * 移行 P4a が足した `personal-only` 列。左が drizzle のプロパティ名、
 * 右が列名。`market` を含めない理由は冒頭コメント。
 */
const PERSONAL_ONLY_IDENTIFIERS = [
  "sector33",
  "sector17",
  "instrumentType",
  "instrument_type",
  "licenseTag",
  "license_tag",
  "srcSource",
  "src_source",
  "quality",
] as const;

/**
 * 公開面 = 本番の Worker がレスポンスを組み立てるために `core_stocks` を読む
 * ファイル。**実在検証つきの明示リスト**にしてある (walk だと対象が移動しても
 * 静かに 0 件になる)。公開面を増やしたらここに足すこと。
 */
const PUBLIC_SURFACE = [
  "services/rsi-screening/src/services/stock-detail-service.ts",
  "services/swing-trading/src/routes/pages.ts",
];

/** コメント (ブロック / 行) を除いた実コード。説明文まで弾かないため。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * 列指定なし select + from(stocks)。
 * `stocks` / `coreSchema.stocks` の両方の書き方を拾い、改行を挟むチェーンも拾う。
 */
const BARE_SELECT_FROM_STOCKS = /\.select\(\s*\)\s*\.from\(\s*(?:\w+\.)?stocks\s*\)/g;

function countBareSelects(source: string): number {
  return (stripComments(source).match(BARE_SELECT_FROM_STOCKS) ?? []).length;
}

/** 走査対象のソース (テストと型定義は除く)。 */
function collectSources(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === "coverage") {
      continue;
    }
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      collectSources(path, acc);
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    if (/\.test\.tsx?$/.test(entry) || /\.d\.ts$/.test(entry)) continue;
    if (relative(ROOT, path).split(sep).includes("tests")) continue;
    acc.push(path);
  }
  return acc;
}

describe("core_stocks の personal-only 列を公開面へ出さない", () => {
  it("列指定なし select + from(stocks) がどこにも無い", () => {
    // ここが 1 件でも増えると、その行は core_stocks の全列を持って歩き回る。
    // どこへ渡しているかの追跡は人にしかできないので、形で禁じる。
    const offenders = collectSources(join(ROOT, "src"))
      .concat(collectSources(join(ROOT, "services")))
      .map((path) => [relative(ROOT, path), countBareSelects(readFileSync(path, "utf-8"))] as const)
      .filter(([, count]) => count > 0);
    expect(
      offenders,
      "列を明示すること (例: select({ id: stocks.id }))。" +
        " 列指定なしは core_stocks の personal-only 列まで返す",
    ).toEqual([]);
  });

  it("走査が空振りしていない (ガード自体の健全性)", () => {
    // collectSources が 0 件を返すと上のテストは無条件に緑になる。
    const sources = collectSources(join(ROOT, "src")).concat(
      collectSources(join(ROOT, "services")),
    );
    expect(sources.length).toBeGreaterThan(100);
    // core_stocks を実際に引いているファイルが走査に入っていること。
    expect(
      sources.some((p) => p.endsWith(join("services", "swing-trading", "src", "routes", "pages.ts"))),
    ).toBe(true);
  });

  it.each(PUBLIC_SURFACE)("%s が実在する (リストが古くなっていない)", (rel) => {
    const path = join(ROOT, rel);
    expect(existsSync(path), `${rel} が無い (PUBLIC_SURFACE が古い)`).toBe(true);
    expect(statSync(path).isFile()).toBe(true);
  });

  it.each(PUBLIC_SURFACE)("%s が personal-only 列を参照しない", (rel) => {
    const code = stripComments(readFileSync(join(ROOT, rel), "utf-8"));
    const found = PERSONAL_ONLY_IDENTIFIERS.filter((id) =>
      new RegExp(`\\b${id}\\b`).test(code),
    );
    expect(found, `${rel} が personal-only 列を参照しています`).toEqual([]);
  });

  it("検出器が名前を変えただけでは抜けられない", () => {
    // ガードそのものの回帰テスト。
    expect(countBareSelects("db.select().from(stocks)")).toBe(1);
    expect(countBareSelects("db.select().from(coreSchema.stocks)")).toBe(1);
    expect(countBareSelects("db\n  .select()\n  .from(stocks)\n")).toBe(1);
    expect(countBareSelects("db.select( ).from( stocks )")).toBe(1);
    // 列を明示していれば通る
    expect(countBareSelects("db.select({ id: stocks.id }).from(stocks)")).toBe(0);
    // 他表の列指定なし select は対象外 (core_stocks だけがライセンス境界を持つ)
    expect(countBareSelects("db.select().from(stockFinancials)")).toBe(0);
    // コメント中の例示で落ちない
    expect(countBareSelects("// db.select().from(stocks) は禁止")).toBe(0);
  });
});
