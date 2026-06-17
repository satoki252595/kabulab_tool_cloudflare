import { describe, it, expect } from "vitest";

/**
 * price-cache.ts の hydrate ロジック (PriceContext への正規化) を
 * DB アクセス無しでも検証できるよう、純関数として切り出してテストする。
 *
 * 配当利回り 100倍 バグの再発防止が主目的:
 *   - DB は Yahoo の生値 (% 表現、例: 3.43)
 *   - PriceContext は decimal (例: 0.0343)
 *   - estimatedDividend = price × dividendYield (decimal 前提)
 */

/** price-cache.ts の hydrate の純関数化バージョン (テスト用) */
function normalize(row: {
  price: number | null;
  dividendYield: number | null;
}): {
  dividendYield: number | null;
  estimatedDividend: number | null;
} {
  const rawDy = row.dividendYield;
  const dy =
    rawDy !== null && Number.isFinite(rawDy) ? rawDy / 100 : null;
  const price = row.price;
  const estimatedDividend =
    price !== null && dy !== null && Number.isFinite(price) && Number.isFinite(dy) && dy > 0
      ? price * dy
      : null;
  return { dividendYield: dy, estimatedDividend };
}

describe("PriceContext.dividendYield 正規化 (% → decimal)", () => {
  it("トヨタ 7203: DB は 3.43% → 0.0343 (decimal)", () => {
    const r = normalize({ price: 2870, dividendYield: 3.43 });
    expect(r.dividendYield).toBeCloseTo(0.0343, 6);
  });

  it("estimatedDividend = price × decimal yield", () => {
    // トヨタ: 2870 × 0.0343 = 98.4 円/株 (TTM ベース)
    const r = normalize({ price: 2870, dividendYield: 3.43 });
    expect(r.estimatedDividend).toBeCloseTo(98.44, 1);
  });

  it("三菱商事 8058: 5252 × 2.38% = 125 円", () => {
    const r = normalize({ price: 5252, dividendYield: 2.38 });
    expect(r.estimatedDividend).toBeCloseTo(125, 0);
  });

  it("ファーストリテイリング 9983: 75050 × 0.85% = 638 円", () => {
    const r = normalize({ price: 75050, dividendYield: 0.85 });
    expect(r.estimatedDividend).toBeCloseTo(637.9, 0);
  });

  it("dividendYield=null は null のまま", () => {
    const r = normalize({ price: 1000, dividendYield: null });
    expect(r.dividendYield).toBeNull();
    expect(r.estimatedDividend).toBeNull();
  });

  it("price=null は estimatedDividend=null", () => {
    const r = normalize({ price: null, dividendYield: 3 });
    expect(r.estimatedDividend).toBeNull();
  });

  it("dividendYield=0 (無配銘柄) は estimatedDividend=null", () => {
    const r = normalize({ price: 1000, dividendYield: 0 });
    // dy > 0 のチェックで弾かれる
    expect(r.estimatedDividend).toBeNull();
  });

  it("100倍バグ再発防止: 結果は決して 10,000 円 超 (1株あたり) にならない", () => {
    // 配当利回り 5% × 株価 10,000円 でも estimated = 500 円
    const r = normalize({ price: 10000, dividendYield: 5 });
    expect(r.estimatedDividend).toBeLessThan(1000);
    expect(r.estimatedDividend).toBeCloseTo(500, 0);
  });
});
