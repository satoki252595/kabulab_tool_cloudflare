/**
 * 優待の全量取込 (`importYutaiFull`、fetch-yutai-full.ts の Phase 3) の検証。
 *
 * 固定したい契約:
 *
 *   1. 母集団 (core_stocks の active かつ equity) の銘柄だけ、優待行を作り直す。退避した
 *      解釈 (short_summary / estimated_value) は内容キーで戻す。値は要約取込と
 *      同じ共有厳密判定で company 適格を見て、不認定は値ごと null で戻す
 *      (provenance 付け替えで値を温存しない)。
 *   1b. 全保存成功後に post-image から利回り・スコアを 1 回だけ追随させる。
 *      batch失敗・応答不明は後続保存/再計算を送らず、旧行/flagを廃止扱いしない。
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
 * 既存テストの掲載文はすべて架空。共有厳密判定・carry・利回り追随のテストは
 * raw34 の原文抜粋 (`./raw34-excerpts.ts`) を使う。D1 は
 * yutai-stock-universe.test.ts と同じく、drizzle/d1 のマイグレーションを流した
 * ローカル SQLite に sqlite-proxy で向ける (外部キーも効く)。
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
  benefitRowsOf,
  carryKey,
  guessGenreSlug,
  importYutaiFull,
  planCarry,
  type CarrySourceRow,
  type StockYutaiData,
  type YutaiFullImportDb,
} from "../../data-scripts/yutai-full-import.js";
import { ROOT } from "../../../../src/shared/db/tests/source-scan.js";
import type { D1BatchStatement } from "../../../../src/shared/db/d1-http-client.js";
import { scoreStock } from "../../../../src/shared/scoring.js";
import { headedDescription } from "../../data-scripts/estimated-value-guard.js";
import type { AtomicBatchSender } from "../../data-scripts/atomic-apply.js";
import { RAW34TEXT } from "./raw34-excerpts.js";

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

/** 本体batchも適用し、記録する。noopでは原子取込の値検証にならない。 */
function makeRecordingSender(): { calls: D1BatchStatement[][]; sender: AtomicBatchSender } {
  return makeAtomicSender();
}

/** 既存の送信数契約は利回り・スコアlaneの件数。本体のstockbatchと区別する。 */
const yieldCalls = (calls: D1BatchStatement[][]) =>
  calls.filter((batch) => batch[0].sql.startsWith("-- preflight"));

/**
 * 実証済み REST batch の all-or-nothing を模す送信ダブル (1 送信 = 1 トランザクション)。
 * recompute-yields.test.ts と同じ形。
 */
function makeAtomicSender(): { calls: D1BatchStatement[][]; sender: AtomicBatchSender } {
  const calls: D1BatchStatement[][] = [];
  const sender: AtomicBatchSender = async (statements) => {
    calls.push(statements.map((s) => ({ sql: s.sql, params: [...s.params] })));
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      for (const s of statements) {
        sqlite.prepare(s.sql).run(...(s.params as (null | number | string)[]));
      }
      sqlite.exec("COMMIT");
    } catch (e) {
      sqlite.exec("ROLLBACK");
      throw e;
    }
  };
  return { calls, sender };
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

/**
 * raw34 8153.json /benefits/0 の DB 保存形 (verbatim。pointer は raw34-excerpts.ts)。
 * marked な per-test unit の外で取る alias (synthetic-code-guard の検査単位対策)。
 */
const RAW8153 = RAW34TEXT["8153"];

const descOf = (code: string) => `架空優待${code} 1,000円相当`;

/** 取得結果 1 銘柄。name / market は core_stocks と違う値にして、上書きすると分かるようにする。 */
function fetched(code: string, description = descOf(code)): StockYutaiData {
  return {
    code,
    name: `取得元の名前${code}`,
    market: "取得元の市場",
    category: "株主優待",
    benefits: [{ minShares: 100, description, notes: "", localRecordMonths: [3], heading: "株主優待" }],
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
  // 推定値は掲載文の額面と一致させる (共有厳密判定を通る「正常な解釈」)。
  HELD.forEach((s) => insBenefit.run(s.id, otherId, descOf(s.code), `要約${s.code}`, 1000));
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
        "SELECT id, stock_id, genre_id, description, short_summary, min_shares, record_month, record_date, estimated_value FROM yutai_benefits ORDER BY id",
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
    const { calls, sender } = makeRecordingSender();

    const result = await importYutaiFull(
      db,
      [
        ...HELD.map((s) => fetched(s.code)),
        fetched(NEW_HOLDER.code),
        ...OUTSIDE.map((s) => fetched(s.code)),
        fetched(ABSENT_CODE),
      ],
      sender
    );

    expect(result).toEqual({
      stockCount: HELD.length + 1,
      benefitCount: HELD.length + 1,
      outOfUniverse: [...OUTSIDE.map((s) => s.code), ABSENT_CODE],
      abolishedCount: 0,
      droppedInterpretations: 0,
      failedCodes: [],
      recompute: {
        updated: 0,
        scoresUpdated: 0,
        skippedNoRow: [...HELD.map((s) => s.id), NEW_HOLDER.id],
        skippedNoScore: [],
      },
    });
    // 財務行が無いので再計算の送信は無い
    expect(yieldCalls(calls)).toEqual([]);
    expect(calls).toHaveLength(HELD.length + 1);
    const after = snapshot();

    // 母集団外の優待行は id まで同じ (消して入れ直していない)。解釈も残る。
    expect(benefitsOf(after.benefits, OUTSIDE_IDS)).toEqual(benefitsOf(before.benefits, OUTSIDE_IDS));
    // 母集団の銘柄は作り直し (id が変わる)、解釈が戻る
    const heldIds = HELD.map((s) => s.id);
    const heldAfter = benefitsOf(after.benefits, heldIds);
    expect(heldAfter.map((b) => [b.stock_id, b.short_summary, b.estimated_value])).toEqual(
      HELD.map((s) => [s.id, `要約${s.code}`, 1000]),
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

  it("完全収集した一覧に無い母集団の銘柄だけ、優待行とis_yutaiを同batchで廃止する", async () => {
    const before = snapshot();
    captureConsole();
    const [abolished, ...rest] = HELD;
    const { calls, sender } = makeRecordingSender();

    const result = await importYutaiFull(db, rest.map((s) => fetched(s.code)), sender);

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
    const removal = calls.at(-1)!;
    expect(removal).toHaveLength(2);
    expect(removal[0].sql).toMatch(/delete from "yutai_benefits"/);
    expect(removal[1].sql).toMatch(/update "core_stocks"/);
  });

  it("真廃止のflag更新が失敗しても同batchの旧優待行削除をrollbackする", async () => {
    const [abolished, ...rest] = HELD;
    const before = snapshot();
    captureConsole();
    sqlite.exec(`CREATE TRIGGER reject_abolish BEFORE UPDATE OF is_yutai ON core_stocks
      WHEN NEW.id=${abolished.id} AND NEW.is_yutai=0
      BEGIN SELECT RAISE(ABORT, 'abolish write failure'); END;`);
    const { calls, sender } = makeAtomicSender();
    await expect(importYutaiFull(db, rest.map((s) => fetched(s.code)), sender)).rejects.toThrow("abolish write failure");
    expect(benefitsOf(snapshot().benefits, [abolished.id])).toEqual(benefitsOf(before.benefits, [abolished.id]));
    expect(isYutaiOf(abolished.id)).toBe(1);
    expect(calls).toHaveLength(HELD.length);
    expect(yieldCalls(calls)).toEqual([]);
  });

  it("掲載文が変わった優待は未解釈で入り、戻せなかった解釈の件数を返す", async () => {
    const logs = captureConsole();
    const [changed, ...rest] = HELD;

    const { sender } = makeRecordingSender();
    const result = await importYutaiFull(
      db,
      [
        fetched(changed.code, "架空優待 文言を変更"),
        ...rest.map((s) => fetched(s.code)),
      ],
      sender
    );

    expect(result).toMatchObject({ stockCount: HELD.length, abolishedCount: 0, droppedInterpretations: 1 });
    expect(
      benefitsOf(snapshot().benefits, [changed.id]).map((b) => [b.description, b.short_summary, b.estimated_value]),
    ).toEqual([[headedDescription("株主優待", "架空優待 文言を変更"), null, null]]);
    expect(logs.some((l) => l.includes("戻せない解釈") && l.includes("1件"))).toBe(true);
  });
});

describe("importYutaiFull は掲載文を切り詰めない", () => {
  it("500字超の掲載文・200字超の注記の末尾 tier 条件を落とさない", async () => {
    captureConsole();
    const [target, ...rest] = HELD;
    // 実 incident: 3447 の 3 群 (taskId 7be55faa/554a7eea/cb002b14) は旧
    // notes[:200] で保存文が文の途中で切断され、末尾 tier の根拠を失った。
    // 合成長文で構造を再現する (原文の引用なし)。
    const longDesc = `架空優待${target.code} ` + "あ".repeat(600);
    const longNotes = "い".repeat(300) + "【10年以上】10口";
    const data = fetched(target.code);
    data.benefits = [{ minShares: 100, description: longDesc, notes: longNotes, localRecordMonths: [3], heading: "株主優待" }];

    const { sender } = makeRecordingSender();
    await importYutaiFull(db, [data, ...rest.map((s) => fetched(s.code))], sender);

    const rows = benefitsOf(snapshot().benefits, [target.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].description).toBe(headedDescription("株主優待", `${longDesc}\n${longNotes}`));
    expect(String(rows[0].description).length).toBeGreaterThan(500);
    expect(String(rows[0].description).endsWith("【10年以上】10口")).toBe(true);
  });
});

describe("importYutaiFull は削除の前に止まる", () => {
  it(`優待行を持つ母集団の銘柄のうち今回も取得できたのが ${MIN_YUTAI_COVERAGE_PERCENT}% 未満なら、何も書かない`, async () => {
    const before = snapshot();
    captureConsole();

    // 20 銘柄のうち 18 銘柄 (90%)。個別ページの取得が大量に失敗した形。
    // 母集団外が取得結果に載っていても、割合には数えない。
    const { calls, sender } = makeRecordingSender();
    await expect(
      importYutaiFull(
        db,
        [...HELD.slice(2).map((s) => fetched(s.code)), ...OUTSIDE.map((s) => fetched(s.code))],
        sender
      ),
    ).rejects.toThrow(/優待データは削除していません/);
    expect(snapshot()).toEqual(before);
    expect(calls).toEqual([]);
  });

  it("取り込み先の銘柄が 1 件も無ければ、何も書かない", async () => {
    const before = snapshot();
    captureConsole();

    const { calls, sender } = makeRecordingSender();
    await expect(
      importYutaiFull(db, [...OUTSIDE.map((s) => fetched(s.code)), fetched(ABSENT_CODE)], sender),
    ).rejects.toThrow(/取り込み先の銘柄が 1 件もありません/);
    expect(snapshot()).toEqual(before);
    expect(calls).toEqual([]);
  });
});

describe("importYutaiFull の解釈の退避", () => {
  const sourceOf = (stockId: number): unknown[] =>
    sqlite
      .prepare("SELECT estimate_value_source FROM yutai_benefits WHERE stock_id = ? ORDER BY id")
      .all(stockId)
      .map((r) => (r as { estimate_value_source: unknown }).estimate_value_source);
  const valueOf = (stockId: number): unknown[] =>
    sqlite
      .prepare("SELECT estimated_value FROM yutai_benefits WHERE stock_id = ? ORDER BY id")
      .all(stockId)
      .map((r) => (r as { estimated_value: unknown }).estimated_value);

  it("退避した出典は検証通過で戻り、legacy-null は company に上がる。不認定は値ごと null", async () => {
    const [target, promoted, nulled] = HELD;
    sqlite
      .prepare("UPDATE yutai_benefits SET estimate_value_source = 'company' WHERE stock_id = ?")
      .run(target.id);
    // 額面 1,000 と合わない値 (共有厳密判定に落ちる)
    sqlite.prepare("UPDATE yutai_benefits SET estimated_value = 1001 WHERE stock_id = ?").run(nulled.id);
    captureConsole();
    const { sender } = makeRecordingSender();

    await importYutaiFull(db, HELD.map((s) => fetched(s.code)), sender);

    // company + 額面一致はそのまま戻る
    expect(sourceOf(target.id)).toEqual(["company"]);
    expect(valueOf(target.id)).toEqual([1000]);
    // legacy-null + 額面一致は company に上がる
    expect(sourceOf(promoted.id)).toEqual(["company"]);
    expect(valueOf(promoted.id)).toEqual([1000]);
    // 不認定は source 付け替えで温存せず、値ごと null
    expect(sourceOf(nulled.id)).toEqual([null]);
    expect(valueOf(nulled.id)).toEqual([null]);
  });

  it("共有厳密判定に落ちた推定値は要約だけ戻し、値は null で戻す", async () => {
    const [zeroRow, lotteryRow, ...rest] = HELD;
    // 0 値 (旧 LLM 経路の残存)
    sqlite
      .prepare("UPDATE yutai_benefits SET estimated_value = 0 WHERE stock_id = ?")
      .run(zeroRow.id);
    // 抽選賞品 (当選人数つきの賞品表記)
    const lotteryDesc = "80,000円相当:40名\n抽選で付与。";
    sqlite
      .prepare("UPDATE yutai_benefits SET description = ?, estimated_value = 80000 WHERE stock_id = ?")
      .run(lotteryDesc, lotteryRow.id);
    const logs = captureConsole();

    const { sender } = makeRecordingSender();
    await importYutaiFull(
      db,
      HELD.map((s) => (s.id === lotteryRow.id ? fetched(s.code, lotteryDesc) : fetched(s.code))),
      sender
    );

    const after = snapshot();
    // 要約は保持、値だけ null
    expect(
      benefitsOf(after.benefits, [zeroRow.id]).map((b) => [b.short_summary, b.estimated_value])
    ).toEqual([[`要約${zeroRow.code}`, null]]);
    expect(
      benefitsOf(after.benefits, [lotteryRow.id]).map((b) => [b.short_summary, b.estimated_value])
    ).toEqual([[null, null]]);
    // 正常な解釈はそのまま戻る
    expect(
      benefitsOf(after.benefits, [rest[0].id]).map((b) => [b.short_summary, b.estimated_value])
    ).toEqual([[`要約${rest[0].code}`, 1000]]);
    expect(logs.some((l) => l.includes("不認定の推定値") && l.includes("2件"))).toBe(true);
    // 残り 18 行は legacy-null から company に上がる
    expect(sourceOf(rest[0].id)).toEqual(["company"]);
    expect(logs.some((l) => l.includes("昇格") && l.includes("18件"))).toBe(true);
  });

  it("未対応の出典 (web) の値は削除の前に止め、何も書かない", async () => {
    const [target] = HELD;
    sqlite.prepare("UPDATE yutai_benefits SET estimate_value_source = 'web' WHERE stock_id = ?").run(target.id);
    const before = snapshot();
    captureConsole();
    const { calls, sender } = makeRecordingSender();

    await expect(importYutaiFull(db, HELD.map((s) => fetched(s.code)), sender)).rejects.toThrow(/未対応の出典/);
    expect(snapshot()).toEqual(before);
    expect(sourceOf(target.id)).toEqual(["web"]);
    expect(calls).toEqual([]);
  });
});

describe("単発権利日の全量取込", () => {
  it("同一掲載文・株数・月の単発日を解釈なしでも保持し、新規通常行はNULLで入れる", async () => {
    const [oneoff, ...rest] = HELD;
    sqlite.prepare("UPDATE yutai_benefits SET record_month=9, record_date='2026-09-02', short_summary=NULL, estimated_value=NULL WHERE stock_id=?").run(oneoff.id);
    const data = fetched(oneoff.code);
    data.benefits[0].localRecordMonths = [9];
    captureConsole();
    const { sender } = makeRecordingSender();
    await importYutaiFull(db, [data, ...rest.map((s) => fetched(s.code)), fetched(NEW_HOLDER.code)], sender);
    expect(sqlite.prepare("SELECT record_date FROM yutai_benefits WHERE stock_id=?").get(oneoff.id)).toEqual({ record_date: "2026-09-02" });
    expect(sqlite.prepare("SELECT record_date FROM yutai_benefits WHERE stock_id=?").get(NEW_HOLDER.id)).toEqual({ record_date: null });
  });

  it.each(["changed", "missing"])("単発の同定を失う %s は削除前に止める", async (kind) => {
    const [oneoff, ...rest] = HELD;
    sqlite.prepare("UPDATE yutai_benefits SET record_date='2026-03-02' WHERE stock_id=?").run(oneoff.id);
    const before = snapshot();
    captureConsole();
    const { calls, sender } = makeRecordingSender();
    const data = rest.map((s) => fetched(s.code));
    if (kind === "changed") data.push(fetched(oneoff.code, "変更後の掲載文"));
    await expect(importYutaiFull(db, data, sender)).rejects.toThrow(/単発権利日.*削除前/);
    expect(snapshot()).toEqual(before);
    expect(calls).toEqual([]);
  });
});

describe("planCarry (退避計画の純関数。原文抜粋)", () => {
  // RAW34TEXT は raw34 の原文抜粋 (pointer は raw34-excerpts.ts に cited)。
  const srcRow = (over: Partial<CarrySourceRow>): CarrySourceRow => ({
    code: "5929",
    description: RAW34TEXT["5929"],
    minShares: 100,
    recordMonth: 3,
    recordDate: null,
    shortSummary: "2年未満保有で優待品 500円相当",
    estimatedValue: 500,
    estimateValueSource: null,
    ...over,
  });
  const metaOf = (rows: CarrySourceRow[], heading = "株主優待"): Map<string, string[]> =>
    new Map(rows.map((r) => [carryKey(r.code, r.description, r.minShares, r.recordMonth), [heading]]));
  const grpOf = (rows: CarrySourceRow[]): Map<string, Map<string, { minShares: number[]; recordMonths: number[] }>> => {
    const out = new Map<string, Map<string, { minShares: number[]; recordMonths: number[] }>>();
    for (const r of rows) {
      let byCode = out.get(r.code);
      if (!byCode) out.set(r.code, (byCode = new Map()));
      const g = byCode.get(r.description);
      if (g) {
        g.minShares.push(r.minShares);
        g.recordMonths.push(r.recordMonth);
      } else {
        byCode.set(r.description, { minShares: [r.minShares], recordMonths: [r.recordMonth] });
      }
    }
    return out;
  };

  it("legacy-null の額面一致は company に上げて carry する", () => {
    const rows = [srcRow({})];
    const p = planCarry(rows, metaOf(rows), grpOf(rows));
    const key = carryKey("5929", RAW34TEXT["5929"], 100, 3);
    expect(p.carried.get(key)).toEqual({ shortSummary: "2年未満保有で優待品 500円相当", estimatedValue: 500, estimateValueSource: "company" });
    expect(p.promotedKeys).toEqual(new Set([key]));
    expect(p.nulledKeys).toEqual(new Set());
  });

  it("headed 既存行は本文キーで突き合う (素文 planned と cross-form carry)", () => {
    const plain = [srcRow({})];
    const headed = [srcRow({ description: headedDescription("株主優待", RAW34TEXT["5929"]) })];
    // 呼び出し側は planned 側を carryBody でキー化する (= 素文キー)。
    const p = planCarry(headed, metaOf(plain), grpOf(plain));
    const key = carryKey("5929", RAW34TEXT["5929"], 100, 3);
    expect(p.carried.get(key)).toEqual({ shortSummary: "2年未満保有で優待品 500円相当", estimatedValue: 500, estimateValueSource: "company" });
    expect(p.promotedKeys).toEqual(new Set([key]));
  });

  it("壊れた headed 既存行はキー化せず STOP する", () => {
    const rows = [srcRow({ description: "【種別：xxx】\n優待品 500円相当" })];
    expect(() => planCarry(rows, metaOf(rows), grpOf(rows))).toThrow(/headed 契約の壊れた掲載文/);
  });

  it("合成されない行 (幽霊月など) は昇格しない", () => {
    // 判定自体は通る額面一致だが、plannedMeta に無い = 表ローカルに合成されない。
    const rows = [srcRow({ recordMonth: 9 })];
    const p = planCarry(rows, new Map(), grpOf(rows));
    const key = carryKey("5929", RAW34TEXT["5929"], 100, 9);
    expect(p.carried.get(key)).toEqual({ shortSummary: "2年未満保有で優待品 500円相当", estimatedValue: 500, estimateValueSource: null });
    expect(p.promotedKeys).toEqual(new Set());
  });

  it("見出しだけの選択肢は HOLD にして値ごと null で戻す", () => {
    // 文言自体は額面一致だが、表見出しが選択肢 (単一代表値は不正確)。
    const rows = [srcRow({})];
    const key = carryKey("5929", RAW34TEXT["5929"], 100, 3);
    const p = planCarry(rows, new Map([[key, ["優待品カタログより選択"]]]), grpOf(rows));
    expect(p.carried.get(key)).toEqual({ shortSummary: null, estimatedValue: null, estimateValueSource: null });
    expect(p.nulledKeys).toEqual(new Set([key]));
    expect(p.promotedKeys).toEqual(new Set());
  });

  it("保有期間の落ちた旧要約と金額を持ち越さず、原文と条件を保持して再作成へ回す", () => {
    const rows = [srcRow({ description: "5年以上継続保有で合成商品3万円相当", shortSummary: "合成商品3万円相当", estimatedValue: 30000, estimateValueSource: "company" })];
    const p = planCarry(rows, metaOf(rows), grpOf(rows));
    const key = carryKey(rows[0].code, rows[0].description, 100, 3);
    expect(p.carried.get(key)).toEqual({ shortSummary: null, estimatedValue: null, estimateValueSource: null });
    expect(p.nulledKeys.has(key)).toBe(true);
    expect(p.carriedRecordDates.get(key)).toBeNull();
  });

  it("見出しの金額は額面根拠にならない (裸の値は上げない)", () => {
    // 文言に金額が無く値は不一致。見出しに同額があっても positive にしない。
    const rows = [srcRow({ description: "優待品の引換", estimatedValue: 3300 })];
    const key = carryKey("5929", "優待品の引換", 100, 3);
    const p = planCarry(rows, new Map([[key, ["3,300円相当の優待"]]]), grpOf(rows));
    expect(p.carried.get(key)).toEqual({ shortSummary: "2年未満保有で優待品 500円相当", estimatedValue: null, estimateValueSource: null });
    expect(p.promotedKeys).toEqual(new Set());
  });

  it("同一文言の群に株数違いの兄弟があれば混在 HOLD (singleton で通さない)", () => {
    // 100 株行だけ見れば額面一致だが、合成群に 1000 株の兄弟がある。
    const rows = [srcRow({})];
    const key = carryKey("5929", RAW34TEXT["5929"], 100, 3);
    const groups = new Map([
      ["5929", new Map([[RAW34TEXT["5929"], { minShares: [100, 1000], recordMonths: [3, 3] }]])],
    ]);
    const p = planCarry(rows, new Map([[key, ["株主優待"]]]), groups);
    expect(p.carried.get(key)).toEqual({ shortSummary: "2年未満保有で優待品 500円相当", estimatedValue: null, estimateValueSource: null });
    expect(p.nulledKeys).toEqual(new Set([key]));
    expect(p.promotedKeys).toEqual(new Set());
  });

  it("不認定の company 値は source を付け替えず値ごと null で戻す (8153 の単価)", () => {
    // 掲載文は 8153 原文の alias、銘柄コードは合成 (pure carry test に実コード不要)。
    const desc = RAW8153;
    const rows = [
      srcRow({ code: ABSENT_CODE, description: desc, shortSummary: "保有期間に応じた優待券", estimatedValue: 500, estimateValueSource: "company" }),
    ];
    const p = planCarry(rows, metaOf(rows), grpOf(rows));
    const key = carryKey(ABSENT_CODE, desc, 100, 3);
    // 保有条件を残した要約は保持、値と出典は null。
    expect(p.carried.get(key)).toEqual({ shortSummary: "保有期間に応じた優待券", estimatedValue: null, estimateValueSource: null });
    expect(p.nulledKeys).toEqual(new Set([key]));
    expect(p.promotedKeys).toEqual(new Set());
  });

  it("未対応の出典の非 null 値は STOP する (扱いを発明しない)", () => {
    expect(() => planCarry([srcRow({ estimateValueSource: "web" })], new Map(), new Map())).toThrow(/未対応の出典/);
    expect(() => planCarry([srcRow({ estimateValueSource: "other" })], new Map(), new Map())).toThrow(/未対応の出典/);
    // 値が null なら出典によらず要約を戻す (STOP しない)
    const rows = [srcRow({ estimatedValue: null, estimateValueSource: "web" })];
    const p = planCarry(rows, metaOf(rows), grpOf(rows));
    expect(p.carried.size).toBe(1);
  });

  it("同一 context の重複は同一なら畳み、食い違えば STOP する", () => {
    const row = srcRow({});
    const same = planCarry([row, { ...row }], metaOf([row]), grpOf([row, { ...row }]));
    expect(same.carried.size).toBe(1);
    expect(() => planCarry([row, { ...row, shortSummary: "別要約" }], metaOf([row]), grpOf([row, { ...row, shortSummary: "別要約" }]))).toThrow(/食い違う/);
    expect(() => planCarry([row, { ...row, estimatedValue: 501 }], metaOf([row]), grpOf([row, { ...row, estimatedValue: 501 }]))).toThrow(/食い違う/);
  });

  it("context (株数・権利月) が違えば別キーで carry する", () => {
    // 同一文言の群に月・株数の混在があるので、3 キーとも混在 HOLD で null 戻し。
    const rows = [
      srcRow({ recordMonth: 3 }),
      srcRow({ recordMonth: 9 }),
      srcRow({ minShares: 1000 }),
    ];
    const p = planCarry(rows, metaOf(rows), grpOf(rows));
    expect(p.carried.size).toBe(3);
    expect(p.nulledKeys).toEqual(
      new Set([
        carryKey("5929", RAW34TEXT["5929"], 100, 3),
        carryKey("5929", RAW34TEXT["5929"], 100, 9),
        carryKey("5929", RAW34TEXT["5929"], 1000, 3),
      ])
    );
    for (const c of p.carried.values()) {
      expect(c.estimatedValue).toBeNull();
      expect(c.estimateValueSource).toBeNull();
    }
    expect(p.promotedKeys).toEqual(new Set());
  });

  it("解釈が無い行は退避しない", () => {
    const rows = [srcRow({ shortSummary: null, estimatedValue: null })];
    const p = planCarry(rows, metaOf(rows), grpOf(rows));
    expect(p.carried.size).toBe(0);
  });

  it("同一contextで単発日と通常月の混在、不正暦日、欠落を拒否する", () => {
    const row = srcRow({ recordDate: "2026-03-02" });
    expect(() => planCarry([row, { ...row, recordDate: null }], metaOf([row]), grpOf([row]))).toThrow(/権利日が食い違う/);
    for (const recordDate of ["2026-02-30", undefined]) {
      expect(() => planCarry([{ ...row, recordDate } as CarrySourceRow], metaOf([row]), grpOf([row]))).toThrow(/単発基準日/);
    }
  });
});

describe("benefitRowsOf は表ローカル月でのみ合成する (8022 の幽霊 9 月行を作らない)", () => {
  it("公式随時は0の専用行を保ち、不正enumを保存前に止める", () => {
    const data = fetched("8022");
    data.benefits[0].localRecordMonths = [0];
    const got = benefitRowsOf(data);
    expect(got.heldBenefits).toBe(0);
    expect(got.rows).toHaveLength(1);
    expect(got.rows[0]).toMatchObject({ recordMonth: 0, minShares: data.benefits[0].minShares });
    expect(got.rows[0].description).toBe(headedDescription(data.benefits[0].heading, data.benefits[0].description));
    for (const invalid of [-1, 13, 0.5]) {
      data.benefits[0].localRecordMonths = [invalid];
      expect(() => benefitRowsOf(data)).toThrow(/権利時期が不正/);
    }
  });

  it("優待ごとに自分の表の月だけで行を作る (union 展開しない)", () => {
    const data: StockYutaiData = {
      ...fetched("8022"),
      benefits: [
        { minShares: 100, description: "3,300円相当", notes: "", localRecordMonths: [3], heading: "直営ゴルフスクールの入会金 無料" },
        { minShares: 100, description: "割引", notes: "", localRecordMonths: [3, 9], heading: "優待割引" },
      ],
    };
    const { rows, heldBenefits } = benefitRowsOf(data);
    expect(heldBenefits).toBe(0);
    expect(rows.map((r) => [r.recordMonth, r.minShares, r.description])).toEqual([
      [3, 100, headedDescription("直営ゴルフスクールの入会金 無料", "3,300円相当")],
      [3, 100, headedDescription("優待割引", "割引")],
      [9, 100, headedDescription("優待割引", "割引")],
    ]);
    // 合成元の表見出しは headed 契約で description 先頭に persist する (判定の HOLD 走査用)。
    expect(rows.map((r) => r.heading)).toEqual([
      "直営ゴルフスクールの入会金 無料",
      "優待割引",
      "優待割引",
    ]);
  });

  it("表の月が空の優待は合成せず held に数える", () => {
    const data: StockYutaiData = {
      ...fetched("8022"),
      benefits: [
        { minShares: 100, description: "x", notes: "", localRecordMonths: [], heading: "不明表" },
      ],
    };
    const { rows, heldBenefits } = benefitRowsOf(data);
    expect(rows).toEqual([]);
    expect(heldBenefits).toBe(1);
  });

  it("旧契約 (localRecordMonths 自体が無い) は契約エラーで明示する", () => {
    const data = fetched("8022");
    delete (data.benefits[0] as unknown as Record<string, unknown>).localRecordMonths;
    expect(() => benefitRowsOf(data)).toThrow(/localRecordMonths がありません/);
  });
});

describe("importYutaiFull は UNKNOWN 表月で書く前に止める (sender0・DB不変)", () => {
  it("held があると削除前に STOP し、何も書かない", async () => {
    const before = snapshot();
    captureConsole();
    const { calls, sender } = makeAtomicSender();
    const bad = fetched(HELD[0].code);
    bad.benefits = [
      { minShares: 100, description: descOf(HELD[0].code), notes: "", localRecordMonths: [], heading: "不明表" },
    ];
    const allData = [bad, ...HELD.slice(1).map((s) => fetched(s.code))];
    await expect(importYutaiFull(db, allData, sender)).rejects.toThrow(/表の月が無い優待/);
    expect(calls.length).toBe(0);
    expect(snapshot()).toEqual(before);
  });

  it("旧契約の取得結果は契約エラーで止め、何も書かない", async () => {
    const before = snapshot();
    captureConsole();
    const { calls, sender } = makeAtomicSender();
    const bad = fetched(HELD[0].code);
    delete (bad.benefits[0] as unknown as Record<string, unknown>).localRecordMonths;
    const allData = [bad, ...HELD.slice(1).map((s) => fetched(s.code))];
    await expect(importYutaiFull(db, allData, sender)).rejects.toThrow(/localRecordMonths がありません/);
    expect(calls.length).toBe(0);
    expect(snapshot()).toEqual(before);
  });
});

describe("importYutaiFull の post-image 利回り追随", () => {
  const finOf = (stockId: number) =>
    sqlite.prepare("SELECT price, yutai_yield, data_date FROM otakara_stock_financials WHERE stock_id = ?").get(stockId) as {
      price: number;
      yutai_yield: number | null;
      data_date: string;
    };
  const scoreOf = (stockId: number) =>
    sqlite.prepare("SELECT fundamental_score, technical_score, total_score FROM otakara_stock_scores WHERE stock_id = ?").get(stockId) as {
      fundamental_score: number;
      technical_score: number;
      total_score: number;
    };
  const benefitValuesOf = (stockId: number) =>
    (
      sqlite.prepare("SELECT estimated_value, estimate_value_source FROM yutai_benefits WHERE stock_id = ?").all(stockId) as {
        estimated_value: number | null;
        estimate_value_source: string | null;
      }[]
    ).map((r) => [r.estimated_value, r.estimate_value_source]);
  const isYutaiOf = (stockId: number) =>
    (sqlite.prepare("SELECT is_yutai FROM core_stocks WHERE id = ?").get(stockId) as { is_yutai: number }).is_yutai;

  /** 財務行 + スコア行を持つ銘柄を足す。スコアは渡した利回りで計算済み。 */
  const seedFinancialStock = (
    id: number,
    code: string,
    yutaiYield: number | null,
    opts: { insertCore?: boolean; active?: number; instrumentType?: string; isYutai?: number } = {}
  ) => {
    const { insertCore = true, active = 1, instrumentType = "equity", isYutai = 1 } = opts;
    if (insertCore) {
      sqlite
        .prepare("INSERT INTO core_stocks (id, code, name, market, is_active, is_yutai, instrument_type) VALUES (?, ?, ?, 'テスト市場', ?, ?, ?)")
        .run(id, code, `テスト${code}`, active, isYutai, instrumentType);
    }
    sqlite
      .prepare("INSERT INTO otakara_stock_financials (stock_id, price, per, pbr, dividend_yield, roe, yutai_yield, data_date) VALUES (?, 1000, 10, 1.0, 2.0, 8.0, ?, '2026-09-13')")
      .run(id, yutaiYield);
    const s = scoreStock({
      price: 1000, per: 10, pbr: 1.0, dividendYield: 2.0, roe: 8.0,
      ma25: null, rsi14: null, macd: null, macdSignal: null, yutaiYield,
    });
    sqlite
      .prepare("INSERT INTO otakara_stock_scores (stock_id, fundamental_score, technical_score, total_score) VALUES (?, ?, ?, ?)")
      .run(id, s.fundamentalScore, s.technicalScore, s.totalScore);
  };
  const seedBenefit = (stockId: number, description: string, value: number | null, source: string | null) => {
    const otherId = YUTAI_GENRES.findIndex((g) => g.slug === "other") + 1;
    sqlite
      .prepare("INSERT INTO yutai_benefits (stock_id, genre_id, description, short_summary, min_shares, record_month, estimated_value, estimate_value_source) VALUES (?, ?, ?, ?, 100, 3, ?, ?)")
      .run(stockId, otherId, description, `旧要約${stockId}`, value, source);
  };
  const expectedScore = (yutaiYield: number | null) => {
    const s = scoreStock({
      price: 1000, per: 10, pbr: 1.0, dividendYield: 2.0, roe: 8.0,
      ma25: null, rsi14: null, macd: null, macdSignal: null, yutaiYield,
    });
    return { fundamental_score: s.fundamentalScore, technical_score: s.technicalScore, total_score: s.totalScore };
  };
  /** INSERT を失敗させる取得結果 (min_shares NOT NULL 違反)。 */
  const failingFetched = (code: string): StockYutaiData => ({
    ...fetched(code),
    benefits: [{ minShares: undefined as unknown as number, description: "x", notes: "", localRecordMonths: [3], heading: "x" }],
  });

  it("厳密 carry で null になった値は利回り・スコアに追随する (raw8153。price/data_date は不変)", async () => {
    // 8153 原文の行。company 1,500 は共有厳密判定に落ちて null で戻る。
    seedFinancialStock(400, "9300", 1.5);
    seedBenefit(400, RAW8153, 1500, "company");
    const prevScore = scoreOf(400);
    captureConsole();
    const { calls, sender } = makeAtomicSender();

    const result = await importYutaiFull(
      db,
      [...HELD.map((s) => fetched(s.code)), fetched("9300", RAW34TEXT["8153"])],
      sender
    );

    // carry が値ごと null にし、利回りは入力なし → null、スコアも追随する
    expect(benefitValuesOf(400)).toEqual([[null, null]]);
    expect(finOf(400).yutai_yield).toBe(null);
    expect(scoreOf(400)).toEqual(expectedScore(null));
    expect(finOf(400).price).toBe(1000);
    expect(finOf(400).data_date).toBe("2026-09-13");
    expect(result.recompute.updated).toBe(1);
    // 財務行の無い 20 銘柄は対象外カウントが明示される
    expect(result.recompute.skippedNoRow).toEqual(HELD.map((s) => s.id));
    // 1 銘柄 1 送信 (preflight + 利回り + スコア。スコア不変なら 2 文)
    expect(yieldCalls(calls)).toHaveLength(1);
    const scoreChanged =
      prevScore.fundamental_score !== expectedScore(null).fundamental_score ||
      prevScore.technical_score !== expectedScore(null).technical_score ||
      prevScore.total_score !== expectedScore(null).total_score;
    expect(yieldCalls(calls)[0].length).toBe(scoreChanged ? 3 : 2);
    expect(yieldCalls(calls)[0][0].sql.startsWith("-- preflight")).toBe(true);
  });

  it("変わらない再実行は利回りlane 0 送信 (冪等)", async () => {
    seedFinancialStock(401, "9301", 9.99);
    seedBenefit(401, descOf("9301"), 1000, null);
    captureConsole();
    const targets = [...HELD.map((s) => fetched(s.code)), fetched("9301")];

    const first = makeAtomicSender();
    const r1 = await importYutaiFull(db, targets, first.sender);
    expect(r1.recompute.updated).toBe(1);
    expect(yieldCalls(first.calls)).toHaveLength(1);
    expect(finOf(401).yutai_yield).toBeCloseTo(1.0, 12);

    const second = makeAtomicSender();
    const r2 = await importYutaiFull(db, targets, second.sender);
    expect(r2.recompute.updated).toBe(0);
    expect(r2.recompute.scoresUpdated).toBe(0);
    expect(yieldCalls(second.calls)).toEqual([]);
    expect(second.calls).toHaveLength(targets.length);
  });

  it("同銘柄の途中INSERT失敗は旧全行/flagを保持し、後続保存・再計算を送らない", async () => {
    seedFinancialStock(HELD[0].id, HELD[0].code, 1.0, { insertCore: false });
    captureConsole();
    const { calls, sender } = makeAtomicSender();
    const before = snapshot();
    const beforeFin = finOf(HELD[0].id);
    const partial = fetched(HELD[0].code);
    partial.benefits.push(...failingFetched(HELD[0].code).benefits);
    const err = await importYutaiFull(db, [partial, ...HELD.slice(1).map((s) => fetched(s.code))], sender).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(AggregateError);
    expect((err as Error).message).toMatch(/NOT NULL/);
    expect(calls.length).toBe(1);
    expect(yieldCalls(calls)).toEqual([]);
    expect(snapshot()).toEqual(before);
    expect(finOf(HELD[0].id)).toEqual(beforeFin);
  });

  it("別銘柄の成功後にbatch失敗しても、失敗銘柄/後続/母集団外は旧行とflagを保つ", async () => {
    seedFinancialStock(HELD[0].id, HELD[0].code, 1.0, { insertCore: false });
    captureConsole();
    const { calls, sender } = makeAtomicSender();
    const [success, failed, ...rest] = HELD;
    const before = snapshot();

    const err = await importYutaiFull(
      db,
      [fetched(success.code), failingFetched(failed.code), ...rest.map((s) => fetched(s.code))],
      sender
    ).then(
      () => null,
      (e: unknown) => e
    );
    expect((err as Error).message).toMatch(/NOT NULL/);
    expect(calls).toHaveLength(2);
    expect(yieldCalls(calls)).toEqual([]);
    const protectedIds = [failed.id, ...rest.map((s) => s.id), ...OUTSIDE_IDS];
    expect(benefitsOf(snapshot().benefits, protectedIds)).toEqual(benefitsOf(before.benefits, protectedIds));
    expect(isYutaiOf(failed.id)).toBe(1);
    expect(isYutaiOf(rest[0].id)).toBe(1);
  });

  it("送信失敗は成功結果も成功ログも出さない", async () => {
    seedFinancialStock(402, "9302", 9.99);
    seedBenefit(402, descOf("9302"), 1000, null);
    const logs = captureConsole();
    const sender: AtomicBatchSender = async () => {
      throw new Error("送信失敗 (テスト)");
    };

    await expect(
      importYutaiFull(db, [...HELD.map((s) => fetched(s.code)), fetched("9302")], sender)
    ).rejects.toThrow(/送信失敗/);
    expect(logs.some((l) => l.includes("利回り再計算を適用"))).toBe(false);
    // importer 自身は financials に書かない (stale のまま残る)
    expect(finOf(402).yutai_yield).toBe(9.99);
  });

  it("優待行なし・未取得でも残存利回り (0 含む) は scope に入り直る。母集団外は不変", async () => {
    // 中断再入の境界: 優待行なし・is_yutai=false・allData 不在でも、利回りが
    // non-null (0 を含む) なら scope の利回り lane で拾って null に直す。
    seedFinancialStock(403, "9303", 0, { isYutai: 0 });
    // 対照: 非母集団 (inactive / 非 equity) の残存利回りには触らない。
    seedFinancialStock(404, "9404", 0, { active: 0 });
    seedFinancialStock(405, "1298", 0, { instrumentType: "reit_fund" }); // 1298: 合成コード (<1300 policy)
    captureConsole();
    const targets = HELD.map((s) => fetched(s.code));

    const first = makeAtomicSender();
    const r1 = await importYutaiFull(db, targets, first.sender);
    expect(r1.recompute.updated).toBe(1);
    expect(yieldCalls(first.calls)).toHaveLength(1);
    expect(finOf(403).yutai_yield).toBe(null);
    expect(scoreOf(403)).toEqual(expectedScore(null));
    expect(finOf(403).price).toBe(1000);
    expect(finOf(403).data_date).toBe("2026-09-13");
    expect(isYutaiOf(403)).toBe(0);
    expect(finOf(404).yutai_yield).toBe(0);
    expect(finOf(405).yutai_yield).toBe(0);
    expect(scoreOf(404)).toEqual(expectedScore(0));
    expect(scoreOf(405)).toEqual(expectedScore(0));

    const second = makeAtomicSender();
    const r2 = await importYutaiFull(db, targets, second.sender);
    expect(r2.recompute.updated).toBe(0);
    expect(r2.recompute.scoresUpdated).toBe(0);
    expect(yieldCalls(second.calls)).toEqual([]);
  });

  it("応答不明のsender throwは1送信で止まり、廃止/後続/再計算の追加writeをしない", async () => {
    seedFinancialStock(HELD[0].id, HELD[0].code, 1.0, { insertCore: false });
    const logs = captureConsole();
    const before = snapshot();
    const sender = vi.fn<AtomicBatchSender>(async () => { throw new Error("応答不明 (テスト)"); });

    const err = await importYutaiFull(db, HELD.map((s) => failingFetched(s.code)), sender).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("応答不明 (テスト)");
    expect(sender).toHaveBeenCalledTimes(1);
    expect(snapshot()).toEqual(before);
    expect(logs.some((l) => l.includes("利回り再計算を適用"))).toBe(false);
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
