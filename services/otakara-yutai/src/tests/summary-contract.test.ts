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
  isVerbatimCopy,
} from "../../data-scripts/summary-contract.js";

const rules = (s: string) => checkSummary(s).map((v) => v.rule).sort();

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
