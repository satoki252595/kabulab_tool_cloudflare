/**
 * 優待の全量取込 (`importYutaiFull`、fetch-yutai-full.ts の Phase 3) の検証。
 *
 * 固定したい契約:
 *
 *   1. 母集団 (core_stocks の active かつ equity) の銘柄だけ、優待行を作り直す。退避した
 *      解釈 (short_summary / estimated_value) は内容キーで戻す。
 *   2. 母集団外の銘柄 (上場廃止・区分が NULL・非普通株) は、取得結果に載っていても
 *      取り込まず、既存の優待行 (解釈を含む) と is_yutai に触らない。
 *   3. 母集団の銘柄で、優待行を持っていたのに今回取得できなかったものは、優待行を消して
 *      is_yutai を落とす (優待の廃止)。
 *   4. 次のときは削除の前に止め、何も書かない: 取り込み先が 0 件 / 優待行を持つ母集団の
 *      銘柄のうち今回も取得できた割合が MIN_YUTAI_COVERAGE_PERCENT 未満。
 *   5. core_stocks は is_yutai しか書かない (行を足さない・name / market を上書きしない)。
 *   6. ジャンルは消さずに slug で upsert する (母集団外の優待行が参照している)。
 *
 * 背景: 以前の取込は、優待行とジャンルを全削除してから作り直していた。取込を母集団に
 * 絞ったあとも全削除のままだと、母集団外の銘柄の優待行と、作り直せない解釈が消える。
 *
 * 掲載文はすべて架空。D1 は yutai-stock-universe.test.ts と同じく、drizzle/d1 の
 * マイグレーションを流したローカル SQLite に sqlite-proxy で向ける (外部キーも効く)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import {
  GENRE_SLUG_MAP,
  MIN_YUTAI_COVERAGE_PERCENT,
  YUTAI_GENRES,
  guessGenreSlug,
  importYutaiFull,
  type StockYutaiData,
  type YutaiFullImportDb,
} from "../../data-scripts/yutai-full-import.js";
import { ROOT } from "../../../../src/shared/db/tests/source-scan.js";

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

/** 母集団 (active かつ equity) で優待行を持つ 20 銘柄。1 銘柄落ちると 95% ちょうど。 */
const HELD = Array.from({ length: 20 }, (_, i) => ({ id: 100 + i, code: String(9100 + i) }));
/** 母集団で、まだ優待行が無い銘柄 (今回はじめて優待を持つ)。 */
const NEW_HOLDER = { id: 200, code: "9200" };
/** 母集団外で、優待行と解釈を持つ銘柄。 */
const OUTSIDE = [
  { id: 301, code: "9998", active: 0, instrumentType: "equity" }, // 上場廃止
  { id: 302, code: "9999", active: 1, instrumentType: null }, // 区分が NULL
  { id: 303, code: "1201", active: 1, instrumentType: "reit_fund" }, // 非普通株
] as const;
const OUTSIDE_IDS: readonly number[] = OUTSIDE.map((s) => s.id);
/**
 * core_stocks に無いコード。テストの DB に無いだけでなく、実在もしない合成コード
 * (JPX の上場銘柄一覧 2026-08-31 版にも本番 core_stocks にも、1300 未満の数字コードは無い)。
 */
const ABSENT_CODE = "1299";

const descOf = (code: string) => `架空優待${code}`;

/** 取得結果 1 銘柄。name / market は core_stocks と違う値にして、上書きすると分かるようにする。 */
function fetched(code: string, description = descOf(code)): StockYutaiData {
  return {
    code,
    name: `取得元の名前${code}`,
    market: "取得元の市場",
    recordMonths: [3],
    category: "株主優待",
    benefits: [{ minShares: 100, description, notes: "" }],
  };
}

let sqlite: DatabaseSync;
let db: YutaiFullImportDb;

beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  applyD1Migrations(sqlite);

  const insStock = sqlite.prepare(
    "INSERT INTO core_stocks (id, code, name, market, is_active, is_yutai, instrument_type) VALUES (?, ?, ?, 'テスト市場', ?, ?, ?)",
  );
  for (const s of HELD) insStock.run(s.id, s.code, `テスト${s.code}`, 1, 1, "equity");
  insStock.run(NEW_HOLDER.id, NEW_HOLDER.code, `テスト${NEW_HOLDER.code}`, 1, 0, "equity");
  for (const s of OUTSIDE) insStock.run(s.id, s.code, `テスト${s.code}`, s.active, 1, s.instrumentType);

  const insGenre = sqlite.prepare(
    "INSERT INTO yutai_genres (id, name, slug, description) VALUES (?, ?, ?, ?)",
  );
  YUTAI_GENRES.forEach((g, i) => insGenre.run(i + 1, g.name, g.slug, g.description));
  const otherId = YUTAI_GENRES.findIndex((g) => g.slug === "other") + 1;

  const insBenefit = sqlite.prepare(
    "INSERT INTO yutai_benefits (stock_id, genre_id, description, short_summary, min_shares, record_month, estimated_value) VALUES (?, ?, ?, ?, 100, 3, ?)",
  );
  HELD.forEach((s, i) => insBenefit.run(s.id, otherId, descOf(s.code), `要約${s.code}`, 1000 + i));
  OUTSIDE.forEach((s, i) => insBenefit.run(s.id, otherId, descOf(s.code), `要約${s.code}`, 5000 + i));

  db = makeProxyDb(sqlite) as unknown as YutaiFullImportDb;
});

afterEach(() => {
  vi.restoreAllMocks();
  sqlite.close();
});

/** console を黙らせて、出した行を返す。 */
function captureConsole(): string[] {
  const lines: string[] = [];
  const capture = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  vi.spyOn(console, "info").mockImplementation(capture);
  vi.spyOn(console, "warn").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
  return lines;
}

function snapshot() {
  return {
    stocks: sqlite
      .prepare(
        "SELECT id, code, name, market, is_active, is_yutai, instrument_type FROM core_stocks ORDER BY id",
      )
      .all(),
    benefits: sqlite
      .prepare(
        "SELECT id, stock_id, genre_id, description, short_summary, min_shares, record_month, estimated_value FROM yutai_benefits ORDER BY id",
      )
      .all(),
    genres: sqlite.prepare("SELECT id, name, slug FROM yutai_genres ORDER BY id").all(),
  };
}

function benefitsOf(benefits: ReturnType<typeof snapshot>["benefits"], ids: readonly number[]) {
  return benefits.filter((b) => ids.includes(Number(b.stock_id)));
}

function isYutaiOf(id: number): unknown {
  return (sqlite.prepare("SELECT is_yutai FROM core_stocks WHERE id = ?").get(id) as { is_yutai: unknown })
    .is_yutai;
}

describe("importYutaiFull は母集団の銘柄の優待だけを作り直す", () => {
  it("母集団の銘柄は作り直して解釈を戻し、母集団外の優待行・解釈・is_yutai には触らない", async () => {
    const before = snapshot();
    const logs = captureConsole();

    const result = await importYutaiFull(db, [
      ...HELD.map((s) => fetched(s.code)),
      fetched(NEW_HOLDER.code),
      ...OUTSIDE.map((s) => fetched(s.code)),
      fetched(ABSENT_CODE),
    ]);

    expect(result).toEqual({
      stockCount: HELD.length + 1,
      benefitCount: HELD.length + 1,
      outOfUniverse: [...OUTSIDE.map((s) => s.code), ABSENT_CODE],
      abolishedCount: 0,
      droppedInterpretations: 0,
      failedCodes: [],
    });
    const after = snapshot();

    // 母集団外の優待行は id まで同じ (消して入れ直していない)。解釈も残る。
    expect(benefitsOf(after.benefits, OUTSIDE_IDS)).toEqual(benefitsOf(before.benefits, OUTSIDE_IDS));
    // 母集団の銘柄は作り直し (id が変わる)、解釈が戻る
    const heldIds = HELD.map((s) => s.id);
    const heldAfter = benefitsOf(after.benefits, heldIds);
    expect(heldAfter.map((b) => [b.stock_id, b.short_summary, b.estimated_value])).toEqual(
      HELD.map((s, i) => [s.id, `要約${s.code}`, 1000 + i]),
    );
    const maxIdBefore = Math.max(...before.benefits.map((b) => Number(b.id)));
    expect(heldAfter.every((b) => Number(b.id) > maxIdBefore)).toBe(true);
    // はじめて優待を持つ銘柄は未解釈で入る
    expect(benefitsOf(after.benefits, [NEW_HOLDER.id]).map((b) => b.short_summary)).toEqual([null]);

    // core_stocks: 行を足さず、name / market を取得元の値で上書きしない。
    // is_yutai は NEW_HOLDER だけ 0→1。母集団外は 1 のまま。
    expect(after.stocks).toEqual(
      before.stocks.map((s) => (s.id === NEW_HOLDER.id ? { ...s, is_yutai: 1 } : s)),
    );
    // ジャンルは消さず、id も変わらない
    expect(after.genres).toEqual(before.genres);
    // 飛ばしたコードを黙らない
    expect(logs.some((l) => l.includes("飛ばすコード") && l.includes(ABSENT_CODE))).toBe(true);
  });

  it("優待行を持っていたのに今回取得できなかった母集団の銘柄は、優待行を消して is_yutai を落とす", async () => {
    const before = snapshot();
    captureConsole();
    const [abolished, ...rest] = HELD;

    const result = await importYutaiFull(db, rest.map((s) => fetched(s.code)));

    expect(result).toMatchObject({
      stockCount: rest.length,
      outOfUniverse: [],
      abolishedCount: 1,
      droppedInterpretations: 1,
    });
    const after = snapshot();
    expect(benefitsOf(after.benefits, [abolished.id])).toEqual([]);
    expect(isYutaiOf(abolished.id)).toBe(0);
    // 母集団外は取得結果に無くても消さない
    expect(benefitsOf(after.benefits, OUTSIDE_IDS)).toEqual(benefitsOf(before.benefits, OUTSIDE_IDS));
    for (const s of OUTSIDE) expect(isYutaiOf(s.id), s.code).toBe(1);
  });

  it("掲載文が変わった優待は未解釈で入り、戻せなかった解釈の件数を返す", async () => {
    const logs = captureConsole();
    const [changed, ...rest] = HELD;

    const result = await importYutaiFull(db, [
      fetched(changed.code, "架空優待 文言を変更"),
      ...rest.map((s) => fetched(s.code)),
    ]);

    expect(result).toMatchObject({ stockCount: HELD.length, abolishedCount: 0, droppedInterpretations: 1 });
    expect(
      benefitsOf(snapshot().benefits, [changed.id]).map((b) => [b.description, b.short_summary, b.estimated_value]),
    ).toEqual([["架空優待 文言を変更", null, null]]);
    expect(logs.some((l) => l.includes("戻せない解釈") && l.includes("1件"))).toBe(true);
  });
});

describe("importYutaiFull は削除の前に止まる", () => {
  it(`優待行を持つ母集団の銘柄のうち今回も取得できたのが ${MIN_YUTAI_COVERAGE_PERCENT}% 未満なら、何も書かない`, async () => {
    const before = snapshot();
    captureConsole();

    // 20 銘柄のうち 18 銘柄 (90%)。個別ページの取得が大量に失敗した形。
    // 母集団外が取得結果に載っていても、割合には数えない。
    await expect(
      importYutaiFull(db, [...HELD.slice(2).map((s) => fetched(s.code)), ...OUTSIDE.map((s) => fetched(s.code))]),
    ).rejects.toThrow(/優待データは削除していません/);
    expect(snapshot()).toEqual(before);
  });

  it("取り込み先の銘柄が 1 件も無ければ、何も書かない", async () => {
    const before = snapshot();
    captureConsole();

    await expect(
      importYutaiFull(db, [...OUTSIDE.map((s) => fetched(s.code)), fetched(ABSENT_CODE)]),
    ).rejects.toThrow(/取り込み先の銘柄が 1 件もありません/);
    expect(snapshot()).toEqual(before);
  });
});

describe("ジャンル", () => {
  it("guessGenreSlug が返しうる slug はすべて YUTAI_GENRES にある", () => {
    const slugs = new Set(YUTAI_GENRES.map((g) => g.slug));
    for (const slug of Object.values(GENRE_SLUG_MAP)) expect(slugs.has(slug), slug).toBe(true);
    // キーワード表に無い文言で通る分岐 (food / voucher / living / other)
    for (const text of ["架空の菓子", "架空の優待券", "架空の自社製品", "架空"]) {
      expect(slugs.has(guessGenreSlug(text, "")), text).toBe(true);
    }
  });
});
