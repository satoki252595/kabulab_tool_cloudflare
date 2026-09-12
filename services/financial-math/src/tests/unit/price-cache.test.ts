import { describe, it, expect } from "vitest";
import { normalizeQuote } from "../../services/price-cache.js";

/**
 * `price-cache.ts` の価格正規化 (% → decimal) の検証。
 *
 * 配当利回り 100倍 バグの再発防止が主目的:
 *   - DB (`core_stock_financials.dividend_yield`) は Yahoo の生値 (% 表現、例: 3.43)
 *   - `PriceContext` は decimal (例: 0.0343)
 *   - `estimatedDividend` = price × dividendYield (decimal 前提)
 *
 * ## このファイルは以前 **偽の安全信号**だった
 *
 * 元の版は price-cache から**何も import せず**、`normalize()` をこのファイル内に
 * コピー実装してテストしていた。つまり実装側の `/100` を消しても、
 * 実装を Neon から D1 へ書き換えても、読む表を変えても**無条件に緑**になる。
 * 「100倍バグの再発防止」を名乗りながら、再発を検出できない構造だった。
 * 本物の関数を import することがこのテストの前提条件である。
 */

describe("normalizeQuote — 配当利回りの % → decimal 正規化", () => {
  it("トヨタ 7203: DB は 3.43% → 0.0343 (decimal)", () => {
    const r = normalizeQuote({ price: 2870, dividendYield: 3.43 });
    expect(r.dividendYield).toBeCloseTo(0.0343, 6);
  });

  it("estimatedDividend = price × decimal yield", () => {
    // トヨタ: 2870 × 0.0343 = 98.4 円/株 (TTM ベース)
    const r = normalizeQuote({ price: 2870, dividendYield: 3.43 });
    expect(r.estimatedDividend).toBeCloseTo(98.44, 1);
  });

  it("三菱商事 8058: 5252 × 2.38% = 125 円", () => {
    const r = normalizeQuote({ price: 5252, dividendYield: 2.38 });
    expect(r.estimatedDividend).toBeCloseTo(125, 0);
  });

  it("ファーストリテイリング 9983: 75050 × 0.85% = 638 円", () => {
    const r = normalizeQuote({ price: 75050, dividendYield: 0.85 });
    expect(r.estimatedDividend).toBeCloseTo(637.9, 0);
  });

  it("dividendYield=null は null のまま", () => {
    const r = normalizeQuote({ price: 1000, dividendYield: null });
    expect(r.dividendYield).toBeNull();
    expect(r.estimatedDividend).toBeNull();
  });

  it("price=null は estimatedDividend=null", () => {
    const r = normalizeQuote({ price: null, dividendYield: 3 });
    expect(r.estimatedDividend).toBeNull();
  });

  it("dividendYield=0 (無配銘柄) は estimatedDividend=null", () => {
    const r = normalizeQuote({ price: 1000, dividendYield: 0 });
    // dy > 0 のチェックで弾かれる
    expect(r.estimatedDividend).toBeNull();
  });

  it("100倍バグ再発防止: 結果は決して 10,000 円 超 (1株あたり) にならない", () => {
    // 配当利回り 5% × 株価 10,000円 でも estimated = 500 円
    const r = normalizeQuote({ price: 10000, dividendYield: 5 });
    expect(r.estimatedDividend).toBeLessThan(1000);
    expect(r.estimatedDividend).toBeCloseTo(500, 0);
  });
});

describe("読み取り面から Yahoo 呼び出しが消えたことを形で固定する", () => {
  /**
   * 「GET で D1 に書かない」は price-read-path.test.ts が値で見ているが、
   * **Yahoo を叩かない**ことは値では見られない (テスト環境では fetch が
   * 失敗して catch に落ちるだけで、緑のまま経路は残る)。
   * import の有無という形で禁じる。
   */
  it("financial-math のソースが src/shared/yahoo を import しない", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    // このファイルは services/financial-math/src/tests/unit/ にある
    const serviceSrc = fileURLToPath(new URL("../..", import.meta.url));

    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
          walk(path);
          continue;
        }
        if (!/\.ts$/.test(entry) || /\.test\.ts$/.test(entry)) continue;
        if (/shared\/yahoo/.test(readFileSync(path, "utf-8"))) offenders.push(path);
      }
    };
    walk(serviceSrc);

    expect(
      offenders,
      "読み取り面が Yahoo を叩く経路が復活している" +
        " (SSR の GET が外部 API のレイテンシと 429 を背負い、D1 へ書き始める)"
    ).toEqual([]);
    // 走査が空振りしていないこと (0 件を返すと上の検査が無条件に緑になる)
    expect(readdirSync(join(serviceSrc, "services")).length).toBeGreaterThan(3);
  });
});
