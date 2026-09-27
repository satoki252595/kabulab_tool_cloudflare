/**
 * 世界の主要株価指数・為替・金利・金・原油
 * (services/moneyflow/lib/sources/global-indices.ts) のテスト。
 *
 * fixtures/private/global-indices/ は 2026-09-27 に実際に既存の Yahoo クライアント
 * (`src/shared/yahoo/client.ts` の `fetchYahooChartRaw`, `YAHOO_PROXY_BASE`
 * 経由, `interval=1wk`。応答の `meta.range` は "6mo" = 28本) へリクエストして
 * 得た生レスポンス (無編集)。原本で確認した数値は
 * 下記の各 `expect` コメントに、実測時点の生レスポンスから直接引用した値を
 * 書く (このテストファイル自身が「原本で目視確認した値」の記録)。
 *
 * `global-indices-symbol-not-found-2026-09-27.json` は `^TOPX` (TOPIX 指数
 * そのもの) を実際にリクエストして得た実物の 404 レスポンス
 * (`{"chart":{"result":null,"error":{"code":"Not Found",...}}}`)。TOPIX が
 * Yahoo Chart API に存在しないことの実機証拠であり、様式異常時に throw する
 * ことのテストにそのまま使う。
 *
 * Yahoo の応答は個人利用のみ (再配布不可) のため、フィクスチャは
 * `fixtures/private/global-indices/` (gitignore 済み) に置き commit しない。
 * 未取得の環境 (CI) では、フィクスチャを読むテストだけ `describe.skipIf` で
 * skip し、フィクスチャ不要のテストは常に走らせる。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

// fetchGlobalIndexWeeklyChart のテスト用に、既存 Yahoo クライアントの取得関数だけ
// 差し替える (本文は実フィクスチャを返す)。他のテストはクライアントを使わない。
const { fetchYahooChartRawMock } = vi.hoisted(() => ({ fetchYahooChartRawMock: vi.fn() }));
vi.mock("../../../../src/shared/yahoo/client.js", () => ({
  fetchYahooChartRaw: fetchYahooChartRawMock,
}));

import {
  fetchGlobalIndexWeeklyChart,
  GLOBAL_INDEX_CATALOG,
  GLOBAL_INDEX_INDICATORS,
  type GlobalIndexChartSnapshot,
  globalIndicesArchiveInput,
  isPeriodObservable,
  parseGlobalIndexWeeklyChart,
  resolveLatestCompletedWeek,
  resolveLatestWeeklyChange,
  resolveObservationPeriod,
  resolveWeeklyChangeForPeriod,
  toGlobalIndexObservationRows,
} from "./global-indices.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "private", "global-indices");
const DATE = "2026-09-27";
const fixturePath = (key: string) => join(FIXTURES_DIR, `global-indices-${key}-${DATE}.json`);
const FIXTURE_KEYS = ["gspc", "n225", "jpy", "eurusd", "ftse", "gold", "tnx", "topix-etf", "sse", "symbol-not-found"];
const hasFixtures = FIXTURE_KEYS.every((key) => existsSync(fixturePath(key)));

/**
 * 実フィクスチャ本文。import 時には読まず、参照された時点で読む
 * (未取得の環境で import 自体が throw しないように)。
 * 参照するテストは全て `describe.skipIf(!hasFixtures)` の中にある。
 */
const RAW = {
  get gspc() { return readFileSync(fixturePath("gspc"), "utf-8"); },
  get n225() { return readFileSync(fixturePath("n225"), "utf-8"); },
  get jpy() { return readFileSync(fixturePath("jpy"), "utf-8"); },
  get eurusd() { return readFileSync(fixturePath("eurusd"), "utf-8"); },
  get ftse() { return readFileSync(fixturePath("ftse"), "utf-8"); },
  get gold() { return readFileSync(fixturePath("gold"), "utf-8"); },
  get tnx() { return readFileSync(fixturePath("tnx"), "utf-8"); },
  get topixEtf() { return readFileSync(fixturePath("topix-etf"), "utf-8"); },
  get sse() { return readFileSync(fixturePath("sse"), "utf-8"); },
  get symbolNotFound() { return readFileSync(fixturePath("symbol-not-found"), "utf-8"); },
};

describe.skipIf(!hasFixtures)("parseGlobalIndexWeeklyChart (実フィクスチャ: gspc)", () => {
  it("原本の ^GSPC レスポンスからメタ情報と週次バーを正しく取り出す", () => {
    const snapshot = parseGlobalIndexWeeklyChart(RAW.gspc, "gspc", "^GSPC");

    // 原本確認値 1: meta.currency
    expect(snapshot.currency).toBe("USD");
    // 原本確認値 2: meta.instrumentType
    expect(snapshot.instrumentType).toBe("INDEX");
    // 原本確認値 3: meta.longName
    expect(snapshot.longName).toBe("S&P 500");
    // 原本確認値 4: meta.regularMarketPrice (2026-09-27 取得時点)
    expect(snapshot.regularMarketPrice).toBe(7743.41);
    // 原本確認値 5: meta.exchangeTimezoneName / meta.regularMarketTime (2026-09-25T20:39:57Z)
    expect(snapshot.exchangeTimezoneName).toBe("America/New_York");
    expect(snapshot.regularMarketTimeSec).toBe(1790368797);
    expect(snapshot.bars).toHaveLength(28);
    // 原本確認値 6: W38/W39 の週足バー (現地月曜0時 = UTC 04:00) と末尾の取得時点スナップショット
    expect(snapshot.bars[25]).toEqual({ timestampSec: 1789358400, close: 7650.5 });
    expect(snapshot.bars[26]).toEqual({ timestampSec: 1789963200, close: 7743.41015625 });
    expect(snapshot.bars[27]).toEqual({ timestampSec: 1790368797, close: 7743.41015625 });
  });

  it("exchangeTimezoneName が IANA タイムゾーン名でなければ throw する (UTC 等に倒さない)", () => {
    const broken = JSON.parse(RAW.gspc) as {
      chart: { result: [{ meta: Record<string, unknown> }] };
    };
    broken.chart.result[0].meta.exchangeTimezoneName = "Not/AZone";
    expect(() => parseGlobalIndexWeeklyChart(JSON.stringify(broken), "gspc", "^GSPC")).toThrow(
      /exchangeTimezoneName が有効な IANA タイムゾーン名ではありません/
    );
  });

  it("chart.error があれば throw する (実物の404: TOPIX(^TOPX)は存在しない)", () => {
    expect(() => parseGlobalIndexWeeklyChart(RAW.symbolNotFound, "topx", "^TOPX")).toThrow(
      /Chart API エラー.*Not Found.*delisted/
    );
  });

  it("meta.symbol が期待値と不一致なら throw する (様式変更/取り違えの検知)", () => {
    expect(() => parseGlobalIndexWeeklyChart(RAW.gspc, "gspc", "^IXIC")).toThrow(
      /meta\.symbol が期待値と不一致/
    );
  });

  it("meta.dataGranularity が1wk以外なら throw する", () => {
    const broken = JSON.parse(RAW.gspc) as {
      chart: { result: [{ meta: Record<string, unknown> }] };
    };
    broken.chart.result[0].meta.dataGranularity = "1d";
    expect(() => parseGlobalIndexWeeklyChart(JSON.stringify(broken), "gspc", "^GSPC")).toThrow(
      /dataGranularity/
    );
  });

  it("timestamp と close の配列長が不一致なら throw する (様式変更の検知)", () => {
    const broken = JSON.parse(RAW.gspc) as {
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
    const broken = JSON.parse(RAW.gspc) as {
      chart: { result: [{ meta: Record<string, unknown> }] };
    };
    broken.chart.result[0].meta.regularMarketPrice = "N/A";
    expect(() => parseGlobalIndexWeeklyChart(JSON.stringify(broken), "gspc", "^GSPC")).toThrow(
      /regularMarketPrice/
    );
  });
});

describe.skipIf(!hasFixtures)("parseGlobalIndexWeeklyChart (実フィクスチャ: 他カテゴリ横断)", () => {
  it("為替 (JPY=X) を正しく取り出す", () => {
    const snapshot = parseGlobalIndexWeeklyChart(RAW.jpy, "jpy", "JPY=X");
    // 原本確認値 7
    expect(snapshot.instrumentType).toBe("CURRENCY");
    expect(snapshot.longName).toBe("USD/JPY");
    expect(snapshot.regularMarketPrice).toBe(157.185);
  });

  it("商品先物 (GC=F, 金) を正しく取り出す (longName が無い実物データ)", () => {
    const snapshot = parseGlobalIndexWeeklyChart(RAW.gold, "gold", "GC=F");
    // 原本確認値 8: 金先物は longName が無い (null) 実データ
    expect(snapshot.longName).toBeNull();
    expect(snapshot.instrumentType).toBe("FUTURE");
    expect(snapshot.regularMarketPrice).toBe(4321.2);
  });

  it("金利指数 (^TNX, 米10年国債利回り) を正しく取り出す", () => {
    const snapshot = parseGlobalIndexWeeklyChart(RAW.tnx, "tnx", "^TNX");
    // 原本確認値 9: ^TNX の close は「利回り(%)そのもの」(×10表記ではない)
    expect(snapshot.longName).toBe("CBOE Interest Rate 10 Year T Note");
    expect(snapshot.regularMarketPrice).toBe(5.184);
  });

  it("TOPIX連動ETF (1306.T, 近似) を正しく取り出す", () => {
    const snapshot = parseGlobalIndexWeeklyChart(RAW.topixEtf, "topix-etf", "1306.T");
    // 原本確認値 10
    expect(snapshot.instrumentType).toBe("ETF");
    expect(snapshot.longName).toBe("NEXT FUNDS TOPIX Exchange Traded Fund");
    expect(snapshot.regularMarketPrice).toBe(430.3);
  });

  it("上海総合指数 (000001.SS) を正しく取り出す", () => {
    const snapshot = parseGlobalIndexWeeklyChart(RAW.sse, "sse", "000001.SS");
    // 原本確認値 11
    expect(snapshot.longName).toBe("SSE Composite Index");
    expect(snapshot.currency).toBe("CNY");
  });
});

/** W39 (2026-09-21〜27) が終わった直後 (UTC)。 */
const AFTER_W39 = new Date("2026-09-28T00:00:00.001Z");
/** W39 の途中 (木曜 0:00 UTC)。この時点で終わっている直近の週は W38。 */
const MID_W39 = new Date("2026-09-24T00:00:00.000Z");

describe.skipIf(!hasFixtures)("resolveLatestWeeklyChange (実フィクスチャ + 実際に見つかった不具合の回帰テスト)", () => {
  it("^GSPC (America/New_York): 直近確定週の騰落を正しく計算する", () => {
    const snapshot = parseGlobalIndexWeeklyChart(RAW.gspc, "gspc", "^GSPC");
    const result = resolveLatestWeeklyChange(snapshot, AFTER_W39);
    expect(result.status).toBe("observed");
    if (result.status !== "observed") throw new Error("unreachable");
    expect(result.observation.period.label).toBe("2026-W39");
    expect(result.observation.previousPeriod.label).toBe("2026-W38");
    expect(result.observation.close).toBe(7743.41015625);
    expect(result.observation.previousClose).toBe(7650.5);
    expect(result.observation.changeAbsolute).toBeCloseTo(92.91015625, 6);
    expect(result.observation.changePercent).toBeCloseTo(1.2144324717338737, 6);
    expect(result.observation.weeklyBarTimestamp).toBe("2026-09-21T04:00:00.000Z");
  });

  it("^N225 (Asia/Tokyo): 現地時間で正しい週に帰属させる (実際に見つかった不具合の回帰)", () => {
    // 実機検証で発覚した不具合: バーの UTC タイムスタンプをそのまま
    // getUTCFullYear/Month/Date で ISO 週に割り当てると、JST 月曜0時 (=UTC
    // 前日15時) が「前の週の日曜日」に誤分類され、直近週の2本 (週足バーと
    // 取得時点スナップショット、どちらも close=66364.203) が別々の週として
    // 扱われ、前週比が「66364.203 - 66364.203 = 0」という誤った結果になっていた。
    const snapshot = parseGlobalIndexWeeklyChart(RAW.n225, "n225", "^N225");
    expect(snapshot.exchangeTimezoneName).toBe("Asia/Tokyo");
    const result = resolveLatestWeeklyChange(snapshot, AFTER_W39);
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
    const snapshot = parseGlobalIndexWeeklyChart(RAW.gold, "gold", "GC=F");
    const result = resolveLatestWeeklyChange(snapshot, AFTER_W39);
    expect(result.status).toBe("observed");
    if (result.status !== "observed") throw new Error("unreachable");
    expect(result.observation.changeAbsolute).toBeCloseTo(-103.69970703125, 6);
    expect(result.observation.changePercent).toBeCloseTo(-2.3435492173805574, 6);
  });

  it("週の途中の now では、終わっている直近の週 (W38) の騰落を返す (未公表で止まらない回帰)", () => {
    // 旧実装は「データ中の最新の暦週 (W39) がまだ終わっていない」ことだけを見て
    // not_yet_published を返し、確定済みの W38 を返せなかった。翌週の最初の足が
    // できた時点で確定週を二度と返せず、東京 (現地月曜 9:00 = UTC 月曜 0:00 に
    // 取引開始) では確定週を返せる時間帯が実質ゼロだった。
    const gspc = resolveLatestWeeklyChange(parseGlobalIndexWeeklyChart(RAW.gspc, "gspc", "^GSPC"), MID_W39);
    expect(gspc.status).toBe("observed");
    if (gspc.status !== "observed") throw new Error("unreachable");
    expect(gspc.observation.period.label).toBe("2026-W38");
    expect(gspc.observation.close).toBe(7650.5);
    expect(gspc.observation.previousClose).toBe(7656.97998046875);
    expect(gspc.observation.changePercent).toBeCloseTo(-0.08462841074782729, 6);

    const n225 = resolveLatestWeeklyChange(parseGlobalIndexWeeklyChart(RAW.n225, "n225", "^N225"), MID_W39);
    expect(n225.status).toBe("observed");
    if (n225.status !== "observed") throw new Error("unreachable");
    expect(n225.observation.period.label).toBe("2026-W38");
    expect(n225.observation.close).toBe(65018.94921875);
    expect(n225.observation.previousClose).toBe(64011.33984375);
    expect(n225.observation.changePercent).toBeCloseTo(1.5741107395338825, 6);
  });

  it("為替 (JPY=X/EURUSD=X): 土曜の気配値スナップショットではなく週足バーの終値を使う (回帰)", () => {
    // 実フィクスチャ: JPY=X の W39 は週足バー close=158.811 と、土曜
    // 2026-09-26T04:21Z の気配値スナップショット close=157.185 の2本。旧実装は
    // 後者を採り、前週 (週足終値 156.875) と別定義の値を比べて +0.198% としていた。
    const jpy = parseGlobalIndexWeeklyChart(RAW.jpy, "jpy", "JPY=X");
    expect(jpy.regularMarketPrice).toBe(157.185);
    const jpyResult = resolveLatestWeeklyChange(jpy, AFTER_W39);
    expect(jpyResult.status).toBe("observed");
    if (jpyResult.status !== "observed") throw new Error("unreachable");
    expect(jpyResult.observation.close).toBe(158.81100463867188);
    expect(jpyResult.observation.previousClose).toBe(156.875);
    expect(jpyResult.observation.changePercent).toBeCloseTo(1.2341065425796813, 6);

    const eurusd = parseGlobalIndexWeeklyChart(RAW.eurusd, "eurusd", "EURUSD=X");
    const eurResult = resolveLatestWeeklyChange(eurusd, AFTER_W39);
    expect(eurResult.status).toBe("observed");
    if (eurResult.status !== "observed") throw new Error("unreachable");
    expect(eurResult.observation.close).toBe(1.1374752521514893);
    expect(eurResult.observation.previousClose).toBe(1.1487650871276855);
    expect(eurResult.observation.changePercent).toBeCloseTo(-0.9827801264769306, 6);
  });

  it("夏時間終了後の取得 (meta.gmtoffset が冬時間) でも過去の週足の週帰属がずれない (回帰)", () => {
    // 2026-11-01 (米国の夏時間終了) 以降に取得すると meta.gmtoffset は -18000 (EST)
    // になるが、夏時間中の週足は UTC 04:00 (EDT 0時) に刻まれたまま。旧実装は
    // gmtoffset を全バーに足していたため、それらを「日曜 23時」と読んで1週前に
    // ずらし、W39 の前週比が 0 になっていた (実フィクスチャの gmtoffset だけを
    // 冬時間の値に差し替えて再現)。現地暦日は exchangeTimezoneName から求める。
    const winter = JSON.parse(RAW.gspc) as {
      chart: { result: [{ meta: Record<string, unknown> }] };
    };
    winter.chart.result[0].meta.gmtoffset = -18000;
    const snapshot = parseGlobalIndexWeeklyChart(JSON.stringify(winter), "gspc", "^GSPC");
    const result = resolveLatestWeeklyChange(snapshot, AFTER_W39);
    expect(result.status).toBe("observed");
    if (result.status !== "observed") throw new Error("unreachable");
    expect(result.observation.previousPeriod.label).toBe("2026-W38");
    expect(result.observation.close).toBe(7743.41015625);
    expect(result.observation.previousClose).toBe(7650.5);
  });

  it("夏時間をまたぐ実データ (^FTSE: GMT 2026-03-23 → BST 2026-03-30) でも週が欠番・重複しない", () => {
    const snapshot = parseGlobalIndexWeeklyChart(RAW.ftse, "ftse", "^FTSE");
    // 実フィクスチャの先頭2本: 2026-03-23T00:00Z (GMT 月曜0時) と 2026-03-29T23:00Z (BST 月曜0時)
    expect(snapshot.bars[0]?.timestampSec).toBe(1774224000);
    expect(snapshot.bars[1]?.timestampSec).toBe(1774825200);
    const w14 = resolveWeeklyChangeForPeriod(snapshot, resolveObservationPeriod("week", new Date("2026-03-30T12:00:00Z")));
    expect(w14.status).toBe("observed");
    if (w14.status !== "observed") throw new Error("unreachable");
    expect(w14.observation.period.label).toBe("2026-W14");
    expect(w14.observation.previousPeriod.label).toBe("2026-W13");
    expect(w14.observation.close).toBe(snapshot.bars[1]?.close);
    expect(w14.observation.previousClose).toBe(snapshot.bars[0]?.close);
  });

  it("対象週の週足が無ければ no_bar_in_period を返す (throw せず、値も補わない)", () => {
    const snapshot = parseGlobalIndexWeeklyChart(RAW.gspc, "gspc", "^GSPC");
    const result = resolveWeeklyChangeForPeriod(
      snapshot,
      resolveObservationPeriod("week", new Date("2026-10-01T00:00:00Z"))
    );
    expect(result.status).toBe("no_bar_in_period");
    if (result.status !== "no_bar_in_period") throw new Error("unreachable");
    expect(result.period.label).toBe("2026-W40");
    expect(result.reason).toMatch(/2026-W40 の週足がありません/);
  });

  it("スナップショットを除いても1週に週足が2本以上あれば throw する (どれかを勝手に選ばない)", () => {
    const broken = JSON.parse(RAW.gspc) as {
      chart: { result: [{ timestamp: number[]; indicators: { quote: [{ close: number[] }] } }] };
    };
    // W38 の週足 (1789358400) と同じ週に、スナップショットでない2本目を差し込む
    broken.chart.result[0].timestamp.splice(26, 0, 1789358400 + 86_400);
    broken.chart.result[0].indicators.quote[0].close.splice(26, 0, 7700);
    const snapshot = parseGlobalIndexWeeklyChart(JSON.stringify(broken), "gspc", "^GSPC");
    expect(() => resolveLatestWeeklyChange(snapshot, AFTER_W39)).toThrow(/2026-W38 の週足バーが 2 本です/);
  });

  it("対象週の週足バーの close が null なら、土曜の気配値スナップショットで代用せず no_bar_in_period (回帰)", () => {
    // 実フィクスチャ JPY=X の W39 週足バー (末尾から2本目, close=158.811) だけを null に
    // した入力。修正前は「その週のバーが1本ならスナップショットを除外しない」条件の
    // ため、土曜 2026-09-26T04:21Z の気配値 157.185 が W39 の週末値として黙って使われ、
    // 前週 (週足終値 156.875) と別定義の値を比べた +0.198% が observed で返っていた。
    const broken = JSON.parse(RAW.jpy) as {
      chart: { result: [{ indicators: { quote: [{ close: (number | null)[] }] } }] };
    };
    const closes = broken.chart.result[0].indicators.quote[0].close;
    expect(closes[closes.length - 2]).toBe(158.81100463867188);
    expect(closes[closes.length - 1]).toBe(157.18499755859375);
    closes[closes.length - 2] = null;
    const snapshot = parseGlobalIndexWeeklyChart(JSON.stringify(broken), "jpy", "JPY=X");
    const result = resolveLatestWeeklyChange(snapshot, AFTER_W39);
    expect(result.status).toBe("no_bar_in_period");
    if (result.status !== "no_bar_in_period") throw new Error("unreachable");
    expect(result.period.label).toBe("2026-W39");
    expect(result.reason).toMatch(/2026-W39 の週足がありません/);
    // 1つ前の確定週 (W38) は影響を受けない
    const w38 = resolveLatestWeeklyChange(snapshot, MID_W39);
    expect(w38.status).toBe("observed");
    if (w38.status !== "observed") throw new Error("unreachable");
    expect(w38.observation.close).toBe(156.875);
  });

  it("週次以外の期間・ラベルと開始日が食い違う期間は throw する", () => {
    const snapshot = parseGlobalIndexWeeklyChart(RAW.gspc, "gspc", "^GSPC");
    expect(() =>
      resolveWeeklyChangeForPeriod(snapshot, resolveObservationPeriod("month", new Date("2026-09-01T00:00:00Z")))
    ).toThrow(/週次以外/);
    expect(() =>
      resolveWeeklyChangeForPeriod(snapshot, {
        granularity: "week",
        start: "2026-09-21",
        end: "2026-09-27",
        label: "2026-W38",
      })
    ).toThrow(/食い違っています/);
  });
});

describe("resolveWeeklyChangeForPeriod (フィクスチャ不要)", () => {
  it("対象週より前の週足が無い場合は throw する (黙って前週比を諦めない)", () => {
    const singleBarSnapshot: GlobalIndexChartSnapshot = {
      key: "gspc",
      yahooSymbol: "^GSPC",
      currency: "USD",
      instrumentType: "INDEX",
      longName: "S&P 500",
      regularMarketPrice: 100,
      regularMarketTimeSec: Math.floor(new Date("2020-01-10T21:00:00Z").getTime() / 1000),
      exchangeTimezoneName: "America/New_York",
      bars: [{ timestampSec: Math.floor(new Date("2020-01-06T05:00:00Z").getTime() / 1000), close: 100 }],
    };
    expect(() =>
      resolveWeeklyChangeForPeriod(
        singleBarSnapshot,
        resolveObservationPeriod("week", new Date("2020-01-08T00:00:00Z"))
      )
    ).toThrow(/より前の週足が取得範囲に無く/);
  });
});

describe("resolveLatestCompletedWeek", () => {
  it("now 時点で終わっている直近の ISO 週を返す (境界値・年またぎ W53 を含む)", () => {
    expect(resolveLatestCompletedWeek(MID_W39).label).toBe("2026-W38");
    expect(resolveLatestCompletedWeek(new Date("2026-09-27T23:59:59.998Z")).label).toBe("2026-W38");
    expect(resolveLatestCompletedWeek(new Date("2026-09-27T23:59:59.999Z")).label).toBe("2026-W39");
    expect(resolveLatestCompletedWeek(AFTER_W39)).toEqual({
      granularity: "week",
      start: "2026-09-21",
      end: "2026-09-27",
      label: "2026-W39",
    });
    // 2026年は ISO 週が53週まである (2026-12-28〜2027-01-03)
    expect(resolveLatestCompletedWeek(new Date("2027-01-04T00:00:00Z")).label).toBe("2026-W53");
    expect(resolveLatestCompletedWeek(new Date("2027-01-11T00:00:00Z")).label).toBe("2027-W01");
  });

  it("不正な Date は throw する", () => {
    expect(() => resolveLatestCompletedWeek(new Date("invalid"))).toThrow(/Invalid Date/);
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
    // Yahoo の 1306.T は取引所の市場価格であり、基準価額 (NAV) ではない
    expect(topixIndicator?.limitations).toMatch(/市場価格/);
    expect(topixIndicator?.limitations).not.toMatch(/基準価額で代替/);
  });

  it("株価指数の説明文は「時価総額に近い」と断定しない (日経平均は株価平均型で時価総額とも一致しない)", () => {
    for (const entry of GLOBAL_INDEX_CATALOG.filter((e) => e.category === "index")) {
      const indicator = GLOBAL_INDEX_INDICATORS.find((i) => i.key === `global_${entry.key}_weekly_change_pct`);
      expect(indicator?.description).not.toMatch(/時価総額/);
      expect(indicator?.description).toMatch(/フロー\)ではない/);
    }
  });

  it("為替の限界の説明は実装 (週足終値・土日の気配値は使わない) と一致する", () => {
    for (const key of ["global_jpy_weekly_change_pct", "global_eurusd_weekly_change_pct"]) {
      const indicator = GLOBAL_INDEX_INDICATORS.find((i) => i.key === key);
      expect(indicator?.limitations).toMatch(/週足/);
      expect(indicator?.limitations).toMatch(/土日に配信される気配値は使わない/);
      expect(indicator?.limitations).not.toMatch(/UTCで区切って/);
    }
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

describe.skipIf(!hasFixtures)("toGlobalIndexObservationRows", () => {
  it("観測済みの銘柄だけを行にし、区分(segmentType)を正しく割り当てる", () => {
    const gspcSnapshot = parseGlobalIndexWeeklyChart(RAW.gspc, "gspc", "^GSPC");
    const jpySnapshot = parseGlobalIndexWeeklyChart(RAW.jpy, "jpy", "JPY=X");
    const tnxSnapshot = parseGlobalIndexWeeklyChart(RAW.tnx, "tnx", "^TNX");

    const rows = toGlobalIndexObservationRows([
      { key: "gspc", result: resolveLatestWeeklyChange(gspcSnapshot, AFTER_W39) },
      { key: "jpy", result: resolveLatestWeeklyChange(jpySnapshot, AFTER_W39) },
      { key: "tnx", result: resolveLatestWeeklyChange(tnxSnapshot, AFTER_W39) },
    ]);
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((r) => r.period))).toEqual(new Set(["2026-W39"]));

    const gspcRow = rows.find((r) => r.indicatorKey === "global_gspc_weekly_change_pct");
    expect(gspcRow?.segmentType).toBe("国地域");
    expect(gspcRow?.segment).toBe("米国");
    expect(gspcRow?.isApproximate).toBe(false);

    const jpyRow = rows.find((r) => r.indicatorKey === "global_jpy_weekly_change_pct");
    expect(jpyRow?.segmentType).toBe("資産クラス");
    expect(jpyRow?.value).toBeCloseTo(1.2341065425796813, 6);

    // ^TNX は %変化 と ポイント差 の2行が出る
    const tnxPctRow = rows.find((r) => r.indicatorKey === "global_tnx_weekly_change_pct");
    const tnxPtRow = rows.find((r) => r.indicatorKey === "global_tnx_weekly_change_pt");
    expect(tnxPctRow).toBeDefined();
    expect(tnxPtRow).toBeDefined();
    expect(tnxPtRow?.value).toBeCloseTo(0.18599987030029297, 6);
    expect(tnxPtRow?.unit).toBe("ポイント(%pt)");
  });

  it("no_bar_in_period の銘柄は行を出さない (黙って空値を埋めない)", () => {
    const gspcSnapshot = parseGlobalIndexWeeklyChart(RAW.gspc, "gspc", "^GSPC");
    const farFuture = new Date("2027-06-01T00:00:00Z"); // 直近の確定週 2027-W22 の週足は無い
    const result = resolveLatestWeeklyChange(gspcSnapshot, farFuture);
    expect(result.status).toBe("no_bar_in_period");
    const rows = toGlobalIndexObservationRows([{ key: "gspc", result }]);
    expect(rows).toHaveLength(0);
  });
});

describe.skipIf(!hasFixtures)("fetchGlobalIndexWeeklyChart (Yahoo クライアントを差し替え、本文は実フィクスチャ)", () => {
  beforeEach(() => {
    fetchYahooChartRawMock.mockReset();
  });

  it("200 かつ様式どおりの本文だけを返す (週次・カタログのシンボルで取得)", async () => {
    fetchYahooChartRawMock.mockResolvedValue(new Response(RAW.gspc, { status: 200 }));
    const result = await fetchGlobalIndexWeeklyChart("gspc");
    expect(fetchYahooChartRawMock).toHaveBeenCalledWith("^GSPC", "3mo", "1wk", false);
    expect(result.key).toBe("gspc");
    expect(result.yahooSymbol).toBe("^GSPC");
    expect(result.raw).toBe(RAW.gspc);
    expect(result.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("HTTP エラー (実物の 404 本文) は throw する (エラー本文を一次データとして返さない)", async () => {
    fetchYahooChartRawMock.mockResolvedValue(new Response(RAW.symbolNotFound, { status: 404 }));
    await expect(fetchGlobalIndexWeeklyChart("gspc")).rejects.toThrow(/HTTP 404.*Not Found/);
  });

  it("200 でも別シンボルの本文なら throw する (取り違えた本文を返さない)", async () => {
    fetchYahooChartRawMock.mockResolvedValue(new Response(RAW.gspc, { status: 200 }));
    await expect(fetchGlobalIndexWeeklyChart("ixic")).rejects.toThrow(/meta\.symbol が期待値と不一致/);
  });
});

describe("fetchGlobalIndexWeeklyChart (Yahoo クライアントを差し替え、フィクスチャ不要)", () => {
  beforeEach(() => {
    fetchYahooChartRawMock.mockReset();
  });

  it("429 (レート制限) は throw する", async () => {
    fetchYahooChartRawMock.mockResolvedValue(new Response("Too Many Requests", { status: 429 }));
    await expect(fetchGlobalIndexWeeklyChart("n225")).rejects.toThrow(/HTTP 429/);
  });
});

describe.skipIf(!hasFixtures)("globalIndicesArchiveInput (実フィクスチャ)", () => {
  it("取得バッチ単位で1レコードにまとめる (冪等キー・ファイル一覧)", () => {
    const input = globalIndicesArchiveInput({
      results: [
        { key: "gspc", yahooSymbol: "^GSPC", raw: RAW.gspc, fetchedAt: "2026-09-27T02:00:00.000Z" },
        { key: "n225", yahooSymbol: "^N225", raw: RAW.n225, fetchedAt: "2026-09-27T02:00:05.000Z" },
      ],
    });
    expect(input.service).toBe("moneyflow");
    expect(input.key).toBe("global-indices-2026-09-27");
    expect(input.files).toHaveLength(2);
    expect(input.files[0]?.filename).toBe("global-indices-gspc-2026-09-27.json");
    expect(input.files[0]?.contentType).toBe("application/json");
  });
});

describe("globalIndicesArchiveInput (フィクスチャ不要)", () => {
  it("results が空なら throw する", () => {
    expect(() => globalIndicesArchiveInput({ results: [] })).toThrow(/results が空です/);
  });
});
