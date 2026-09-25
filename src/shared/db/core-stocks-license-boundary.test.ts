/**
 * `core_stocks` のライセンス境界ガード。
 *
 * `core_stocks` は 1 行に出所の違う列を混ぜている。JPX「東証上場銘柄一覧
 * (data_j.xls)」由来の `market` / `sector` / `instrument_type` は
 * **personal-only** で、公開面 (無認証の HTML / JSON) へ出してはいけない。
 * EDINET コードリスト由来の `code` / `name` / `sector33` は commercial-ok。
 *
 * ⚠️ 2026-09-25: `license_tag` / `src_source` / `quality`（判断そのものの3列）
 * と `edinet_code`（EDINET 由来の commercial-ok 列）は書込経路が無く全行 NULL
 * だったため列ごと DROP した（本番実測。core-schema.ts 参照）。列が存在しない
 * ので、以下のガードは `market` / `sector` / `instrument_type` の3列だけを見る。
 *

 * ## 2026-09-13 に検査範囲を変えた
 *
 * それまで `market` は「以前から公開しているので、止めるのはこのガードの
 * 仕事ではない」として**検査対象から外していた**。同日、公開面の表示を落とす
 * 変更 (src/shared/db/public-columns.ts) と一緒に対象へ入れた。
 * `sector` (JPX 33 業種を src/cron/universe.ts が `sector: r.sector33` で
 * 書いている) も同じ理由で入れた。
 *
 * 逆に **`sector33` は対象から外した**。`core_stocks.sector33` を書いているのは
 * stockStock の `collectors/edinet_codelist.py` だけで、そこは EDINET
 * コードリストの「提出者業種」を `license_tag=commercial-ok` として取得している。
 * 公開面の業種表示はこの列へ切り替えた (= 出してよい列になった)。
 *
 * 2026-09-14 に stockStock 側の宣言も `sector33` を commercial-ok に直した
 * (列単位ライセンス地図 `tests/fixtures/contracts/d1-license-map.json`)。
 * 宣言とこのガードの対応は `public-columns.test.ts` が固定する。
 *
 * ## `instrument_type` を**述語として**使うことは暫定で認める (2026-09-13、ユーザー承認待ち)
 *
 * 日次取込と公開面の一覧を普通株に絞るため、`instrument_type` (personal-only のまま)
 * を WHERE / JOIN の ON で使う。WHERE は D1 の中で評価されるので値は Worker にも
 * レスポンスにも載らず、外から観測できるのは「一覧に載るかどうか」の 1 bit だけ
 * (公開面が述語に使っている `is_active` はライセンス未宣言の列で、前例にはならない。
 * 判断の根拠と承認待ちであることは src/shared/db/active-equity.ts §2)。よって
 * src/shared/db/public-columns.ts の「値を載せない・出さない」方針に反しない。
 * ただし述語は src/shared/db/active-equity.ts の 1 箇所を経由する場合に限る。
 * 値の select と、`market` / `sector` を述語に使うことは引き続き禁止。
 * 下の「instrument_type を書くのは universe sync だけ」のテストが、`instrumentType`
 * を修飾つきで参照するファイルを universe.ts (書き手) と active-equity.ts (述語) の
 * 2 つに固定している。
 *
 * ## 何を機械的に見ているのか
 *
 * 危ないのは列名を書いた漏れではなく、**列名を一度も書かない漏れ**である。
 * drizzle の既定 select は全列返しなので、`db.select().from(stocks)` は
 * 宣言に列を足した瞬間から personal-only 列を含んだ行を返し始める。
 * 呼び出し側が必要フィールドだけ詰め替えていれば今日は漏れないが、行を
 * spread した / JSON にそのまま流した 1 箇所で崩れ、型でも lint でも
 * 検出できない。そこで 5 つを見る:
 *
 *   1. `.select()` (列指定なし) + `from(stocks)` が**リポジトリ全体で** 0 件。
 *   2. `db.query.stocks.findFirst/findMany` で `columns` を省いたものが 0 件。
 *   3. 公開面のファイルに `<なにか>stocks.<personal-only 列>` という
 *      **修飾つき参照**が無い。
 *   4. 公開面の関係クエリの `columns` に personal-only 列の**キー**が無い。
 *   5. `core_stocks` へ**書く**経路が `sector33` を書き込み先にしない。
 *
 * 5 は読み側ではなく書き側の検査。公開面が `sector33` を読むようになったので、
 * この repo の取込が `sector33` へ JPX の 33業種を書き足すと、**1〜4 が全部緑の
 * まま**公開面が personal-only を返す状態へ戻る (列の中身は静的検査に映らない)。
 * 業種の書き込み先は `sector` のままにし、`sector33` の充填は EDINET を持つ
 * stockStock 側でやる。
 *
 * 2 を落とすと検査は無意味になる。1 だけを見ていた版では
 * services/otakara-yutai/app.ts の銘柄詳細 (`db.query.stocks.findFirst`) が
 * 全列を SSR プロセスへ載せたまま緑になっていた。regex も型も別系統の API には
 * 掛からない。同じ理由で 4 を足した: `columns: { market: true }` は 2 を通る
 * (`columns` は書いてある) のに personal-only 列を 1 列だけ確実に持ってくる。
 *
 * ### 3 が「修飾つき参照」なのはなぜか
 *
 * 旧版は `\bmarket\b` のような**裸の識別子** grep だった。`market` を対象に
 * 入れた瞬間にこれは壊れる: select のキー名 (`market: publicMarketColumn`)、
 * 型注釈 (`market: string | null`)、コメントの説明文が必ず一致するので、
 * **常時赤か、赤を消すために検査を無意味に緩めるかの二択**になる。
 * `sector` はさらに悪く、`sectorDaily` / `sectorOpts` / `業種` の説明文と
 * 衝突する。
 *
 * 見たいのは「その列を `core_stocks` から読んでいるか」なので、
 * `stocks.market` / `coreStocks.market` / `coreSchema.stocks.market` という
 * **表を修飾した形**だけを拾う。`stockFinancials.marketCap` は
 * 接尾辞が `stocks` でないので当たらず、`marketCap` は `market` の直後が
 * 単語文字なので `\b` でも当たらない (どちらも確認済み)。
 *
 * ### 許可リストを持たない理由
 *
 * 例外を 1 件認めるとその 1 件が「行をどこへ渡しているか」の追跡を永久に
 * 要求し、追跡は人にしかできない (= いつか外れる)。id だけ要る writer 経路も
 * `select({ id: stocks.id })` と書けば済む。
 *
 * ### 静的検査の限界
 *
 * ここで見ているのは書き方だけで、実際に HTML/JSON へ出たかは見ていない。
 * 出力に personal-only の値が出ないこと / 出してよい `sector33` が出ること /
 * `sector33` が NULL のとき JPX の `sector` へ落ちないことは
 * services/otakara-yutai/src/tests/stock-detail-license.test.ts が
 * 番兵値を DB に入れて実測している。
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import {
  NOT_PUBLIC_SURFACE,
  PUBLIC_SURFACE_DIRS,
  ROOT,
  collectSources,
  stripComments,
} from "./tests/source-scan.js";
import { PERSONAL_ONLY_COLUMNS } from "./public-columns.js";

/**
 * 公開面 = 本番の Worker がレスポンスを組み立てるために `core_stocks` を読む
 * ファイル。**実在検証つきの明示リスト**にしてある (walk だと対象が移動しても
 * 静かに 0 件になる)。公開面を増やしたらここに足すこと。
 */
const PUBLIC_SURFACE = [
  "services/rsi-screening/src/services/stock-detail-service.ts",
  // スクリーニング結果表。`from(stockRsiPercentile).innerJoin(stocks, ...)` と
  // 書くので `from(stocks)` を探す旧検出器には引っかからず、リストからも
  // 漏れていた。**`stocks.market` を select している公開面が丸ごと無検査**
  // だったということ (2026-09-13 に join も検出対象へ入れて発見)。
  "services/rsi-screening/src/services/screening-service.ts",
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
  "services/financial-math/src/services/price-cache.ts",
  "services/ir-catalog/src/services/ingest.ts",
  // 事業タグ (biztag) の読み取り専用データソース。select する列は
  // id/code/name/sector33 の 4 つだけ (services/yuho-quant/src/biztag/source.ts
  // 冒頭コメント参照)。personal-only 列は識別子としても一度も出てこない。
  "services/yuho-quant/src/biztag/source.ts",
];

// 明示リスト (PUBLIC_SURFACE) が本当に公開面を網羅しているかの下支え。
//
// `PUBLIC_SURFACE` を 2 件だけにしていた版は、`core_stocks` を引く公開面が
// 実際には 8 件あるのに 2 件しか検査していなかった (リストが作られた時点で
// 既に不完全)。「増えたら足すこと」と書いてあっても、足し忘れは検査自体には
// 現れない。そこで**走査して見つかった公開面がリストに載っているか**を見る。
//
// 走査範囲 (`PUBLIC_SURFACE_DIRS` / `NOT_PUBLIC_SURFACE`) と `stripComments` /
// `collectSources` は ./tests/source-scan.ts に置いた。src/shared/db/active-equity.test.ts
// も同じ範囲を走査するので、片方にだけディレクトリを足す食い違いを作らないため。

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

/**
 * `<なにか>stocks.<personal-only 列>` という**修飾つき参照**。
 *
 * 裸の識別子 grep にしない理由は冒頭コメント (`market` / `sector` を対象に
 * 入れると select のキー名・型注釈・説明文が必ず一致して機能しなくなる)。
 *
 * 表の側は `.select()` 検出器と同じく**`stocks` で終わる識別子**を拾う。
 * `import { stocks as coreStocks }` の別名で抜けられないようにするため
 * (この書き方はリポジトリに実在する)。
 */
function findQualifiedPersonalOnlyRefs(source: string): string[] {
  const code = stripComments(source);
  const found = new Set<string>();
  for (const column of PERSONAL_ONLY_COLUMNS) {
    const re = new RegExp(`\\b\\w*[Ss]tocks\\s*\\.\\s*${column}\\b`, "g");
    for (const m of code.matchAll(re)) found.add(m[0].replace(/\s+/g, ""));
  }
  return [...found].sort();
}

/**
 * 関係クエリの**トップレベル `columns` に書かれた personal-only 列のキー**。
 *
 * `columns` を書いてあれば `countUnrestrictedRelationalQueries` は 0 を返すので、
 * `columns: { market: true }` はそこを素通りする。しかも `columns` は
 * 「この列だけ確実に取ってくる」という宣言なので、全列返しより**狙って**
 * personal-only を持ってきている。別枠で見る。
 *
 * 走査範囲を関係クエリの引数に限るので、ここでは裸のキー名で一致させてよい
 * (`{ market: true }` の `market` は列名そのもの)。
 */
function findPersonalOnlyRelationalColumns(source: string): string[] {
  const code = stripComments(source);
  const found = new Set<string>();
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
    // `columns: { ... }` の中身だけを取る。`with: { benefits: { columns: ... } }`
    // の内側は別の表なので対象外 —— `columns` の直前がトップレベルかを深さで見る。
    let nest = 0;
    for (let i = 0; i < args.length; i++) {
      const ch = args[i];
      if (ch === "{" || ch === "[" || ch === "(") nest++;
      else if (ch === "}" || ch === "]" || ch === ")") nest--;
      else if (nest === 0 && args.startsWith("columns", i)) {
        const braceStart = args.indexOf("{", i);
        if (braceStart === -1) break;
        let d = 0;
        let braceEnd = args.length;
        for (let j = braceStart; j < args.length; j++) {
          if (args[j] === "{") d++;
          else if (args[j] === "}") {
            d--;
            if (d === 0) {
              braceEnd = j;
              break;
            }
          }
        }
        const body = args.slice(braceStart + 1, braceEnd);
        for (const column of PERSONAL_ONLY_COLUMNS) {
          if (new RegExp(`\\b${column}\\s*:`).test(body)) found.add(column);
        }
        break;
      }
    }
  }
  return [...found].sort();
}

/**
 * `core_stocks` へ**書く**ファイル (`insert(stocks)` / `update(stocks)`)。
 *
 * 公開面が `sector33` を読むようになったので、危ないのは読み側だけではなくなった。
 * この repo の取込が `sector33` へ JPX (data_j.xls) の 33業種区分を書き足すと、
 * 公開面は**コードを 1 行も変えずに** personal-only を返す状態へ戻る。
 * 読み側の検査は全部緑のままなので、書き側で止める。
 */
const WRITES_STOCKS = /\.\s*(?:insert|update)\s*\(\s*(?:\w+\.)?\w*[Ss]tocks\s*\)/;

/**
 * `sector33` を**書き込み先**として指名している箇所。
 *
 * 拾うのは代入キー (`sector33:`) と短縮プロパティ (`{ ..., sector33 }`) だけで、
 * **プロパティ参照 (`r.sector33`) は拾わない**。src/cron/universe.ts は
 * `sector: r.sector33` と書く (JPX パーサの項目名が `sector33`) ので、参照まで
 * 拾うと常時赤になり、赤を消すために検査を緩める道をたどる。
 */
const SECTOR33_WRITE_KEY = /(?<![.\w$])sector33\s*[:,}]/;

function writesSector33(source: string): boolean {
  const code = stripComments(source);
  return WRITES_STOCKS.test(code) && SECTOR33_WRITE_KEY.test(code);
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
    // join だけで `core_stocks` を読む公開面も拾う。`from(stocks)` と
    // `query.stocks.` しか見ていなかった版では
    // services/rsi-screening/src/services/screening-service.ts
    // (`from(stockRsiPercentile).innerJoin(stocks, ...)` で `stocks.market` を
    // select している) がリストから漏れ、無検査のままだった。
    const readsStocks =
      /\bfrom\(\s*(?:\w+\.)?\w*[Ss]tocks\s*\)|\b(?:inner|left|right|full)?[Jj]oin\(\s*(?:\w+\.)?\w*[Ss]tocks\s*,|\bcrossJoin\(\s*(?:\w+\.)?\w*[Ss]tocks\s*\)|\bquery\s*\.\s*stocks\s*\./;
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

  it.each(PUBLIC_SURFACE)("%s が personal-only 列を修飾つきで読まない", (rel) => {
    // `stocks.market` / `coreStocks.sector` のような修飾つき参照。
    // 出してよい列へ切り替えるなら src/shared/db/public-columns.ts 経由で書く。
    const found = findQualifiedPersonalOnlyRefs(readFileSync(join(ROOT, rel), "utf-8"));
    expect(
      found,
      `${rel} が core_stocks の personal-only 列を直接読んでいます。` +
        " 公開面の市場区分 / 業種は src/shared/db/public-columns.ts 経由にすること",
    ).toEqual([]);
  });

  it.each(PUBLIC_SURFACE)("%s の関係クエリが columns で personal-only を指名しない", (rel) => {
    // `columns: { market: true }` は「columns を書いてあるか」の検査を通る。
    const found = findPersonalOnlyRelationalColumns(readFileSync(join(ROOT, rel), "utf-8"));
    expect(
      found,
      `${rel} の db.query.stocks.find* が personal-only 列を columns で指名しています`,
    ).toEqual([]);
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

  it("修飾つき参照の検出器が誤検出せず、別名でも抜けられない", () => {
    // 拾うべきもの
    expect(findQualifiedPersonalOnlyRefs("stocks.market")).toEqual(["stocks.market"]);
    expect(findQualifiedPersonalOnlyRefs("coreSchema.stocks.sector")).toEqual(["stocks.sector"]);
    // 別名 import。この書き方はリポジトリに実在するので、拾えないと無効化される。
    expect(findQualifiedPersonalOnlyRefs("coreStocks.market")).toEqual(["coreStocks.market"]);
    expect(findQualifiedPersonalOnlyRefs("schema.coreStocks.instrumentType")).toEqual([
      "coreStocks.instrumentType",
    ]);
    // 改行・空白を挟んだ形
    expect(findQualifiedPersonalOnlyRefs("stocks\n  .instrumentType")).toEqual([
      "stocks.instrumentType",
    ]);

    // **拾ってはいけないもの**。裸の識別子 grep にすると全部誤検出になり、
    // 検査が常時赤 → 無意味に緩める、という道をたどる。
    expect(findQualifiedPersonalOnlyRefs("market: publicMarketColumn,")).toEqual([]);
    expect(findQualifiedPersonalOnlyRefs("sector: string | null;")).toEqual([]);
    expect(findQualifiedPersonalOnlyRefs("stockFinancials.marketCap")).toEqual([]);
    expect(findQualifiedPersonalOnlyRefs("stocks.marketCap")).toEqual([]); // 列自体が無い綴り
    expect(findQualifiedPersonalOnlyRefs("sectorDaily.sector")).toEqual([]); // 別表
    expect(findQualifiedPersonalOnlyRefs("marketContext.date")).toEqual([]);
    // `sector33` は commercial-ok なので対象外 (冒頭コメント)。
    expect(findQualifiedPersonalOnlyRefs("stocks.sector33")).toEqual([]);
    // コメント中の例示で落ちない
    expect(findQualifiedPersonalOnlyRefs("// stocks.market は禁止")).toEqual([]);
  });

  it("columns 指名の検出器がトップレベルだけを見る", () => {
    expect(
      findPersonalOnlyRelationalColumns("db.query.stocks.findFirst({ columns: { market: true } })"),
    ).toEqual(["market"]);
    expect(
      findPersonalOnlyRelationalColumns(
        "db.query.stocks.findFirst({ columns: { id: true, name: true, sector: true } })",
      ),
    ).toEqual(["sector"]);
    // 出してよい列だけなら通る
    expect(
      findPersonalOnlyRelationalColumns(
        "db.query.stocks.findFirst({ columns: { id: true, sector33: true } })",
      ),
    ).toEqual([]);
    // `with` の内側 (別表の columns) をトップレベルと取り違えない。
    // yutai_benefits の `description` は別のライセンス境界で、この検査の対象外。
    expect(
      findPersonalOnlyRelationalColumns(
        "db.query.stocks.findFirst({ columns: { id: true }, with: { benefits: { columns: { market: true } } } })",
      ),
    ).toEqual([]);
    // 他表の関係クエリは対象外
    expect(
      findPersonalOnlyRelationalColumns("db.query.benefits.findMany({ columns: { market: true } })"),
    ).toEqual([]);
    // コメント中の例示で落ちない
    expect(
      findPersonalOnlyRelationalColumns("// db.query.stocks.findFirst({ columns: { market: true } })"),
    ).toEqual([]);
  });

  it("core_stocks へ書く経路が sector33 を書き込み先にしない", () => {
    // 公開面が読む列へ JPX の値が流れ込む唯一の経路。ここが開くと、読み側の
    // 検査 (上の 3 つ) が全部緑のまま公開面が personal-only を返す状態へ戻る。
    // 業種の書き込み先は `sector` のままにし、`sector33` の充填は EDINET を
    // 持っている stockStock 側でやること (src/shared/db/core-schema.ts)。
    const offenders = collectSources(join(ROOT, "src"))
      .concat(collectSources(join(ROOT, "services")))
      .filter((path) => writesSector33(readFileSync(path, "utf-8")))
      .map((path) => relative(ROOT, path).split(sep).join("/"));
    expect(
      offenders,
      "sector33 は公開面が読む列。JPX (data_j.xls) の 33業種を書くなら `sector` へ",
    ).toEqual([]);
  });

  it("instrument_type を書くのは universe sync だけで、公開面は値を読まない（母集団の述語は src/shared/db/active-equity.ts 経由だけ）", () => {
    // 移行 P4b 第 1 段で src/cron/universe.ts が JPX の「市場・商品区分」から
    // `instrument_type` (personal-only) を書き始めた。値が入った瞬間から、公開面が
    // この列を読めば番兵ではなく実値が出る。読み側は上の修飾つき参照の検査と
    // services/otakara-yutai/src/tests/stock-detail-license.test.ts (番兵) が見ている。
    // ここでは「書く経路が取込層の 1 箇所に留まっている」ことを固定する。
    const writesInstrumentType = (source: string): boolean => {
      const code = stripComments(source);
      return (
        WRITES_STOCKS.test(code) &&
        /(?<![.\w$])instrumentType\s*[:,}]/.test(code)
      );
    };
    const writers = collectSources(join(ROOT, "src"))
      .concat(collectSources(join(ROOT, "services")))
      .concat(collectSources(join(ROOT, "scripts")))
      .filter((path) => writesInstrumentType(readFileSync(path, "utf-8")))
      .map((path) => relative(ROOT, path).split(sep).join("/"));
    expect(writers).toEqual(["src/cron/universe.ts"]);
    expect(PUBLIC_SURFACE).not.toContain("src/cron/universe.ts");
    for (const rel of PUBLIC_SURFACE) {
      expect(
        findQualifiedPersonalOnlyRefs(readFileSync(join(ROOT, rel), "utf-8")).filter(
          (ref) => /instrument(Type|_type)$/.test(ref),
        ),
        rel,
      ).toEqual([]);
    }
    // 検出器の健全性: 書き込み先としての指名は拾い、参照は拾わない
    expect(writesInstrumentType("db.update(stocks).set({ instrumentType: to })")).toBe(true);
    expect(
      writesInstrumentType("db.select({ t: stocks.instrumentType }).from(stocks)"),
    ).toBe(false);

    // `instrumentType` を修飾つきで参照するファイル (テスト以外) を固定する。
    //   - src/cron/universe.ts: 唯一の書き手 (ガードの件数も同じ SELECT で数える)
    //   - src/shared/db/active-equity.ts: 母集団の述語 (WHERE / ON だけで使う)
    // 3 つ目が現れたら、値を select しているか、helper を経由しない述語である。
    const qualifiedReferrers = collectSources(join(ROOT, "src"))
      .concat(collectSources(join(ROOT, "services")))
      .concat(collectSources(join(ROOT, "scripts")))
      .filter((path) =>
        findQualifiedPersonalOnlyRefs(readFileSync(path, "utf-8")).some((ref) =>
          /instrument(Type|_type)$/.test(ref),
        ),
      )
      .map((path) => relative(ROOT, path).split(sep).join("/"))
      .sort();
    expect(
      qualifiedReferrers,
      "instrument_type を述語に使うなら src/shared/db/active-equity.ts の activeEquityCondition() を経由すること",
    ).toEqual(["src/cron/universe.ts", "src/shared/db/active-equity.ts"]);
  });

  it("sector33 の書き込み検出器が参照と書き込みを取り違えない", () => {
    // 拾うべきもの (書き込み先としての指名)
    expect(writesSector33("db.insert(stocks).values({ sector33: r.sector33 })")).toBe(true);
    expect(writesSector33("db.insert(coreSchema.stocks).values({ code, sector33 })")).toBe(true);
    expect(
      writesSector33("db.update(stocks).set({ sector33: sql`excluded.sector33` })"),
    ).toBe(true);
    // 拾ってはいけないもの: JPX パーサの項目名を読んで `sector` へ書く現状の形。
    // ここを誤検出すると検査が常時赤になり、緩める方向へ倒れる。
    expect(
      writesSector33("db.insert(coreSchema.stocks).values({ sector: r.sector33 })"),
    ).toBe(false);
    // 読み取りだけのファイルは対象外 (読み側は別の検査が見ている)
    expect(writesSector33("db.select({ sector: stocks.sector33 }).from(stocks)")).toBe(false);
    // コメント中の例示で落ちない
    expect(writesSector33("// db.insert(stocks).values({ sector33: x })")).toBe(false);
  });

  it("フラグを 1 箇所だけで切り替えられる (戻し道が残っている)", () => {
    // 「元に戻せる」と PR に書いたのに定数が複数箇所に散っていた、を防ぐ。
    const flagged = collectSources(join(ROOT, "src"))
      .concat(collectSources(join(ROOT, "services")))
      .filter((path) => /\bPUBLISH_JPX_DERIVED_COLUMNS\s*=/.test(readFileSync(path, "utf-8")))
      .map((path) => relative(ROOT, path).split(sep).join("/"));
    expect(flagged, "定数の定義は 1 ファイルに閉じること").toEqual([
      "src/shared/db/public-columns.ts",
    ]);
  });
});
