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
 * そこで**クエリの形**を検査する。全列返しになる書き方は drizzle に 2 系統ある
 * ので、両方を非テストのソースから 0 件にする:
 *
 *   1. `.select()` (列指定なし) + `from(stocks)`
 *   2. `db.query.stocks.findFirst/findMany` で `columns` を省いたもの
 *
 * 2 を落とすと検査は無意味になる。1 だけを見ていた版では
 * services/otakara-yutai/app.ts の銘柄詳細 (`db.query.stocks.findFirst`) が
 * 全列を SSR プロセスへ載せたまま緑になっていた。regex も型も別系統の API には
 * 掛からない。
 *
 * 許可リストを持たないのは、例外を 1 件認めるとその 1 件が「行をどこへ渡して
 * いるか」の追跡を永久に要求し、追跡は人にしかできない（= いつか外れる）ため。
 * id だけ要る writer 経路も `select({ id: stocks.id })` と書けば済む。
 *
 * **静的検査の限界**: ここで見ているのは書き方だけで、実際に HTML/JSON へ出たか
 * は見ていない。銘柄詳細の出力に `personal-only` の値が出ないことは
 * services/otakara-yutai/src/tests/stock-detail-license.test.ts が
 * 番兵値を DB に入れて実測している。
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
  "services/rsi-screening/src/routes/pages.ts",
  "services/swing-trading/src/routes/pages.ts",
  "services/otakara-yutai/app.ts",
  "services/financial-math/src/routes/pages.ts",
  "services/ir-catalog/src/services/query.ts",
  "services/yuho-quant/src/services/order-query.ts",
  "services/yuho-quant/src/services/overseas-query.ts",
  // 以下 3 件は Worker の中で `core_stocks` を引くが、レスポンスを直接
  // 組み立てるのではなく取込 / キャッシュ充填の層。除外する理由を書き分けるより
  // 検査を受けさせた方が安い (現状どれも識別子を参照していない)。
  "services/otakara-yutai/src/services/yutai-scraper.ts",
  "services/financial-math/src/services/price-cache.ts",
  "services/ir-catalog/src/services/ingest.ts",
];

/**
 * 明示リストが本当に公開面を網羅しているかの下支え。
 *
 * `PUBLIC_SURFACE` を 2 件だけにしていた版は、`core_stocks` を引く公開面が
 * 実際には 8 件あるのに 2 件しか検査していなかった (リストが作られた時点で
 * 既に不完全)。「増えたら足すこと」と書いてあっても、足し忘れは検査自体には
 * 現れない。そこで**走査して見つかった公開面がリストに載っているか**を見る。
 *
 * ここに挙げたディレクトリは Worker がレスポンスを組み立てる層。
 * 取込 (data-scripts / src/cron) とスキーマ定義は対象外。
 */
const PUBLIC_SURFACE_DIRS = [
  join("services", "rsi-screening", "src"),
  join("services", "swing-trading", "src"),
  join("services", "otakara-yutai"),
  join("services", "financial-math", "src"),
  join("services", "ir-catalog", "src"),
  join("services", "yuho-quant", "src"),
];

/** 公開面の判定から外すもの (取込経路・スキーマ定義・クライアント JS 生成)。 */
const NOT_PUBLIC_SURFACE = /(^|[\\/])(data-scripts|db|tests)[\\/]/;

/** コメント (ブロック / 行) を除いた実コード。説明文まで弾かないため。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * 列指定なし select + from(stocks)。
 *
 * 識別子は **`stocks` で終わるもの全部**を拾う (`stocks` / `coreSchema.stocks` /
 * `coreStocks`)。`import { stocks as coreStocks }` の別名は
 * services/financial-math/src/services/price-cache.ts と
 * services/otakara-yutai/src/db/schema.ts で実際に使われている書き方なので、
 * `stocks` だけを見ていると別名にした瞬間に検査が素通りする。
 * `core_stocks` 以外に `*stocks` という名前の表は無い (確認済み) ため、
 * 接尾辞一致で誤検出は出ない。
 */
const BARE_SELECT_FROM_STOCKS =
  /\.select\(\s*\)\s*\.from\(\s*(?:\w+\.)?\w*[Ss]tocks\s*\)/g;

/**
 * `db.query.stocks.findFirst/findMany` のうち、**`columns` を持たないもの**。
 *
 * drizzle の関係クエリも `columns` を省くと全列返しで、`.select()` の禁止では
 * まったく塞げない (別系統の API なので regex にも型にも掛からない)。
 * services/otakara-yutai/app.ts の銘柄詳細が実際にこの形で `core_stocks` を
 * 引いていた。`columns` の中身までは静的に検証できないので、
 * **`columns` を書いているか**だけを見る。出力に漏れないことは
 * services/otakara-yutai/src/tests/stock-detail-license.test.ts が値で見ている。
 *
 * 対象を `findFirst`/`findMany` の呼び出しに続く最初の `{...}` の先頭付近に
 * 限らず、呼び出しから次の `}` までの範囲に `columns:` があるかで判定する
 * (ネストした `with` の中の `columns` も拾ってしまうため、先に検出した
 * 呼び出しの引数全体を対象にする)。
 */
const RELATIONAL_STOCKS_QUERY = /\bquery\s*\.\s*stocks\s*\.\s*(?:findFirst|findMany)\s*\(/g;

function countBareSelects(source: string): number {
  return (stripComments(source).match(BARE_SELECT_FROM_STOCKS) ?? []).length;
}

/**
 * `columns` を持たない `query.stocks.find*` の件数。
 *
 * 引数オブジェクトの範囲は波括弧の対応を数えて取る。regex で `\{[\s\S]*?\}` を
 * 使うと `with: { ... }` の最初の `}` で切れ、`columns` を書いてあっても
 * 書いていないと判定する / その逆が起きる。
 */
function countUnrestrictedRelationalQueries(source: string): number {
  const code = stripComments(source);
  let count = 0;
  for (const match of code.matchAll(RELATIONAL_STOCKS_QUERY)) {
    const open = code.indexOf("{", match.index + match[0].length - 1);
    if (open === -1) continue;
    let depth = 0;
    let end = code.length;
    for (let i = open; i < code.length; i++) {
      if (code[i] === "{") depth++;
      else if (code[i] === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    const args = code.slice(open + 1, end);
    // ネストを除いたトップレベルにだけ `columns:` を探す。
    let nest = 0;
    let topLevel = "";
    for (const ch of args) {
      if (ch === "{" || ch === "[" || ch === "(") nest++;
      else if (ch === "}" || ch === "]" || ch === ")") nest--;
      else if (nest === 0) topLevel += ch;
    }
    if (!/\bcolumns\s*:/.test(topLevel)) count++;
  }
  return count;
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

  it("columns を書かない query.stocks.find* がどこにも無い", () => {
    // `.select()` の禁止では塞がらない別系統の全列返し。
    const offenders = collectSources(join(ROOT, "src"))
      .concat(collectSources(join(ROOT, "services")))
      .map(
        (path) =>
          [
            relative(ROOT, path),
            countUnrestrictedRelationalQueries(readFileSync(path, "utf-8")),
          ] as const,
      )
      .filter(([, count]) => count > 0);
    expect(
      offenders,
      "db.query.stocks.find* には columns を書くこと。" +
        " 省くと core_stocks の personal-only 列まで返る",
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

  it("core_stocks を引く公開面が PUBLIC_SURFACE に全部載っている", () => {
    // リストへの足し忘れを検査に現れさせる。載っていない公開面は
    // personal-only 列の識別子検査を一切受けていない。
    const readsStocks = /\bfrom\(\s*(?:\w+\.)?\w*[Ss]tocks\s*\)|\bquery\s*\.\s*stocks\s*\./;
    const missing = PUBLIC_SURFACE_DIRS.flatMap((dir) => collectSources(join(ROOT, dir)))
      .map((path) => relative(ROOT, path))
      .filter((rel) => !NOT_PUBLIC_SURFACE.test(rel))
      .filter((rel) => readsStocks.test(stripComments(readFileSync(join(ROOT, rel), "utf-8"))))
      .filter((rel) => !PUBLIC_SURFACE.includes(rel.split(sep).join("/")));
    expect(missing, "PUBLIC_SURFACE に足すこと (公開面なら) / 対象外なら理由を書いて除外する").toEqual(
      [],
    );
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
    // 別名 import (`import { stocks as coreStocks }`) で抜けられない。
    // この書き方はリポジトリに実在するので、拾えないと検査が無効化される。
    expect(countBareSelects("db.select().from(coreStocks)")).toBe(1);
    expect(countBareSelects("db.select().from(schema.coreStocks)")).toBe(1);
  });

  it("関係クエリの検出器が columns の有無を取り違えない", () => {
    // columns なし = 全列返し
    expect(countUnrestrictedRelationalQueries("db.query.stocks.findFirst({ where: w })")).toBe(1);
    expect(countUnrestrictedRelationalQueries("db.query.stocks.findMany({})")).toBe(1);
    // columns あり = 通る
    expect(
      countUnrestrictedRelationalQueries("db.query.stocks.findFirst({ columns: { id: true } })"),
    ).toBe(0);
    // `with` の内側の columns をトップレベルと取り違えない (本番で踏んだ形)。
    // 波括弧の対応を数えずに `\{[\s\S]*?\}` で切ると、ここが 0 件になって
    // 「columns を書いてある」と誤判定する。
    expect(
      countUnrestrictedRelationalQueries(
        "db.query.stocks.findFirst({ where: w, with: { benefits: { columns: { minShares: true } } } })",
      ),
    ).toBe(1);
    // 逆向き: トップレベルに columns があり with の中には無い
    expect(
      countUnrestrictedRelationalQueries(
        "db.query.stocks.findFirst({ columns: { id: true }, with: { benefits: true } })",
      ),
    ).toBe(0);
    // 他表の関係クエリは対象外
    expect(countUnrestrictedRelationalQueries("db.query.benefits.findMany({})")).toBe(0);
    // コメント中の例示で落ちない
    expect(countUnrestrictedRelationalQueries("// db.query.stocks.findFirst({}) は禁止")).toBe(0);
  });
});
