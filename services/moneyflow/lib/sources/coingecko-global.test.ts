/**
 * CoinGecko グローバルスナップショット (services/moneyflow/lib/sources/coingecko-global.ts)
 * のテスト。
 *
 * fixtures/ は 2026-09-27 に実際に `https://api.coingecko.com/api/v3` へ
 * リクエストして得た生レスポンス (categories は 769 件中 5 件に絞った部分集合。
 * それ以外は無編集)。原本で確認した数値は下記の各 `expect` コメントに、実測
 * 時点の生レスポンスから直接引用した値を書く (このテストファイル自身が「原本
 * で目視確認した値」の記録)。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  COINGECKO_GLOBAL_INDICATORS,
  type MoneyflowIndicatorDefinition,
  coinGeckoArchiveInput,
  isPeriodObservable,
  parseCoinGeckoCoinMarkets,
  parseCoinGeckoGlobal,
  parseCoinGeckoStablecoinCategory,
  resolveObservationPeriod,
  toCoinGeckoObservationRows,
} from "./coingecko-global.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const readFixture = (name: string) => readFileSync(join(FIXTURES_DIR, name), "utf-8");

const GLOBAL_RAW = readFixture("global-2026-09-27.json");
const MARKETS_RAW = readFixture("coins-markets-jpy-2026-09-27.json");
const CATEGORIES_RAW = readFixture("categories-stablecoins-2026-09-27.json");

describe("parseCoinGeckoGlobal (実フィクスチャ: global-2026-09-27.json)", () => {
  it("原本の /global レスポンスから世界合計の時価総額・ドミナンス等を正しく取り出す", () => {
    const snapshot = parseCoinGeckoGlobal(GLOBAL_RAW);

    // 原本確認値 1: data.total_market_cap.usd (2026-09-27 02:19:54 UTC 取得時点)
    expect(snapshot.totalMarketCapUsd).toBe(2906523550432.045);
    // 原本確認値 2: data.total_market_cap.jpy
    expect(snapshot.totalMarketCapJpy).toBe(457152556629704.2);
    // 原本確認値 3: data.market_cap_percentage.btc (ビットコイン・ドミナンス)
    expect(snapshot.btcDominancePct).toBe(58.28026279528517);
    // 原本確認値 4: data.market_cap_percentage.eth
    expect(snapshot.ethDominancePct).toBe(11.330688036389803);
    // 原本確認値 5: data.updated_at (unix秒 1790475594) → ISO 変換の正しさ
    expect(snapshot.asOf).toBe("2026-09-27T02:19:54.000Z");
    expect(snapshot.totalVolumeUsd).toBe(57734085750.77637);
    expect(snapshot.marketCapChangePercentage24hUsd).toBe(-2.3537251367874337);
    expect(snapshot.activeCryptocurrencies).toBe(21621);
    expect(snapshot.markets).toBe(1501);
  });

  it("data フィールドが無ければ throw する (様式変更の検知)", () => {
    expect(() => parseCoinGeckoGlobal(JSON.stringify({ foo: 1 }))).toThrow(/data フィールド/);
  });

  it("total_market_cap.usd が数値でなければ throw する (フォールバック禁止)", () => {
    const broken = JSON.parse(GLOBAL_RAW) as { data: Record<string, unknown> };
    (broken.data.total_market_cap as Record<string, unknown>).usd = "N/A";
    expect(() => parseCoinGeckoGlobal(JSON.stringify(broken))).toThrow(/total_market_cap\.usd/);
  });

  it("JSON として壊れていれば throw する", () => {
    expect(() => parseCoinGeckoGlobal("{not json")).toThrow(/JSON として解釈できません/);
  });
});

describe("parseCoinGeckoCoinMarkets (実フィクスチャ: coins-markets-jpy-2026-09-27.json)", () => {
  it("原本の /coins/markets レスポンスから円建て価格・時価総額を正しく取り出す", () => {
    const coins = parseCoinGeckoCoinMarkets(MARKETS_RAW);
    expect(coins).toHaveLength(5);

    const bitcoin = coins.find((c) => c.id === "bitcoin");
    // 原本確認値 6: bitcoin.current_price (円建て)
    expect(bitcoin?.priceJpy).toBe(13289426);
    // 原本確認値 7: bitcoin.market_cap (円建て)
    expect(bitcoin?.marketCapJpy).toBe(266969122134522);
    expect(bitcoin?.symbol).toBe("btc");
    expect(bitcoin?.marketCapRank).toBe(1);

    const ethereum = coins.find((c) => c.id === "ethereum");
    // 原本確認値 8: ethereum.market_cap (円建て)
    expect(ethereum?.marketCapJpy).toBe(51897511333033);

    const ripple = coins.find((c) => c.id === "ripple");
    expect(ripple?.symbol).toBe("xrp");
    expect(ripple?.priceJpy).toBe(240.11);
  });

  it("配列でなければ throw する (様式変更の検知)", () => {
    expect(() => parseCoinGeckoCoinMarkets(JSON.stringify({ error: "not found" }))).toThrow(/配列ではありません/);
  });

  it("空配列なら throw する (指定 coin id が存在しない可能性)", () => {
    expect(() => parseCoinGeckoCoinMarkets("[]")).toThrow(/空配列/);
  });

  it("current_price が欠けている行があれば throw する", () => {
    const broken = JSON.parse(MARKETS_RAW) as Array<Record<string, unknown>>;
    delete broken[0]!.current_price;
    expect(() => parseCoinGeckoCoinMarkets(JSON.stringify(broken))).toThrow(/current_price/);
  });
});

describe("parseCoinGeckoStablecoinCategory (実フィクスチャ: categories-stablecoins-2026-09-27.json)", () => {
  it("原本の /coins/categories からステーブルコイン合計時価総額を正しく取り出す", () => {
    const stablecoins = parseCoinGeckoStablecoinCategory(CATEGORIES_RAW);
    expect(stablecoins.id).toBe("stablecoins");
    // 原本確認値 9: id="stablecoins" の market_cap (ドル建て合計)
    expect(stablecoins.marketCapUsd).toBe(292862711888.5375);
    expect(stablecoins.updatedAt).toBe("2026-09-27T02:25:38.000Z");
  });

  it("id=stablecoins のカテゴリが無ければ throw する (様式変更の検知)", () => {
    const filtered = (JSON.parse(CATEGORIES_RAW) as Array<{ id: string }>).filter(
      (c) => c.id !== "stablecoins"
    );
    expect(() => parseCoinGeckoStablecoinCategory(JSON.stringify(filtered))).toThrow(/stablecoins.*見つかりません/);
  });
});

describe("resolveObservationPeriod / isPeriodObservable", () => {
  it("month: 2026-09-27 を含む月は 2026-09-01〜2026-09-30", () => {
    const period = resolveObservationPeriod("month", new Date("2026-09-27T00:00:00Z"));
    expect(period).toEqual({
      granularity: "month",
      start: "2026-09-01",
      end: "2026-09-30",
      label: "2026-09",
    });
  });

  it("quarter: 2026-09-27 は Q3 (7〜9月)", () => {
    const period = resolveObservationPeriod("quarter", new Date("2026-09-27T00:00:00Z"));
    expect(period).toEqual({ granularity: "quarter", start: "2026-07-01", end: "2026-09-30", label: "2026-Q3" });
  });

  it("week: 2026-09-27 (日曜) は ISO week 39 (月 2026-09-21 〜 日 2026-09-27)", () => {
    const period = resolveObservationPeriod("week", new Date("2026-09-27T00:00:00Z"));
    expect(period.label).toBe("2026-W39");
    expect(period.start).toBe("2026-09-21");
    expect(period.end).toBe("2026-09-27");
  });

  it("day: 単日はその日自身", () => {
    const period = resolveObservationPeriod("day", new Date("2026-09-27T05:00:00Z"));
    expect(period).toEqual({ granularity: "day", start: "2026-09-27", end: "2026-09-27", label: "2026-09-27" });
  });

  it("進行中の月は observable=false (まだ終わっていない)", () => {
    const period = resolveObservationPeriod("month", new Date("2026-09-10T00:00:00Z"));
    const result = isPeriodObservable(period, new Date("2026-09-10T00:00:00Z"));
    expect(result.observable).toBe(false);
    expect(result.reason).toMatch(/まだ終わっていません/);
  });

  it("終わった月は observable=true", () => {
    const period = resolveObservationPeriod("month", new Date("2026-08-15T00:00:00Z"));
    const result = isPeriodObservable(period, new Date("2026-09-27T00:00:00Z"));
    expect(result.observable).toBe(true);
    expect(result.reason).toBeUndefined();
  });
});

describe("toCoinGeckoObservationRows", () => {
  it("縦長の観測ログ行 (期間・指標キー・区分・値・単位・近似/推定フラグ) を組み立てる", () => {
    const global = parseCoinGeckoGlobal(GLOBAL_RAW);
    const coins = parseCoinGeckoCoinMarkets(MARKETS_RAW);
    const stablecoins = parseCoinGeckoStablecoinCategory(CATEGORIES_RAW);
    const period = resolveObservationPeriod("day", new Date("2026-09-27T00:00:00Z"));

    const rows = toCoinGeckoObservationRows({ global, coins, stablecoins }, period);

    // 5銘柄 × (価格 + 時価総額) + 世界合計 + ステーブルコイン合計 + BTCドミナンス = 13行
    expect(rows).toHaveLength(13);
    expect(rows.every((r) => r.period === "2026-09-27")).toBe(true);
    expect(rows.every((r) => r.isApproximate === false && r.isEstimated === false)).toBe(true);

    const btcPrice = rows.find(
      (r) => r.indicatorKey === "coingecko_price_jpy" && r.segment === "ビットコイン(BTC)"
    );
    expect(btcPrice?.value).toBe(13289426);
    expect(btcPrice?.unit).toBe("円/単位");

    const stablecoinRow = rows.find((r) => r.indicatorKey === "coingecko_stablecoin_market_cap_usd");
    expect(stablecoinRow?.value).toBe(292862711888.5375);
    expect(stablecoinRow?.segmentType).toBe("資産クラス");

    const dominanceRow = rows.find((r) => r.indicatorKey === "coingecko_btc_dominance_pct");
    expect(dominanceRow?.value).toBe(58.28026279528517);
    expect(dominanceRow?.unit).toBe("%");
  });
});

describe("COINGECKO_GLOBAL_INDICATORS (指標定義)", () => {
  it("5指標すべてに必須フィールドが揃っている", () => {
    expect(COINGECKO_GLOBAL_INDICATORS).toHaveLength(5);
    const requiredFields: Array<keyof MoneyflowIndicatorDefinition> = [
      "key",
      "displayName",
      "requirements",
      "flowType",
      "description",
      "unit",
      "sourceUrl",
      "usageTerms",
      "frequency",
      "limitations",
    ];
    for (const indicator of COINGECKO_GLOBAL_INDICATORS) {
      for (const field of requiredFields) {
        const value = indicator[field];
        expect(value, `${indicator.key}.${String(field)}`).toBeTruthy();
      }
      expect(indicator.requirements).toContain("R3");
    }
  });

  it("キーが重複していない", () => {
    const keys = COINGECKO_GLOBAL_INDICATORS.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("coinGeckoArchiveInput (ルール6: アーカイブ入力の組み立て)", () => {
  it("日次冪等キー + 3ファイルの実体で記録入力を組む", () => {
    const bundle = {
      global: { url: "https://api.coingecko.com/api/v3/global", raw: GLOBAL_RAW, fetchedAt: "2026-09-27T02:30:00.000Z" },
      coinMarkets: {
        url: "https://api.coingecko.com/api/v3/coins/markets?vs_currency=jpy&ids=bitcoin",
        raw: MARKETS_RAW,
        fetchedAt: "2026-09-27T02:30:01.000Z",
      },
      stablecoinCategory: {
        url: "https://api.coingecko.com/api/v3/coins/categories",
        raw: CATEGORIES_RAW,
        fetchedAt: "2026-09-27T02:30:02.000Z",
      },
    };
    const input = coinGeckoArchiveInput(bundle);

    expect(input.service).toBe("moneyflow");
    expect(input.key).toBe("coingecko-global-2026-09-27");
    expect(input.source).toBe("https://api.coingecko.com/api/v3/global");
    expect(input.metadata).toMatchObject({ fetchedAt: "2026-09-27T02:30:00.000Z" });
    expect(input.files).toHaveLength(3);
    expect(input.files[0]!.filename).toBe("coingecko-global-2026-09-27.json");
    expect(input.files[0]!.contentType).toBe("application/json");
    expect(new TextDecoder().decode(input.files[0]!.bytes)).toBe(GLOBAL_RAW);
  });

  it("fetchedAt が日付として解釈できなければ throw する", () => {
    const bundle = {
      global: { url: "x", raw: "{}", fetchedAt: "not-a-date" },
      coinMarkets: { url: "x", raw: "[]", fetchedAt: "2026-09-27T00:00:00.000Z" },
      stablecoinCategory: { url: "x", raw: "[]", fetchedAt: "2026-09-27T00:00:00.000Z" },
    };
    expect(() => coinGeckoArchiveInput(bundle)).toThrow(/日付キーを作れません/);
  });
});
