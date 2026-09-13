import { describe, it, expect, vi, beforeEach } from "vitest";
import type { YutaiRawData } from "../../services/yutai-scraper";

/**
 * 優待データスクレイピング・インポートサービスのテスト
 */

import {
  parseYutaiData,
  importYutaiData,
  scrapeAndImport,
} from "../../services/yutai-scraper";
import {
  parseYutaiCSV,
  parseYutaiJSON,
} from "../../services/yutai-data-provider";
import {
  yutaiRawDataSchema,
  yutaiImportResultSchema,
} from "../../validators/yutai-scraper";
import { stocks, yutaiBenefits, yutaiGenres } from "../../db/schema";

// --- テスト用HTML ---
const SAMPLE_HTML = `
<html>
<body>
<table class="yutai-table">
  <thead>
    <tr>
      <th>銘柄コード</th>
      <th>銘柄名</th>
      <th>市場</th>
      <th>優待ジャンル</th>
      <th>優待内容</th>
      <th>最低株数</th>
      <th>権利確定月</th>
      <th>優待価値(円)</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>2702</td>
      <td>日本マクドナルドHD</td>
      <td>東証プライム</td>
      <td>食事券</td>
      <td>バーガー類、サイドメニュー、飲物の無料引換券6枚</td>
      <td>100</td>
      <td>6</td>
      <td>3000</td>
    </tr>
    <tr>
      <td>9861</td>
      <td>吉野家HD</td>
      <td>東証プライム</td>
      <td>食事券</td>
      <td>300円サービス券10枚</td>
      <td>100</td>
      <td>2</td>
      <td>3000</td>
    </tr>
    <tr>
      <td>7412</td>
      <td>アトム</td>
      <td>東証スタンダード</td>
      <td>食事券</td>
      <td>優待カード(2万円相当ポイント)</td>
      <td>100</td>
      <td>3</td>
      <td>20000</td>
    </tr>
  </tbody>
</table>
</body>
</html>
`;

const SAMPLE_HTML_NO_TABLE = `
<html><body><p>優待情報はありません</p></body></html>
`;

const SAMPLE_HTML_PARTIAL = `
<html>
<body>
<table class="yutai-table">
  <thead>
    <tr>
      <th>銘柄コード</th>
      <th>銘柄名</th>
      <th>市場</th>
      <th>優待ジャンル</th>
      <th>優待内容</th>
      <th>最低株数</th>
      <th>権利確定月</th>
      <th>優待価値(円)</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>2702</td>
      <td>日本マクドナルドHD</td>
      <td>東証プライム</td>
      <td>食事券</td>
      <td>バーガー類無料引換券</td>
      <td>100</td>
      <td>6</td>
      <td>3000</td>
    </tr>
    <tr>
      <td></td>
      <td></td>
      <td></td>
      <td></td>
      <td></td>
      <td></td>
      <td></td>
      <td></td>
    </tr>
  </tbody>
</table>
</body>
</html>
`;

// --- テスト用CSV ---
const SAMPLE_CSV = `code,name,market,genre,description,minShares,recordMonth,estimatedValue
2702,日本マクドナルドHD,東証プライム,食事券,バーガー類無料引換券,100,6,3000
9861,吉野家HD,東証プライム,食事券,300円サービス券10枚,100,2,3000
`;

const SAMPLE_CSV_EMPTY = `code,name,market,genre,description,minShares,recordMonth,estimatedValue
`;

// --- テスト用JSON ---
const SAMPLE_JSON = JSON.stringify([
  {
    stockCode: "2702",
    stockName: "日本マクドナルドHD",
    market: "東証プライム",
    genreName: "食事券",
    description: "バーガー類無料引換券",
    minShares: 100,
    recordMonth: 6,
    estimatedValue: 3000,
  },
  {
    stockCode: "9861",
    stockName: "吉野家HD",
    market: "東証プライム",
    genreName: "食事券",
    description: "300円サービス券10枚",
    minShares: 100,
    recordMonth: 2,
    estimatedValue: 3000,
  },
]);

// --- モックDB ---
function createMockDb() {
  // insert → values → onConflictDoUpdate / onConflictDoNothing → returning
  const returning = vi.fn();
  const onConflictDoUpdate = vi.fn().mockReturnValue({ returning });
  const onConflictDoNothing = vi.fn().mockReturnValue({ returning });
  const insertValues = vi.fn().mockReturnValue({
    onConflictDoUpdate,
    onConflictDoNothing,
    returning,
  });
  const insert = vi.fn().mockReturnValue({ values: insertValues });

  // select → from → where
  const selectWhere = vi.fn().mockResolvedValue([]);
  const selectFrom = vi.fn().mockReturnValue({ where: selectWhere });
  const select = vi.fn().mockReturnValue({ from: selectFrom });

  return {
    insert,
    select,
    _insertValues: insertValues,
    _selectWhere: selectWhere,
    _returning: returning,
    _onConflictDoUpdate: onConflictDoUpdate,
    _onConflictDoNothing: onConflictDoNothing,
  };
}

describe("優待データスクレイピングサービス", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================
  // parseYutaiData
  // =========================================================
  describe("parseYutaiData", () => {
    it("HTMLテーブルから優待データを正しくパースすること", () => {
      const result = parseYutaiData(SAMPLE_HTML);

      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({
        stockCode: "2702",
        stockName: "日本マクドナルドHD",
        market: "東証プライム",
        genreName: "食事券",
        description: "バーガー類、サイドメニュー、飲物の無料引換券6枚",
        minShares: 100,
        recordMonth: 6,
        estimatedValue: 3000,
      });
      expect(result[1].stockCode).toBe("9861");
      expect(result[2].stockCode).toBe("7412");
      expect(result[2].estimatedValue).toBe(20000);
    });

    it("テーブルが存在しないHTMLでは空配列を返すこと", () => {
      const result = parseYutaiData(SAMPLE_HTML_NO_TABLE);
      expect(result).toEqual([]);
    });

    it("必須フィールドが空の行はスキップすること", () => {
      const result = parseYutaiData(SAMPLE_HTML_PARTIAL);
      expect(result).toHaveLength(1);
      expect(result[0].stockCode).toBe("2702");
    });

    it("空文字列を渡した場合は空配列を返すこと", () => {
      const result = parseYutaiData("");
      expect(result).toEqual([]);
    });
  });

  // =========================================================
  // importYutaiData
  // =========================================================
  describe("importYutaiData", () => {
    it("銘柄が母集団 (active かつ equity) に無ければ core_stocks に足さずスキップすること", async () => {
      const mockDb = createMockDb();

      // stock select (active かつ equity) → 見つからない
      mockDb._selectWhere.mockResolvedValueOnce([]);

      const data: YutaiRawData[] = [
        {
          stockCode: "2702",
          stockName: "日本マクドナルドHD",
          market: "東証プライム",
          genreName: "食事券",
          description: "バーガー類無料引換券",
          minShares: 100,
          recordMonth: 6,
          estimatedValue: 3000,
        },
      ];

      const result = await importYutaiData(
        mockDb as unknown as Parameters<typeof importYutaiData>[0],
        data,
      );

      expect(result).toEqual({ created: 0, updated: 0, skipped: 1 });
      // 銘柄もジャンルも優待も書かない。引いたのは銘柄の 1 回だけ
      expect(mockDb.insert).not.toHaveBeenCalled();
      expect(mockDb.select).toHaveBeenCalledTimes(1);
    });

    it("新規ジャンルと優待を作成し、銘柄は既存行を引くだけであること", async () => {
      const mockDb = createMockDb();

      // stock select → 既存
      mockDb._selectWhere.mockResolvedValueOnce([{ id: 10 }]);
      // genre select → 見つからない
      mockDb._selectWhere.mockResolvedValueOnce([]);
      // genre insert → 新規作成
      mockDb._returning.mockResolvedValueOnce([{ id: 1 }]);
      // benefit upsert
      mockDb._onConflictDoUpdate.mockReturnValueOnce({
        returning: vi.fn().mockResolvedValueOnce([{ id: 100 }]),
      });

      const data: YutaiRawData[] = [
        {
          stockCode: "2702",
          stockName: "日本マクドナルドHD",
          market: "東証プライム",
          genreName: "食事券",
          description: "バーガー類無料引換券",
          minShares: 100,
          recordMonth: 6,
          estimatedValue: 3000,
        },
      ];

      const result = await importYutaiData(mockDb as any, data);

      expect(result.created).toBe(1);
      expect(result.updated).toBe(0);
      expect(result.skipped).toBe(0);
      // insert はジャンルと優待の 2 回で、core_stocks へは書かない
      expect(mockDb.insert.mock.calls.map(([table]) => table)).toEqual([
        yutaiGenres,
        yutaiBenefits,
      ]);
      expect(mockDb.insert.mock.calls.map(([table]) => table)).not.toContain(stocks);
    });

    it("既存のジャンル・銘柄がある場合はそれを再利用すること", async () => {
      const mockDb = createMockDb();

      // stock select → 既存
      mockDb._selectWhere.mockResolvedValueOnce([{ id: 10 }]);
      // genre select → 既存
      mockDb._selectWhere.mockResolvedValueOnce([{ id: 1, name: "食事券" }]);
      // benefit upsert → 更新
      mockDb._onConflictDoUpdate.mockReturnValueOnce({
        returning: vi.fn().mockResolvedValueOnce([{ id: 100 }]),
      });

      const data: YutaiRawData[] = [
        {
          stockCode: "2702",
          stockName: "日本マクドナルドHD",
          market: "東証プライム",
          genreName: "食事券",
          description: "更新された優待内容",
          minShares: 100,
          recordMonth: 6,
          estimatedValue: 5000,
        },
      ];

      const result = await importYutaiData(mockDb as any, data);

      // ジャンルinsertは呼ばれない（既存を再利用）
      // 2回のselectのみ（stock, genre）
      expect(mockDb.select).toHaveBeenCalledTimes(2);
      expect(result.created + result.updated).toBe(1);
    });

    it("空の配列を渡した場合は何もせず結果を返すこと", async () => {
      const mockDb = createMockDb();

      const result = await importYutaiData(mockDb as any, []);

      expect(result).toEqual({ created: 0, updated: 0, skipped: 0 });
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it("DB操作でエラーが発生した場合は該当データをスキップすること", async () => {
      const mockDb = createMockDb();

      // stock select → エラー
      mockDb._selectWhere.mockRejectedValueOnce(new Error("DB Error"));

      const data: YutaiRawData[] = [
        {
          stockCode: "2702",
          stockName: "日本マクドナルドHD",
          market: "東証プライム",
          genreName: "食事券",
          description: "テスト",
          minShares: 100,
          recordMonth: 6,
          estimatedValue: 3000,
        },
      ];

      const result = await importYutaiData(mockDb as any, data);

      expect(result.skipped).toBe(1);
      expect(result.created).toBe(0);
    });
  });

  // =========================================================
  // scrapeAndImport
  // =========================================================
  describe("scrapeAndImport", () => {
    it("HTMLを取得してパースし、DBにインポートすること", async () => {
      const mockDb = createMockDb();

      // global fetchをモック
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(SAMPLE_HTML),
      }) as any;

      // 3件分のDB操作モック
      for (let i = 0; i < 3; i++) {
        // stock select
        mockDb._selectWhere.mockResolvedValueOnce([{ id: i + 10 }]);
        // genre select
        mockDb._selectWhere.mockResolvedValueOnce([{ id: 1, name: "食事券" }]);
        // benefit upsert
        mockDb._onConflictDoUpdate.mockReturnValueOnce({
          returning: vi.fn().mockResolvedValueOnce([{ id: i + 100 }]),
        });
      }

      try {
        const result = await scrapeAndImport(
          mockDb as any,
          "https://example.com/yutai",
        );

        expect(globalThis.fetch).toHaveBeenCalledWith(
          "https://example.com/yutai",
          expect.objectContaining({
            headers: expect.objectContaining({
              "User-Agent": expect.any(String),
            }),
          }),
        );
        expect(result.created + result.updated + result.skipped).toBe(3);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("フェッチ失敗時にエラーをスローすること", async () => {
      const mockDb = createMockDb();

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi
        .fn()
        .mockRejectedValue(new Error("Network error")) as any;

      try {
        await expect(
          scrapeAndImport(mockDb as any, "https://example.com/yutai"),
        ).rejects.toThrow("Network error");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  // =========================================================
  // parseYutaiCSV
  // =========================================================
  describe("parseYutaiCSV", () => {
    it("CSVを正しくパースすること", () => {
      const result = parseYutaiCSV(SAMPLE_CSV);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        stockCode: "2702",
        stockName: "日本マクドナルドHD",
        market: "東証プライム",
        genreName: "食事券",
        description: "バーガー類無料引換券",
        minShares: 100,
        recordMonth: 6,
        estimatedValue: 3000,
      });
      expect(result[1].stockCode).toBe("9861");
    });

    it("ヘッダーのみのCSVでは空配列を返すこと", () => {
      const result = parseYutaiCSV(SAMPLE_CSV_EMPTY);
      expect(result).toEqual([]);
    });

    it("空文字列を渡した場合は空配列を返すこと", () => {
      const result = parseYutaiCSV("");
      expect(result).toEqual([]);
    });
  });

  // =========================================================
  // parseYutaiJSON
  // =========================================================
  describe("parseYutaiJSON", () => {
    it("JSON配列を正しくパースすること", () => {
      const result = parseYutaiJSON(SAMPLE_JSON);

      expect(result).toHaveLength(2);
      expect(result[0].stockCode).toBe("2702");
      expect(result[1].stockCode).toBe("9861");
    });

    it("不正なJSONでエラーをスローすること", () => {
      expect(() => parseYutaiJSON("not-json")).toThrow();
    });

    it("空配列のJSONでは空配列を返すこと", () => {
      const result = parseYutaiJSON("[]");
      expect(result).toEqual([]);
    });

    it("不正なデータ構造でエラーをスローすること", () => {
      expect(() => parseYutaiJSON('[{"invalid": true}]')).toThrow();
    });
  });

  // =========================================================
  // Zodバリデーションスキーマ
  // =========================================================
  describe("Zodスキーマ", () => {
    it("yutaiRawDataSchemaが有効なデータを受け入れること", () => {
      const validData = {
        stockCode: "2702",
        stockName: "日本マクドナルドHD",
        market: "東証プライム",
        genreName: "食事券",
        description: "バーガー類無料引換券",
        minShares: 100,
        recordMonth: 6,
        estimatedValue: 3000,
      };

      const result = yutaiRawDataSchema.safeParse(validData);
      expect(result.success).toBe(true);
    });

    it("yutaiRawDataSchemaが不正なデータを拒否すること", () => {
      const invalidData = {
        stockCode: "",
        stockName: "テスト",
        market: "東証",
        genreName: "食事券",
        description: "テスト",
        minShares: -1,
        recordMonth: 13,
        estimatedValue: 100,
      };

      const result = yutaiRawDataSchema.safeParse(invalidData);
      expect(result.success).toBe(false);
    });

    it("yutaiImportResultSchemaが有効なインポート結果を受け入れること", () => {
      const result = yutaiImportResultSchema.safeParse({
        created: 10,
        updated: 5,
        skipped: 2,
      });
      expect(result.success).toBe(true);
    });

    it("estimatedValueがnullableであること", () => {
      const data = {
        stockCode: "2702",
        stockName: "テスト",
        market: "東証プライム",
        genreName: "食事券",
        description: "テスト",
        minShares: 100,
        recordMonth: 6,
        estimatedValue: null,
      };

      const result = yutaiRawDataSchema.safeParse(data);
      expect(result.success).toBe(true);
    });
  });
});
