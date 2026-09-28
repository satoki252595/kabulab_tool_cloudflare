/**
 * 推定金額の決定論ガード (`estimated-value-guard.ts`) のテスト。
 *
 * 掲載文はすべて架空 (出典サイトの文面は使わない)。実データ監査 (2026-09-28)
 * で見つけた内訳を合成文で再現する:
 *   - 全角数字の正規化 (旧 `String(数値)` は「４」を "52" に誤変換していた)
 *   - 0・負値の拒否 (旧 LLM 経路が「推定不能」を 0 で書いていた)
 *   - 抽選賞品の拒否 (当選人数つきの賞品表記。固定分との併記は通す)
 */
import { describe, expect, it } from "vitest";
import {
  extractQuantities,
  extractYenAmounts,
  extractYenSpans,
  isCarryableValue,
  isLotteryPrizeAmount,
  isUnconvertedForeignAmount,
  sanitizeEstimatedValue,
} from "../../data-scripts/estimated-value-guard.js";

describe("extractYenAmounts (全角数字の正規化)", () => {
  it("全角数字を半角として読む", () => {
    // 旧実装は「４万円」を "52万円" = 520,000 と誤読していた
    expect(extractYenAmounts("架空宿泊券 ４万円相当")).toEqual([40000]);
    expect(extractYenAmounts("架空商品券 ３,０００円分")).toEqual([3000]);
    expect(extractYenAmounts("架空ギフト ２０万円相当")).toEqual([200000]);
  });

  it("半角の従来挙動は不変", () => {
    expect(extractYenAmounts("架空ギフト 3,000円相当")).toEqual([3000]);
    expect(extractYenAmounts("旅行券 20万円相当")).toEqual([200000]);
    expect(extractYenAmounts("架空優待券 2枚")).toEqual([]);
  });

  it("抽出位置を返す (金額と当選人数の隣接判定用)", () => {
    const spans = extractYenSpans("抽選で8名に15万円相当の架空ギフト券");
    expect(spans.map((s) => s.value)).toEqual([150000]);
    const [s] = spans;
    expect("抽選で8名に15万円相当の架空ギフト券".slice(s.index, s.end)).toBe("15万円");
  });
});

describe("extractQuantities (全角数字の正規化)", () => {
  it("全角数字を半角として読む", () => {
    // 旧実装は「２枚」を 50 枚と誤読し、50 倍の grounding 乗数を許していた
    expect(extractQuantities("架空優待券 ２枚")).toEqual([2]);
  });

  it("人数の単位 (名) は数量にしない (当選人数で金額を掛けない)", () => {
    // 「1万円相当 各5名」の 5 で 50,000 円 (賞金総額) を根拠づけない。
    // 人数は金額の単位と掛からない。
    expect(extractQuantities("架空ギフト 1万円相当 各5名")).toEqual([]);
    expect(extractQuantities("架空優待券 2枚")).toEqual([2]);
    expect(sanitizeEstimatedValue("架空ギフト 1万円相当 各5名", 50000)).toBeNull();
  });
});

describe("sanitizeEstimatedValue (0・負値の拒否)", () => {
  it("0・負・小数を null にする (スキーマの positive と二重化)", () => {
    expect(sanitizeEstimatedValue("架空ギフト 3,000円相当", 0)).toBeNull();
    expect(sanitizeEstimatedValue("架空ギフト 3,000円相当", -100)).toBeNull();
    expect(sanitizeEstimatedValue("架空ギフト 3,000円相当", 10.5)).toBeNull();
    expect(sanitizeEstimatedValue("架空ギフト 3,000円相当", 3000)).toBe(3000);
  });
});

describe("isLotteryPrizeAmount (抽選賞品の機械判定)", () => {
  it("R1: 賞品表の金額 (○○円相当:N名) を弾く", () => {
    const desc = "80,000円相当:40名\n30,000円相当:90名\n抽選で付与。";
    expect(isLotteryPrizeAmount(desc, 80000)).toBe(true);
    expect(isLotteryPrizeAmount(desc, 30000)).toBe(true);
  });

  it("R1: N名に○○円 (当選配布) を弾く", () => {
    expect(isLotteryPrizeAmount("抽選で8名に15万円相当の架空ギフト券", 150000)).toBe(true);
  });

  it("R2: 総額表示 + 各N名の配分表を弾く", () => {
    const desc = "◇抽選で総額900万円相当の架空ポイントを進呈。\n1、8万円相当 各10名\n2、2万円相当 各40名";
    expect(isLotteryPrizeAmount(desc, 9000000)).toBe(true);
  });

  it("抽選語が無ければ弾かない", () => {
    expect(isLotteryPrizeAmount("8万円相当 各10名", 80000)).toBe(false);
  });

  it("固定分との併記は弾かない (23 件の適正行に相当)", () => {
    // 固定ギフト + 抽選宿泊の併記。固定分の金額は通す
    expect(
      isLotteryPrizeAmount(
        "架空電子マネー 2,000円相当、割引券、体験チケット (抽選で各店舗につき1名)",
        2000
      )
    ).toBe(false);
    // 固定セット + 抽選の上限つき添え物
    expect(
      isLotteryPrizeAmount("架空干物セット 5,000円相当。珍味小箱は抽選で上限 1,000個", 5000)
    ).toBe(false);
    // 固定ギフトの総額 + 無関係な抽選 (R2 の各N名条件で除外)
    expect(isLotteryPrizeAmount("総額5000円相当のギフト。抽選で1組に旅行券", 5000)).toBe(false);
  });

  it("各株主・名義・条件人数は当選人数に数えない", () => {
    expect(isLotteryPrizeAmount("抽選あり。各株主1名に食事券 1,000円相当", 1000)).toBe(false);
    expect(isLotteryPrizeAmount("抽選あり。2名で来店時に使える 1,000円相当券", 1000)).toBe(false);
    expect(isLotteryPrizeAmount("抽選あり。同伴者1名まで使える 1,000円相当券", 1000)).toBe(false);
  });

  it("離れた抽選記述は対象外 (生成側の仕様遵守に委ねる残件)", () => {
    // 50万円相当と抽選が別文。機械判定の対象外であることを固定する
    const desc = "※抽選で20名に商品を提供。\n◇契約の際に50万円相当の商品券を贈呈。";
    expect(isLotteryPrizeAmount(desc, 500000)).toBe(false);
  });
});

describe("sanitizeEstimatedValue (抽選賞品の統合)", () => {
  it("抽選賞品を金額帯によらず null にする (5 万円未満も)", () => {
    expect(sanitizeEstimatedValue("抽選で8名に15万円相当の架空ギフト券", 150000)).toBeNull();
    expect(sanitizeEstimatedValue("抽選で5名に3,000円相当の架空商品券", 3000)).toBeNull();
  });

  it("固定分との併記は通す", () => {
    expect(
      sanitizeEstimatedValue("架空デジタルギフト 1,000円相当 (抽選で宿泊券も)", 1000)
    ).toBe(1000);
  });
});

describe("isUnconvertedForeignAmount (外貨額面の未換算)", () => {
  it("外貨額面と一致する低額の値を弾く (147A: USD額面→円の混同)", () => {
    expect(isUnconvertedForeignAmount("架空クーポン 25USD×4=100USD", 100)).toBe(true);
    expect(isUnconvertedForeignAmount("架空クーポン 25USD×4=100USD", 25)).toBe(true);
    expect(sanitizeEstimatedValue("架空クーポン 25USD×4=100USD", 100)).toBeNull();
  });

  it("円額面と一致する値は通す (外貨との併記)", () => {
    expect(isUnconvertedForeignAmount("100USD (約15,000円相当) の架空クーポン", 15000)).toBe(false);
    expect(sanitizeEstimatedValue("100USD (約15,000円相当) の架空クーポン", 15000)).toBe(15000);
  });

  it("外貨額面と無関係の値は判定しない", () => {
    expect(isUnconvertedForeignAmount("架空ギフト 3,000円相当", 3000)).toBe(false);
    expect(isUnconvertedForeignAmount("100USD相当の架空クーポン", 3000)).toBe(false);
  });
});

describe("isCarryableValue (持ち越し判定 = 取り込みゲートと同一)", () => {
  it("null は持ち越さない (持ち越し対象外の明示)", () => {
    expect(isCarryableValue("架空ギフト 3,000円相当", null)).toBe(false);
  });

  it("ゲートを通る値は持ち越す", () => {
    expect(isCarryableValue("架空ギフト 3,000円相当", 3000)).toBe(true);
  });

  it("0・抽選賞品・根拠なし値は持ち越さない", () => {
    expect(isCarryableValue("架空ギフト 3,000円相当", 0)).toBe(false);
    expect(isCarryableValue("抽選で8名に15万円相当の架空ギフト券", 150000)).toBe(false);
    expect(isCarryableValue("架空の米 5kg", 5000)).toBe(false);
    expect(isCarryableValue("割引券 20%割引", 2000)).toBe(false);
  });

  it("外貨建ては持ち越さない (円の金額表現が無い)", () => {
    expect(isCarryableValue("架空クーポン 25USD×4=100USD", 100)).toBe(false);
  });
});
