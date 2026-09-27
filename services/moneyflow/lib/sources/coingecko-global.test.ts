/**
 * CoinGecko グローバルスナップショット (services/moneyflow/lib/sources/coingecko-global.ts)
 * のテスト。
 *
 * fixtures/private/coingecko-global/ は 2026-09-27 に実際に `https://api.coingecko.com/api/v3` へ
 * リクエストして得た生レスポンス (categories は 769 件中 5 件に絞った部分集合。
 * それ以外は無編集)。原本で確認した数値は下記の各 `expect` コメントに、実測
 * 時点の生レスポンスから直接引用した値を書く (このテストファイル自身が「原本
 * で目視確認した値」の記録)。
 *
 * CoinGecko の利用条件上、生レスポンスの再配布可否を確認していないため
 * fixture は commit しない (.gitignore 済み)。無い環境 (CI) では fixture を
 * 読むテストだけ describe.skipIf で skip し、合成入力のテストは常に走らせる。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  COINGECKO_GLOBAL_INDICATORS,
  type MoneyflowIndicatorDefinition,
  coinGeckoArchiveInput,
  fetchCoinGeckoCoinMarkets,
  fetchCoinGeckoGlobal,
  isPeriodObservable,
  parseCoinGeckoCoinMarkets,
  parseCoinGeckoGlobal,
  parseCoinGeckoStablecoinCategory,
  resolveObservationPeriod,
  toCoinGeckoObservationRows,
} from "./coingecko-global.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "private", "coingecko-global");
const FIXTURE_NAMES = {
  global: "global-2026-09-27.json",
  markets: "coins-markets-jpy-2026-09-27.json",
  categories: "categories-stablecoins-2026-09-27.json",
} as const;
const HAS_FIXTURES = Object.values(FIXTURE_NAMES).every((n) => existsSync(join(FIXTURES_DIR, n)));

// fixture が無い環境 (CI) で import 時に落ちないよう、読込は呼ばれた時だけ行う (1回だけ読んで使い回す)
const fixtureCache = new Map<string, string>();
function readFixture(name: string): string {
  let text = fixtureCache.get(name);
  if (text === undefined) {
    text = readFileSync(join(FIXTURES_DIR, name), "utf-8");
    fixtureCache.set(name, text);
  }
  return text;
}
const GLOBAL_RAW = () => readFixture(FIXTURE_NAMES.global);
const MARKETS_RAW = () => readFixture(FIXTURE_NAMES.markets);
const CATEGORIES_RAW = () => readFixture(FIXTURE_NAMES.categories);

describe("parseCoinGeckoGlobal (実フィクスチャ: global-2026-09-27.json)", () => {
  it("data フィールドが無ければ throw する (様式変更の検知)", () => {
    expect(() => parseCoinGeckoGlobal(JSON.stringify({ foo: 1 }))).toThrow(/data フィールド/);
  });

  it("JSON として壊れていれば throw する", () => {
    expect(() => parseCoinGeckoGlobal("{not json")).toThrow(/JSON として解釈できません/);
  });

  describe.skipIf(!HAS_FIXTURES)("実フィクスチャ (private)", () => {
    it("原本の /global レスポンスから世界合計の時価総額・ドミナンス等を正しく取り出す", () => {
      const snapshot = parseCoinGeckoGlobal(GLOBAL_RAW());

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

    it("total_market_cap.usd が数値でなければ throw する (フォールバック禁止)", () => {
      const broken = JSON.parse(GLOBAL_RAW()) as { data: Record<string, unknown> };
      (broken.data.total_market_cap as Record<string, unknown>).usd = "N/A";
      expect(() => parseCoinGeckoGlobal(JSON.stringify(broken))).toThrow(/total_market_cap\.usd/);
    });
  });
});

describe("parseCoinGeckoCoinMarkets (実フィクスチャ: coins-markets-jpy-2026-09-27.json)", () => {
  it("配列でなければ throw する (様式変更の検知)", () => {
    expect(() => parseCoinGeckoCoinMarkets(JSON.stringify({ error: "not found" }))).toThrow(/配列ではありません/);
  });

  it("空配列なら throw する (指定 coin id が存在しない可能性)", () => {
    expect(() => parseCoinGeckoCoinMarkets("[]")).toThrow(/空配列/);
  });

  describe.skipIf(!HAS_FIXTURES)("実フィクスチャ (private)", () => {
    it("原本の /coins/markets レスポンスから円建て価格・時価総額を正しく取り出す", () => {
      const coins = parseCoinGeckoCoinMarkets(MARKETS_RAW());
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

    it("current_price が欠けている行があれば throw する", () => {
      const broken = JSON.parse(MARKETS_RAW()) as Array<Record<string, unknown>>;
      delete broken[0]!.current_price;
      expect(() => parseCoinGeckoCoinMarkets(JSON.stringify(broken))).toThrow(/current_price/);
    });

    it("要求した coin id の一部が応答から丸ごと欠けていれば throw する (件数だけ減るデータ欠損を検知)", () => {
      const rows = JSON.parse(MARKETS_RAW()) as Array<{ id: string }>;
      // bitcoin 自体は様式的に正しいまま、行ごと欠落している状況を再現する。
      const missingBitcoin = rows.filter((r) => r.id !== "bitcoin");
      expect(missingBitcoin.length).toBeGreaterThan(0);
      expect(() => parseCoinGeckoCoinMarkets(JSON.stringify(missingBitcoin))).toThrow(/missing=bitcoin/);
    });

    it("expectedIds を明示すれば、その集合だけで欠落チェックする", () => {
      const rows = JSON.parse(MARKETS_RAW()) as Array<{ id: string }>;
      const onlyBitcoin = rows.filter((r) => r.id === "bitcoin");
      expect(() => parseCoinGeckoCoinMarkets(JSON.stringify(onlyBitcoin), ["bitcoin"])).not.toThrow();
      expect(parseCoinGeckoCoinMarkets(JSON.stringify(onlyBitcoin), ["bitcoin"])).toHaveLength(1);
    });
  });
});

describe.skipIf(!HAS_FIXTURES)("parseCoinGeckoStablecoinCategory (実フィクスチャ: categories-stablecoins-2026-09-27.json)", () => {
  it("原本の /coins/categories からステーブルコイン合計時価総額を正しく取り出す", () => {
    const stablecoins = parseCoinGeckoStablecoinCategory(CATEGORIES_RAW());
    expect(stablecoins.id).toBe("stablecoins");
    // 原本確認値 9: id="stablecoins" の market_cap (ドル建て合計)
    expect(stablecoins.marketCapUsd).toBe(292862711888.5375);
    expect(stablecoins.updatedAt).toBe("2026-09-27T02:25:38.000Z");
  });

  it("id=stablecoins のカテゴリが無ければ throw する (様式変更の検知)", () => {
    const filtered = (JSON.parse(CATEGORIES_RAW()) as Array<{ id: string }>).filter(
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

  it("day: 当日は取得した瞬間に observable=true (リアルタイムAPIで公表ラグが無く、月/週のような『期間途中』の概念が無いため)", () => {
    const now = new Date("2026-09-27T05:00:00Z");
    const period = resolveObservationPeriod("day", now);
    const result = isPeriodObservable(period, now);
    expect(result.observable).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("day: 過去の日付も observable=true", () => {
    const period = resolveObservationPeriod("day", new Date("2026-09-20T00:00:00Z"));
    const result = isPeriodObservable(period, new Date("2026-09-27T00:00:00Z"));
    expect(result.observable).toBe(true);
  });

  it("day: まだ来ていない未来の日付は observable=false", () => {
    const period = resolveObservationPeriod("day", new Date("2026-10-01T00:00:00Z"));
    const result = isPeriodObservable(period, new Date("2026-09-27T00:00:00Z"));
    expect(result.observable).toBe(false);
    expect(result.reason).toMatch(/まだ来ていない/);
  });
});

describe.skipIf(!HAS_FIXTURES)("toCoinGeckoObservationRows", () => {
  it("縦長の観測ログ行 (期間・指標キー・区分・値・単位・近似/推定フラグ) を組み立てる", () => {
    const global = parseCoinGeckoGlobal(GLOBAL_RAW());
    const coins = parseCoinGeckoCoinMarkets(MARKETS_RAW());
    const stablecoins = parseCoinGeckoStablecoinCategory(CATEGORIES_RAW());
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

  it("usageTerms は attribution 義務を『商用利用時のみ』と誤って条件付けていない (CoinGecko API Terms 本文で" +
    "『regardless of the usage plan』と一般義務であることを 2026-09-27 に確認済み)", () => {
    for (const indicator of COINGECKO_GLOBAL_INDICATORS) {
      expect(indicator.usageTerms).toMatch(/Powered by CoinGecko/);
      expect(indicator.usageTerms).not.toMatch(/商用利用・再配布には/);
    }
  });
});

describe("coinGeckoArchiveInput (ルール6: アーカイブ入力の組み立て)", () => {
  it("fetchedAt が日付として解釈できなければ throw する", () => {
    const bundle = {
      global: { url: "x", raw: "{}", fetchedAt: "not-a-date" },
      coinMarkets: { url: "x", raw: "[]", fetchedAt: "2026-09-27T00:00:00.000Z" },
      stablecoinCategory: { url: "x", raw: "[]", fetchedAt: "2026-09-27T00:00:00.000Z" },
    };
    expect(() => coinGeckoArchiveInput(bundle)).toThrow(/日付キーを作れません/);
  });

  describe.skipIf(!HAS_FIXTURES)("実フィクスチャ (private)", () => {
    it("日次冪等キー + 3ファイルの実体で記録入力を組む", () => {
      const bundle = {
        global: { url: "https://api.coingecko.com/api/v3/global", raw: GLOBAL_RAW(), fetchedAt: "2026-09-27T02:30:00.000Z" },
        coinMarkets: {
          url: "https://api.coingecko.com/api/v3/coins/markets?vs_currency=jpy&ids=bitcoin",
          raw: MARKETS_RAW(),
          fetchedAt: "2026-09-27T02:30:01.000Z",
        },
        stablecoinCategory: {
          url: "https://api.coingecko.com/api/v3/coins/categories",
          raw: CATEGORIES_RAW(),
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
      expect(new TextDecoder().decode(input.files[0]!.bytes)).toBe(GLOBAL_RAW());
    });
  });
});

// ---------------------------------------------------------------------------
// 2026-09-27 再検証で追加した回帰テスト (修正前のコードでは失敗する)
// ---------------------------------------------------------------------------

describe("fetchJsonText 経由の HTTP エラー (fetch をスタブ)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("429 は本文の抜粋とレート制限の案内付きで throw する", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('{"status":{"error_code":429}}', { status: 429, statusText: "Too Many Requests" }))
    );
    await expect(fetchCoinGeckoGlobal("demo-key")).rejects.toThrow(/429 .*レート制限.*body=\{"status"/);
  });

  it("エラー応答の本文読み取りに失敗しても空文字に丸めず、失敗した事実を残して throw する (catch で既定値を返さない)", async () => {
    const broken = {
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      text: () => Promise.reject(new Error("socket hang up")),
    } as unknown as Response;
    vi.stubGlobal("fetch", vi.fn(async () => broken));
    const err = await fetchCoinGeckoGlobal("demo-key").then(
      () => {
        throw new Error("reject されるべき");
      },
      (e: unknown) => e as Error
    );
    expect(err.message).toMatch(/503 Service Unavailable/);
    expect(err.message).toMatch(/本文の読み取りにも失敗しました \(socket hang up\)/);
    expect((err.cause as Error).message).toBe("socket hang up");
  });

  it("本文が空のエラー応答は『(空)』と明示する", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500, statusText: "Internal Server Error" })));
    await expect(fetchCoinGeckoGlobal("demo-key")).rejects.toThrow(/500 Internal Server Error .*body=\(空\)/);
  });

  describe.skipIf(!HAS_FIXTURES)("実フィクスチャを応答本文に使う (private)", () => {
    it("Demo キーがあれば x-cg-demo-api-key を付け、未設定なら付けない", async () => {
      const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(MARKETS_RAW(), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      const withKey = await fetchCoinGeckoCoinMarkets(["bitcoin"], "demo-key");
      expect(withKey.raw).toBe(MARKETS_RAW());
      expect(withKey.url).toBe(
        "https://api.coingecko.com/api/v3/coins/markets?vs_currency=jpy&ids=bitcoin&order=market_cap_desc&price_change_percentage=24h"
      );
      expect(new Date(withKey.fetchedAt).toISOString()).toBe(withKey.fetchedAt);
      const firstHeaders = fetchMock.mock.calls[0]![1]!.headers as Record<string, string>;
      expect(firstHeaders["x-cg-demo-api-key"]).toBe("demo-key");

      // 引数省略時は型付きアクセサ (coinGeckoEnv.DEMO_API_KEY) を読む。空文字は未設定扱い。
      vi.stubEnv("COINGECKO_DEMO_API_KEY", "");
      await fetchCoinGeckoGlobal();
      const secondHeaders = fetchMock.mock.calls[1]![1]!.headers as Record<string, string>;
      expect("x-cg-demo-api-key" in secondHeaders).toBe(false);
    });
  });
});

describe.skipIf(!HAS_FIXTURES)("欠損を 0 で返す CoinGecko の挙動を実在値として通さない (ルール2)", () => {
  it("実フィクスチャ自体に『値が無い通貨建てが 0.0』の実例がある (/global の total_market_cap.eth 等)", () => {
    const g = JSON.parse(GLOBAL_RAW()) as { data: { total_market_cap: Record<string, number> } };
    const zeros = Object.entries(g.data.total_market_cap)
      .filter(([, v]) => v === 0)
      .map(([k]) => k);
    expect(zeros).toEqual(["eth", "ltc", "bch", "bnb", "eos", "xrp", "xlm", "link", "dot", "yfi", "sol"]);
  });

  it("total_market_cap.usd が 0 なら throw する", () => {
    const broken = JSON.parse(GLOBAL_RAW()) as { data: { total_market_cap: Record<string, number> } };
    broken.data.total_market_cap.usd = 0;
    expect(() => parseCoinGeckoGlobal(JSON.stringify(broken))).toThrow(/total_market_cap\.usd が正の数ではありません/);
  });

  it("market_cap_percentage.btc が 0〜100% の範囲外なら throw する", () => {
    const broken = JSON.parse(GLOBAL_RAW()) as { data: { market_cap_percentage: Record<string, number> } };
    broken.data.market_cap_percentage.btc = 5828.026279528517;
    expect(() => parseCoinGeckoGlobal(JSON.stringify(broken))).toThrow(/market_cap_percentage\.btc が 100% を超えています/);
  });

  it("/coins/markets の market_cap が 0 (流通量未確認の銘柄) なら throw する", () => {
    const broken = JSON.parse(MARKETS_RAW()) as Array<Record<string, unknown>>;
    broken[2]!.market_cap = 0;
    expect(() => parseCoinGeckoCoinMarkets(JSON.stringify(broken))).toThrow(/\[2\]\.market_cap が正の数ではありません/);
  });

  it("stablecoins カテゴリの market_cap が 0 なら throw する", () => {
    const broken = JSON.parse(CATEGORIES_RAW()) as Array<Record<string, unknown>>;
    broken.find((c) => c.id === "stablecoins")!.market_cap = 0;
    expect(() => parseCoinGeckoStablecoinCategory(JSON.stringify(broken))).toThrow(/stablecoins\.market_cap が正の数ではありません/);
  });
});

describe.skipIf(!HAS_FIXTURES)("/coins/markets の余計な行・重複行の検知", () => {
  it("要求していない coin id が混ざれば throw する", () => {
    const rows = JSON.parse(MARKETS_RAW()) as Array<{ id: string }>;
    expect(() => parseCoinGeckoCoinMarkets(JSON.stringify(rows), ["bitcoin", "ethereum", "ripple", "solana"])).toThrow(
      /unexpected=dogecoin/
    );
  });

  it("同じ coin id の行が重複していれば throw する (観測ログの冪等キー衝突を防ぐ)", () => {
    const rows = JSON.parse(MARKETS_RAW()) as Array<{ id: string }>;
    const dup = [...rows, rows.find((r) => r.id === "ethereum")!];
    expect(() => parseCoinGeckoCoinMarkets(JSON.stringify(dup))).toThrow(/duplicated=ethereum/);
  });
});

describe.skipIf(!HAS_FIXTURES)("toCoinGeckoObservationRows: 表示名未登録の銘柄を id から組み立てて埋めない", () => {
  it("追跡銘柄以外の coin が渡されたら『cardano(ADA)』のような区分を作らず throw する", () => {
    const global = parseCoinGeckoGlobal(GLOBAL_RAW());
    const stablecoins = parseCoinGeckoStablecoinCategory(CATEGORIES_RAW());
    const coins = parseCoinGeckoCoinMarkets(MARKETS_RAW());
    const notTracked = { ...coins[0]!, id: "cardano", symbol: "ada", name: "Cardano" };
    const period = resolveObservationPeriod("day", new Date("2026-09-27T00:00:00Z"));
    expect(() => toCoinGeckoObservationRows({ global, coins: [...coins, notTracked], stablecoins }, period)).toThrow(
      /coin id "cardano" は追跡銘柄/
    );
  });
});

describe("指標定義の財務的な正確さ (実フィクスチャで裏付け)", () => {
  it("時価総額の定義文は『流通量×価格』で『発行量×価格』と書かない", () => {
    const marketCapDef = COINGECKO_GLOBAL_INDICATORS.find((i) => i.key === "coingecko_market_cap_jpy")!;
    expect(marketCapDef.description).toMatch(/流通量/);
    for (const indicator of COINGECKO_GLOBAL_INDICATORS) {
      expect(indicator.description).not.toMatch(/発行量×価格/);
    }
  });

  describe.skipIf(!HAS_FIXTURES)("実フィクスチャ (private)", () => {
    it("時価総額は『流通量×価格』であり『発行量(総量)×価格』ではない — XRP の実値で確認", () => {
      const rows = JSON.parse(MARKETS_RAW()) as Array<{
        id: string;
        current_price: number;
        market_cap: number;
        circulating_supply: number;
        total_supply: number;
      }>;
      const xrp = rows.find((r) => r.id === "ripple")!;
      // 原本: price 240.11 / circulating 62,879,209,849 / total 99,985,622,230 / market_cap 15,095,658,844,409
      const byCirculating = xrp.current_price * xrp.circulating_supply;
      const byTotal = xrp.current_price * xrp.total_supply;
      expect(Math.abs(byCirculating - xrp.market_cap) / xrp.market_cap).toBeLessThan(0.001);
      expect(byTotal / xrp.market_cap).toBeGreaterThan(1.5);

      const marketCapDef = COINGECKO_GLOBAL_INDICATORS.find((i) => i.key === "coingecko_market_cap_jpy")!;
      expect(marketCapDef.description).toMatch(/流通量/);
      for (const indicator of COINGECKO_GLOBAL_INDICATORS) {
        expect(indicator.description).not.toMatch(/発行量×価格/);
      }
    });
  });
});

describe.skipIf(!HAS_FIXTURES)("coinGeckoArchiveInput: ファイルごとの取得時刻を来歴に残す", () => {
  it("metadata.fetchedAtByFile に 3 ファイルそれぞれの取得時刻を持つ", () => {
    const input = coinGeckoArchiveInput({
      global: { url: "https://api.coingecko.com/api/v3/global", raw: GLOBAL_RAW(), fetchedAt: "2026-09-27T02:30:00.000Z" },
      coinMarkets: { url: "u2", raw: MARKETS_RAW(), fetchedAt: "2026-09-27T02:30:01.000Z" },
      stablecoinCategory: { url: "u3", raw: CATEGORIES_RAW(), fetchedAt: "2026-09-27T02:30:02.000Z" },
    });
    expect(input.metadata.fetchedAtByFile).toEqual({
      global: "2026-09-27T02:30:00.000Z",
      coinMarkets: "2026-09-27T02:30:01.000Z",
      stablecoinCategory: "2026-09-27T02:30:02.000Z",
    });
  });
});

describe.skipIf(!HAS_FIXTURES)("toCoinGeckoObservationRows: スナップショットに別期間のラベルを付けない (過去値の捏造防止)", () => {
  // skip された describe でも factory は実行されるため、読込は beforeAll で行う
  let global: ReturnType<typeof parseCoinGeckoGlobal>;
  let coins: ReturnType<typeof parseCoinGeckoCoinMarkets>;
  let stablecoins: ReturnType<typeof parseCoinGeckoStablecoinCategory>;
  beforeAll(() => {
    global = parseCoinGeckoGlobal(GLOBAL_RAW());
    coins = parseCoinGeckoCoinMarkets(MARKETS_RAW());
    stablecoins = parseCoinGeckoStablecoinCategory(CATEGORIES_RAW());
  });

  it("2026-09-27 取得のスナップショットを過去日 (2026-09-20) のラベルで書こうとすると throw する", () => {
    const period = resolveObservationPeriod("day", new Date("2026-09-20T00:00:00Z"));
    // isPeriodObservable は過去日を observable=true と返す (公表ラグ判定としては正しい) ため、
    // ラベルとスナップショット時刻の整合はここで担保する。
    expect(isPeriodObservable(period, new Date("2026-09-27T03:00:00Z")).observable).toBe(true);
    expect(() => toCoinGeckoObservationRows({ global, coins, stablecoins }, period)).toThrow(
      /global\.asOf=2026-09-27T02:19:54\.000Z .*期間 2026-09-20 .*の外/
    );
  });

  it("別の月 (2026-08) のラベルで書こうとすると throw する", () => {
    const period = resolveObservationPeriod("month", new Date("2026-08-15T00:00:00Z"));
    expect(() => toCoinGeckoObservationRows({ global, coins, stablecoins }, period)).toThrow(/期間 2026-08/);
  });

  it("UTC 0 時をまたいで 1 ファイルだけ前日の時刻なら throw する (どちらの日の値とも言えない)", () => {
    const period = resolveObservationPeriod("day", new Date("2026-09-27T00:00:00Z"));
    const staleGlobal = { ...global, asOf: "2026-09-26T23:58:00.000Z" };
    expect(() => toCoinGeckoObservationRows({ global: staleGlobal, coins, stablecoins }, period)).toThrow(
      /global\.asOf=2026-09-26T23:58:00\.000Z/
    );
  });

  it("銘柄の last_updated が日時として解釈できなければ throw する", () => {
    const period = resolveObservationPeriod("day", new Date("2026-09-27T00:00:00Z"));
    const broken = coins.map((c, i) => (i === 0 ? { ...c, lastUpdated: "not-a-date" } : c));
    expect(() => toCoinGeckoObservationRows({ global, coins: broken, stablecoins }, period)).toThrow(
      /coins\[bitcoin\]\.lastUpdated が日時として解釈できません/
    );
  });

  it("スナップショット時刻を含む期間 (同日・同月) なら 13 行を返す", () => {
    const day = resolveObservationPeriod("day", new Date("2026-09-27T00:00:00Z"));
    const month = resolveObservationPeriod("month", new Date("2026-09-27T00:00:00Z"));
    expect(toCoinGeckoObservationRows({ global, coins, stablecoins }, day)).toHaveLength(13);
    expect(toCoinGeckoObservationRows({ global, coins, stablecoins }, month)).toHaveLength(13);
  });
});

describe.skipIf(!HAS_FIXTURES)("parseCoinGeckoStablecoinCategory: 候補が複数なら先頭を黙って採らない", () => {
  it('id="stablecoins" が 2 件あれば throw する', () => {
    const cats = JSON.parse(CATEGORIES_RAW()) as Array<{ id: string; market_cap: number }>;
    const stable = cats.find((c) => c.id === "stablecoins")!;
    const dup = [{ ...stable, market_cap: 1 }, ...cats];
    expect(() => parseCoinGeckoStablecoinCategory(JSON.stringify(dup))).toThrow(/stablecoins" のカテゴリが 2 件/);
  });
});
