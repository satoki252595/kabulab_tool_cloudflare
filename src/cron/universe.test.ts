import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import * as coreSchema from "../shared/db/core-schema.js";
import type { JpxRow } from "../shared/jpx/sectors.js";
import {
  UPSERT_CHUNK,
  assertUniverseCoverage,
  countUnclassifiedCategories,
  coverageDenominator,
  instrumentTypeBackfilled,
  planInstrumentTypeUpdates,
  shouldDeactivateUniverseCode,
  writeUniverse,
} from "./universe.js";

describe("assertUniverseCoverage", () => {
  it("2026-06-30 JPX実件数と直近D1 active件数を受理する", () => {
    expect(() =>
      assertUniverseCoverage(4_437, 3_709, 3_718, 0)
    ).not.toThrow();
  });

  it("raw・対象株の部分取得と既存母集団からの異常縮小をmutation前に拒否する", () => {
    expect(() => assertUniverseCoverage(3_900, 3_709, 3_718, 0)).toThrow(
      "JPX listing"
    );
    expect(() => assertUniverseCoverage(4_437, 200, 3_718, 0)).toThrow(
      "安全下限"
    );
    expect(() => assertUniverseCoverage(4_437, 3_600, 3_718, 0)).toThrow(
      "98% 未満"
    );
  });

  it("195銘柄規模の対象外化候補をupsert前に拒否する", () => {
    expect(() => assertUniverseCoverage(4_437, 3_709, 3_718, 195)).toThrow(
      "対象外化候補"
    );
  });
});

/**
 * 移行 P4b (ETF/ETN/PRO/外国株 +725 行) 後の母集団を想定した回帰。
 * 実際に月次で throw するのはこちら (kabulab-cf) 側なので、stockStock 側
 * (`universe_guards.py`) と同じ分母・同じ縮退でなければ母集団同期が止まる。
 */
describe("assertUniverseCoverage: instrument_type の分母 (移行 P4b 対向)", () => {
  /** P4b 後の実測見込み: active 4,440 (= 内国普通株 3,700 + 非株式 740)。 */
  const P4B_ACTIVE = 4_440;
  const P4B_EQUITY_ACTIVE = 3_700;

  it("P4b 後の母集団を equity の分母で受理する (分母が active 全体なら 0.833 で落ちていた)", () => {
    expect(() =>
      assertUniverseCoverage(4_437, 3_700, P4B_ACTIVE, 0, {
        existingEquityActiveCount: P4B_EQUITY_ACTIVE,
        pendingDeactivationEquityCount: 0,
      })
    ).not.toThrow();
    // 分母を渡さない = 従来どおり active 全体。P4b では必ず throw する
    // (= 揃えないと毎月止まる、を固定しておく)。
    expect(() =>
      assertUniverseCoverage(4_437, 3_700, P4B_ACTIVE, 0)
    ).toThrow("98% 未満");
  });

  it("instrument_type が全 NULL の遷移期は従来の分母へ縮退する (fail-closed)", () => {
    // 充填前の active 3,715 は集合として内国普通株とほぼ一致するので通る。
    expect(() =>
      assertUniverseCoverage(4_437, 3_709, 3_718, 0, {
        existingEquityActiveCount: 0,
        pendingDeactivationEquityCount: 0,
      })
    ).not.toThrow();
    // 未充填のまま P4b を実行すると 0.833 で止まる。これが fail-closed の実体。
    expect(() =>
      assertUniverseCoverage(4_437, 3_700, P4B_ACTIVE, 0, {
        existingEquityActiveCount: 0,
        pendingDeactivationEquityCount: 0,
      })
    ).toThrow("未充填");
  });

  it("部分充填の equity 件数を分母にして fail-open しない", () => {
    // 充填が 500 件で止まった状態。equity を分母にすると 3,100/500 = 6.2 で
    // 0.98 を割らず、実際は 3,100/4,440 = 0.698 の部分取得を素通ししてしまう。
    expect(() =>
      assertUniverseCoverage(4_437, 3_100, P4B_ACTIVE, 0, {
        existingEquityActiveCount: 500,
        pendingDeactivationEquityCount: 0,
      })
    ).toThrow("部分充填");
  });

  it("部分充填の equity 件数を分母にした (d2) の誤発火もさせない", () => {
    // 11/500 = 2.2% で止まるが、実母集団に対しては 11/3,700 = 0.3%。
    // 被覆率側が通る入力 (equityCount=3,700) で (d2) だけを見る。
    expect(() =>
      assertUniverseCoverage(4_437, 3_700, P4B_ACTIVE, 11, {
        existingEquityActiveCount: 500,
        pendingDeactivationEquityCount: 11,
      })
    ).toThrow("部分充填");
    // 充填済みなら同じ 11 件は 0.3% なので当然通る。
    expect(() =>
      assertUniverseCoverage(4_437, 3_700, P4B_ACTIVE, 11, {
        existingEquityActiveCount: P4B_EQUITY_ACTIVE,
        pendingDeactivationEquityCount: 11,
      })
    ).not.toThrow();
  });

  it("(d1) を通り抜ける内国普通株の大量対象外化を (d2) が止める", () => {
    // 75 件は active 全体 4,440 の 1.69% なので (d1) は通る。P4b で実効上限が
    // 74 → 88 件へ緩んだ分がここ。equity 3,700 に対しては 2.02% で (d2) が止める。
    expect(() =>
      assertUniverseCoverage(4_437, 3_700, P4B_ACTIVE, 75, {
        existingEquityActiveCount: P4B_EQUITY_ACTIVE,
        pendingDeactivationEquityCount: 75,
      })
    ).toThrow("内国普通株の対象外化候補");
    // 境界 (74/3,700 = ちょうど 2%) は通す。比較の向きを移植元と揃える。
    expect(() =>
      assertUniverseCoverage(4_437, 3_700, P4B_ACTIVE, 74, {
        existingEquityActiveCount: P4B_EQUITY_ACTIVE,
        pendingDeactivationEquityCount: 74,
      })
    ).not.toThrow();
  });

  it("equity が active 全体を超える入力は部分集合違反として先に止める", () => {
    expect(() =>
      assertUniverseCoverage(4_437, 3_709, 3_718, 0, {
        existingEquityActiveCount: 3_719,
      })
    ).toThrow("部分集合");
  });

  it("初回 seed (existing=0) は移植元どおり (c)(d) を丸ごとスキップする", () => {
    expect(() =>
      assertUniverseCoverage(4_437, 3_709, 0, 0, {
        existingEquityActiveCount: 0,
        pendingDeactivationEquityCount: 0,
      })
    ).not.toThrow();
  });
});

describe("instrumentTypeBackfilled / coverageDenominator", () => {
  it("未観測・未充填・部分充填を 1 つの述語で束ねる", () => {
    expect(instrumentTypeBackfilled(null)).toBe(false);
    expect(instrumentTypeBackfilled(undefined)).toBe(false);
    expect(instrumentTypeBackfilled(0)).toBe(false);
    expect(instrumentTypeBackfilled(2_999)).toBe(false);
    // 下限は MIN_EQUITY_ROWS と同じ 3,000 (新しい数字を発明していない)
    expect(instrumentTypeBackfilled(3_000)).toBe(true);
  });

  it("分母を選んだ理由をラベルで返す (0.833 の原因が読めるように)", () => {
    expect(coverageDenominator(4_440, null)).toEqual({
      value: 4_440,
      label: expect.stringContaining("未観測"),
    });
    expect(coverageDenominator(4_440, 0).value).toBe(4_440);
    expect(coverageDenominator(4_440, 500).label).toContain("部分充填");
    expect(coverageDenominator(4_440, 3_700)).toEqual({
      value: 3_700,
      label: "active かつ equity",
    });
  });
});

describe("shouldDeactivateUniverseCode", () => {
  const currentJpxCodes = new Set(["9432", "25935"]);

  it("JPXに存在する通常株をactiveのまま保持する", () => {
    expect(shouldDeactivateUniverseCode("9432", currentJpxCodes)).toBe(false);
  });

  it("JPX不在銘柄と共有コード契約外の5桁種類株を対象外化する", () => {
    expect(shouldDeactivateUniverseCode("1449", currentJpxCodes)).toBe(true);
    expect(shouldDeactivateUniverseCode("25935", currentJpxCodes)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 移行 P4b 第 1 段: 既存行への instrument_type の充填 (行は増やさない)
// ---------------------------------------------------------------------------

/**
 * JPX data_j の形の行。内国株式の 3 行は sectors*.test.ts と同じ data_j の実在行。
 * ETF と REIT の 2 行は合成で、コードは JPX の上場銘柄一覧 (2026-08-31 版) にも本番
 * core_stocks にも無く、銘柄名も架空。区分文字列だけが data_j の表記
 * (REIT 等は REIT… の 1 区分しか無い)。
 */
const TOYOTA: JpxRow = {
  asOf: "2026-06-30",
  code: "7203",
  name: "トヨタ自動車",
  marketCategory: "プライム（内国株式）",
  sector33: "輸送用機器",
};
const VERITAS: JpxRow = {
  asOf: "2026-06-30",
  code: "130A",
  name: "Ｖｅｒｉｔａｓ　Ｉｎ　Ｓｉｌｉｃｏ",
  marketCategory: "グロース（内国株式）",
  sector33: "医薬品",
};
const ITO_EN_PREFERRED: JpxRow = {
  asOf: "2026-06-30",
  code: "25935",
  name: "伊藤園第１種優先株式",
  marketCategory: "プライム（内国株式）",
  sector33: "食料品",
};
const SYNTHETIC_ETF: JpxRow = {
  asOf: "2026-06-30",
  code: "1202",
  name: "合成テスト指数連動型ＥＴＦ",
  marketCategory: "ETF・ETN",
  sector33: null,
};
const SYNTHETIC_REIT: JpxRow = {
  asOf: "2026-06-30",
  code: "1201",
  name: "合成テストリート投資法人",
  marketCategory: "REIT・ベンチャーファンド・カントリーファンド・インフラファンド",
  sector33: null,
};

describe("planInstrumentTypeUpdates", () => {
  const jpx = [TOYOTA, VERITAS, ITO_EN_PREFERRED, SYNTHETIC_ETF, SYNTHETIC_REIT];

  it("内国普通株以外の既存 active 行だけに区分を書く (内国普通株は upsert の担当)", () => {
    const updates = planInstrumentTypeUpdates(
      [
        { id: 1, code: "7203", instrumentType: null },
        { id: 2, code: "1201", instrumentType: null },
      ],
      jpx,
      new Set()
    );
    expect(updates).toEqual([{ id: 2, code: "1201", from: null, to: "reit_fund" }]);
  });

  it("行は増やさない: core に無い ETF (1202) は data_j にあっても計画に出ない", () => {
    const updates = planInstrumentTypeUpdates(
      [{ id: 2, code: "1201", instrumentType: null }],
      jpx,
      new Set()
    );
    expect(updates.map((u) => u.code)).not.toContain("1202");
  });

  it("値が変わらない行は書かない", () => {
    expect(
      planInstrumentTypeUpdates(
        [{ id: 2, code: "1201", instrumentType: "reit_fund" }],
        jpx,
        new Set()
      )
    ).toEqual([]);
  });

  it("対象外化する行は、値が変わる場合でも書かない", () => {
    // 以前は id 3 を instrumentType: null にしていたが、25935 の分類も null なので
    // 「値が変わらない」の枝で先に除かれ、deactivatedIds の除外を消しても緑のままだった
    // (レビューで変異させて確認)。分類 (null) と違う値を置いて、除外の枝だけで守られる形にする。
    const deactivating = { id: 3, code: "25935", instrumentType: "equity" };
    // 前提: 対象外化の集合に入れなければ計画に出る (= この入力は除外の枝を通る)
    expect(planInstrumentTypeUpdates([deactivating], jpx, new Set())).toEqual([
      { id: 3, code: "25935", from: "equity", to: null },
    ]);
    expect(planInstrumentTypeUpdates([deactivating], jpx, new Set([3]))).toEqual([]);
  });

  it("equity のまま区分が変わった行は書き換える (equity 分母を isListedEquity の集合に保つ)", () => {
    // 内国株式から PRO Market へ移ると data_j に残るので対象外化されず、
    // upsert の対象からも外れる。書き換えないと `equity` のまま残る。
    const movedToPro: JpxRow = { ...VERITAS, marketCategory: "PRO Market" };
    expect(
      planInstrumentTypeUpdates(
        [{ id: 4, code: "130A", instrumentType: "equity" }],
        [movedToPro],
        new Set()
      )
    ).toEqual([{ id: 4, code: "130A", from: "equity", to: "pro_market" }]);
  });

  it("分類できない区分は別の語で埋めず null (未分類) を書く", () => {
    const renamed: JpxRow = { ...SYNTHETIC_REIT, marketCategory: "REIT等" };
    expect(
      planInstrumentTypeUpdates(
        [{ id: 2, code: "1201", instrumentType: "reit_fund" }],
        [renamed],
        new Set()
      )
    ).toEqual([{ id: 2, code: "1201", from: "reit_fund", to: null }]);
  });

  it("同じコードで区分が食い違う data_j は書込前に止める", () => {
    expect(() =>
      planInstrumentTypeUpdates(
        [{ id: 2, code: "1201", instrumentType: null }],
        [SYNTHETIC_REIT, { ...SYNTHETIC_REIT, marketCategory: "ETF・ETN" }],
        new Set()
      )
    ).toThrow("食い違って");
  });
});

describe("countUnclassifiedCategories", () => {
  it("5 文字の種類株は内国株式の区分で未分類に数える (区分の変化の検知用)", () => {
    expect(
      countUnclassifiedCategories([TOYOTA, ITO_EN_PREFERRED, SYNTHETIC_ETF, SYNTHETIC_REIT])
    ).toEqual({ "プライム（内国株式）": 1 });
  });
});

const CORE_STOCKS_DDL = `
CREATE TABLE core_stocks (
  id integer PRIMARY KEY AUTOINCREMENT,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  market text NOT NULL,
  sector text,
  is_active integer NOT NULL DEFAULT 1,
  is_yutai integer NOT NULL DEFAULT 0,
  created_at integer NOT NULL DEFAULT (unixepoch()),
  updated_at integer NOT NULL DEFAULT (unixepoch()),
  instrument_type text, sector33 text, sector17 text, edinet_code text,
  listing_status text, listing_date text, delisting_date text,
  license_tag text, src_source text, src_data_date text,
  src_fetched_at integer, quality text
);
`;

describe("writeUniverse: instrument_type の書込", () => {
  let sqlite: DatabaseSync;
  /** 実行した文ごとの bind 数 (D1 の上限 100/文 を見る)。 */
  let bindCounts: { sql: string; params: number }[];

  function makeProxyDb(target: DatabaseSync) {
    return drizzle(
      async (sqlStr, params, method) => {
        bindCounts.push({ sql: sqlStr, params: params.length });
        const stmt = target.prepare(sqlStr);
        const bind = params as (null | number | bigint | string | Uint8Array)[];
        if (method === "run") {
          stmt.run(...bind);
          return { rows: [] };
        }
        const rows = (stmt.all(...bind) as Record<string, unknown>[]).map((o) =>
          Object.values(o)
        );
        return { rows: method === "get" ? (rows[0] ?? []) : rows };
      },
      { schema: coreSchema }
    );
  }

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec(CORE_STOCKS_DDL);
    bindCounts = [];
    const ins = sqlite.prepare(
      "INSERT INTO core_stocks (id, code, name, market, sector, is_active, is_yutai, sector33) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    );
    // 本番の形: 内国普通株は market=JPX 区分、優待 REIT は otakara の取込が入れた market='東証'。
    ins.run(1, "7203", "トヨタ自動車", "プライム（内国株式）", "輸送用機器", 1, 1, "輸送用機器");
    ins.run(2, "1201", "合成テストリート投資法人", "東証", null, 1, 1, null);
    ins.run(3, "25935", "伊藤園第１種優先株式", "プライム（内国株式）", "食料品", 1, 0, null);
  });

  afterEach(() => {
    sqlite?.close();
  });

  function readStocks() {
    return sqlite
      .prepare(
        "SELECT id, code, is_active, instrument_type, sector33, is_yutai FROM core_stocks ORDER BY id"
      )
      .all();
  }

  it("equity は upsert で、非 equity は既存行の UPDATE で入り、行も is_active も増えない", async () => {
    const db = makeProxyDb(sqlite);
    const result = await writeUniverse(db as never, {
      equities: [TOYOTA],
      instrumentTypeUpdates: [{ id: 2, code: "1201", from: null, to: "reit_fund" }],
      deactivatedIds: [3],
    });
    expect(result).toEqual({ upserted: 1, instrumentTypeUpdated: 1 });
    expect(readStocks()).toEqual([
      // sector33 (stockStock が書く enrich 列) と is_yutai は触らない
      { id: 1, code: "7203", is_active: 1, instrument_type: "equity", sector33: "輸送用機器", is_yutai: 1 },
      { id: 2, code: "1201", is_active: 1, instrument_type: "reit_fund", sector33: null, is_yutai: 1 },
      // 対象外化する行は instrument_type を書かない
      { id: 3, code: "25935", is_active: 0, instrument_type: null, sector33: null, is_yutai: 0 },
    ]);
  });

  it("既存行の instrument_type を上書きする (equity 以外の値が残っていても equity に戻す)", async () => {
    sqlite.exec("UPDATE core_stocks SET instrument_type = 'pro_market' WHERE id = 1");
    const db = makeProxyDb(sqlite);
    await writeUniverse(db as never, {
      equities: [TOYOTA],
      instrumentTypeUpdates: [],
      deactivatedIds: [],
    });
    expect(
      sqlite.prepare("SELECT instrument_type FROM core_stocks WHERE id = 1").get()
    ).toEqual({ instrument_type: "equity" });
  });

  it("upsert の bind 数は 1 行 6 のまま (instrument_type はリテラル) で、チャンク上限でも 100 以下", async () => {
    const db = makeProxyDb(sqlite);
    await writeUniverse(db as never, {
      equities: [TOYOTA, VERITAS],
      instrumentTypeUpdates: [],
      deactivatedIds: [],
    });
    const upsert = bindCounts.find((b) => b.sql.startsWith("insert into"));
    expect(upsert?.params).toBe(12);
    expect(upsert?.sql).toContain("'equity'");
    // 1 行 6 bind × UPSERT_CHUNK 行 が D1 の上限 100 を超えない。
    expect(6 * UPSERT_CHUNK).toBeLessThanOrEqual(100);
    // instrument_type を bind にすると 7 × 16 = 112 で超える (リテラルにした理由)。
    expect(7 * UPSERT_CHUNK).toBeGreaterThan(100);
  });

  it("非 equity の UPDATE は値ごとに 1 文 (値 1 + id 最大 80 = 81 bind)", async () => {
    const db = makeProxyDb(sqlite);
    await writeUniverse(db as never, {
      equities: [],
      instrumentTypeUpdates: [
        { id: 2, code: "1201", from: null, to: "reit_fund" },
        { id: 3, code: "25935", from: null, to: null },
      ],
      deactivatedIds: [],
    });
    const updates = bindCounts.filter((b) => b.sql.startsWith("update"));
    expect(updates).toHaveLength(2);
    for (const u of updates) expect(u.params).toBeLessThanOrEqual(100);
  });
});

/**
 * 充填の前後でガード (c)(d1)(d2) の分母が切り替わっても、月次同期が throw しないこと。
 * 数字は本番 D1 の 2026-09-13 実測 (SELECT のみ) と、設計書 P4b 節の data_j
 * 2026-08-31 版の実測:
 *
 *   core_stocks: total 3,818 / active 3,715 (内国株式 3,706 + market='東証' 9)
 *                instrument_type 非 NULL 0 件
 *   data_j 2026-08-31: raw 4,441 / isListedEquity 3,700
 */
describe("assertUniverseCoverage: 充填の前後 (P4b 第 1 段の本番数値)", () => {
  const RAW = 4_441;
  const EQUITY = 3_700;

  it("充填する run は未充填として従来の分母で判定される (3,700 / 3,715 = 99.6%)", () => {
    expect(coverageDenominator(3_715, 0).label).toContain("未充填");
    expect(() =>
      assertUniverseCoverage(RAW, EQUITY, 3_715, 0, {
        existingEquityActiveCount: 0,
        pendingDeactivationEquityCount: 0,
      })
    ).not.toThrow();
  });

  it("充填後の run は equity の分母 (3,700) へ切り替わり、同じ入力で通る", () => {
    // 充填後の active = 内国普通株 3,700 (isListedEquity を全件 upsert) + 非 equity 9 = 3,709。
    const ACTIVE_AFTER = 3_709;
    const EQUITY_AFTER = 3_700;
    expect(coverageDenominator(ACTIVE_AFTER, EQUITY_AFTER)).toEqual({
      value: EQUITY_AFTER,
      label: "active かつ equity",
    });
    expect(() =>
      assertUniverseCoverage(RAW, EQUITY, ACTIVE_AFTER, 0, {
        existingEquityActiveCount: EQUITY_AFTER,
        pendingDeactivationEquityCount: 0,
      })
    ).not.toThrow();
  });

  it("分母の切替は (c) を緩める向きにしか動かない (equity ⊆ active)", () => {
    // (c) の比は equityCount / 分母。分母が active → equity (≤ active) へ小さくなるので、
    // 切替前に通った入力は切替後も必ず通る。境界: 3,635 / 3,709 = 98.0% は切替前に通る。
    expect(() => assertUniverseCoverage(RAW, 3_635, 3_709, 0)).not.toThrow();
    expect(() =>
      assertUniverseCoverage(RAW, 3_635, 3_709, 0, {
        existingEquityActiveCount: 3_700,
        pendingDeactivationEquityCount: 0,
      })
    ).not.toThrow();
  });

  it("(d2) が (d1) より先に落ちるのは 2% ちょうど付近の 1 点だけで、本番の数値では起きない", () => {
    // (d2) だけが落ちるには 0.02E < pe ≤ p ≤ 0.02A (pe ≤ p) を満たす整数が要る。
    // 窓の幅は 0.02 × (A − E) で、第 1 段の後は A − E = 9 → 幅 0.18。
    // 本番の E = 3,700, A = 3,709 では窓 (74, 74.18] に整数が無いので、(d2) を
    // 評価し始めても前月まで通っていた入力は落ちない。
    expect(() =>
      assertUniverseCoverage(RAW, EQUITY, 3_709, 74, {
        existingEquityActiveCount: 3_700,
        pendingDeactivationEquityCount: 74,
      })
    ).not.toThrow();
    // 75 件は (d1) が先に止める (75 / 3,709 = 2.02%)。メッセージで (d1) と分かる。
    expect(() =>
      assertUniverseCoverage(RAW, EQUITY, 3_709, 75, {
        existingEquityActiveCount: 3_700,
        pendingDeactivationEquityCount: 75,
      })
    ).toThrow(/^対象外化候補/);
    // 窓に整数が入る E もある (E = 3,749 → 窓 (74.98, 75.16])。そのとき
    // 内国普通株を一度に 75 件対象外化する入力だけが (d2) で止まる。これは
    // (d2) を足した目的そのもの (内国普通株 2% 超の一括対象外化) で、誤発火ではない。
    expect(() =>
      assertUniverseCoverage(RAW, EQUITY, 3_758, 75, {
        existingEquityActiveCount: 3_749,
        pendingDeactivationEquityCount: 75,
      })
    ).toThrow("内国普通株の対象外化候補");
  });

  it("充填が 3,000 件未満で止まった翌 run は従来の分母へ縮退する (PR #21 の fail-closed を保つ)", () => {
    expect(coverageDenominator(3_709, 1_600).label).toContain("部分充填");
    expect(instrumentTypeBackfilled(1_600)).toBe(false);
  });
});
