/**
 * 世界の主要株価指数・為替・金利・金・原油アダプタ (`./global-indices.ts`) のテスト。
 *
 * - 実ファイル (2026-09-27 に既存 Yahoo クライアント `fetchYahooChartRaw(symbol, "6mo", "1wk")`
 *   で取得した Chart API 応答 JSON 16 銘柄 + TOPIX 指数 (^TOPX) の実物の 404 応答本文) は
 *   `../sources/fixtures/private/global-indices/` にあり commit しない (Yahoo は個人利用のみ)。
 *   無い環境 (CI) では `describe.skipIf` で skip する。値の期待値は Python (json + zoneinfo) で
 *   同じファイルから独立に計算したもの (取引所の IANA タイムゾーンの暦週で集計し、
 *   `meta.regularMarketTime` と同時刻の取得時点スナップショットを除いた週足の終値を、直前の週と比較)。
 *   検証証跡 verified_values の ^GSPC +1.2144%・^N225 +2.069%・金 -2.3435%・^TNX +0.186pt とも一致。
 * - CI でも走る部分は、Chart API 週足応答の形を真似た **合成テストデータ** (実データではない。
 *   終値は 1000, 1010, 1020… のような作り物) で対応付けの規則を確かめる。
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isMoneyflowFlowType,
  isMoneyflowFrequency,
  isMoneyflowLicense,
  isMoneyflowRequirement,
} from "../../../../src/shared/notion-archive/index.js";
import { validateDrafts, type ObservationDraft, type SpecFile } from "../source-spec.js";
import {
  GLOBAL_INDEX_CATALOG,
  parseGlobalIndexWeeklyChart,
  resolveLatestWeeklyChange,
} from "../sources/global-indices.js";
import {
  GLOBAL_INDICES_ADAPTER_INDICATORS,
  GLOBAL_INDICES_CHART_RANGE,
  GLOBAL_INDICES_EXPECTED_CURRENCY,
  GLOBAL_INDICES_SPEC_NAME,
  GLOBAL_INDICES_WEEKS_PER_BATCH,
  globalIndicesBatchKey,
  globalIndicesBatchWeeks,
  globalIndicesFilename,
  globalIndicesSpec,
  weekPeriodFromLabel,
} from "./global-indices.js";

const ROW_BUDGET = 600;
const DAY_MS = 86_400_000;
const TARGET = "2026-W39";
const TARGET_KEY = `global-indices-${TARGET}`;
/** 2026-W39 が終わった後の最初の平日の定時実行 (月曜 17:30 JST)。 */
const MONDAY_RUN = new Date("2026-09-28T08:30:00.000Z");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function row(drafts: readonly ObservationDraft[], period: string, indicatorKey: string): ObservationDraft {
  const hits = drafts.filter((d) => d.period === period && d.indicatorKey === indicatorKey);
  if (hits.length !== 1) throw new Error(`テスト: ${period} ${indicatorKey} の行が ${hits.length} 件`);
  return hits[0] as ObservationDraft;
}

// ---------------------------------------------------------------------------
// 合成テストデータ (実データではない)
// ---------------------------------------------------------------------------

/** 合成テストデータ用の取引所タイムゾーン (実ファイルの meta.exchangeTimezoneName と同じ値)。 */
const SYN_TIMEZONE: Readonly<Record<string, string>> = {
  gspc: "America/New_York",
  ixic: "America/New_York",
  stoxx50e: "Europe/Zurich",
  ftse: "Europe/London",
  gdaxi: "Europe/Berlin",
  hsi: "Asia/Hong_Kong",
  sse: "Asia/Shanghai",
  ks11: "Asia/Seoul",
  bsesn: "Asia/Kolkata",
  n225: "Asia/Tokyo",
  "topix-etf": "Asia/Tokyo",
  jpy: "Europe/London",
  eurusd: "Europe/London",
  gold: "America/New_York",
  crudeoil: "America/New_York",
  tnx: "America/Chicago",
};

/** 合成テストデータの最初の週 (2026-W13) の月曜。 */
const SYN_FIRST_MONDAY_MS = Date.UTC(2026, 2, 23);
/** 2026-W13〜W39 の 27 週。インデックス 26 が W39、25 が W38。 */
const SYN_WEEKS = 27;
/** 合成テストデータの取得時点スナップショットの時刻 (W39 の金曜 21:00 UTC)。 */
const SYN_SNAPSHOT_SEC = Date.UTC(2026, 8, 25, 21, 0, 0) / 1000;

type SynBar = [timestampSec: number, close: number | null];

/** 合成テストデータ: 週 i の終値 (作り物)。米10年債は 4.00, 4.01, 4.02…、他は 1000, 1010, 1020…。 */
function synClose(key: string, i: number): number {
  return key === "tnx" ? 4 + i * 0.01 : 1000 + i * 10;
}

/** 合成テストデータ: 週足 (どのタイムゾーンでも月曜になる UTC 12 時に付ける)。 */
function synBars(key: string, weeks: readonly number[]): SynBar[] {
  return weeks.map((i) => [(SYN_FIRST_MONDAY_MS + i * 7 * DAY_MS + 12 * 3600 * 1000) / 1000, synClose(key, i)]);
}

function allWeeks(): number[] {
  return Array.from({ length: SYN_WEEKS }, (_, i) => i);
}

/**
 * 合成テストデータ: Yahoo Chart API 週足応答の最小形 (パーサが読む項目だけ)。
 * 実物 (2026-09-27 取得の全 16 銘柄) と同じく、末尾に必ず取得時点スナップショット
 * (時刻 = meta.regularMarketTime、週足とは別の時刻) を付ける。その終値は `snapshot` を
 * 渡せばその値、渡さなければ最後の (終値のある) 週足と同じ値 (株価指数の実物と同じ形)。
 * regularMarketTime を最後の週足の時刻にすると、モジュールがその週足をスナップショットとして
 * 除外してしまい、実物と違う形でテストすることになる。
 */
function synChartJson(opts: {
  key: string;
  symbol: string;
  currency: string;
  bars: readonly SynBar[];
  snapshot?: number;
}): string {
  const closes = opts.bars.map((b) => b[1]).filter((c): c is number => c !== null);
  const lastClose = closes[closes.length - 1];
  if (lastClose === undefined) throw new Error("テスト: 終値のある週足が 0 本");
  const snapshotClose = opts.snapshot !== undefined ? opts.snapshot : lastClose;
  const bars: SynBar[] = [...opts.bars, [SYN_SNAPSHOT_SEC, snapshotClose]];
  const timezone = SYN_TIMEZONE[opts.key];
  if (timezone === undefined) throw new Error(`テスト: タイムゾーン表に無いキー ${opts.key}`);
  return JSON.stringify({
    chart: {
      result: [
        {
          meta: {
            note: "合成テストデータ (実データではない)",
            symbol: opts.symbol,
            currency: opts.currency,
            instrumentType: "SYNTHETIC_TEST",
            regularMarketPrice: snapshotClose,
            regularMarketTime: SYN_SNAPSHOT_SEC,
            exchangeTimezoneName: timezone,
            dataGranularity: "1wk",
            range: "6mo",
          },
          timestamp: bars.map((b) => b[0]),
          indicators: { quote: [{ close: bars.map((b) => b[1]) }] },
        },
      ],
      error: null,
    },
  });
}

function synCurrency(key: string): string {
  const c = GLOBAL_INDICES_EXPECTED_CURRENCY[key];
  if (!c) throw new Error(`テスト: 通貨表に無いキー ${key}`);
  return c;
}

/** 合成テストデータ: 全 16 銘柄の応答 (銘柄ごとに週足を差し替え可能)。 */
function synResponses(override: Partial<Record<string, SynBar[]>> = {}): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of GLOBAL_INDEX_CATALOG) {
    const bars = override[e.key] !== undefined ? (override[e.key] as SynBar[]) : synBars(e.key, allWeeks());
    out.set(e.key, synChartJson({ key: e.key, symbol: e.yahooSymbol, currency: synCurrency(e.key), bars }));
  }
  return out;
}

function toFiles(responses: Map<string, string>, week = TARGET): SpecFile[] {
  const enc = new TextEncoder();
  return GLOBAL_INDEX_CATALOG.map((e) => {
    const raw = responses.get(e.key);
    if (raw === undefined) throw new Error(`テスト: 応答が無い ${e.key}`);
    return { filename: globalIndicesFilename(e.key, week), bytes: enc.encode(raw) };
  });
}

// ---------------------------------------------------------------------------
// 指標定義
// ---------------------------------------------------------------------------

describe("指標定義 (IndicatorDefInput)", () => {
  const JAPANESE = /[ぁ-んァ-ヶ一-龠]/;

  it("16 銘柄の騰落率 + 米10年債のポイント差 = 17 件、キーは一意", () => {
    expect(GLOBAL_INDICES_ADAPTER_INDICATORS).toHaveLength(GLOBAL_INDEX_CATALOG.length + 1);
    const keys = GLOBAL_INDICES_ADAPTER_INDICATORS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const e of GLOBAL_INDEX_CATALOG) expect(keys).toContain(`global_${e.key}_weekly_change_pct`);
    expect(keys).toContain("global_tnx_weekly_change_pt");
    expect(globalIndicesSpec.indicators).toBe(GLOBAL_INDICES_ADAPTER_INDICATORS);
    expect(globalIndicesSpec.name).toBe(GLOBAL_INDICES_SPEC_NAME);
  });

  it("列挙値の型ガードを通り、https の出典・日本語の説明と限界を持つ", () => {
    for (const d of GLOBAL_INDICES_ADAPTER_INDICATORS) {
      expect(isMoneyflowFlowType(d.flowType)).toBe(true);
      expect(isMoneyflowFrequency(d.frequency)).toBe(true);
      expect(isMoneyflowLicense(d.license)).toBe(true);
      expect(isMoneyflowRequirement(d.requirement)).toBe(true);
      expect(d.sourceUrl).toMatch(/^https:\/\/finance\.yahoo\.com\/quote\/[^/]+\/$/);
      expect(d.description).toMatch(JAPANESE);
      expect(d.limitations).toMatch(JAPANESE);
      expect(d.displayName.trim()).not.toBe("");
      // 全指標: R4・価格・週次・個人利用のみ (Yahoo)、資金の流れではないことを明記
      expect(d.requirement).toBe("R4");
      expect(d.flowType).toBe("価格");
      expect(d.frequency).toBe("週次");
      expect(d.license).toBe("personal-only");
      expect(d.description).toMatch(/フロー/);
      expect(d.limitations).toMatch(/資金の純流入・純流出の額は測れない/);
      expect(d.limitations).toMatch(/個人利用に限る/);
    }
  });

  it("換算後の単位を説明に書く (騰落率は比率、ポイント差は%ポイント)", () => {
    for (const d of GLOBAL_INDICES_ADAPTER_INDICATORS) {
      if (d.key === "global_tnx_weekly_change_pt") {
        expect(d.description).toMatch(/%ポイントのまま記録/);
      } else {
        expect(d.description).toMatch(/比率で記録する \(0\.012 = \+1\.2%/);
      }
    }
  });

  it("銘柄ごとの出典は Yahoo Finance の銘柄ページ (記号は URL エンコード)", () => {
    const url = (key: string) => GLOBAL_INDICES_ADAPTER_INDICATORS.find((d) => d.key === key)?.sourceUrl;
    expect(url("global_gspc_weekly_change_pct")).toBe("https://finance.yahoo.com/quote/%5EGSPC/");
    expect(url("global_jpy_weekly_change_pct")).toBe("https://finance.yahoo.com/quote/JPY%3DX/");
    expect(url("global_topix-etf_weekly_change_pct")).toBe("https://finance.yahoo.com/quote/1306.T/");
  });

  it("為替の向きを通貨ペアごとに正しく説明する (ユーロドルに円安/円高を書かない)", () => {
    const jpy = GLOBAL_INDICES_ADAPTER_INDICATORS.find((d) => d.key === "global_jpy_weekly_change_pct");
    const eurusd = GLOBAL_INDICES_ADAPTER_INDICATORS.find((d) => d.key === "global_eurusd_weekly_change_pct");
    expect(jpy?.description).toMatch(/円安/);
    expect(eurusd?.description).not.toMatch(/円安|円高/);
    expect(eurusd?.description).toMatch(/ユーロ高・ドル安/);
    expect(jpy?.limitations).toMatch(/週足の終値を使い、土日の気配値は使わない/);
  });

  it("TOPIX は ETF (1306) の市場価格による近似と明記し、基準価額と取り違えない", () => {
    const topix = GLOBAL_INDICES_ADAPTER_INDICATORS.find((d) => d.key === "global_topix-etf_weekly_change_pct");
    expect(topix?.description).toMatch(/1306/);
    expect(topix?.description).toMatch(/市場価格/);
    expect(topix?.limitations).toMatch(/近似/);
    expect(topix?.limitations).toMatch(/基準価額 \(ETF の1口あたり純資産\) とも TOPIX とも完全には一致しない/);
  });

  it("株価指数の説明で「値上がり=買いが売りより多い」という誤解を招かない", () => {
    const gspc = GLOBAL_INDICES_ADAPTER_INDICATORS.find((d) => d.key === "global_gspc_weekly_change_pct");
    expect(gspc?.description).not.toMatch(/買いたい人のほうが多かった/);
    expect(gspc?.description).toMatch(/必ず同じ額/);
  });

  it("先物は「期日が最も近い限月」と断定しない (金の実ファイルは 12 月限: Gold Dec 26)", () => {
    for (const key of ["global_gold_weekly_change_pct", "global_crudeoil_weekly_change_pct"]) {
      const d = GLOBAL_INDICES_ADAPTER_INDICATORS.find((x) => x.key === key);
      expect(d?.description).not.toMatch(/期日が最も近い限月。/);
      expect(d?.limitations).not.toMatch(/期日が最も近い限月の価格をつないだ/);
      expect(d?.description).toMatch(/取引の中心になっている限月/);
    }
  });

  it("配当込みの DAX・株価平均型の日経平均の違いを限界に書く", () => {
    const dax = GLOBAL_INDICES_ADAPTER_INDICATORS.find((d) => d.key === "global_gdaxi_weekly_change_pct");
    const n225 = GLOBAL_INDICES_ADAPTER_INDICATORS.find((d) => d.key === "global_n225_weekly_change_pct");
    expect(dax?.description).toMatch(/パフォーマンス指数/);
    expect(dax?.limitations).toMatch(/配当込み/);
    expect(n225?.limitations).toMatch(/株価を平均する方式/);
  });
});

// ---------------------------------------------------------------------------
// 週・キー
// ---------------------------------------------------------------------------

describe("対象週・キー・ファイル名", () => {
  it("resolve は通信せずに、終わった直近の ISO 週をキーにする", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const keyAt = async (iso: string) => (await globalIndicesSpec.resolve(new Date(iso))).key;
    expect((await globalIndicesSpec.resolve(MONDAY_RUN)).key).toBe(TARGET_KEY);
    // 日曜の日中 (UTC) は W39 がまだ終わっていないので W38
    expect(await keyAt("2026-09-27T10:00:00.000Z")).toBe("global-indices-2026-W38");
    // 境界: 日曜 23:59:59.999Z で W39 が終わった扱い (モジュールの isPeriodObservable と同じ)
    expect(await keyAt("2026-09-27T23:59:59.998Z")).toBe("global-indices-2026-W38");
    expect(await keyAt("2026-09-27T23:59:59.999Z")).toBe(TARGET_KEY);
    // 年またぎ: 2026 年は 53 週ある
    expect(await keyAt("2027-01-04T08:30:00.000Z")).toBe("global-indices-2026-W53");
    await expect(globalIndicesSpec.resolve(new Date("invalid"))).rejects.toThrow(/不正な now/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("週のラベル ⇔ 期間、記録する 13 週の並び", () => {
    expect(weekPeriodFromLabel("2026-W39")).toEqual({
      granularity: "week",
      start: "2026-09-21",
      end: "2026-09-27",
      label: "2026-W39",
    });
    expect(weekPeriodFromLabel("2026-W53").start).toBe("2026-12-28");
    expect(weekPeriodFromLabel("2020-W01").start).toBe("2019-12-30");
    expect(() => weekPeriodFromLabel("2025-W53")).toThrow(/存在しない ISO 週/);
    expect(() => weekPeriodFromLabel("2026-39")).toThrow(/YYYY-Www/);
    const weeks = globalIndicesBatchWeeks(weekPeriodFromLabel(TARGET)).map((w) => w.label);
    expect(weeks).toHaveLength(GLOBAL_INDICES_WEEKS_PER_BATCH);
    expect(weeks[0]).toBe("2026-W27");
    expect(weeks[weeks.length - 1]).toBe(TARGET);
    const yearEnd = globalIndicesBatchWeeks(weekPeriodFromLabel("2027-W02")).map((w) => w.label);
    expect(yearEnd.slice(-4)).toEqual(["2026-W52", "2026-W53", "2027-W01", "2027-W02"]);
  });

  it("キーは global-indices-YYYY-Www、ファイル名はキーだけから決まる", () => {
    expect(globalIndicesBatchKey(weekPeriodFromLabel(TARGET))).toBe(TARGET_KEY);
    expect(globalIndicesFilename("topix-etf", TARGET)).toBe("global-indices-topix-etf-2026-W39.json");
    expect(() =>
      globalIndicesBatchKey({ granularity: "week", start: "2026-09-22", end: "2026-09-28", label: TARGET })
    ).toThrow(/ISO 週ではない期間/);
  });
});

// ---------------------------------------------------------------------------
// 対応付け (合成テストデータ・CI で走る)
// ---------------------------------------------------------------------------

describe("toObservations (合成テストデータ)", () => {
  it("13 週 × 17 指標 = 221 行。順序・単位換算・区分種別・フラグ", () => {
    const drafts = globalIndicesSpec.toObservations({ key: TARGET_KEY, files: toFiles(synResponses()) });
    validateDrafts(GLOBAL_INDICES_SPEC_NAME, drafts, GLOBAL_INDICES_ADAPTER_INDICATORS);
    expect(drafts).toHaveLength(GLOBAL_INDICES_WEEKS_PER_BATCH * 17);
    expect(drafts.length).toBeLessThanOrEqual(ROW_BUDGET);

    // 週の古い順 → カタログの順。最後の行 (取込完了の印) は対象週の米10年債ポイント差
    expect(drafts[0]?.period).toBe("2026-W27");
    expect(drafts[0]?.indicatorKey).toBe("global_gspc_weekly_change_pct");
    const last = drafts[drafts.length - 1];
    expect(last?.period).toBe(TARGET);
    expect(last?.indicatorKey).toBe("global_tnx_weekly_change_pt");

    // 騰落率: 合成の終値 W38 (i=25) = 1250、W39 (i=26) = 1260 → 1260/1250-1 = 0.008 を比率で記録
    const gspc = row(drafts, TARGET, "global_gspc_weekly_change_pct");
    expect(gspc.value).toBeCloseTo(1260 / 1250 - 1, 15);
    expect(gspc.unit).toBe("比率");
    expect(gspc).toMatchObject({
      periodStart: "2026-09-21",
      periodEnd: "2026-09-27",
      category: "米国",
      categoryKind: "国地域",
      changeFromPrev: null,
      approximate: true,
      measureKind: "実測",
    });
    expect(row(drafts, "2026-W27", "global_gspc_weekly_change_pct").value).toBeCloseTo(1140 / 1130 - 1, 15);
    // 米10年債: 4.26 - 4.25 = 0.01 %ポイント (換算なし) と、相対変化率 0.01/4.25
    const tnxPt = row(drafts, TARGET, "global_tnx_weekly_change_pt");
    expect(tnxPt.unit).toBe("%ポイント");
    expect(tnxPt.value).toBeCloseTo(0.01, 12);
    expect(row(drafts, TARGET, "global_tnx_weekly_change_pct").value).toBeCloseTo(0.01 / 4.25, 12);
    // 区分種別: 為替 → 通貨、先物 → 商品 (モジュールの「資産クラス」から細かい軸へ)
    expect(row(drafts, TARGET, "global_jpy_weekly_change_pct")).toMatchObject({
      category: "為替(ドル円)",
      categoryKind: "通貨",
    });
    expect(row(drafts, TARGET, "global_gold_weekly_change_pct")).toMatchObject({ category: "金", categoryKind: "商品" });
    expect(row(drafts, TARGET, "global_sse_weekly_change_pct").category).toBe("中国本土");
    expect(drafts.every((d) => d.approximate && d.measureKind === "実測" && d.changeFromPrev === null)).toBe(true);
  });

  it("取得時点のスナップショットは使わず、週足の終値で比べる", () => {
    // 合成テストデータ: ドル円の W39 に週足 (1260) と、土曜の気配値に当たるスナップショット (9999)
    const responses = synResponses();
    responses.set(
      "jpy",
      synChartJson({ key: "jpy", symbol: "JPY=X", currency: "JPY", bars: synBars("jpy", allWeeks()), snapshot: 9999 })
    );
    const drafts = globalIndicesSpec.toObservations({ key: TARGET_KEY, files: toFiles(responses) });
    expect(row(drafts, TARGET, "global_jpy_weekly_change_pct").value).toBeCloseTo(1260 / 1250 - 1, 15);
  });

  it("対象週の週足の終値が欠落していても、スナップショットで代用せず行を作らない", () => {
    // 合成テストデータ: ドル円の W39 (i=26) の週足の終値が null、スナップショット (土曜の気配値役) は 9999
    const bars = synBars("jpy", allWeeks());
    bars[26] = [bars[26]?.[0] as number, null];
    const responses = synResponses();
    responses.set("jpy", synChartJson({ key: "jpy", symbol: "JPY=X", currency: "JPY", bars, snapshot: 9999 }));
    const drafts = globalIndicesSpec.toObservations({ key: TARGET_KEY, files: toFiles(responses) });
    validateDrafts(GLOBAL_INDICES_SPEC_NAME, drafts, GLOBAL_INDICES_ADAPTER_INDICATORS);
    expect(drafts.some((d) => d.period === TARGET && d.indicatorKey === "global_jpy_weekly_change_pct")).toBe(false);
    expect(drafts.some((d) => d.value === 9999 / 1250 - 1)).toBe(false);
    expect(drafts).toHaveLength(GLOBAL_INDICES_WEEKS_PER_BATCH * 17 - 1);
  });

  it("記録する週のどこかで 2 週続けて週足が無ければ throw (2 週以上の騰落を週次として記録しない)", () => {
    // 合成テストデータ: ハンセン指数の W30・W31 (i=17,18) が無い → W32 の比較元が W29 (3 週前) になる
    const weeks = allWeeks().filter((i) => i !== 17 && i !== 18);
    expect(() =>
      globalIndicesSpec.toObservations({
        key: TARGET_KEY,
        files: toFiles(synResponses({ hsi: synBars("hsi", weeks) })),
      })
    ).toThrow(/2026-W32 の比較元が 2026-W29 \(3 週前\)/);
    // 1 週だけの欠落 (W30) は正常: W31 は W29 と比べる
    const drafts = globalIndicesSpec.toObservations({
      key: TARGET_KEY,
      files: toFiles(synResponses({ hsi: synBars("hsi", allWeeks().filter((i) => i !== 17)) })),
    });
    expect(row(drafts, "2026-W31", "global_hsi_weekly_change_pct").value).toBeCloseTo(1180 / 1160 - 1, 15);
  });

  it("休場で 1 週間週足の無い週は行を作らず、次の週は休場前の週と比べる", () => {
    // 合成テストデータ: 上海総合の W38 (i=25) が丸ごと休場 (週足なし)
    const weeks = allWeeks().filter((i) => i !== 25);
    const drafts = globalIndicesSpec.toObservations({
      key: TARGET_KEY,
      files: toFiles(synResponses({ sse: synBars("sse", weeks) })),
    });
    validateDrafts(GLOBAL_INDICES_SPEC_NAME, drafts, GLOBAL_INDICES_ADAPTER_INDICATORS);
    expect(drafts).toHaveLength(GLOBAL_INDICES_WEEKS_PER_BATCH * 17 - 1);
    expect(drafts.some((d) => d.period === "2026-W38" && d.indicatorKey === "global_sse_weekly_change_pct")).toBe(false);
    expect(row(drafts, TARGET, "global_sse_weekly_change_pct").value).toBeCloseTo(1260 / 1240 - 1, 15);
    // 終値が null の週 (パーサが除く) も同じ扱い
    const withNull = synBars("sse", allWeeks());
    withNull[25] = [withNull[25]?.[0] as number, null];
    const drafts2 = globalIndicesSpec.toObservations({
      key: TARGET_KEY,
      files: toFiles(synResponses({ sse: withNull })),
    });
    expect(drafts2).toHaveLength(GLOBAL_INDICES_WEEKS_PER_BATCH * 17 - 1);
  });

  it("対象週とその前の週の両方に週足が無い銘柄は throw (廃止・シンボル変更の疑い)", () => {
    const weeks = allWeeks().filter((i) => i < 25);
    expect(() =>
      globalIndicesSpec.toObservations({
        key: TARGET_KEY,
        files: toFiles(synResponses({ sse: synBars("sse", weeks) })),
      })
    ).toThrow(/対象週 2026-W39 とその前の週のどちらにも週足がありません/);
  });

  it("記録する最初の週より前の週足がファイルに無ければ throw (取得範囲が短すぎる)", () => {
    const weeks = allWeeks().filter((i) => i >= 14); // W27 から (W26 が無い)
    expect(() =>
      globalIndicesSpec.toObservations({
        key: TARGET_KEY,
        files: toFiles(synResponses({ hsi: synBars("hsi", weeks) })),
      })
    ).toThrow(/2026-W27 より前の週足が取得範囲に無く/);
  });
});

describe("toObservations は想定外の入力で throw する (合成テストデータ)", () => {
  it("ファイルが足りない", () => {
    const files = toFiles(synResponses()).filter((f) => !f.filename.includes("-tnx-"));
    expect(() => globalIndicesSpec.toObservations({ key: TARGET_KEY, files })).toThrow(/該当ファイルが 0 件/);
  });

  it("想定外のファイルが混ざっている (別の週・別名)", () => {
    const files = toFiles(synResponses());
    const extra: SpecFile = { filename: "global-indices-gspc-2026-W38.json", bytes: files[0]?.bytes as Uint8Array };
    expect(() => globalIndicesSpec.toObservations({ key: TARGET_KEY, files: [...files, extra] })).toThrow(
      /想定外のファイル/
    );
    // 同じ中身でもキーの週とファイル名の週が違えば取り違えとして扱う
    expect(() =>
      globalIndicesSpec.toObservations({ key: "global-indices-2026-W38", files: toFiles(synResponses()) })
    ).toThrow(/想定外のファイル/);
  });

  it("銘柄の中身の取り違え (^IXIC のファイルに ^GSPC の応答)", () => {
    const responses = synResponses();
    responses.set("ixic", responses.get("gspc") as string);
    expect(() => globalIndicesSpec.toObservations({ key: TARGET_KEY, files: toFiles(responses) })).toThrow(
      /meta\.symbol が期待値と不一致/
    );
  });

  it("応答の通貨が想定と違う", () => {
    const responses = synResponses();
    responses.set(
      "ftse",
      synChartJson({ key: "ftse", symbol: "^FTSE", currency: "GBp", bars: synBars("ftse", allWeeks()) })
    );
    expect(() => globalIndicesSpec.toObservations({ key: TARGET_KEY, files: toFiles(responses) })).toThrow(
      /応答の通貨 GBp が想定 \(GBP\) と違います/
    );
  });

  it("Chart API のエラー応答・UTF-8 でない・キーの形式違い", () => {
    const responses = synResponses();
    responses.set(
      "n225",
      JSON.stringify({ chart: { result: null, error: { code: "Not Found", description: "合成テストデータ" } } })
    );
    expect(() => globalIndicesSpec.toObservations({ key: TARGET_KEY, files: toFiles(responses) })).toThrow(
      /Chart API エラー: .*Not Found/
    );

    const files = toFiles(synResponses());
    const broken = files.map((f) =>
      f.filename.includes("-gold-") ? { filename: f.filename, bytes: new Uint8Array([0xff, 0xfe, 0x7b]) } : f
    );
    expect(() => globalIndicesSpec.toObservations({ key: TARGET_KEY, files: broken })).toThrow(/UTF-8 として読めません/);

    expect(() => globalIndicesSpec.toObservations({ key: "global-indices-2026-09-27", files })).toThrow(
      /キーの形式が違います/
    );
    expect(() => globalIndicesSpec.toObservations({ key: "global-indices-2025-W53", files })).toThrow(/存在しない ISO 週/);
  });
});

// ---------------------------------------------------------------------------
// resolve / fetch (fetch スタブ)
// ---------------------------------------------------------------------------

interface ChartRequest {
  symbol: string;
  range: string | null;
  interval: string | null;
}

/**
 * 取込プロキシ経由の Chart API 呼び出し (`YAHOO_PROXY_BASE` + `CRON_SECRET`) をスタブで受ける。
 * `bodyFor` が返した本文と状態で応答する。
 */
function stubYahoo(bodyFor: (req: ChartRequest) => { body: string; status: number }): ChartRequest[] {
  vi.stubEnv("YAHOO_PROXY_BASE", "https://proxy.invalid");
  vi.stubEnv("CRON_SECRET", "test-secret");
  const calls: ChartRequest[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const proxied = new URL(String(input));
      if (proxied.origin !== "https://proxy.invalid" || proxied.pathname !== "/api/ingest/yahoo") {
        throw new Error(`テスト: 想定外の URL ${proxied.href}`);
      }
      const upstream = new URL(proxied.searchParams.get("u") as string);
      const m = /^\/v8\/finance\/chart\/([^/]+)$/.exec(upstream.pathname);
      if (!m) throw new Error(`テスト: 想定外の Yahoo URL ${upstream.href}`);
      const req: ChartRequest = {
        symbol: decodeURIComponent(m[1] as string),
        range: upstream.searchParams.get("range"),
        interval: upstream.searchParams.get("interval"),
      };
      calls.push(req);
      const { body, status } = bodyFor(req);
      return new Response(body, { status, headers: { "content-type": "application/json" } });
    })
  );
  return calls;
}

function keyForSymbol(symbol: string): string {
  const e = GLOBAL_INDEX_CATALOG.find((c) => c.yahooSymbol === symbol);
  if (!e) throw new Error(`テスト: カタログに無いシンボル ${symbol}`);
  return e.key;
}

describe("resolve() / fetch() (合成テストデータを返す fetch スタブ)", () => {
  it("fetch は 16 銘柄を 6mo・週足で順に取り、キーだけから決まる名前で返す", async () => {
    const responses = synResponses();
    const calls = stubYahoo((req) => ({ body: responses.get(keyForSymbol(req.symbol)) as string, status: 200 }));
    const resolved = await globalIndicesSpec.resolve(MONDAY_RUN);
    expect(resolved.key).toBe(TARGET_KEY);
    expect(calls).toHaveLength(0);

    const batch = await resolved.fetch();
    expect(batch.key).toBe(TARGET_KEY);
    expect(calls.map((c) => c.symbol)).toEqual(GLOBAL_INDEX_CATALOG.map((e) => e.yahooSymbol));
    expect(calls.every((c) => c.range === GLOBAL_INDICES_CHART_RANGE && c.interval === "1wk")).toBe(true);
    expect(batch.files.map((f) => f.filename)).toEqual(
      GLOBAL_INDEX_CATALOG.map((e) => `global-indices-${e.key}-2026-W39.json`)
    );
    expect(batch.files.every((f) => f.contentType === "application/json")).toBe(true);
    expect(batch.metadata).toMatchObject({ targetWeek: TARGET, range: "6mo", interval: "1wk", weeksPerBatch: 13 });
    const drafts = globalIndicesSpec.toObservations({ key: batch.key, files: batch.files });
    validateDrafts(GLOBAL_INDICES_SPEC_NAME, drafts, GLOBAL_INDICES_ADAPTER_INDICATORS);
    expect(drafts).toHaveLength(221);
  });

  it("エラー応答 (429) を返す銘柄があれば、保管前に中止する", async () => {
    const responses = synResponses();
    stubYahoo((req) =>
      req.symbol === "^HSI"
        ? { body: "Too Many Requests", status: 429 }
        : { body: responses.get(keyForSymbol(req.symbol)) as string, status: 200 }
    );
    const resolved = await globalIndicesSpec.resolve(MONDAY_RUN);
    await expect(resolved.fetch()).rejects.toThrow(/hsi=\^HSI\]: HTTP 429/);
  });
});

// ---------------------------------------------------------------------------
// 実ファイル (2026-09-27 取得。private・commit しない)
// ---------------------------------------------------------------------------

const FIXTURE_DIR = fileURLToPath(new URL("../sources/fixtures/private/global-indices/", import.meta.url));
const FIXTURE_DATE = "2026-09-27";
const fixturePath = (key: string) => `${FIXTURE_DIR}global-indices-${key}-${FIXTURE_DATE}.json`;
const NOT_FOUND_PATH = `${FIXTURE_DIR}global-indices-symbol-not-found-${FIXTURE_DATE}.json`;
const hasFixtures = [...GLOBAL_INDEX_CATALOG.map((e) => fixturePath(e.key)), NOT_FOUND_PATH].every((p) => existsSync(p));

function realFiles(): SpecFile[] {
  return GLOBAL_INDEX_CATALOG.map((e) => ({
    filename: globalIndicesFilename(e.key, TARGET),
    bytes: new Uint8Array(readFileSync(fixturePath(e.key))),
  }));
}

describe.skipIf(!hasFixtures)("toObservations (実ファイル: Yahoo Chart API 週足 2026-09-27 取得)", () => {
  it("validateDrafts を通り、13 週 × 17 指標 = 221 行 (予算内)", () => {
    const drafts = globalIndicesSpec.toObservations({ key: TARGET_KEY, files: realFiles() });
    validateDrafts(GLOBAL_INDICES_SPEC_NAME, drafts, GLOBAL_INDICES_ADAPTER_INDICATORS);
    expect(drafts).toHaveLength(221);
    expect(drafts.length).toBeLessThanOrEqual(ROW_BUDGET);
    expect(new Set(drafts.map((d) => d.period)).size).toBe(13);
    const last = drafts[drafts.length - 1];
    expect(last?.period).toBe(TARGET);
    expect(last?.indicatorKey).toBe("global_tnx_weekly_change_pt");
  });

  it("値と単位換算が Python で独立に計算した値と一致する", () => {
    const drafts = globalIndicesSpec.toObservations({ key: TARGET_KEY, files: realFiles() });
    // ^GSPC: 7650.5 → 7743.41015625 (+1.2144%) → 比率 0.012144…
    const gspc = row(drafts, TARGET, "global_gspc_weekly_change_pct");
    expect(gspc.unit).toBe("比率");
    expect(gspc.value).toBeCloseTo(0.012144324717338737, 15);
    // ^N225: 65018.94921875 → 66364.203125 (+2.069%)。JST の週の帰属の回帰も兼ねる
    expect(row(drafts, TARGET, "global_n225_weekly_change_pct").value).toBeCloseTo(0.02069018220709816, 15);
    // 金先物: 4424.89990234375 → 4321.2001953125 (-2.3435%)
    expect(row(drafts, TARGET, "global_gold_weekly_change_pct").value).toBeCloseTo(-0.023435492173805573, 15);
    // WTI: 100.30000305175781 → 92.41000366210938 (-7.866%)
    expect(row(drafts, TARGET, "global_crudeoil_weekly_change_pct").value).toBeCloseTo(-0.07866399949735756, 15);
    // ドル円: 週足の終値 156.875 → 158.81100463867188 (+1.234%)。土曜の気配値 157.185 は使わない
    expect(row(drafts, TARGET, "global_jpy_weekly_change_pct").value).toBeCloseTo(0.012341065425796813, 15);
    // ユーロドル: 1.1487650871276855 → 1.1374752521514893 (-0.983%)
    expect(row(drafts, TARGET, "global_eurusd_weekly_change_pct").value).toBeCloseTo(-0.009827801264769306, 15);
    // ^TNX: 4.998 → 5.184 = +0.186%ポイント (換算なし) / 相対 +3.72%
    const tnxPt = row(drafts, TARGET, "global_tnx_weekly_change_pt");
    expect(tnxPt.unit).toBe("%ポイント");
    expect(tnxPt.value).toBeCloseTo(0.18599987030029297, 15);
    expect(row(drafts, TARGET, "global_tnx_weekly_change_pct").value).toBeCloseTo(0.03721485892470648, 15);
    // TOPIX 連動 ETF (1306): 426.29998779296875 → 430.29998779296875 (+0.938%)
    expect(row(drafts, TARGET, "global_topix-etf_weekly_change_pct").value).toBeCloseTo(0.009383063838938197, 15);
    // 13 週の最初の週 (W27): ^GSPC 7354.02001953125 → 7483.240234375 (+1.757%)
    const gspcW27 = row(drafts, "2026-W27", "global_gspc_weekly_change_pct");
    expect(gspcW27.value).toBeCloseTo(0.01757137110050818, 15);
    expect(gspcW27).toMatchObject({ periodStart: "2026-06-29", periodEnd: "2026-07-05" });
  });

  it("モジュールの resolveLatestWeeklyChange (月曜の now) と対象週の値が一致する", () => {
    const drafts = globalIndicesSpec.toObservations({ key: TARGET_KEY, files: realFiles() });
    for (const e of GLOBAL_INDEX_CATALOG) {
      const snapshot = parseGlobalIndexWeeklyChart(readFileSync(fixturePath(e.key), "utf-8"), e.key, e.yahooSymbol);
      const result = resolveLatestWeeklyChange(snapshot, MONDAY_RUN);
      if (result.status !== "observed") throw new Error(`テスト: ${e.key} が observed でない`);
      expect(result.observation.period.label).toBe(TARGET);
      expect(row(drafts, TARGET, `global_${e.key}_weekly_change_pct`).value).toBeCloseTo(
        result.observation.changePercent / 100,
        15
      );
    }
  });
});

describe.skipIf(!hasFixtures)("resolve() / fetch() (実ファイルを返す fetch スタブ)", () => {
  it("月曜の定時実行: キー global-indices-2026-W39、実ファイルのバイト列をそのまま保管用に返す", async () => {
    const calls = stubYahoo((req) => ({
      body: readFileSync(fixturePath(keyForSymbol(req.symbol)), "utf-8"),
      status: 200,
    }));
    const resolved = await globalIndicesSpec.resolve(MONDAY_RUN);
    expect(resolved.key).toBe(TARGET_KEY);
    const batch = await resolved.fetch();
    expect(batch.key).toBe(TARGET_KEY);
    expect(calls).toHaveLength(16);
    for (const [i, e] of GLOBAL_INDEX_CATALOG.entries()) {
      const f = batch.files[i];
      expect(f?.filename).toBe(`global-indices-${e.key}-2026-W39.json`);
      expect(Buffer.from(f?.bytes as Uint8Array).equals(readFileSync(fixturePath(e.key)))).toBe(true);
    }
    const drafts = globalIndicesSpec.toObservations({ key: batch.key, files: batch.files });
    validateDrafts(GLOBAL_INDICES_SPEC_NAME, drafts, GLOBAL_INDICES_ADAPTER_INDICATORS);
    expect(drafts).toEqual(globalIndicesSpec.toObservations({ key: TARGET_KEY, files: realFiles() }));
  });

  it("実物の 404 応答 (^TOPX: symbol may be delisted) が返る銘柄があれば保管前に中止する", async () => {
    // 状態 404 のまま返る場合 (HTTP ステータスで止まる) と、状態 200 で本文だけエラーの場合 (様式検査で止まる)
    stubYahoo((req) =>
      req.symbol === "1306.T"
        ? { body: readFileSync(NOT_FOUND_PATH, "utf-8"), status: 404 }
        : { body: readFileSync(fixturePath(keyForSymbol(req.symbol)), "utf-8"), status: 200 }
    );
    await expect((await globalIndicesSpec.resolve(MONDAY_RUN)).fetch()).rejects.toThrow(
      /topix-etf=1306\.T\]: HTTP 404.*symbol may be delisted/
    );
    stubYahoo((req) => ({
      body: readFileSync(req.symbol === "^TNX" ? NOT_FOUND_PATH : fixturePath(keyForSymbol(req.symbol)), "utf-8"),
      status: 200,
    }));
    await expect((await globalIndicesSpec.resolve(MONDAY_RUN)).fetch()).rejects.toThrow(
      /Chart API エラー: .*symbol may be delisted/
    );
  });
});
