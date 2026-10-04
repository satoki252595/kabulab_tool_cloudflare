/**
 * 公開表示用要約の契約テスト。
 *
 * 本番実測 (2026-09-12 / 8,314 行) で見つかった違反の実物を固定し、
 * 「事実の記述」は誤検知しないことも同時に固定する。
 */
import { describe, expect, it } from "vitest";
import {
  SUMMARY_MAX_CHARS,
  checkSummary,
  formatViolations,
  isSummaryPercentGrounded,
  isSummaryNumbersGrounded,
  missingSummaryConditions,
  isVerbatimCopy,
} from "../../data-scripts/summary-contract.js";

const rules = (s: string) => checkSummary(s).map((v) => v.rule).sort();

it("選択・保有・抽選・応募条件を全経路で検証し、株数を保有期間にしない", () => {
  expect(missingSummaryConditions("100株以上の株主に商品", "商品")).toEqual([]);
  expect(missingSummaryConditions("5年以上継続保有で商品3万円相当", "商品3万円相当")).toEqual(["holding_condition_missing"]);
  expect(missingSummaryConditions("5年以上継続保有で商品3万円相当", "長期保有で商品3万円相当")).toEqual(["holding_condition_missing"]);
  expect(missingSummaryConditions("5年以上継続保有で商品3万円相当", "5年以上保有で商品3万円相当")).toEqual([]);
  expect(missingSummaryConditions("5年以上継続保有で商品3万円相当", "3年以上保有で商品3万円相当")).toEqual(["holding_condition_missing"]);
  expect(missingSummaryConditions("1年未満2千円・1年以上5千円のカタログ", "保有期間に応じたカタログ")).toEqual([]);
  expect(missingSummaryConditions("1年未満2千円・1年以上5千円のカタログ", "保有期間別のカタログ5千円")).toEqual(["holding_condition_missing"]);
  expect(missingSummaryConditions("商品又は寄付を選択", "商品")).toEqual(["choice_condition_missing"]);
  expect(missingSummaryConditions("応募株主から抽選で贈呈", "商品")).toEqual(["lottery_condition_missing", "application_condition_missing"]);
  expect(missingSummaryConditions("応募株主から抽選で贈呈", "応募して抽選で商品")).toEqual([]);
  expect(missingSummaryConditions("応募株主から抽選で贈呈", "抽選で商品")).toEqual(["application_condition_missing"]);
  expect(missingSummaryConditions("申し込みが必要な商品", "商品")).toEqual(["application_condition_missing"]);
  expect(missingSummaryConditions("申込株主から抽選で贈呈", "申込後に抽選で商品")).toEqual([]);
  expect(missingSummaryConditions("半年以上保有し株主名簿に記載又は記録された株主に商品", "半年以上保有で商品")).toEqual([]);
  expect(missingSummaryConditions("株主名簿に記載又は記録された株主は商品又は寄付を選択", "商品")).toEqual(["choice_condition_missing"]);
});

describe("checkSummary — 本番で実在した違反", () => {
  it("注記記号の取り込みを検出する", () => {
    // 9042: 利用方法の説明文をそのまま持ち込んでいた
    expect(rules("※従来の2冊相当、グループ各社で利用可能なクーポン券。")).toContain("annotation");
    // 3289: ※2 のような参照記号
    expect(rules("【3年以上保有株主】5,000ポイント※2、長期保有感謝ポイント")).toContain("annotation");
    // 7621: ◆ を見出しに使ったもの
    expect(rules("◆以下より1点を選択66,000円相当")).toContain("annotation");
    // 3679 の掲載文側で使われる ◇
    expect(rules("◇保有する株式数に応じて付与")).toContain("annotation");
  });

  it("60字超を検出する", () => {
    // 7780 (135字) の冒頭を再現した 61 字
    expect(rules("あ".repeat(SUMMARY_MAX_CHARS + 1))).toContain("too_long");
    expect(rules("あ".repeat(SUMMARY_MAX_CHARS))).not.toContain("too_long");
  });

  it("説明文調を検出する", () => {
    expect(rules("株主優待品をお得に購入できます。")).toContain("prose");
    expect(rules("リーガメンバーズ会員にご登録いただく必要があります。")).toContain("prose");
  });

  it("内部 headed marker の書き写しを検出する (読みやすい条件文言は通す)", () => {
    expect(rules("【種別：\"500円割引券\"】 1枚")).toContain("internal");
    // 取り込み側は NFKC 済み (：→:) で来る。両形を落とす。
    expect(rules("【種別：\"500円割引券\"】 1枚".normalize("NFKC"))).toContain("internal");
    expect(rules("割引券 500円 1枚")).not.toContain("internal");
  });

  it("空を検出する", () => {
    expect(rules("")).toEqual(["empty"]);
    expect(rules("   ")).toEqual(["empty"]);
  });

  it("複数違反を全て返す", () => {
    const v = checkSummary("※" + "あ".repeat(70) + "です。");
    expect(v.map((x) => x.rule).sort()).toEqual(["annotation", "prose", "too_long"]);
    expect(formatViolations(v)).toContain("annotation");
  });
});

describe("checkSummary — 事実の記述は通す (誤検知しない)", () => {
  // 本番データから採った実物。いずれも公開してよい事実の記述。
  const FACTUAL = [
    "1,000円相当",
    "5kg",
    "2,500ポイント",
    "あべのハルカス展望台「ハルカス 300」入場優待券",
    "ワタミ:8枚4000円相当の株主優待券。",
    "カタログギフト 3,000円相当",
    "【6カ月以上保有】4,000円相当分",
    "<梅>1回分5,000円相当、<竹>2回分10,000円相当",
    "10%割引や15%割引の優待券を提供",
    "入園券2枚、招待用乗車券4枚",
  ];
  it.each(FACTUAL)("%s は違反なし", (text) => {
    expect(checkSummary(text)).toEqual([]);
  });
});

describe("isVerbatimCopy", () => {
  it("事実の最小表現は逐語コピー扱いしない", () => {
    // 掲載文1行目と一致する 759 行は中央値 8 字・最大 34 字で全て事実
    expect(isVerbatimCopy("1,000円相当", "1,000円相当\n■贈呈時期\n毎年5月末頃")).toBe(false);
    expect(isVerbatimCopy("5枚", "5枚")).toBe(false);
    expect(
      isVerbatimCopy(
        "あべのハルカス展望台「ハルカス 300」入場優待券",
        "あべのハルカス展望台「ハルカス 300」入場優待券\n■2枚（年間 4枚）",
      ),
    ).toBe(false);
  });

  it("40字以上の逐語一致は検出する", () => {
    const long = "自社オンラインショップで8,500円以上の買物につき1個利用できる長い説明文がここに続く";
    expect(long.length).toBeGreaterThanOrEqual(40);
    expect(isVerbatimCopy(long, `見出し\n${long}\n※注記`)).toBe(true);
  });

  it("空文字は判定しない", () => {
    expect(isVerbatimCopy("", "なにか")).toBe(false);
    expect(isVerbatimCopy("なにか", "")).toBe(false);
  });
});

describe("isSummaryPercentGrounded — 要約の % は掲載文の % で裏づける", () => {
  it("% の無い要約は判定しない", () => {
    expect(isSummaryPercentGrounded("なにか", "QUOカード 1,000円相当")).toBe(true);
  });

  it("掲載文に % があれば通す (半角・全角)", () => {
    expect(isSummaryPercentGrounded("系列店で使える20%割引券 2枚", "系列店の20%割引券 2枚")).toBe(true);
    expect(isSummaryPercentGrounded("系列店で使える２０％割引券", "系列店の20%割引券")).toBe(true);
  });

  it("掲載文に % が無ければ落とす (別群の割引要約の貼り付け)", () => {
    // 8508 型: 抽選の掲載文に割引率の要約
    expect(isSummaryPercentGrounded("応募口数で抽選招待", "美容施設の20%割引")).toBe(false);
  });

  it("数値が違えば落とす (単位つき数値の一致。10%で20%は根拠づけられない)", () => {
    expect(isSummaryPercentGrounded("系列店で使える10%割引券", "系列店の20%割引券")).toBe(false);
    expect(isSummaryPercentGrounded("系列店で使える10%割引券", "系列店の10%割引券")).toBe(true);
  });

  it("人数は率の根拠にならない (raw20名で20%は根拠づけられない)", () => {
    expect(isSummaryPercentGrounded("20名に抽選で贈呈", "施設利用の20%割引")).toBe(false);
    expect(isSummaryPercentGrounded("２０名に抽選で贈呈", "施設利用の２０％割引")).toBe(false);
  });

  it("複数の % は全ての数値が一致すれば通す (615 行の適正形)", () => {
    expect(isSummaryPercentGrounded("平日10%・土曜20%の割引券", "土曜20%割引券")).toBe(true);
    expect(isSummaryPercentGrounded("平日10%・土曜20%の割引券", "日曜30%割引券")).toBe(false);
  });
});

it("生成した円額・枚数・株数・保有条件を単位ごとに照合し、別単位や計算値を採用しない", () => {
  const context = { minShares: [100], recordMonths: [3, 9] };
  const source = "1年以上保有で2千円分の券2枚、20名に贈呈";
  expect(isSummaryNumbersGrounded(source, "100株・1年以上:2,000円の券2枚", context)).toBe(true);
  expect(isSummaryNumbersGrounded(source, "券4,000円分", context)).toBe(false);
  expect(isSummaryNumbersGrounded(source, "券3枚", context)).toBe(false);
  expect(isSummaryNumbersGrounded(source, "20%割引", context)).toBe(false);
  expect(isSummaryNumbersGrounded(source, "300株:券2枚", context)).toBe(false);
  expect(isSummaryNumbersGrounded(source, "3年以上:券2枚", context)).toBe(false);
  expect(isSummaryNumbersGrounded(source, "3月・9月:券2枚", context)).toBe(true);
  expect(isSummaryNumbersGrounded(source, "100株:券2枚", { ...context, minShares: [100, 300] })).toBe(false);
  expect(isSummaryNumbersGrounded("1,2枚から選択", "券12枚", context)).toBe(false);
  expect(isSummaryNumbersGrounded("500円相当", "商品券1億円相当", context)).toBe(false);
  expect(isSummaryNumbersGrounded("5000円相当", "商品券1万5千円相当", context)).toBe(false);
  expect(isSummaryNumbersGrounded("1万5千円相当", "商品券5000円相当", context)).toBe(false);
  expect(isSummaryNumbersGrounded("500円相当", "商品券一万円相当", context)).toBe(false);
  expect(isSummaryNumbersGrounded("新米5kg", "新米 5kg", context)).toBe(true);
  expect(isSummaryNumbersGrounded("新米5kg", "新米 3kg", context)).toBe(false);
});

it("実原文の数量「1部」を照合し、数値・単位の変更は採用しない", () => {
  // 2026-10-04 の通常 .3 実測で、原文と同じ「1部」が未対応単位として拒否された。
  const source = "1部";
  const context = { minShares: [100], recordMonths: [3] };
  expect(isSummaryNumbersGrounded(source, "1部", context)).toBe(true);
  expect(isSummaryNumbersGrounded(source, "１部", context)).toBe(true);
  expect(isSummaryNumbersGrounded(source, "2部", context)).toBe(false);
  expect(isSummaryNumbersGrounded(source, "1本", context)).toBe(false);
  expect(isSummaryNumbersGrounded("一部は対象外", "一部は対象外", context)).toBe(true);
});

it("実在の株数範囲は下限recipientと原文の全範囲で照合する", () => {
  // 2026-10-04の21時定時実行で、正しい範囲が上限株数だけで誤拒否された。
  const source = "100株以上200株未満";
  const context = { minShares: [100], recordMonths: [3] };
  expect(isSummaryNumbersGrounded(source, source, context)).toBe(true);
  expect(isSummaryNumbersGrounded("1,000株以上2,000株未満", "1000株以上2000株未満", { ...context, minShares: [1000] })).toBe(true);
  expect(isSummaryNumbersGrounded(source, "100株以上300株未満", context)).toBe(false);
  expect(isSummaryNumbersGrounded(source, "100株以上200株以下", context)).toBe(false);
  expect(isSummaryNumbersGrounded(source, "200株", context)).toBe(false);
  expect(isSummaryNumbersGrounded(source, source, { ...context, minShares: [100, 200] })).toBe(false);
  expect(isSummaryNumbersGrounded(source, source, { ...context, minShares: [] })).toBe(false);
  expect(isSummaryNumbersGrounded("100株以上・別条件200株未満", source, context)).toBe(false);
  expect(isSummaryNumbersGrounded("100株以上100株未満", "100株以上100株未満", context)).toBe(false);
  expect(isSummaryNumbersGrounded("1,2株以上200株未満", "12株以上200株未満", { ...context, minShares: [12] })).toBe(false);
  expect(isSummaryNumbersGrounded("-100株以上200株未満", source, context)).toBe(false);
  expect(isSummaryNumbersGrounded("1万100株以上200株未満", source, context)).toBe(false);
});

it("原文と同じ日数・か月期間だけを裏づけ、権利月や換算から期間を補わない", () => {
  const context = { minShares: [100], recordMonths: [3] };
  expect(isSummaryNumbersGrounded("利用期限30日", "30日間利用可能", context)).toBe(true);
  expect(isSummaryNumbersGrounded("6か月以上継続保有", "6か月以上保有", context)).toBe(true);
  expect(isSummaryNumbersGrounded("利用券", "30日間利用可能", context)).toBe(false);
  expect(isSummaryNumbersGrounded("利用期限30日", "60日間利用可能", context)).toBe(false);
  expect(isSummaryNumbersGrounded("継続保有で贈呈", "3か月以上保有", context)).toBe(false);
  expect(isSummaryNumbersGrounded("6か月以上継続保有", "3か月以上保有", context)).toBe(false);
  expect(isSummaryNumbersGrounded("3月に贈呈", "3か月以上保有", context)).toBe(false);
  expect(isSummaryNumbersGrounded("3か月以上保有", "3月に贈呈", { ...context, recordMonths: [] })).toBe(false);
  expect(isSummaryNumbersGrounded("1年以上保有", "12か月以上保有", context)).toBe(false);
  expect(isSummaryNumbersGrounded("3か月以上保有", "90日以上保有", context)).toBe(false);
  expect(isSummaryNumbersGrounded("1日間利用可能", "一日間利用可能", context)).toBe(false);
  expect(isSummaryNumbersGrounded("6か月以上保有", "6ヶ月以上保有", context)).toBe(false);
  expect(isSummaryNumbersGrounded("6か月以上保有", "6カ月以上保有", context)).toBe(false);
});

it("随時のrecipient0を暦0月の根拠にせず、他の実月・期間は同じ契約を保つ", () => {
  const context = { minShares: [100], recordMonths: [0, 3] };
  expect(isSummaryNumbersGrounded("随時利用できるサービス", "随時利用可能", context)).toBe(true);
  expect(isSummaryNumbersGrounded("随時利用できるサービス", "0月に利用可能", context)).toBe(false);
  expect(isSummaryNumbersGrounded("誤記0月", "0月に利用可能", context)).toBe(false);
  expect(isSummaryNumbersGrounded("サービス", "3月に利用可能", context)).toBe(true);
  expect(isSummaryNumbersGrounded("サービス", "3か月利用可能", context)).toBe(false);
});
