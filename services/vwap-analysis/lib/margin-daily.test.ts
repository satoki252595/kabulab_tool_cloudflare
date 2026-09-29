/**
 * JPX 信用残高 (日次 mtall) パーサの回帰テスト。
 *
 * フィクスチャは行の形だけ実 PDF (2026-09-28 分) に合わせた合成テキストで、
 * 銘柄名・コード・ISIN・数値は架空 (margin.test.ts の SYNTHETIC_TEXT と同方式)。
 * 実原本 4259 行の通し検証は別途 pure replay で確認済み
 * (基準日 2026-09-28・総合計 4259・全ガード通過。643A0/644A0 の `-` セル、
 * 14900 の種別欠落、25935 の第１種優先株式、634A0 の前日比差分を含む。
 * いずれも観測事実で、原因の断定ではない)。
 * 合成フィクスチャの合計値はすべて数値 (null なし)。実原本の合計 38 行も
 * null を含まないことを確認済み。null→合計の規則はコード化しない。
 */
import { describe, expect, it } from "vitest";
import {
  MARGIN_DAILY_FORMAT,
  parseDailyMarginDates,
  parseDailyMarginText,
  selectDailyMarginRows,
  validateDailyMarginSnapshot,
} from "./margin-daily.js";

const FIXTURE = `2026/9/28 申込み現在 東京証券取引所株式部 （単位：一株、一円） 2026/9/29
As of 2026/9/28 application based Tokyo Stock Exchange, Equities Dept. (Unit: 1 share, 1 yen)
売残高
Outstanding Sales
前日比
Daily change
上場比
Ratio to
listed shares
買残高
Outstanding
Purchases
前日比
Daily change
上場比
Ratio to
listed shares
一般信用
Negotiable
前日比
Daily change
制度信用
Standardized
前日比
Daily change
一般信用
Negotiable
前日比
Daily change
制度信用
Standardized
前日比
Daily change
B 合成食品 普通株式 プライム 貸 99990 JP9999999999 株数 Shs. 100 10 0.1% 200 ▲20 0.2% 40 4 60 6 150 ▲10 50 ▲10
SYNTHETIC FOODS CO.,LTD.Prime Loan 99990 JP9999999999 金額 Val. 100,000 10,000 - 200,000 ▲20,000 - 40,000 4,000 60,000 6,000 150,000 ▲10,000 50,000 ▲10,000
B 合成機械 普通株式 スタンダード 制 88880 JP8888888888 株数 Shs. 0 - 0.0% 30 - 0.3% 0 - 0 - 12 - 18 -
SYNTHETIC MACHINERY CO.,LTD.Standard Margin 88880 JP8888888888 金額 Val. 0 - - 30,000 - - 0 - 0 - 12,000 - 18,000 -
J 合成投信 受益証券 投信等 貸 77770 JP7777777777 株数 Shs. 50 5 * 70 7 * 50 5 0 0 70 7 0 0
SYNTHETIC FUND Investment trusts Loan 77770 JP7777777777 金額 Val. 50,000 5,000 - 70,000 7,000 - 50,000 5,000 0 0 70,000 7,000 0 0
B 合成通信株式会社第１回社債型種類株式 プライム 貸 66665 JP6666666666 株数 Shs. 8 1 0.0% 9 2 0.0% 8 1 0 0 9 2 0 0
SYNTHETIC TEL CO.,LTD.Prime Loan 66665 JP6666666666 金額 Val. 8,000 1,000 - 9,000 2,000 - 8,000 1,000 0 0 9,000 2,000 0 0
B 合成運輸 普通株式 グロース 他 55550 JP5555555555 株数 Shs. 3 0 0.0% 4 1 0.1% 3 0 0 0 4 1 0 0
SYNTHETIC TRANSPORT CO.,LTD.Growth Other 55550 JP5555555555 金額 Val. 3,000 0 - 4,000 1,000 - 3,000 0 0 0 4,000 1,000 0 0
A 合成指数（ 投信等 貸 44440 JP4444444444 株数 Shs. 6 0 * 7 0 * 6 0 0 0 7 0 0 0
SYNTHETIC INDEX Investment trusts Loan 44440 JP4444444444 金額 Val. 6,000 0 - 7,000 0 - 6,000 0 0 0 7,000 0 0 0
貸借銘柄 4 銘柄 株数 Shs. 164 16 - 286 ▲11 - 104 10 60 6 236 ▲1 50 ▲10
loan trading issue 金額 Val. 164,000 16,000 - 286,000 ▲11,000 - 104,000 10,000 60,000 6,000 236,000 ▲1,000 50,000 ▲10,000
プライム 小計 2 銘柄 株数 Shs. 108 11 - 209 ▲18 - 48 5 60 6 159 ▲8 50 ▲10
Prime sub-total 金額 Val. 108,000 11,000 - 209,000 ▲18,000 - 48,000 5,000 60,000 6,000 159,000 ▲8,000 50,000 ▲10,000
スタンダード 小計 0 銘柄 株数 Shs. 0 0 - 0 0 - 0 0 0 0 0 0 0 0
Standard sub-total 金額 Val. 0 0 - 0 0 - 0 0 0 0 0 0 0 0
グロース 小計 0 銘柄 株数 Shs. 0 0 - 0 0 - 0 0 0 0 0 0 0 0
Growth sub-total 金額 Val. 0 0 - 0 0 - 0 0 0 0 0 0 0 0
投信等 小計 2 銘柄 株数 Shs. 56 5 - 77 7 - 56 5 0 0 77 7 0 0
Investment trusts sub-total 金額 Val. 56,000 5,000 - 77,000 7,000 - 56,000 5,000 0 0 77,000 7,000 0 0
制度信用銘柄 1 銘柄 株数 Shs. 0 0 - 30 0 - 0 0 0 0 12 0 18 0
standardized margin trading issue 金額 Val. 0 0 - 30,000 0 - 0 0 0 0 12,000 0 18,000 0
プライム 小計 0 銘柄 株数 Shs. 0 0 - 0 0 - 0 0 0 0 0 0 0 0
Prime sub-total 金額 Val. 0 0 - 0 0 - 0 0 0 0 0 0 0 0
スタンダード 小計 1 銘柄 株数 Shs. 0 0 - 30 0 - 0 0 0 0 12 0 18 0
Standard sub-total 金額 Val. 0 0 - 30,000 0 - 0 0 0 0 12,000 0 18,000 0
グロース 小計 0 銘柄 株数 Shs. 0 0 - 0 0 - 0 0 0 0 0 0 0 0
Growth sub-total 金額 Val. 0 0 - 0 0 - 0 0 0 0 0 0 0 0
その他 1 銘柄 株数 Shs. 3 0 - 4 1 - 3 0 0 0 4 1 0 0
other issues 金額 Val. 3,000 0 - 4,000 1,000 - 3,000 0 0 0 4,000 1,000 0 0
プライム 小計 0 銘柄 株数 Shs. 0 0 - 0 0 - 0 0 0 0 0 0 0 0
Prime sub-total 金額 Val. 0 0 - 0 0 - 0 0 0 0 0 0 0 0
スタンダード 小計 0 銘柄 株数 Shs. 0 0 - 0 0 - 0 0 0 0 0 0 0 0
Standard sub-total 金額 Val. 0 0 - 0 0 - 0 0 0 0 0 0 0 0
グロース 小計 1 銘柄 株数 Shs. 3 0 - 4 1 - 3 0 0 0 4 1 0 0
Growth sub-total 金額 Val. 3,000 0 - 4,000 1,000 - 3,000 0 0 0 4,000 1,000 0 0
総合計 6 銘柄 株数 Shs. 167 16 - 320 ▲10 - 107 10 60 6 252 0 68 ▲10
total 金額 Val. 167,000 16,000 - 320,000 ▲10,000 - 107,000 10,000 60,000 6,000 252,000 0 68,000 ▲10,000
プライム 小計 2 銘柄 株数 Shs. 108 11 - 209 ▲18 - 48 5 60 6 159 ▲8 50 ▲10
Prime sub-total 金額 Val. 108,000 11,000 - 209,000 ▲18,000 - 48,000 5,000 60,000 6,000 159,000 ▲8,000 50,000 ▲10,000
スタンダード 小計 1 銘柄 株数 Shs. 0 0 - 30 0 - 0 0 0 0 12 0 18 0
Standard sub-total 金額 Val. 0 0 - 30,000 0 - 0 0 0 0 12,000 0 18,000 0
グロース 小計 1 銘柄 株数 Shs. 3 0 - 4 1 - 3 0 0 0 4 1 0 0
Growth sub-total 金額 Val. 3,000 0 - 4,000 1,000 - 3,000 0 0 0 4,000 1,000 0 0
投信等 小計 2 銘柄 株数 Shs. 56 5 - 77 7 - 56 5 0 0 77 7 0 0
Investment trusts sub-total 金額 Val. 56,000 5,000 - 77,000 7,000 - 56,000 5,000 0 0 77,000 7,000 0 0
合計 Total 売残高 Outstanding Sales 買残高 Outstanding Purchases
`;

const PROV = { sourceUrl: "https://example.invalid/m.pdf", rawSha256: "0".repeat(64), rawPageId: null };

describe("parseDailyMarginText", () => {
  it("6行・18合計を全ガード通過で解析する", () => {
    const snap = parseDailyMarginText(FIXTURE, PROV);
    expect(snap.format).toBe(MARGIN_DAILY_FORMAT);
    expect(snap.basisDate).toBe("2026-09-28");
    expect(snap.publicationDate).toBe("2026-09-29");
    expect(snap.rows).toHaveLength(6);
    expect(snap.totals).toHaveLength(18);
  });

  it("▲は負数、`-`/`*` は null (0 にしない)", () => {
    const snap = parseDailyMarginText(FIXTURE, PROV);
    const a = snap.rows.find((r) => r.sourceCode === "99990")!;
    expect(a.shares.buyChg).toBe(-20);
    expect(a.shares.sellListedRatio).toBe(0.1);
    const b = snap.rows.find((r) => r.sourceCode === "88880")!;
    expect(b.shares.sellChg).toBeNull();
    expect(b.amounts.buyChg).toBeNull();
    const c = snap.rows.find((r) => r.sourceCode === "77770")!;
    expect(c.shares.sellListedRatio).toBeNull();
    expect(c.shares.sellListedRatioRaw).toBe("*");
    expect(c.amounts.sellListedRatioRaw).toBe("-");
  });

  it("種類株は ordinaryTicker null・種別欠落は null・他でも普通株は eligible", () => {
    const snap = parseDailyMarginText(FIXTURE, PROV);
    const d = snap.rows.find((r) => r.sourceCode === "66665")!;
    expect(d.ordinaryTicker).toBeNull();
    expect(d.sectype).toBe("社債型種類株式");
    expect(d.eligible).toBe(false);
    const f = snap.rows.find((r) => r.sourceCode === "44440")!;
    expect(f.sectype).toBeNull();
    expect(f.eligible).toBe(false);
    const e = snap.rows.find((r) => r.sourceCode === "55550")!;
    expect(e.ordinaryTicker).toBe("5555");
    expect(e.eligible).toBe(true);
    const a = snap.rows.find((r) => r.sourceCode === "99990")!;
    expect(a.ordinaryTicker).toBe("9999");
    expect(a.eligible).toBe(true);
  });

  it("列ずれ (セル数異常) は throw する", () => {
    const broken = FIXTURE.replace("100 10 0.1% 200", "100 10 200");
    expect(() => parseDailyMarginText(broken, PROV)).toThrow(/セル数/);
  });

  it("一般+制度≠総計の行は throw する", () => {
    const broken = FIXTURE.replace(
      "株数 Shs. 100 10 0.1% 200 ▲20 0.2% 40 4 60 6",
      "株数 Shs. 100 10 0.1% 200 ▲20 0.2% 40 4 61 6"
    );
    expect(() => parseDailyMarginText(broken, PROV)).toThrow(/内訳/);
  });

  it("合計不一致 (総合計の改竄) は throw する", () => {
    // 内訳 (168=108+60) は保ち、明細和との不一致だけ作る。
    const broken = FIXTURE.replace(
      "総合計 6 銘柄 株数 Shs. 167 16 - 320 ▲10 - 107",
      "総合計 6 銘柄 株数 Shs. 168 16 - 320 ▲10 - 108"
    );
    expect(() => parseDailyMarginText(broken, PROV)).toThrow(/合計が合いません/);
  });

  it("株数/金額のペア欠けは throw する", () => {
    const lines = FIXTURE.split("\n").filter(
      (l) => !l.startsWith("SYNTHETIC TRANSPORT CO.,LTD.Growth Other 55550")
    );
    expect(() => parseDailyMarginText(lines.join("\n"), PROV)).toThrow(/金額行がありません/);
  });

  it("未知の売買単位字母・未知の種別は throw する", () => {
    const badLetter = FIXTURE.replace("B 合成食品 普通株式", "Z 合成食品 普通株式");
    expect(() => parseDailyMarginText(badLetter, PROV)).toThrow(/売買単位字母/);
    const badSectype = FIXTURE.replace("合成食品 普通株式 プライム", "合成食品 優先株式 プライム");
    expect(() => parseDailyMarginText(badSectype, PROV)).toThrow(/銘柄種別/);
  });

  it("合計・明細どちらの文法にも一致しないマーカー行は黙殺せず throw する", () => {
    // コード欄が 6 文字 (未知様式) の株数行を 1 行だけ追加する。
    const extra =
      "B 合成食品 普通株式 プライム 貸 999900 JP9999999999 株数 Shs. 1 0 0.0% 1 0 0.0% 1 0 0 0 1 0 0 0";
    expect(() => parseDailyMarginText(`${FIXTURE}${extra}\n`, PROV)).toThrow(/未知の株数行/);
    const extraVal = "SYNTHETIC X Prime Loan 999900 JP9999999999 金額 Val. 1 0 - 1 0 - 1 0 0 0 1 0 0 0";
    expect(() => parseDailyMarginText(`${FIXTURE}${extraVal}\n`, PROV)).toThrow(/未知の金額行/);
  });

  it("暦に無い日付・不正な3桁区切りは throw する", () => {
    const badDate = FIXTURE.replace("2026/9/28 申込み現在", "2026/2/30 申込み現在");
    expect(() => parseDailyMarginText(badDate, PROV)).toThrow(/暦にありません/);
    const badComma = FIXTURE.replace("株数 Shs. 100 10 0.1%", "株数 Shs. 1,00 10 0.1%");
    expect(() => parseDailyMarginText(badComma, PROV)).toThrow(/3桁区切り/);
  });

  it("合計行に null が混ざると突合不能で throw する (0 扱いしない)", () => {
    const nullTotal = FIXTURE.replace(
      "プライム 小計 2 銘柄 株数 Shs. 108 11 -",
      "プライム 小計 2 銘柄 株数 Shs. 108 - -"
    );
    expect(() => parseDailyMarginText(nullTotal, PROV)).toThrow(/確定できません/);
  });

  it("日付行の欠落・不一致・単位注記の欠落は throw する", () => {
    expect(parseDailyMarginDates(FIXTURE)).toEqual({ basisDate: "2026-09-28", publicationDate: "2026-09-29" });
    const noDate = FIXTURE.split("\n").slice(2).join("\n");
    expect(() => parseDailyMarginText(noDate, PROV)).toThrow(/日付行/);
    const badUnit = FIXTURE.replace("（単位：一株、一円）", "（単位：一株）");
    expect(() => parseDailyMarginText(badUnit, PROV)).toThrow(/日付行/);
  });
});

describe("selectDailyMarginRows", () => {
  it("5文字原文と4文字ティッカーの両方で引き、重複は ambiguous", () => {
    const snap = parseDailyMarginText(FIXTURE, PROV);
    expect(selectDailyMarginRows(snap.rows, "99990")).toMatchObject({ status: "ok" });
    expect(selectDailyMarginRows(snap.rows, "9999")).toMatchObject({ status: "ok" });
    expect(selectDailyMarginRows(snap.rows, "66665")).toMatchObject({ status: "ok" });
    expect(selectDailyMarginRows(snap.rows, "6666")).toMatchObject({ status: "missing" });
    expect(selectDailyMarginRows(snap.rows, "0000")).toMatchObject({ status: "missing" });
    const base = snap.rows.find((r) => r.sourceCode === "99990")!;
    const dup = [...snap.rows, { ...base, sourceCode: "99991" }];
    expect(selectDailyMarginRows(dup, "9999")).toMatchObject({ status: "ambiguous", count: 2 });
  });
});

describe("validateDailyMarginSnapshot", () => {
  it("形式タグ・日付の異常は throw する", () => {
    const snap = parseDailyMarginText(FIXTURE, PROV);
    expect(() =>
      validateDailyMarginSnapshot({ ...snap, format: "x" as typeof snap.format })
    ).toThrow(/形式タグ/);
    expect(() => validateDailyMarginSnapshot({ ...snap, basisDate: "2026/09/28" })).toThrow(/基準日/);
  });
});

describe("assertDailyMarginHeaders (公式列見出しの厳密検証)", () => {
  it("列交換 (一般信用↔制度信用) は合計が合っていても STOP する", () => {
    const swapped = FIXTURE.replace(
      "一般信用\nNegotiable\n前日比\nDaily change\n制度信用\nStandardized",
      "制度信用\nStandardized\n前日比\nDaily change\n一般信用\nNegotiable"
    );
    expect(swapped).not.toBe(FIXTURE);
    expect(() => parseDailyMarginText(swapped, PROV)).toThrow(/公式列見出し/);
  });

  it("見出し欠落は STOP する", () => {
    const noHeader = FIXTURE.split("\n").filter((l) => l !== "売残高").join("\n");
    expect(() => parseDailyMarginText(noHeader, PROV)).toThrow(/公式列見出し/);
  });

  it("売買グループ見出しの欠落は STOP する", () => {
    const noGroup = FIXTURE.replace("合計 Total 売残高 Outstanding Sales 買残高 Outstanding Purchases\n", "");
    expect(() => parseDailyMarginText(noGroup, PROV)).toThrow(/グループ見出し/);
  });
});
