/**
 * CoinGecko 暗号資産スナップショット・アダプタ (`./coingecko-global.ts`) のテスト。
 *
 * - 実ファイル (2026-09-27 02:19〜02:25 UTC に CoinGecko API v3 から curl で取得した応答 JSON。
 *   `/coins/categories` は 769 件の応答から stablecoins・usd-stablecoin・jpy-stablecoin・
 *   smart-contract-platform・layer-1 の 5 件だけを抜き出した部分集合) は
 *   `../sources/fixtures/private/coingecko-global/` にあり commit しない (CoinGecko の利用条件が
 *   要確認のため)。無い環境 (CI) では `describe.skipIf` で skip する。値の期待値は Python (json) で
 *   同じファイルから独立に読んだもの (検証証跡 verified_values の bitcoin 価格・時価総額、
 *   ethereum 時価総額、全体時価総額、ステーブルコイン時価総額、BTC ドミナンスとも一致)。
 * - CI でも走る部分は、CoinGecko の応答の形を真似た **合成テストデータ** (実データではない。
 *   価格・時価総額は 10,000,000 円・200兆円のような切りのいい作り物) で対応付けの規則を確かめる。
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isMoneyflowCategoryKind,
  isMoneyflowFlowType,
  isMoneyflowFrequency,
  isMoneyflowLicense,
  isMoneyflowMeasureKind,
  isMoneyflowRequirement,
  isMoneyflowUnit,
} from "../../../../src/shared/notion-archive/index.js";
import { validateDrafts, type ObservationDraft, type SpecFile } from "../source-spec.js";
import {
  COINGECKO_GLOBAL_INDICATORS,
  COINGECKO_MAJOR_COIN_IDS,
  resolveObservationPeriod,
} from "../sources/coingecko-global.js";
import {
  COINGECKO_COIN_CATEGORY,
  COINGECKO_GLOBAL_ADAPTER_INDICATORS,
  COINGECKO_GLOBAL_SPEC_NAME,
  COINGECKO_SNAPSHOT_TOLERANCE_MS,
  coinGeckoGlobalBatchKey,
  coinGeckoGlobalFilenames,
  coingeckoGlobalSpec,
} from "./coingecko-global.js";

const ROW_BUDGET = 600;
const API = "https://api.coingecko.com/api/v3";
const EXPECTED_URLS = [
  `${API}/global`,
  `${API}/coins/markets?vs_currency=jpy&ids=bitcoin,ethereum,ripple,solana,dogecoin&order=market_cap_desc&price_change_percentage=24h`,
  `${API}/coins/categories?order=market_cap_desc`,
];

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function row(drafts: readonly ObservationDraft[], indicatorKey: string, category: string): ObservationDraft {
  const hits = drafts.filter((d) => d.indicatorKey === indicatorKey && d.category === category);
  if (hits.length !== 1) throw new Error(`テスト: ${indicatorKey} / ${category} の行が ${hits.length} 件`);
  return hits[0] as ObservationDraft;
}

const JAPANESE_RE = /[ぁ-んァ-ヶ一-龠]/;

// ---------------------------------------------------------------------------
// 合成テストデータ (実データではない)
// ---------------------------------------------------------------------------

/** 合成テストデータの日付 (UTC)。 */
const SYN_DATE = "2026-10-05";
const SYN_KEY = `coingecko-global-${SYN_DATE}`;
/** 合成テストデータの CoinGecko 側の更新時刻 (UTC 08:29)。 */
const SYN_T = Date.UTC(2026, 9, 5, 8, 29, 0);

interface SynCoin {
  symbol: string;
  name: string;
  price: number;
  marketCap: number;
}

/** 合成テストデータの銘柄 (値は作り物)。cardano は「追跡していない銘柄が混ざった」ケース用。 */
const SYN_COINS: Readonly<Record<string, SynCoin>> = {
  bitcoin: { symbol: "btc", name: "Bitcoin", price: 10_000_000, marketCap: 200_000_000_000_000 },
  ethereum: { symbol: "eth", name: "Ethereum", price: 400_000, marketCap: 50_000_000_000_000 },
  ripple: { symbol: "xrp", name: "XRP", price: 200, marketCap: 12_000_000_000_000 },
  solana: { symbol: "sol", name: "Solana", price: 20_000, marketCap: 10_000_000_000_000 },
  dogecoin: { symbol: "doge", name: "Dogecoin", price: 20, marketCap: 3_000_000_000_000 },
  cardano: { symbol: "ada", name: "Cardano", price: 100, marketCap: 3_500_000_000_000 },
};

interface SynOptions {
  globalUpdatedAtMs: number;
  coinsUpdatedAtMs: number;
  categoriesUpdatedAtMs: number;
  /** 応答に入れる銘柄の順 (API は時価総額順だが、ここではわざと崩す)。 */
  coinIds: readonly string[];
  /** この銘柄の market_cap を 0 にする (CoinGecko が欠損を 0 で返すケース)。null なら全銘柄に値を入れる。 */
  zeroMarketCapFor: string | null;
  btcDominancePct: number;
}

const SYN_BASE: SynOptions = {
  globalUpdatedAtMs: SYN_T,
  coinsUpdatedAtMs: SYN_T + 20_000,
  categoriesUpdatedAtMs: SYN_T - 15 * 60_000,
  coinIds: ["solana", "bitcoin", "dogecoin", "ethereum", "ripple"],
  zeroMarketCapFor: null,
  btcDominancePct: 61.5,
};

function synGlobalJson(o: SynOptions): string {
  return JSON.stringify({
    data: {
      active_cryptocurrencies: 1000,
      markets: 100,
      total_market_cap: { usd: 1_000_000_000_000, jpy: 150_000_000_000_000 },
      total_volume: { usd: 50_000_000_000 },
      market_cap_percentage: { btc: o.btcDominancePct, eth: 12.5 },
      market_cap_change_percentage_24h_usd: -1.5,
      updated_at: Math.floor(o.globalUpdatedAtMs / 1000),
    },
  });
}

function synCoinsJson(o: SynOptions): string {
  return JSON.stringify(
    o.coinIds.map((id, i) => {
      const c = SYN_COINS[id];
      if (c === undefined) throw new Error(`テスト: 合成テストデータに無い銘柄 ${id}`);
      return {
        id,
        symbol: c.symbol,
        name: c.name,
        current_price: c.price,
        market_cap: o.zeroMarketCapFor === id ? 0 : c.marketCap,
        market_cap_rank: i + 1,
        price_change_percentage_24h: 0.5,
        last_updated: new Date(o.coinsUpdatedAtMs).toISOString(),
      };
    })
  );
}

function synCategoriesJson(o: SynOptions): string {
  return JSON.stringify([
    { id: "layer-1", name: "Layer 1 (L1)", market_cap: 800_000_000_000, updated_at: new Date(o.categoriesUpdatedAtMs).toISOString() },
    { id: "stablecoins", name: "Stablecoins", market_cap: 250_000_000_000, updated_at: new Date(o.categoriesUpdatedAtMs).toISOString() },
  ]);
}

function synFiles(date: string, overrides: Partial<SynOptions> = {}): SpecFile[] {
  const o: SynOptions = { ...SYN_BASE, ...overrides };
  const enc = new TextEncoder();
  const names = coinGeckoGlobalFilenames(date);
  return [
    { filename: names.global, bytes: enc.encode(synGlobalJson(o)) },
    { filename: names.coinMarkets, bytes: enc.encode(synCoinsJson(o)) },
    { filename: names.stablecoinCategory, bytes: enc.encode(synCategoriesJson(o)) },
  ];
}

interface Bodies {
  global: string;
  coins: string;
  categories: string;
}

/** CoinGecko API の 3 つの URL にだけ応答する fetch スタブ (それ以外の URL は 404)。 */
function stubCoinGeckoFetch(bodies: Bodies, status = 200) {
  const spy = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const init = { status, statusText: status === 200 ? "OK" : "Too Many Requests" };
    if (url === EXPECTED_URLS[0]) return new Response(bodies.global, init);
    if (url === EXPECTED_URLS[1]) return new Response(bodies.coins, init);
    if (url === EXPECTED_URLS[2]) return new Response(bodies.categories, init);
    return new Response("not found", { status: 404, statusText: "Not Found" });
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

function synBodies(): Bodies {
  return { global: synGlobalJson(SYN_BASE), coins: synCoinsJson(SYN_BASE), categories: synCategoriesJson(SYN_BASE) };
}

// ---------------------------------------------------------------------------
// 指標定義
// ---------------------------------------------------------------------------

describe("指標定義 (IndicatorDefInput)", () => {
  it("モジュールの 5 指標をすべて持ち、キーが一意で、列挙値の型ガードを通る", () => {
    const keys = COINGECKO_GLOBAL_ADAPTER_INDICATORS.map((d) => d.key);
    expect(keys).toEqual(COINGECKO_GLOBAL_INDICATORS.map((d) => d.key));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toHaveLength(5);
    for (const d of COINGECKO_GLOBAL_ADAPTER_INDICATORS) {
      expect(isMoneyflowFlowType(d.flowType), d.key).toBe(true);
      expect(isMoneyflowFrequency(d.frequency), d.key).toBe(true);
      expect(isMoneyflowLicense(d.license), d.key).toBe(true);
      expect(isMoneyflowRequirement(d.requirement), d.key).toBe(true);
      expect(d.requirement).toBe("R3");
      expect(d.frequency).toBe("日次");
      // 無料プランの商用可否・保存条項が未確認のため attribution-required に丸めない。
      expect(d.license).toBe("要確認");
      expect(d.sourceUrl).toMatch(/^https:\/\//);
      expect(d.displayName.trim()).not.toBe("");
      expect(d.description).toMatch(JAPANESE_RE);
      expect(d.limitations).toMatch(JAPANESE_RE);
      // 画面に出すときの表示義務を限界欄に残す。
      expect(d.limitations).toContain("Powered by CoinGecko");
      // 1 日 1 回のスナップショットであること (終値ではない) を必ず書く。
      expect(d.limitations).toContain("スナップショット");
    }
  });

  it("flowType はモジュールの分類を Notion の列挙値へ写し、ドミナンスはシェアにする", () => {
    const flow = Object.fromEntries(COINGECKO_GLOBAL_ADAPTER_INDICATORS.map((d) => [d.key, d.flowType]));
    expect(flow).toEqual({
      coingecko_price_jpy: "価格",
      coingecko_market_cap_jpy: "残高",
      coingecko_global_market_cap_usd: "残高",
      coingecko_stablecoin_market_cap_usd: "残高",
      coingecko_btc_dominance_pct: "シェア",
    });
  });

  it("説明はフロー/ストックの区別と記録する単位を書く", () => {
    for (const d of COINGECKO_GLOBAL_ADAPTER_INDICATORS) {
      expect(d.description, d.key).toMatch(/ストック/);
      expect(d.description, d.key).toMatch(/観測ログ/);
    }
    const byKey = new Map(COINGECKO_GLOBAL_ADAPTER_INDICATORS.map((d) => [d.key, d]));
    expect(byKey.get("coingecko_btc_dominance_pct")?.description).toContain("比率");
    expect(byKey.get("coingecko_global_market_cap_usd")?.description).toContain("米ドル");
    // 時価総額は発行総量ではなく流通量×価格 (XRP の実値で確認した定義)。
    expect(byKey.get("coingecko_market_cap_jpy")?.description).toContain("流通量");
  });

  it("区分名の表はモジュールの追跡銘柄と過不足なく一致する", () => {
    expect(Object.keys(COINGECKO_COIN_CATEGORY).sort()).toEqual([...COINGECKO_MAJOR_COIN_IDS].sort());
  });
});

// ---------------------------------------------------------------------------
// キー・期間・ファイル名
// ---------------------------------------------------------------------------

describe("キー・期間・ファイル名", () => {
  it("キーは UTC の日付で coingecko-global-YYYY-MM-DD", () => {
    const period = resolveObservationPeriod("day", new Date("2026-09-27T08:30:00.000Z"));
    expect(coinGeckoGlobalBatchKey(period)).toBe("coingecko-global-2026-09-27");
    expect(coingeckoGlobalSpec.name).toBe(COINGECKO_GLOBAL_SPEC_NAME);
    expect(COINGECKO_GLOBAL_SPEC_NAME).toBe("coingecko-global");
  });

  it("日次ではない期間からはキーを作らない", () => {
    const week = resolveObservationPeriod("week", new Date("2026-09-27T08:30:00.000Z"));
    expect(() => coinGeckoGlobalBatchKey(week)).toThrow(/日次ではない/);
  });

  it("resolve は取得元へ通信せず、now の UTC の日付でキーを決める", async () => {
    const spy = stubCoinGeckoFetch(synBodies());
    // 2026-09-28 08:59 JST = 2026-09-27 23:59 UTC → UTC の日付は 27 日。
    const late = await coingeckoGlobalSpec.resolve(new Date("2026-09-27T23:59:00.000Z"));
    expect(late.key).toBe("coingecko-global-2026-09-27");
    const next = await coingeckoGlobalSpec.resolve(new Date("2026-09-28T00:00:00.000Z"));
    expect(next.key).toBe("coingecko-global-2026-09-28");
    expect(spy).not.toHaveBeenCalled();
  });

  it("ファイル名はキーの日付だけから決まる", () => {
    expect(coinGeckoGlobalFilenames("2026-09-27")).toEqual({
      global: "coingecko-global-2026-09-27.json",
      coinMarkets: "coingecko-coins-markets-2026-09-27.json",
      stablecoinCategory: "coingecko-categories-stablecoins-2026-09-27.json",
    });
  });
});

// ---------------------------------------------------------------------------
// toObservations (合成テストデータ)
// ---------------------------------------------------------------------------

describe("toObservations (合成テストデータ)", () => {
  it("13 行を固定の順で作り、検証を通る", () => {
    const drafts = coingeckoGlobalSpec.toObservations({ key: SYN_KEY, files: synFiles(SYN_DATE) });
    validateDrafts(coingeckoGlobalSpec.name, drafts, coingeckoGlobalSpec.indicators);
    expect(drafts).toHaveLength(13);
    const coins = COINGECKO_MAJOR_COIN_IDS.map((id) => COINGECKO_COIN_CATEGORY[id] as string);
    // 応答の銘柄の順 (合成テストデータではわざと崩している) に依らず、追跡銘柄の順 → 全体の 3 指標。
    expect(drafts.map((d) => `${d.indicatorKey}|${d.category}`)).toEqual([
      ...coins.flatMap((c) => [`coingecko_price_jpy|${c}`, `coingecko_market_cap_jpy|${c}`]),
      "coingecko_global_market_cap_usd|暗号資産全体",
      "coingecko_stablecoin_market_cap_usd|ステーブルコイン合計",
      "coingecko_btc_dominance_pct|ビットコイン(BTC)",
    ]);
    // 最後の行 (取込完了の印) は常に BTC ドミナンス。
    expect(drafts[drafts.length - 1]?.indicatorKey).toBe("coingecko_btc_dominance_pct");
  });

  it("単位・区分種別・期間・近似/実測の対応付け", () => {
    const drafts = coingeckoGlobalSpec.toObservations({ key: SYN_KEY, files: synFiles(SYN_DATE) });
    for (const d of drafts) {
      expect(d.period).toBe(SYN_DATE);
      expect(d.periodStart).toBe(SYN_DATE);
      expect(d.periodEnd).toBe(SYN_DATE);
      expect(d.changeFromPrev).toBeNull();
      expect(d.approximate).toBe(true);
      expect(d.measureKind).toBe("実測");
      expect(isMoneyflowUnit(d.unit)).toBe(true);
      expect(isMoneyflowCategoryKind(d.categoryKind)).toBe(true);
      expect(isMoneyflowMeasureKind(d.measureKind)).toBe(true);
    }
    const btcPrice = row(drafts, "coingecko_price_jpy", "ビットコイン(BTC)");
    expect(btcPrice).toMatchObject({ value: 10_000_000, unit: "円", categoryKind: "商品" });
    const dogeCap = row(drafts, "coingecko_market_cap_jpy", "ドージコイン(DOGE)");
    expect(dogeCap).toMatchObject({ value: 3_000_000_000_000, unit: "円", categoryKind: "商品" });
    const total = row(drafts, "coingecko_global_market_cap_usd", "暗号資産全体");
    expect(total).toMatchObject({ value: 1_000_000_000_000, unit: "米ドル", categoryKind: "全体" });
    const stable = row(drafts, "coingecko_stablecoin_market_cap_usd", "ステーブルコイン合計");
    expect(stable).toMatchObject({ value: 250_000_000_000, unit: "米ドル", categoryKind: "資産クラス" });
    // % → 比率 (61.5% → 0.615)。
    const dom = row(drafts, "coingecko_btc_dominance_pct", "ビットコイン(BTC)");
    expect(dom).toMatchObject({ value: 0.615, unit: "比率", categoryKind: "商品" });
  });

  it("key とファイルのバイト列だけから決まる (同じ入力なら同じ結果)", () => {
    const a = coingeckoGlobalSpec.toObservations({ key: SYN_KEY, files: synFiles(SYN_DATE) });
    const b = coingeckoGlobalSpec.toObservations({ key: SYN_KEY, files: [...synFiles(SYN_DATE)].reverse() });
    expect(b).toEqual(a);
  });

  it("更新時刻がその日 (UTC) の 0 時ちょうど〜23:59 なら当日の行にする", () => {
    const dayStart = Date.UTC(2026, 9, 5, 0, 0, 0);
    const early = synFiles(SYN_DATE, {
      globalUpdatedAtMs: dayStart,
      coinsUpdatedAtMs: dayStart + 30_000,
      categoriesUpdatedAtMs: dayStart + 60_000,
    });
    const earlyDrafts = coingeckoGlobalSpec.toObservations({ key: SYN_KEY, files: early });
    expect(earlyDrafts.every((d) => d.period === SYN_DATE)).toBe(true);
    const late = synFiles(SYN_DATE, {
      globalUpdatedAtMs: dayStart + 86_400_000 - 60_000,
      coinsUpdatedAtMs: dayStart + 86_400_000 - 1_000,
      categoriesUpdatedAtMs: dayStart + 86_400_000 - 20 * 60_000,
    });
    expect(coingeckoGlobalSpec.toObservations({ key: SYN_KEY, files: late })).toHaveLength(13);
  });
});

// ---------------------------------------------------------------------------
// 想定外の入力 (合成テストデータ)
// ---------------------------------------------------------------------------

describe("toObservations は想定外の入力で throw する (合成テストデータ)", () => {
  it("ファイルが足りない", () => {
    const files = synFiles(SYN_DATE).slice(0, 2);
    expect(() => coingeckoGlobalSpec.toObservations({ key: SYN_KEY, files })).toThrow(/該当ファイルが 0 件/);
  });

  it("想定外のファイルが混ざっている / 別の日のファイル", () => {
    const extra = [...synFiles(SYN_DATE), { filename: "other.json", bytes: new Uint8Array([123, 125]) }];
    expect(() => coingeckoGlobalSpec.toObservations({ key: SYN_KEY, files: extra })).toThrow(/想定外のファイル/);
    expect(() =>
      coingeckoGlobalSpec.toObservations({ key: "coingecko-global-2026-10-06", files: synFiles(SYN_DATE) })
    ).toThrow(/想定外のファイル/);
  });

  it("キーの形式違い・実在しない日付", () => {
    expect(() => coingeckoGlobalSpec.toObservations({ key: "coingecko-global-2026-10", files: [] })).toThrow(
      /キーの形式/
    );
    expect(() => coingeckoGlobalSpec.toObservations({ key: "coingecko-global-2026-02-30", files: [] })).toThrow(
      /実在しない日付/
    );
  });

  it("追跡していない銘柄が混ざっている", () => {
    const files = synFiles(SYN_DATE, { coinIds: [...SYN_BASE.coinIds, "cardano"] });
    expect(() => coingeckoGlobalSpec.toObservations({ key: SYN_KEY, files })).toThrow(/cardano/);
  });

  it("追跡銘柄が欠けている", () => {
    const files = synFiles(SYN_DATE, { coinIds: ["bitcoin", "ethereum", "ripple", "solana"] });
    expect(() => coingeckoGlobalSpec.toObservations({ key: SYN_KEY, files })).toThrow(/dogecoin/);
  });

  it("時価総額が 0 (CoinGecko が欠損を 0 で返した) なら記録しない", () => {
    const files = synFiles(SYN_DATE, { zeroMarketCapFor: "ripple" });
    expect(() => coingeckoGlobalSpec.toObservations({ key: SYN_KEY, files })).toThrow(/正の数/);
  });

  it("ドミナンスが 100% を超える (単位の変更等)", () => {
    const files = synFiles(SYN_DATE, { btcDominancePct: 158.3 });
    expect(() => coingeckoGlobalSpec.toObservations({ key: SYN_KEY, files })).toThrow(/100/);
  });

  it("更新時刻がキーの日付 (UTC) の外 (古い値を今日の値にしない)", () => {
    const twoDaysAgo = SYN_T - 2 * 86_400_000;
    const files = synFiles(SYN_DATE, {
      globalUpdatedAtMs: twoDaysAgo,
      coinsUpdatedAtMs: twoDaysAgo,
      categoriesUpdatedAtMs: twoDaysAgo,
    });
    expect(() => coingeckoGlobalSpec.toObservations({ key: SYN_KEY, files })).toThrow(/の外です/);
  });

  it("UTC 0 時直後で 1 つでも前日の更新時刻が混ざる / 翌日 0 時ちょうど (前日・翌日の値を当日の行にしない)", () => {
    // 回帰: 以前は「前後 1 時間」まで当日扱いにしており、前日 23:40 の集計値を当日の行にしていた
    // (取得元モジュールの最新版も期間外の更新時刻を拒むので、アダプタの検査もその日の中に揃える)。
    const dayStart = Date.UTC(2026, 9, 5, 0, 0, 0);
    const files = synFiles(SYN_DATE, {
      globalUpdatedAtMs: dayStart + 60_000,
      coinsUpdatedAtMs: dayStart + 90_000,
      categoriesUpdatedAtMs: dayStart - 20 * 60_000,
    });
    expect(() => coingeckoGlobalSpec.toObservations({ key: SYN_KEY, files })).toThrow(
      /stablecoins の updated_at \(2026-10-04T23:40:00\.000Z\) が 2026-10-05 \(UTC の 0 時〜24 時\) の外です/
    );
    const next = synFiles(SYN_DATE, {
      globalUpdatedAtMs: dayStart + 86_400_000,
      coinsUpdatedAtMs: dayStart + 86_399_000,
      categoriesUpdatedAtMs: dayStart + 86_000_000,
    });
    expect(() => coingeckoGlobalSpec.toObservations({ key: SYN_KEY, files: next })).toThrow(/の外です/);
  });

  it("3 つの応答の更新時刻が 1 時間より大きくずれている", () => {
    const files = synFiles(SYN_DATE, { categoriesUpdatedAtMs: SYN_T - COINGECKO_SNAPSHOT_TOLERANCE_MS - 60_000 });
    expect(() => coingeckoGlobalSpec.toObservations({ key: SYN_KEY, files })).toThrow(/ずれています/);
  });

  it("UTF-8 として読めないファイル", () => {
    const files = synFiles(SYN_DATE);
    const broken = files.map((f, i) => (i === 0 ? { filename: f.filename, bytes: new Uint8Array([0xff, 0xfe, 0x00]) } : f));
    expect(() => coingeckoGlobalSpec.toObservations({ key: SYN_KEY, files: broken })).toThrow(/UTF-8/);
  });
});

// ---------------------------------------------------------------------------
// resolve() / fetch() (合成テストデータを返す fetch スタブ)
// ---------------------------------------------------------------------------

describe("resolve() / fetch() (合成テストデータを返す fetch スタブ)", () => {
  it("3 つの API を順に取り、同じキー・固定のファイル名で返し、そのまま解析できる", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(SYN_T + 60_000));
    const spy = stubCoinGeckoFetch(synBodies());
    const resolved = await coingeckoGlobalSpec.resolve(new Date(SYN_T + 30_000));
    expect(resolved.key).toBe(SYN_KEY);
    expect(spy).not.toHaveBeenCalled();
    const batch = await resolved.fetch();
    expect(spy.mock.calls.map((c) => c[0])).toEqual(EXPECTED_URLS);
    expect(batch.key).toBe(SYN_KEY);
    const names = coinGeckoGlobalFilenames(SYN_DATE);
    expect(batch.files.map((f) => f.filename)).toEqual([names.global, names.coinMarkets, names.stablecoinCategory]);
    expect(batch.files.every((f) => f.contentType === "application/json")).toBe(true);
    expect(new TextDecoder().decode(batch.files[1]?.bytes)).toBe(synCoinsJson(SYN_BASE));
    for (const url of EXPECTED_URLS) expect(batch.source).toContain(url);
    expect(batch.metadata).toMatchObject({
      snapshotDateUtc: SYN_DATE,
      snapshotTimesCheckedBeforeArchive: true,
      coinIds: [...COINGECKO_MAJOR_COIN_IDS],
    });
    const drafts = coingeckoGlobalSpec.toObservations({ key: batch.key, files: batch.files });
    validateDrafts(coingeckoGlobalSpec.name, drafts, coingeckoGlobalSpec.indicators);
    expect(drafts).toHaveLength(13);
  });

  it("取得中に UTC の日付が変わったら保管せずに中止する", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-06T00:00:02.000Z"));
    stubCoinGeckoFetch(synBodies());
    const resolved = await coingeckoGlobalSpec.resolve(new Date("2026-10-05T23:59:59.000Z"));
    expect(resolved.key).toBe(SYN_KEY);
    await expect(resolved.fetch()).rejects.toThrow(/UTC の日付が変わった/);
  });

  it("UTC 0 時直後に前日の更新時刻が返ったら、保管する前に (fetch の中で) 中止する", async () => {
    // 回帰: 以前は fetch がそのまま返し、run-spec が保管してから解析で throw していた。保管済みの
    // キーは保管ファイルの再解析しかしないので、その日は何度再実行しても失敗し続けていた。
    const dayStart = Date.UTC(2026, 9, 5, 0, 0, 0);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(dayStart + 3 * 60_000));
    const o: SynOptions = {
      ...SYN_BASE,
      globalUpdatedAtMs: dayStart + 60_000,
      coinsUpdatedAtMs: dayStart + 90_000,
      categoriesUpdatedAtMs: dayStart - 18 * 60_000,
    };
    stubCoinGeckoFetch({ global: synGlobalJson(o), coins: synCoinsJson(o), categories: synCategoriesJson(o) });
    const resolved = await coingeckoGlobalSpec.resolve(new Date(dayStart + 2 * 60_000));
    expect(resolved.key).toBe(SYN_KEY);
    await expect(resolved.fetch()).rejects.toThrow(/の外です/);
  });

  it("解析できない応答 (様式変更) は保管へ進める (一次データを残し、解析で throw させる)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(SYN_T + 60_000));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    stubCoinGeckoFetch({ ...synBodies(), global: JSON.stringify({ data: { renamed: true } }) });
    const resolved = await coingeckoGlobalSpec.resolve(new Date(SYN_T + 30_000));
    const batch = await resolved.fetch();
    expect(batch.files).toHaveLength(3);
    expect(batch.metadata).toMatchObject({ snapshotTimesCheckedBeforeArchive: false });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(() => coingeckoGlobalSpec.toObservations({ key: batch.key, files: batch.files })).toThrow(/total_market_cap/);
    warn.mockRestore();
  });

  it("HTTP エラー (429) は throw する", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(SYN_T + 60_000));
    stubCoinGeckoFetch(synBodies(), 429);
    const resolved = await coingeckoGlobalSpec.resolve(new Date(SYN_T + 30_000));
    await expect(resolved.fetch()).rejects.toThrow(/429/);
  });
});

// ---------------------------------------------------------------------------
// 実ファイル (2026-09-27 取得)
// ---------------------------------------------------------------------------

const FIXTURE_DIR = fileURLToPath(new URL("../sources/fixtures/private/coingecko-global/", import.meta.url));
const FIXTURE = {
  global: `${FIXTURE_DIR}global-2026-09-27.json`,
  coins: `${FIXTURE_DIR}coins-markets-jpy-2026-09-27.json`,
  categories: `${FIXTURE_DIR}categories-stablecoins-2026-09-27.json`,
};
const hasFixtures = Object.values(FIXTURE).every((p) => existsSync(p));
const FIXTURE_DATE = "2026-09-27";
const FIXTURE_KEY = `coingecko-global-${FIXTURE_DATE}`;

function fixtureFiles(): SpecFile[] {
  const names = coinGeckoGlobalFilenames(FIXTURE_DATE);
  return [
    { filename: names.global, bytes: new Uint8Array(readFileSync(FIXTURE.global)) },
    { filename: names.coinMarkets, bytes: new Uint8Array(readFileSync(FIXTURE.coins)) },
    { filename: names.stablecoinCategory, bytes: new Uint8Array(readFileSync(FIXTURE.categories)) },
  ];
}

describe.skipIf(!hasFixtures)("toObservations (実ファイル: CoinGecko API 2026-09-27 取得)", () => {
  it("検証を通り、行数が予算内", () => {
    const drafts = coingeckoGlobalSpec.toObservations({ key: FIXTURE_KEY, files: fixtureFiles() });
    validateDrafts(coingeckoGlobalSpec.name, drafts, coingeckoGlobalSpec.indicators);
    expect(drafts).toHaveLength(13);
    expect(drafts.length).toBeLessThanOrEqual(ROW_BUDGET);
    expect(drafts[drafts.length - 1]?.indicatorKey).toBe("coingecko_btc_dominance_pct");
    expect(drafts.every((d) => d.period === FIXTURE_DATE && d.periodStart === FIXTURE_DATE)).toBe(true);
  });

  it("値が Python (json) で独立に読んだ値と一致する (単位の換算を含む)", () => {
    const drafts = coingeckoGlobalSpec.toObservations({ key: FIXTURE_KEY, files: fixtureFiles() });
    // /coins/markets の current_price (円)。
    expect(row(drafts, "coingecko_price_jpy", "ビットコイン(BTC)")).toMatchObject({ value: 13289426, unit: "円" });
    expect(row(drafts, "coingecko_price_jpy", "リップル(XRP)")).toMatchObject({ value: 240.11, unit: "円" });
    // /coins/markets の market_cap (円)。
    expect(row(drafts, "coingecko_market_cap_jpy", "ビットコイン(BTC)").value).toBe(266969122134522);
    expect(row(drafts, "coingecko_market_cap_jpy", "イーサリアム(ETH)").value).toBe(51897511333033);
    expect(row(drafts, "coingecko_market_cap_jpy", "ドージコイン(DOGE)").value).toBe(2372546484538);
    // 残りの銘柄 (Python json で独立に読んだ値。価格が 1 円台〜数万円の小さい桁も含める)。
    expect(row(drafts, "coingecko_price_jpy", "イーサリアム(ETH)").value).toBe(425153);
    expect(row(drafts, "coingecko_price_jpy", "ソラナ(SOL)").value).toBe(19113.84);
    expect(row(drafts, "coingecko_price_jpy", "ドージコイン(DOGE)").value).toBe(15.2);
    expect(row(drafts, "coingecko_market_cap_jpy", "ソラナ(SOL)").value).toBe(11233010370776);
    // XRP の時価総額は流通量 62,879,209,849 × 240.11 ≒ 15.1兆円 (総量ベースの約 24.0兆円ではない)。
    expect(row(drafts, "coingecko_market_cap_jpy", "リップル(XRP)").value).toBe(15095658844409);
    // /global の total_market_cap.usd (米ドル)。
    expect(row(drafts, "coingecko_global_market_cap_usd", "暗号資産全体")).toMatchObject({
      value: 2906523550432.045,
      unit: "米ドル",
    });
    // /coins/categories の stablecoins.market_cap (米ドル)。
    expect(row(drafts, "coingecko_stablecoin_market_cap_usd", "ステーブルコイン合計")).toMatchObject({
      value: 292862711888.5375,
      unit: "米ドル",
    });
    // /global の market_cap_percentage.btc = 58.28026279528517 (%) → 比率 (Python: 58.28026279528517 / 100)。
    expect(row(drafts, "coingecko_btc_dominance_pct", "ビットコイン(BTC)")).toMatchObject({
      value: 0.5828026279528516,
      unit: "比率",
    });
  });
});

describe.skipIf(!hasFixtures)("resolve() / fetch() (実ファイルを返す fetch スタブ)", () => {
  it("取得日のキーで 3 ファイルを返し、そのバイト列から同じ観測行を作れる", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-27T02:25:40.000Z"));
    stubCoinGeckoFetch({
      global: readFileSync(FIXTURE.global, "utf8"),
      coins: readFileSync(FIXTURE.coins, "utf8"),
      categories: readFileSync(FIXTURE.categories, "utf8"),
    });
    const resolved = await coingeckoGlobalSpec.resolve(new Date("2026-09-27T02:19:00.000Z"));
    expect(resolved.key).toBe(FIXTURE_KEY);
    const batch = await resolved.fetch();
    expect(batch.key).toBe(FIXTURE_KEY);
    const names = coinGeckoGlobalFilenames(FIXTURE_DATE);
    expect(batch.files.map((f) => f.filename)).toEqual([names.global, names.coinMarkets, names.stablecoinCategory]);
    // 取得したバイト列は元の応答そのもの (加工しない)。
    expect(Buffer.from(batch.files[0]?.bytes as Uint8Array).equals(readFileSync(FIXTURE.global))).toBe(true);
    const fromFetch = coingeckoGlobalSpec.toObservations({ key: batch.key, files: batch.files });
    const fromFiles = coingeckoGlobalSpec.toObservations({ key: FIXTURE_KEY, files: fixtureFiles() });
    expect(fromFetch).toEqual(fromFiles);
  });
});
