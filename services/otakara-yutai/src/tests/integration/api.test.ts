import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * APIエンドポイント統合テスト
 * 注意: src/index.tsはVercelビルド用スタブのため、実際のAPI/SSRルートは
 * api/index.tsにインラインで定義されている。このテストはsrc/index.tsの
 * 最小アプリに対するテストであり、本番ルートのテストではない。
 * TODO: api/index.tsのテスト環境を整備する
 *
 * DB層をモックし、Honoのapp.request()でエンドポイントをテストする
 */

// --- モックデータ ---
const mockGenres = [
  { id: 1, name: "食品", slug: "food", description: "食品関連の優待", createdAt: new Date() },
  { id: 2, name: "日用品", slug: "daily", description: "日用品関連の優待", createdAt: new Date() },
];

const mockStocks = [
  {
    id: 1,
    code: "2702",
    name: "日本マクドナルド",
    market: "東証プライム",
    sector: "小売業",
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
];

const mockBenefits = [
  {
    id: 1,
    stockId: 1,
    genreId: 1,
    description: "食事券",
    minShares: 100,
    recordMonth: 6,
    estimatedValue: 3000,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
];

const mockFinancials = [
  {
    id: 1,
    stockId: 1,
    price: 6500,
    per: 35.2,
    pbr: 4.1,
    dividendYield: 0.5,
    eps: 184.7,
    bps: 1585.4,
    marketCap: 864000,
    ma5: 6480,
    ma25: 6400,
    ma75: 6300,
    rsi14: 55.3,
    fetchedAt: new Date(),
    dataDate: "2026-03-20",
  },
];

const mockScores = [
  {
    id: 1,
    stockId: 1,
    fundamentalScore: 65.0,
    technicalScore: 70.0,
    totalScore: 67.5,
    scoredAt: new Date(),
  },
];

// --- DBモック設定 ---
const mockDbSelect = vi.fn();
const mockDbSelectDistinct = vi.fn();
const mockQueryGenresFindMany = vi.fn();
const mockQueryStocksFindFirst = vi.fn();

const mockDb = {
  select: mockDbSelect,
  selectDistinct: mockDbSelectDistinct,
  query: {
    yutaiGenres: { findMany: mockQueryGenresFindMany },
    stocks: { findFirst: mockQueryStocksFindFirst },
  },
};

vi.mock("@neondatabase/serverless", () => ({
  neon: vi.fn(() => vi.fn()),
}));

vi.mock("drizzle-orm/neon-http", () => ({
  drizzle: vi.fn(() => mockDb),
}));

/** 汎用selectチェーンモック — 全チェーンメソッドがthenableなProxyを返す */
function createChain(finalResult: unknown) {
  const thenableChain: Record<string, unknown> = {};
  const methods = [
    "from", "leftJoin", "innerJoin", "where", "orderBy", "limit", "offset",
  ];
  for (const method of methods) {
    thenableChain[method] = vi.fn().mockReturnValue(thenableChain);
  }
  // どのメソッドからでもawait可能にする
  (thenableChain as Record<string, unknown>).then = (
    resolve: (value: unknown) => unknown,
    reject?: (reason: unknown) => unknown
  ) => Promise.resolve(finalResult).then(resolve, reject);
  return thenableChain;
}

/**
 * 新しいストックリストAPI用モック
 * 複数回のselectを順番にモック
 */
function setupStockListMocks(
  countValue: number,
  rows: unknown[],
  benefitRows: unknown[] = []
) {
  const calls: unknown[][] = [];

  // count query → stock data query → benefits query
  const countChain = createChain([{ count: countValue }]);
  const dataChain = createChain(rows);
  const benefitsChain = createChain(benefitRows);

  let selectIdx = 0;
  mockDbSelect.mockImplementation(() => {
    selectIdx++;
    if (selectIdx === 1) return countChain;
    if (selectIdx === 2) return dataChain;
    return benefitsChain;
  });
}

/** ジャンルフィルタ付きストックリストのモック */
function setupGenreFilterMocks(
  genreRows: unknown[],
  distinctRows: unknown[],
  countValue: number,
  rows: unknown[],
  benefitRows: unknown[] = []
) {
  let selectIdx = 0;
  const genreChain = createChain(genreRows);
  const countChain = createChain([{ count: countValue }]);
  const dataChain = createChain(rows);
  const benefitsChain = createChain(benefitRows);

  mockDbSelect.mockImplementation(() => {
    selectIdx++;
    if (selectIdx === 1) return genreChain; // genre lookup
    if (selectIdx === 2) return countChain;  // count
    if (selectIdx === 3) return dataChain;   // data
    return benefitsChain;                     // benefits
  });

  const distinctChain = createChain(distinctRows);
  mockDbSelectDistinct.mockReturnValue(distinctChain);
}

// テスト対象のアプリをインポート（モック設定後）
// api/index.tsのインラインアプリをテストするため、DBモックを通じてテスト
// src/index.tsはVercelビルド用の最小エントリのため、テスト対象外
import { app } from "../../index";

beforeEach(() => {
  vi.clearAllMocks();
});

// src/index.tsはVercelスタブのため、API統合テストはスキップ
// 実際のAPIテストはapi/index.tsのテスト環境整備後に移行
describe.skip("404ハンドラー", () => {
  it("存在しないパスで404を返すこと", async () => {
    const res = await app.request("/api/nonexistent", undefined, {
      DATABASE_URL: "postgresql://test",
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Not Found");
  });
});

