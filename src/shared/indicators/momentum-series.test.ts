/**
 * `p_momentum.closes` の符号化が往復で値を変えないことの検証。
 *
 * writer (日次 cron) と reader (/emh) が別プロセスなので、ここが 1 銘柄でも
 * ずれると「保存はできているのに数値が違う」になり、画面には何も出ない。
 * 丸め誤差はランキングを黙って入れ替えるので、近似一致ではなく**完全一致**を見る。
 */
import { describe, expect, it } from "vitest";
import { encodeCloses, decodeCloses } from "./momentum-series.js";

describe("encodeCloses / decodeCloses", () => {
  it("整数・小数を往復で完全に復元する", () => {
    const closes = [100, 2870.5, 75050, 0.5, 1234.56789, 1e6];
    expect(decodeCloses(encodeCloses(closes))).toEqual(closes);
  });

  it("D1 の real が返す 17 桁の値でも往復する", () => {
    // real(倍精度) の最短再現表現は String() が保証する。toFixed で桁を
    // 固定すると丸めが入り、累積リターンが最終桁で変わる。
    const closes = [0.1 + 0.2, 1 / 3, 12345.678901234567];
    expect(decodeCloses(encodeCloses(closes))).toEqual(closes);
  });

  it("null / 非有限 / 非正の終値は落とす", () => {
    expect(decodeCloses(encodeCloses([100, null, NaN, Infinity, 0, -5, 200]))).toEqual([
      100, 200,
    ]);
  });

  it("空配列は空文字列、空文字列は空配列", () => {
    expect(encodeCloses([])).toBe("");
    expect(decodeCloses("")).toEqual([]);
  });

  it("壊れた CSV でも例外を投げず、読める要素だけ返す", () => {
    // 投影は再生成可能な派生物なので、1 行の破損で画面全体を 500 にしない。
    // 落ちた銘柄は window 不足で null になりランキングから外れる (件数に現れる)。
    expect(decodeCloses("100,,abc,200,NaN,300")).toEqual([100, 200, 300]);
  });

  it("順序を保つ (逆順にすると累積リターンの符号が反転する)", () => {
    const rising = [100, 110, 120];
    expect(decodeCloses(encodeCloses(rising))).toEqual(rising);
    expect(decodeCloses(encodeCloses(rising))).not.toEqual([...rising].reverse());
  });
});
