/**
 * PDF 本文センチメント判定の固定テスト (CLAUDE.md ルール:
 *   「新しい分類を足すときも『それっぽい語で拾う』のは禁止。
 *    必ず test に固定してからタグを追加する」と同精神)。
 *
 * - Engine 1 (数値ルール): 業績予想/配当予想/特別損益の合成 PDF テキストで
 *   positive/negative/mixed/unknown が正しく出ることを固定
 * - Engine 2 (辞書): 東北大評価極性辞書 + kuromoji の最小動作確認
 * - dispatch: タグ → エンジン振り分けの全列挙
 *
 * 実 PDF (バイナリ) は使わない。すべて手書きの合成テキストで挙動を固定。
 * kuromoji 初期化 (~500-1000ms) があるため Engine 2 テストは少し遅い。
 */
import { describe, expect, it } from "vitest";
import { classifyForecastRevision } from "../services/pdf-sentiment/rules/forecast-revision.js";
import { classifyDividendRevision } from "../services/pdf-sentiment/rules/dividend-revision.js";
import { classifyExtraordinaryPL } from "../services/pdf-sentiment/rules/extraordinary-pl.js";
import { classifyTextSentiment } from "../services/pdf-sentiment/index.js";
import {
  extractBeforeAfter,
  parseAmount,
  parseJpNumber,
} from "../services/pdf-sentiment/rules/numbers.js";

describe("numbers.parseJpNumber", () => {
  it("半角・全角・カンマ・小数を扱う", () => {
    expect(parseJpNumber("1,234")).toBe(1234);
    expect(parseJpNumber("１，２３４")).toBe(1234);
    expect(parseJpNumber("12.5")).toBe(12.5);
  });
  it("△/▲ をマイナス扱い", () => {
    expect(parseJpNumber("△500")).toBe(-500);
    expect(parseJpNumber("▲1,200")).toBe(-1200);
    expect(parseJpNumber("−300")).toBe(-300);
  });
  it("不正値は NaN", () => {
    expect(parseJpNumber("--")).toBeNaN();
    expect(parseJpNumber("abc")).toBeNaN();
    expect(parseJpNumber("")).toBeNaN();
  });
});

describe("numbers.parseAmount", () => {
  it("百万円/千円/億円/円 を円換算する", () => {
    expect(parseAmount("100百万円")).toBe(100_000_000);
    expect(parseAmount("500千円")).toBe(500_000);
    expect(parseAmount("3億円")).toBe(300_000_000);
    expect(parseAmount("1,234円")).toBe(1234);
  });
  it("単位強制で不一致は NaN", () => {
    expect(parseAmount("100千円", ["百万円"])).toBeNaN();
  });
});

describe("numbers.extractBeforeAfter", () => {
  it("テンプレ「前回→今回」を抽出 (営業利益)", () => {
    const text = "営業利益 5,000百万円 4,500百万円 △500 -10.0%";
    const r = extractBeforeAfter(text, "営業利益", ["百万円"]);
    expect(r).toEqual({ before: 5_000_000_000, after: 4_500_000_000 });
  });
  it("単位不一致は null", () => {
    const text = "営業利益 1,000百万円 1,500千円";
    expect(extractBeforeAfter(text, "営業利益", ["百万円"])).toBeNull();
  });
  it("key が無ければ null", () => {
    expect(extractBeforeAfter("空のテキスト", "営業利益")).toBeNull();
  });
});

describe("classifyForecastRevision (Engine 1)", () => {
  it("営業利益が増加 → positive", () => {
    const text = `
      連結業績予想の修正に関するお知らせ
      売上高 100,000百万円 105,000百万円 5,000 +5.0%
      営業利益 5,000百万円 6,000百万円 1,000 +20.0%
      経常利益 5,200百万円 6,200百万円 1,000 +19.2%
      親会社株主に帰属する当期純利益 3,500百万円 4,200百万円 700 +20.0%
    `;
    const r = classifyForecastRevision(text);
    expect(r.sentiment).toBe("positive");
    expect(r.method).toBe("rule_v1");
  });

  it("営業利益が減少 → negative", () => {
    const text = `
      営業利益 5,000百万円 4,200百万円 △800 △16.0%
      経常利益 5,100百万円 4,300百万円 △800 △15.7%
      親会社株主に帰属する当期純利益 3,400百万円 2,900百万円 △500 △14.7%
    `;
    const r = classifyForecastRevision(text);
    expect(r.sentiment).toBe("negative");
    expect(r.method).toBe("rule_v1");
  });

  it("売上+ 営業利益− → mixed (営業利益 primary)", () => {
    const text = `
      売上高 100,000百万円 110,000百万円 10,000 +10.0%
      営業利益 5,000百万円 4,000百万円 △1,000 △20.0%
    `;
    const r = classifyForecastRevision(text);
    expect(r.sentiment).toBe("mixed");
  });

  it("全指標フラット → unknown", () => {
    const text = `
      売上高 100,000百万円 100,000百万円 0 0.0%
      営業利益 5,000百万円 5,000百万円 0 0.0%
    `;
    const r = classifyForecastRevision(text);
    expect(r.sentiment).toBe("unknown");
  });

  it("テーブル無しは unknown", () => {
    const r = classifyForecastRevision("お知らせの全文ではテーブルがありません");
    expect(r.sentiment).toBe("unknown");
  });
});

describe("classifyDividendRevision (Engine 1)", () => {
  it("年間配当の合計が増加 → positive", () => {
    const text = `
      配当予想の修正に関するお知らせ
      期末配当 20円 25円 5
      合計 (年間) 40円 50円 10
    `;
    const r = classifyDividendRevision(text);
    expect(r.sentiment).toBe("positive");
    expect(r.method).toBe("rule_v1");
  });

  it("配当合計が減少 → negative", () => {
    const text = `
      1 株当たり配当金 合計 50円 30円 △20
    `;
    const r = classifyDividendRevision(text);
    expect(r.sentiment).toBe("negative");
  });

  it("配当テーブルなし → unknown", () => {
    const r = classifyDividendRevision("配当に関する一般的なお知らせ本文");
    expect(r.sentiment).toBe("unknown");
  });
});

describe("classifyExtraordinaryPL (Engine 1)", () => {
  it("特別損失のみ → negative", () => {
    const text = "特別損失 500百万円を計上する見込み";
    const r = classifyExtraordinaryPL(text);
    expect(r.sentiment).toBe("negative");
  });

  it("特別利益のみ → positive", () => {
    const text = "特別利益 200百万円を計上する見込み";
    const r = classifyExtraordinaryPL(text);
    expect(r.sentiment).toBe("positive");
  });

  it("両方あって損失が 2 倍以上 → negative", () => {
    const text = "特別損失 1,000百万円, 特別利益 100百万円";
    const r = classifyExtraordinaryPL(text);
    expect(r.sentiment).toBe("negative");
  });

  it("両方あって規模差<2倍 → mixed", () => {
    const text = "特別損失 600百万円 特別利益 500百万円";
    const r = classifyExtraordinaryPL(text);
    expect(r.sentiment).toBe("mixed");
  });

  it("金額抽出失敗 → unknown", () => {
    const r = classifyExtraordinaryPL("特別損失について検討中");
    expect(r.sentiment).toBe("unknown");
  });
});

describe("dispatchClassify (タグ → エンジン)", () => {
  it("title sentiment 確定タグは skipped", async () => {
    const r = await classifyTextSentiment("どんなテキストでも", "上方修正");
    expect(r.sentiment).toBe("skipped");
  });

  it("決算短信は skipped", async () => {
    const r = await classifyTextSentiment("売上 100億円", "決算短信");
    expect(r.sentiment).toBe("skipped");
  });

  it("人事・組織は skipped", async () => {
    const r = await classifyTextSentiment("代表取締役の異動", "人事・組織");
    expect(r.sentiment).toBe("skipped");
  });

  it("未分類 (primaryTag=null) は skipped", async () => {
    const r = await classifyTextSentiment("任意のテキスト", null);
    expect(r.sentiment).toBe("skipped");
  });

  it("業績予想の修正 + 数値あり → Engine 1 (positive)", async () => {
    const text = `
      営業利益 1,000百万円 1,500百万円 500 +50%
    `;
    const r = await classifyTextSentiment(text, "業績予想の修正");
    expect(r.sentiment).toBe("positive");
    expect(r.method).toBe("rule_v1");
  });

  it("配当(決定・予想) + 数値あり → Engine 1 (negative)", async () => {
    const text = `1 株当たり配当金 合計 60円 40円 △20`;
    const r = await classifyTextSentiment(text, "配当(決定・予想)");
    expect(r.sentiment).toBe("negative");
  });

  it("テキスト空 → unknown", async () => {
    const r = await classifyTextSentiment("   ", "業績予想の修正");
    expect(r.sentiment).toBe("unknown");
  });
});

// Engine 2 (kuromoji + 辞書) は初期化に時間がかかるので 1 件だけ確認。
// 重い辞書ロードが入るのでタイムアウトを長めに。
describe("classifyByDictionary (Engine 2, smoke)", () => {
  it("ネガティブ語彙が多いと negative になりうる", async () => {
    // 「困難」「下落」「悪化」「減少」「失敗」「中止」を多用 → negative 期待
    const text = `
      当社グループは経済環境の悪化に直面しており、業績の回復は困難な状況です。
      売上の減少、利益の悪化、計画の中止、施策の失敗が続いており、株価も下落しています。
      新規プロジェクトは中止せざるを得ず、見通しは厳しいと言わざるを得ません。
      減損損失の計上も予想され、当期純損失の拡大が懸念されます。
    `;
    const r = await classifyTextSentiment(text, "配当政策の変更");
    // 辞書マッチ次第で unknown もありうる (閾値あり)。少なくとも positive ではない。
    expect(r.sentiment === "negative" || r.sentiment === "unknown").toBe(true);
    if (r.sentiment === "negative") {
      expect(r.method).toBe("dict_v1");
      expect(r.score).not.toBeNull();
    }
  }, 30_000);
});
