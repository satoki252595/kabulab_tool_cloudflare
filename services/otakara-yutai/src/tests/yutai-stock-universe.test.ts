/**
 * 優待の取込が `core_stocks` に行を足さず、母集団 (active かつ equity、
 * src/shared/db/active-equity.ts) の銘柄にだけ優待を付けることの検証。
 *
 * 固定したい契約:
 *
 *   1. `importYutaiData` は、母集団に無いコード (active の非普通株・区分が NULL・
 *      上場廃止・`core_stocks` に無い) を `skipped` に数えて飛ばし、`core_stocks` に
 *      行を足さず、ジャンルも作らない。**値**で見る。
 *   2. `core_stocks` へ INSERT するのは src/cron/universe.ts (東証の上場銘柄一覧からの
 *      同期) だけ。src / services / scripts の全体を静的に見る。data-scripts の CLI は
 *      import すると main() が走るので値では試せず、この静的検査が担保している。
 *   3. 1 コードずつ銘柄を引く取込 (importYutaiData / fetch-yutai-data.ts) は
 *      `findActiveEquityStockId` で引き、`core_stocks` を UPDATE しない。
 *   4. fetch-yutai-full.ts は D1 へ直接書かず、yutai-full-import.ts の `importYutaiFull` に
 *      委ねる。その中身 (母集団の銘柄の優待だけを作り直す・削除の前に止める・
 *      name / market を書かない) は src/tests/yutai-full-import.test.ts が値で見る。
 *
 * 背景: 以前の取込は、コードが `core_stocks` に無ければ行を足していた。足した行は
 * 区分が NULL の active 行になり、日次からも公開面からも外れたまま残る
 * (src/cron/universe.ts の instrument_type 充填の注記にある本番 2026-09-13 の 9 行)。
 * 2026-09-13 のユーザー決定でその 9 行を元データから削除するので、取込が作り直さない
 * ようにする。
 *
 * D1 は src/cron/daily-targets.test.ts と同じく、drizzle/d1 のマイグレーションを流した
 * ローカル SQLite に sqlite-proxy で向ける。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { importYutaiData, type YutaiRawData } from "../services/yutai-scraper.js";
import type { Database } from "../db/client.js";
import {
  ROOT,
  collectSources,
  stripComments,
} from "../../../../src/shared/db/tests/source-scan.js";

/** drizzle/d1 の全マイグレーションを番号順に流す (本番 D1 と同じ形)。 */
function applyD1Migrations(target: DatabaseSync): void {
  const dir = join(ROOT, "drizzle", "d1");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
    for (const stmt of readFileSync(join(dir, f), "utf-8").split("--> statement-breakpoint")) {
      if (stmt.trim()) target.exec(stmt);
    }
  }
}

/** createD1HttpDb と同じ sqlite-proxy 経路をローカル SQLite に向ける。 */
function makeProxyDb(target: DatabaseSync) {
  return drizzle(async (sqlStr, params, method) => {
    const stmt = target.prepare(sqlStr);
    const bind = params as (null | number | bigint | string | Uint8Array)[];
    if (method === "run") {
      stmt.run(...bind);
      return { rows: [] };
    }
    const rows = (stmt.all(...bind) as Record<string, unknown>[]).map((o) => Object.values(o));
    return { rows: method === "get" ? (rows[0] ?? []) : rows };
  });
}

/** 4 銘柄。優待を付けてよいのは 7203 だけ。 */
const STOCKS = [
  { id: 1, code: "7203", active: 1, instrumentType: "equity" },
  { id: 2, code: "1201", active: 1, instrumentType: "reit_fund" },
  { id: 3, code: "9999", active: 1, instrumentType: null },
  { id: 4, code: "6501", active: 0, instrumentType: "equity" },
] as const;

/** 1 コード 1 ジャンル。ジャンルを分けてあるので、飛ばした行がジャンルを作ると分かる。 */
const ITEMS: YutaiRawData[] = [
  { code: "7203", genre: "テストジャンルA" },
  { code: "1201", genre: "テストジャンルB" },
  { code: "9999", genre: "テストジャンルC" },
  { code: "6501", genre: "テストジャンルD" },
  { code: "1301", genre: "テストジャンルE" },
].map(({ code, genre }) => ({
  stockCode: code,
  stockName: `テスト${code}`,
  market: "テスト市場",
  genreName: genre,
  description: `テスト優待${code}`,
  minShares: 100,
  recordMonth: 3,
  estimatedValue: null,
}));

let sqlite: DatabaseSync;

beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  applyD1Migrations(sqlite);
  const ins = sqlite.prepare(
    "INSERT INTO core_stocks (id, code, name, market, is_active, instrument_type) VALUES (?, ?, ?, 'テスト市場', ?, ?)"
  );
  for (const s of STOCKS) ins.run(s.id, s.code, `テスト${s.code}`, s.active, s.instrumentType);
});

afterEach(() => {
  sqlite.close();
});

describe("importYutaiData は core_stocks に行を足さず、母集団の銘柄にだけ優待を付ける", () => {
  it("母集団外の 4 コードを飛ばし、core_stocks・ジャンル・優待を書かない", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = makeProxyDb(sqlite) as unknown as Database;

    const result = await importYutaiData(db, ITEMS);
    const warned = warn.mock.calls.map((args) => args.join(" "));
    warn.mockRestore();

    expect(result).toEqual({ created: 1, updated: 0, skipped: 4 });
    // core_stocks は 1 行も増えない
    expect(sqlite.prepare("SELECT id, code FROM core_stocks ORDER BY id").all()).toEqual(
      STOCKS.map((s) => ({ id: s.id, code: s.code }))
    );
    // 優待とジャンルは 7203 の分だけ
    expect(sqlite.prepare("SELECT stock_id FROM yutai_benefits").all()).toEqual([{ stock_id: 1 }]);
    expect(sqlite.prepare("SELECT name FROM yutai_genres").all()).toEqual([
      { name: "テストジャンルA" },
    ]);
    // 飛ばした件数を黙らない
    expect(warned.some((w) => w.includes("4 件飛ばしました"))).toBe(true);
  });
});

/** `core_stocks` への INSERT。表の側は `stocks` で終わる識別子。 */
const INSERTS_STOCKS = /\.\s*insert\s*\(\s*(?:\w+\.)?\w*[Ss]tocks\s*\)/;
/** `core_stocks` への UPDATE。 */
const UPDATES_STOCKS = /\.\s*update\s*\(\s*(?:\w+\.)?\w*[Ss]tocks\s*\)/;

/** `core_stocks` に行を足してよい唯一の経路 (東証の上場銘柄一覧からの同期)。 */
const CORE_STOCKS_INSERTER = "src/cron/universe.ts";

const YUTAI_FULL_CLI = "services/otakara-yutai/data-scripts/fetch-yutai-full.ts";
const YUTAI_FULL_IMPORT = "services/otakara-yutai/data-scripts/yutai-full-import.ts";
/** 1 コードずつ銘柄を引く優待の取込。 */
const YUTAI_PER_CODE_IMPORTERS = [
  "services/otakara-yutai/src/services/yutai-scraper.ts",
  "services/otakara-yutai/data-scripts/fetch-yutai-data.ts",
];

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
        ...YUTAI_PER_CODE_IMPORTERS,
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

  it.each(YUTAI_PER_CODE_IMPORTERS)(
    "%s は findActiveEquityStockId で銘柄を引き、core_stocks を UPDATE しない",
    (rel) => {
      const source = code(rel);
      expect(source).toMatch(/\bfindActiveEquityStockId\(\s*db\s*,/);
      expect(source).not.toMatch(UPDATES_STOCKS);
    },
  );

  it("fetch-yutai-full.ts は D1 へ直接書かず、importYutaiFull に委ねる", () => {
    const cli = code(YUTAI_FULL_CLI);
    expect(cli).toMatch(/\bimportYutaiFull\(/);
    expect(cli).not.toMatch(/\.\s*(?:insert|update|delete)\s*\(/);
    expect(code(YUTAI_FULL_IMPORT)).toMatch(/\bactiveEquityCondition\(\)/);
  });

  it("検出器が書き方を問わず拾い、別の表とコメントは拾わない", () => {
    expect(INSERTS_STOCKS.test("db.insert(stocks).values({ code })")).toBe(true);
    expect(INSERTS_STOCKS.test("db\n  .insert(coreSchema.stocks)")).toBe(true);
    expect(INSERTS_STOCKS.test("db.insert(coreStocks)")).toBe(true);
    expect(INSERTS_STOCKS.test("db.insert(yutaiBenefits)")).toBe(false);
    expect(INSERTS_STOCKS.test("db.update(stocks).set({ isYutai: true })")).toBe(false);
    expect(INSERTS_STOCKS.test(stripComments("// db.insert(stocks)"))).toBe(false);
    expect(UPDATES_STOCKS.test("db\n  .update(stocks)\n  .set({ name })")).toBe(true);
    expect(UPDATES_STOCKS.test("db.update(coreSchema.stocks)")).toBe(true);
    expect(UPDATES_STOCKS.test("db.update(yutaiBenefits)")).toBe(false);
  });
});
