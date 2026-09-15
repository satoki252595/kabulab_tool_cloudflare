/**
 * 優待の取込が `core_stocks` に行を足さないことの検証。
 *
 * 固定したい契約: `core_stocks` へ INSERT するのは src/cron/universe.ts
 * (東証の上場銘柄一覧からの同期) だけ。src / services / scripts の全体を
 * 静的に見る。data-scripts の CLI は import すると main() が走るので
 * 値では試せず、この静的検査が担保している。
 *
 * 背景: 以前の取込は、コードが `core_stocks` に無ければ行を足していた。足した行は
 * 区分が NULL の active 行になり、日次からも公開面からも外れたまま残る
 * (src/cron/universe.ts の instrument_type 充填の注記にある本番 2026-09-13 の 9 行)。
 * 2026-09-13 のユーザー決定でその 9 行を元データから削除するので、取込が作り直さない
 * ようにする。
 *
 * 旧 v1 取込 (importYutaiData / fetch-yutai-data.ts) の値テストは K1b で削除。
 * 現行 v2 (fetch-yutai-full.ts → importYutaiFull) の振る舞いは
 * src/tests/yutai-full-import.test.ts が値で見る。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  ROOT,
  collectSources,
  stripComments,
} from "../../../../src/shared/db/tests/source-scan.js";

/** `core_stocks` への INSERT。表の側は `stocks` で終わる識別子。 */
const INSERTS_STOCKS = /\.\s*insert\s*\(\s*(?:\w+\.)?\w*[Ss]tocks\s*\)/;

/** `core_stocks` に行を足してよい唯一の経路 (東証の上場銘柄一覧からの同期)。 */
const CORE_STOCKS_INSERTER = "src/cron/universe.ts";

const YUTAI_FULL_CLI = "services/otakara-yutai/data-scripts/fetch-yutai-full.ts";
const YUTAI_FULL_IMPORT = "services/otakara-yutai/data-scripts/yutai-full-import.ts";

function code(rel: string): string {
  return stripComments(readFileSync(join(ROOT, rel), "utf-8"));
}

describe("優待の取込の書き方", () => {
  it(`core_stocks へ INSERT するのは ${CORE_STOCKS_INSERTER} だけ`, () => {
    const sources = ["src", "services", "scripts"]
      .flatMap((dir) => collectSources(join(ROOT, dir)))
      .map((path) => relative(ROOT, path).split(sep).join("/"));
    // 走査が空振りすると下の検査は無条件に緑になる。data-scripts と唯一の経路も入っていること。
    expect(sources).toEqual(
      expect.arrayContaining([
        YUTAI_FULL_CLI,
        YUTAI_FULL_IMPORT,
        CORE_STOCKS_INSERTER,
      ])
    );
    const inserters = sources.filter((rel) => INSERTS_STOCKS.test(code(rel)));
    expect(
      inserters,
      "core_stocks に行を足すのは東証の上場銘柄一覧からの同期 (src/cron/universe.ts) だけ。" +
        " 取込は src/shared/db/active-equity.ts で銘柄を引き、無ければ飛ばす",
    ).toEqual([CORE_STOCKS_INSERTER]);
  });

  it("検出器が書き方を問わず拾い、別の表とコメントは拾わない", () => {
    expect(INSERTS_STOCKS.test("db.insert(stocks).values({ code })")).toBe(true);
    expect(INSERTS_STOCKS.test("db\n  .insert(coreSchema.stocks)")).toBe(true);
    expect(INSERTS_STOCKS.test("db.insert(coreStocks)")).toBe(true);
    expect(INSERTS_STOCKS.test("db.insert(yutaiBenefits)")).toBe(false);
    expect(INSERTS_STOCKS.test("db.update(stocks).set({ isYutai: true })")).toBe(false);
    expect(INSERTS_STOCKS.test(stripComments("// db.insert(stocks)"))).toBe(false);
  });
});
