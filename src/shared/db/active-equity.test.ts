/**
 * 母集団の述語 (src/shared/db/active-equity.ts) の検証。
 *
 * 固定したい契約:
 *
 *   1. 発行 SQL が `is_active = ?` と `instrument_type = ?` の AND で、値は bind の
 *      まま (`[1, "equity"]`)。述語を片方でも落とすと落ちる。
 *   2. 日次取込 (src/cron/daily.ts / src/cron/monthly.ts) と公開面に、`is_active`
 *      単独の母集団述語 `eq(<...>stocks.isActive, true)` が残っていない。1 箇所でも
 *      残ると、そこだけ非普通株を含む別の集合を見る (分母と分子がずれる、凍結した
 *      値が一覧に並ぶ)。
 *   3. 2 の検出器が拾うべき書き方を拾い、コメントの中の同じ文字列は拾わない。
 *   4. 取込の母集団の述語 `ingestUniverseCondition()` の発行 SQL が
 *      `instrument_type = ?` と (`is_active = ?` かつ `instrument_type is null`) の OR で、
 *      値は bind のまま (`["equity", 0]`)。取り込む行・取り込まない行は
 *      src/cron/ingest-universe.test.ts が値で見る。
 *
 * 2 は書き方の検査で、実際に非普通株が落ちるかは値で見ているテストがある:
 * src/cron/daily-targets.test.ts / daily-sector-aggregate.test.ts /
 * momentum-projection.test.ts / monthly-rebuild-universe.test.ts と、
 * 各サービスの tests (rsi screening-freshness / swing active-equity-universe /
 * financial-math emh-projection / otakara screening-pagination・genres-pagination /
 * yuho active-equity-universe)。rsi ホームの件数 (services/rsi-screening/src/routes/pages.ts)
 * は値のテストを持たないので、この静的検査だけが担保している。
 */
import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import { INSTRUMENT_TYPE_EQUITY } from "../jpx/instrument-type.js";
import { activeEquityCondition, ingestUniverseCondition } from "./active-equity.js";
import {
  NOT_PUBLIC_SURFACE,
  PUBLIC_SURFACE_DIRS,
  ROOT,
  collectSources,
  stripComments,
} from "./tests/source-scan.js";

/**
 * `is_active` 単独の母集団述語。表の側は `stocks` で終わる識別子を拾う
 * (`stocks` / `coreSchema.stocks` / `coreStocks`)。
 */
const IS_ACTIVE_ONLY = /\beq\(\s*(?:\w+\.)*\w*[Ss]tocks\.isActive\s*,\s*true\s*\)/g;

function findIsActiveOnly(source: string): string[] {
  return [...stripComments(source).matchAll(IS_ACTIVE_ONLY)].map((m) => m[0]);
}

/**
 * 走査対象 (リポジトリルートからの相対パス、区切りは `/`)。
 *
 * - 日次取込と、その値を再利用する月次: src/cron/daily.ts / src/cron/monthly.ts
 * - 公開面: `PUBLIC_SURFACE_DIRS` を `collectSources` で走査したファイル。除外
 *   (tests / data-scripts / db) は core-stocks-license-boundary.test.ts と同じ。
 *
 * 対象外にしたもの:
 *
 * - src/cron/universe.ts — `is_active` の所有者 (JPX の一覧で対象外化する側)。
 *   母集団ガード (c)(d1)(d2) は「既存 active 全体」を読んだうえで equity の件数を
 *   JS で数える必要があり、非普通株の `instrument_type` 充填計画も同じ SELECT から
 *   作る。日次の母集団を**読む**側ではないので、ここを equity に絞ると充填と
 *   ガードが壊れる。
 * - src/shared/db/core-repo.ts — import している箇所が 0 の未使用関数群。
 *   日次にも公開面にも流れない。
 * - src/shared/db/active-equity.ts — 述語の定義そのもの。
 */
function scanTargets(): string[] {
  const cron = ["src/cron/daily.ts", "src/cron/monthly.ts"];
  const surfaces = PUBLIC_SURFACE_DIRS.flatMap((dir) => collectSources(join(ROOT, dir)))
    .map((path) => relative(ROOT, path).split(sep).join("/"))
    .filter((rel) => !NOT_PUBLIC_SURFACE.test(rel));
  return [...cron, ...surfaces];
}

describe("activeEquityCondition", () => {
  it("発行 SQL は is_active と instrument_type の AND で、値は bind のまま", () => {
    const { sql, params } = new SQLiteSyncDialect().sqlToQuery(activeEquityCondition());
    expect({ sql, params }).toEqual({
      sql: '("core_stocks"."is_active" = ? and "core_stocks"."instrument_type" = ?)',
      params: [1, "equity"],
    });
    // 文字列は instrument-type.ts の正本から来ている (stockStock の universe_guards と同じ値)。
    expect(INSTRUMENT_TYPE_EQUITY).toBe("equity");
  });

  it("呼ぶたびに新しい SQL を返す (インスタンスを共有しない)", () => {
    expect(activeEquityCondition()).not.toBe(activeEquityCondition());
  });
});

describe("ingestUniverseCondition (TDnet / EDINET の取込の母集団)", () => {
  it("発行 SQL は equity か (is_active = 0 かつ区分が NULL) で、値は bind のまま", () => {
    const { sql, params } = new SQLiteSyncDialect().sqlToQuery(ingestUniverseCondition());
    expect({ sql, params }).toEqual({
      sql:
        '("core_stocks"."instrument_type" = ? or ("core_stocks"."is_active" = ? and "core_stocks"."instrument_type" is null))',
      params: ["equity", 0],
    });
  });

  it("呼ぶたびに新しい SQL を返す (インスタンスを共有しない)", () => {
    expect(ingestUniverseCondition()).not.toBe(ingestUniverseCondition());
  });
});

describe("日次取込と公開面に is_active 単独の母集団述語が残っていない", () => {
  it("走査対象が空振りしていない (ガード自体の健全性)", () => {
    // 走査が 0 件だと下のテストは無条件に緑になる。書き換えた呼び出し元が
    // 全部入っていることを確かめる。
    expect(scanTargets()).toEqual(
      expect.arrayContaining([
        "src/cron/daily.ts",
        "src/cron/monthly.ts",
        "services/rsi-screening/src/routes/pages.ts",
        "services/rsi-screening/src/services/screening-service.ts",
        "services/swing-trading/src/routes/pages.ts",
        "services/financial-math/src/routes/pages.ts",
        "services/otakara-yutai/app.ts",
        "services/yuho-quant/src/services/order-query.ts",
        "services/yuho-quant/src/services/overseas-query.ts",
      ]),
    );
  });

  it("eq(<...>stocks.isActive, true) が 0 件 (activeEquityCondition() を使う)", () => {
    const offenders = scanTargets().flatMap((rel) =>
      findIsActiveOnly(readFileSync(join(ROOT, rel), "utf-8")).map((m) => `${rel}: ${m}`),
    );
    expect(
      offenders,
      "日次取込と公開面の母集団は src/shared/db/active-equity.ts の activeEquityCondition() で絞ること。" +
        " is_active 単独だと、日次が更新しない非普通株まで含む別の集合になる",
    ).toEqual([]);
  });

  it("検出器が表の書き方を問わず拾い、コメントは拾わない", () => {
    // 拾うべきもの
    expect(findIsActiveOnly("eq(stocks.isActive, true)")).toHaveLength(1);
    expect(findIsActiveOnly("eq(coreSchema.stocks.isActive, true)")).toHaveLength(1);
    expect(findIsActiveOnly("eq(coreStocks.isActive, true)")).toHaveLength(1);
    expect(findIsActiveOnly("and(eq(x.stockId, stocks.id), eq( stocks.isActive ,true ))")).toHaveLength(1);
    // コメントの中の同じ文字列は拾わない
    expect(findIsActiveOnly("// eq(stocks.isActive, true)")).toEqual([]);
    expect(findIsActiveOnly("/* eq(coreSchema.stocks.isActive, true) */")).toEqual([]);
    // 別の述語は拾わない
    expect(findIsActiveOnly("eq(stocks.isYutai, true)")).toEqual([]);
    expect(findIsActiveOnly("eq(stocks.isActive, false)")).toEqual([]);
    expect(findIsActiveOnly("activeEquityCondition()")).toEqual([]);
  });
});
