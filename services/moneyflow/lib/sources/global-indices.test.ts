/**
 * 世界の主要株価指数・為替・金利・金・原油
 * (services/moneyflow/lib/sources/global-indices.ts) のテスト。
 *
 * fixtures/ は 2026-09-27 に実際に既存の Yahoo クライアント
 * (`src/shared/yahoo/client.ts` の `fetchYahooChartRaw`, `YAHOO_PROXY_BASE`
 * 経由) へリクエストして得た生レスポンス (無編集)。原本で確認した数値は
 * 下記の各 `expect` コメントに、実測時点の生レスポンスから直接引用した値を
 * 書く (このテストファイル自身が「原本で目視確認した値」の記録)。
 *
 * `global-indices-symbol-not-found-2026-09-27.json` は `^TOPX` (TOPIX 指数
 * そのもの) を実際にリクエストして得た実物の 404 レスポンス
 * (`{"chart":{"result":null,"error":{"code":"Not Found",...}}}`)。TOPIX が
 * Yahoo Chart API に存在しないことの実機証拠であり、様式異常時に throw する
 * ことのテストにそのまま使う。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  GLOBAL_INDEX_CATALOG,
  GLOBAL_INDEX_INDICATORS,
  type GlobalIndexChartSnapshot,
  globalIndicesArchiveInput,
  isPeriodObservable,
  parseGlobalIndexWeeklyChart,
  resolveLatestWeeklyChange,
  resolveObservationPeriod,
  toGlobalIndexObservationRows,
} from "./global-indices.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const DATE = "2026-09-27";
const readFixture = (key: string) =>
  readFileSync(join(FIXTURES_DIR, `global-indices-${key}-${DATE}.json`), "utf-8");

const GSPC_RAW = readFixture("gspc");
const N225_RAW = readFixture("n225");
const JPY_RAW = readFixture("jpy");
const GOLD_RAW = readFixture("gold");
const TNX_RAW = readFixture("tnx");
const TOPIX_ETF_RAW = readFixture("topix-etf");
const SSE_RAW = readFixture("sse");
const SYMBOL_NOT_FOUND_RAW = readFileSync(
  join(FIXTURES_DIR, `global-indices-symbol-not-found-${DATE}.json`),
  "utf-8"
);

describe("parseGlobalIndexWeeklyChart (実フィクスチャ: gspc)", () => {
  it("原本の ^GSPC レスポンスからメタ情報と週次バーを正しく取り出す", () => {
    const snapshot = parseGlobalIndexWeeklyChart(GSPC_RAW, "gspc", "^GSPC");

    // 原本確認値 1: meta.currency
    expect(snapshot.currency).toBe("USD");
    // 原本確認値 2: meta.instrumentType
    expect(snapshot.instrumentType).toBe("INDEX");
    // 原本確認値 3: meta.longName
    expect(snapshot.longName).toBe("S&P 500");
    // 原本確認値 4: meta.regularMarketPrice (2026-09-27 取得時点)
    expect(snapshot.regularMarketPrice).toBe(7743.41);
    // 原本確認値 5: meta.gmtoffset (EDT = UTC-4)
    expect(snapshot.gmtoffsetSec).toBe(-14400);
    expect(snapshot.bars).toHaveLength(28);
    // 原本確認値 6: 直近2本の close (timestamp 1789358400 / 1789963200)
    expect(snapshot.bars[25]).toEqual({ timestampSec: 1789358400, close: 7650.5 });
    expect(snapshot.bars[26]).toEqual({ timestampSec: 1789963200, close: 7743.41015625 });
  });

  it("chart.error があれば throw する (実物の404: TOPIX(^TOPX)は存在しない)", () => {
    expect(() => parseGlobalIndexWeeklyChart(SYMBOL_NOT_FOUND_RAW, "topx", "^TOPX")).toThrow(
      /Chart API エラー.*Not Found.*delisted/
    );
  });

  it("meta.symbol が期待値と不一致なら throw する (様式変更/取り違えの検知)", () => {
    expect(() => parseGlobalIndexWeeklyChart(GSPC_RAW, "gspc", "^IXIC")).toThrow(
      /meta\.symbol が期待値と不一致/
    );
  });

  it("meta.dataGranularity が1wk以外なら throw する", () => {
    const broken = JSON.parse(GSPC_RAW) as {
      chart: { result: [{ meta: Record<string, unknown> }] };
    };
    broken.chart.result[0].meta.dataGranularity = "1d";
    expect(() => parseGlobalIndexWeeklyChart(JSON.stringify(broken), "gspc", "^GSPC")).toThrow(
      /dataGranularity/
    );
  });

  it("timestamp と close の配列長が不一致なら throw する (様式変更の検知)", () => {
    const broken = JSON.parse(GSPC_RAW) as {
      chart: { result: [{ indicators: { quote: [{ close: unknown[] }] } }] };
    };
    broken.chart.result[0].indicators.quote[0].close.pop();
    expect(() => parseGlobalIndexWeeklyChart(JSON.stringify(broken), "gspc", "^GSPC")).toThrow(
      /長さが一致しません/
    );
  });

  it("JSON として壊れていれば throw する", () => {
    expect(() => parseGlobalIndexWeeklyChart("{not json", "gspc", "^GSPC")).toThrow(
      /JSON として解釈できません/
    );
  });

  it("regularMarketPrice が数値でなければ throw する (フォールバック禁止)", () => {
    const broken = JSON.parse(GSPC_RAW) as {
      chart: { result: [{ meta: Record<string, unknown> }] };
    };
    broken.chart.result[0].meta.regularMarketPrice = "N/A";
    expect(() => parseGlobalIndexWeeklyChart(JSON.stringify(broken), "gspc", "^GSPC")).toThrow(
      /regularMarketPrice/
    );
  });
});

describe("parseGlobalIndexWeeklyChart (実フィクスチャ: 他カテゴリ横断)", () => {
  it("為替 (JPY=X) を正しく取り出す", () => {
    const snapshot = parseGlobalIndexWeeklyChart(JPY_RAW, "jpy", "JPY=X");
    // 原本確認値 7
    expect(snapshot.instrumentType).toBe("CURRENCY");
    expect(snapshot.longName).toBe("USD/JPY");
    expect(snapshot.regularMarketPrice).toBe(157.185);
  });

  it("商品先物 (GC=F, 金) を正しく取り出す (longName が無い実物データ)", () => {
    const snapshot = parseGlobalIndexWeeklyChart(GOLD_RAW, "gold", "GC=F");
    // 原本確認値 8: 金先物は longName が無い (null) 実データ
    expect(snapshot.longName).toBeNull();
    expect(snapshot.instrumentType).toBe("FUTURE");
    expect(snapshot.regularMarketPrice).toBe(4321.2);
  });

  it("金利指数 (^TNX, 米10年国債利回り) を正しく取り出す", () => {
    const snapshot = parseGlobalIndexWeeklyChart(TNX_RAW, "tnx", "^TNX");
    // 原本確認値 9: ^TNX の close は「利回り(%)そのもの」(×10表記ではない)
    expect(snapshot.longName).toBe("CBOE Interest Rate 10 Year T Note");
    expect(snapshot.regularMarketPrice).toBe(5.184);
  });

  it("TOPIX連動ETF (1306.T, 近似) を正しく取り出す", () => {
    const snapshot = parseGlobalIndexWeeklyChart(TOPIX_ETF_RAW, "topix-etf", "1306.T");
    // 原本確認値 10
    expect(snapshot.instrumentType).toBe("ETF");
    expect(snapshot.longName).toBe("NEXT FUNDS TOPIX Exchange Traded Fund");
    expect(snapshot.regularMarketPrice).toBe(430.3);
  });

  it("上海総合指数 (000001.SS) を正しく取り出す", () => {
    const snapshot = parseGlobalIndexWeeklyChart(SSE_RAW, "sse", "000001.SS");
    // 原本確認値 11
    expect(snapshot.longName).toBe("SSE Composite Index");
    expect(snapshot.currency).toBe("CNY");
  });
});

describe("resolveLatestWeeklyChange (実フィクスチャ + 実際に見つかったタイムゾーン不具合の回帰テスト)", () => {
  const FAR_FUTURE = new Date("2027-06-01T00:00:00Z");

  it("^GSPC (UTC-4): 直近確定週の騰落を正しく計算する", () => {
    const snapshot = parseGlobalIndexWeeklyChart(GSPC_RAW, "gspc", "^GSPC");
    const result = resolveLatestWeeklyChange(snapshot, FAR_FUTURE);
    expect(result.status).toBe("observed");
    if (result.status !== "observed") throw new Error("unreachable");
    expect(result.observation.period.label).toBe("2026-W39");
    expect(result.observation.close).toBe(7743.41015625);
    expect(result.observation.previousClose).toBe(7650.5);
    expect(result.observation.changeAbsolute).toBeCloseTo(92.91015625, 6);
    expect(result.observation.changePercent).toBeCloseTo(1.2144324717338737, 6);
  });

  it("^N225 (UTC+9, JST): 現地時間で正しい週に帰属させる (実際に見つかった不具合の回帰)", () => {
    // 実機検証で発覚した不具合: バーの UTC タイムスタンプをそのまま
    // getUTCFullYear/Month/Date で ISO 週に割り当てると、JST 月曜0時 (=UTC
    // 前日15時) が「前の週の日曜日」に誤分類され、直近の未確定週の2本
    // (月曜バー: close=66364.203 と 確定値スナップショット: close=66364.203、
    // 実は同じ値) が別々の週として扱われてしまい、前週比が
    // 「66364.203 - 66364.203 = 0」という誤った結果になっていた。
    // gmtoffsetSec (+32400) で現地時刻に補正した結果、正しい前週
    // (close=65018.94921875) と比較されるようになったことを確認する。
    const snapshot = parseGlobalIndexWeeklyChart(N225_RAW, "n225", "^N225");
    expect(snapshot.gmtoffsetSec).toBe(32400);
    const result = resolveLatestWeeklyChange(snapshot, FAR_FUTURE);
    expect(result.status).toBe("observed");
    if (result.status !== "observed") throw new Error("unreachable");
    expect(result.observation.close).toBe(66364.203125);
    // 修正前は誤って 66364.203125 (=close と同値、変化ゼロ) になっていた。
    expect(result.observation.previousClose).toBe(65018.94921875);
    expect(result.observation.previousClose).not.toBe(result.observation.close);
    expect(result.observation.changeAbsolute).toBeCloseTo(1345.25390625, 6);
    expect(result.observation.changePercent).toBeCloseTo(2.069018220709816, 6);
  });

  it("GC=F (金先物): 前週比のマイナス方向の変化も正しく計算する", () => {
    const snapshot = parseGlobalIndexWeeklyChart(GOLD_RAW, "gold", "GC=F");
    const result = resolveLatestWeeklyChange(snapshot, FAR_FUTURE);
    expect(result.status).toBe("observed");
    if (result.status !== "observed") throw new Error("unreachable");
    expect(result.observation.changeAbsolute).toBeCloseTo(-103.69970703125, 6);
    expect(result.observation.changePercent).toBeCloseTo(-2.3435492173805574, 6);
  });

  it("直近の暦週が終わっていない now を渡すと not_yet_published を返す (throw しない)", () => {
    const snapshot = parseGlobalIndexWeeklyChart(GSPC_RAW, "gspc", "^GSPC");
    const beforeWeekEnd = new Date("2026-09-27T10:00:00.000Z"); // 週末(日曜)23:59:59より前
    const result = resolveLatestWeeklyChange(snapshot, beforeWeekEnd);
    expect(result.status).toBe("not_yet_published");
    if (result.status !== "not_yet_published") throw new Error("unreachable");
    expect(result.period.label).toBe("2026-W39");
    expect(result.reason).toMatch(/まだ終わっていません/);
  });

  it("週末を過ぎた now では observed になる (境界値)", () => {
    const snapshot = parseGlobalIndexWeeklyChart(GSPC_RAW, "gspc", "^GSPC");
    const afterWeekEnd = new Date("2026-09-28T00:00:00.001Z");
    const result = resolveLatestWeeklyChange(snapshot, afterWeekEnd);
    expect(result.status).toBe("observed");
  });

  it("確定済みの週が1週分しかない場合は throw する (黙って前週比を諦めない)", () => {
    const singleBarSnapshot: GlobalIndexChartSnapshot = {
      key: "gspc",
      yahooSymbol: "^GSPC",
      currency: "USD",
      instrumentType: "INDEX",
      longName: "S&P 500",
      regularMarketPrice: 100,
      gmtoffsetSec: -14400,
      bars: [{ timestampSec: Math.floor(new Date("2020-01-06T05:00:00Z").getTime() / 1000), close: 100 }],
    };
    expect(() => resolveLatestWeeklyChange(singleBarSnapshot, FAR_FUTURE)).toThrow(
      /確定済みの週が1週分しかなく/
    );
  });
});

describe("resolveObservationPeriod / isPeriodObservable", () => {
  it("週の開始(月曜)・終了(日曜)・ラベルを正しく解決する", () => {
    const period = resolveObservationPeriod("week", new Date("2026-09-23T12:00:00Z"));
    expect(period).toEqual({
      granularity: "week",
      start: "2026-09-21",
      end: "2026-09-27",
      label: "2026-W39",
    });
  });

  it("期間終了前は observable=false, 終了後は true", () => {
    const period = resolveObservationPeriod("week", new Date("2026-09-23T12:00:00Z"));
    expect(isPeriodObservable(period, new Date("2026-09-27T23:59:59.998Z")).observable).toBe(false);
    expect(isPeriodObservable(period, new Date("2026-09-27T23:59:59.999Z")).observable).toBe(true);
  });
});

describe("GLOBAL_INDEX_INDICATORS", () => {
  it("カタログの全銘柄 + ^TNX 専用のポイント差指標を含む", () => {
    expect(GLOBAL_INDEX_INDICATORS).toHaveLength(GLOBAL_INDEX_CATALOG.length + 1);
    const keys = GLOBAL_INDEX_INDICATORS.map((i) => i.key);
    expect(keys).toContain("global_gspc_weekly_change_pct");
    expect(keys).toContain("global_tnx_weekly_change_pct");
    expect(keys).toContain("global_tnx_weekly_change_pt");
  });

  it("全指標が R4 を要件に持ち、flowType が price_only である (資金フローそのものではない)", () => {
    for (const indicator of GLOBAL_INDEX_INDICATORS) {
      expect(indicator.requirements).toContain("R4");
      expect(indicator.flowType).toBe("price_only");
      expect(indicator.description.length).toBeGreaterThan(10);
      expect(indicator.sourceUrl).toMatch(/^https:\/\//);
    }
  });

  it("TOPIX(ETF代替)の指標定義には近似である旨の注記が limitations に含まれる", () => {
    const topixIndicator = GLOBAL_INDEX_INDICATORS.find(
      (i) => i.key === "global_topix-etf_weekly_change_pct"
    );
    expect(topixIndicator?.limitations).toMatch(/ETF|連動/);
  });

  it("EUR/USD の説明文は円を含まず、ユーロ/ドルの向きで正確に説明する (jpy用テンプレの誤用を回帰検知)", () => {
    const eurusdIndicator = GLOBAL_INDEX_INDICATORS.find(
      (i) => i.key === "global_eurusd_weekly_change_pct"
    );
    expect(eurusdIndicator).toBeDefined();
    // 円は一切登場しない通貨ペアなので「円安/円高」を含んではいけない
    expect(eurusdIndicator?.description).not.toMatch(/円安|円高/);
    expect(eurusdIndicator?.description).toMatch(/ユーロ/);
    expect(eurusdIndicator?.description).toMatch(/ドル/);
  });

  it("USD/JPY の説明文は円安/円高の説明を保持する (JPY=X のみに適用されるべき表現)", () => {
    const jpyIndicator = GLOBAL_INDEX_INDICATORS.find(
      (i) => i.key === "global_jpy_weekly_change_pct"
    );
    expect(jpyIndicator?.description).toMatch(/円安/);
  });
});

describe("toGlobalIndexObservationRows", () => {
  it("観測済みの銘柄だけを行にし、区分(segmentType)を正しく割り当てる", () => {
    const gspcSnapshot = parseGlobalIndexWeeklyChart(GSPC_RAW, "gspc", "^GSPC");
    const jpySnapshot = parseGlobalIndexWeeklyChart(JPY_RAW, "jpy", "JPY=X");
    const tnxSnapshot = parseGlobalIndexWeeklyChart(TNX_RAW, "tnx", "^TNX");
    const farFuture = new Date("2027-06-01T00:00:00Z");

    const rows = toGlobalIndexObservationRows([
      { key: "gspc", result: resolveLatestWeeklyChange(gspcSnapshot, farFuture) },
      { key: "jpy", result: resolveLatestWeeklyChange(jpySnapshot, farFuture) },
      { key: "tnx", result: resolveLatestWeeklyChange(tnxSnapshot, farFuture) },
    ]);

    const gspcRow = rows.find((r) => r.indicatorKey === "global_gspc_weekly_change_pct");
    expect(gspcRow?.segmentType).toBe("国地域");
    expect(gspcRow?.segment).toBe("米国");
    expect(gspcRow?.isApproximate).toBe(false);

    const jpyRow = rows.find((r) => r.indicatorKey === "global_jpy_weekly_change_pct");
    expect(jpyRow?.segmentType).toBe("資産クラス");

    // ^TNX は %変化 と ポイント差 の2行が出る
    const tnxPctRow = rows.find((r) => r.indicatorKey === "global_tnx_weekly_change_pct");
    const tnxPtRow = rows.find((r) => r.indicatorKey === "global_tnx_weekly_change_pt");
    expect(tnxPctRow).toBeDefined();
    expect(tnxPtRow).toBeDefined();
    expect(tnxPtRow?.value).toBeCloseTo(0.18599987030029297, 6);
    expect(tnxPtRow?.unit).toBe("ポイント(%pt)");
  });

  it("not_yet_published の銘柄は行を出さない (黙って空値を埋めない)", () => {
    const gspcSnapshot = parseGlobalIndexWeeklyChart(GSPC_RAW, "gspc", "^GSPC");
    const beforeWeekEnd = new Date("2026-09-27T10:00:00.000Z");
    const rows = toGlobalIndexObservationRows([
      { key: "gspc", result: resolveLatestWeeklyChange(gspcSnapshot, beforeWeekEnd) },
    ]);
    expect(rows).toHaveLength(0);
  });
});

describe("globalIndicesArchiveInput", () => {
  it("取得バッチ単位で1レコードにまとめる (冪等キー・ファイル一覧)", () => {
    const input = globalIndicesArchiveInput({
      results: [
        { key: "gspc", yahooSymbol: "^GSPC", raw: GSPC_RAW, fetchedAt: "2026-09-27T02:00:00.000Z" },
        { key: "n225", yahooSymbol: "^N225", raw: N225_RAW, fetchedAt: "2026-09-27T02:00:05.000Z" },
      ],
    });
    expect(input.service).toBe("moneyflow");
    expect(input.key).toBe("global-indices-2026-09-27");
    expect(input.files).toHaveLength(2);
    expect(input.files[0]?.filename).toBe("global-indices-gspc-2026-09-27.json");
    expect(input.files[0]?.contentType).toBe("application/json");
  });

  it("results が空なら throw する", () => {
    expect(() => globalIndicesArchiveInput({ results: [] })).toThrow(/results が空です/);
  });
});
