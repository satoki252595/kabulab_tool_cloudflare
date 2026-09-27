/**
 * jpx-derivatives-investor.ts のユニットテスト。
 *
 * ## フィクスチャについて (重要: 個人利用限定・PUBLIC リポジトリには commit しない)
 *
 * `fixtures/private/jpx-derivatives-investor/jpx-deriv-investor-week-20260907_20260911.csv` と
 * `fixtures/private/jpx-derivatives-investor/jpx-futures-oi-20260918-indexfut.xlsx` は 2026-09-27 に JPX から
 * 実際に取得した実ファイルそのもの (無加工)。JPX 利用規約は personal-only
 * (商用二次利用・再配信禁止) のため、`fixtures/private/` (.gitignore 済み) に置き
 * **リポジトリには commit しない**。
 * 未取得の環境 (fixture が手元に無い環境。例: CI) では、フィクスチャに依存する
 * テストは fail ではなく skip する。フォーマットの堅牢性 (様式変更で throw する
 * こと) 自体は、margin.test.ts と同様に synthetic (架空) な最小データで別途検証
 * しており、フィクスチャの有無に関係なく常時実行される。
 *
 * 再取得手順: 本文中の URL (index.html / open-interest 年次 JSON) を
 * ブラウザ相当 User-Agent で GET し、このファイルと同じファイル名で
 * `fixtures/private/jpx-derivatives-investor/` に保存する。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  INDICATOR_DEFINITIONS,
  INDICATOR_FUTURES_OI_KEY,
  INDICATOR_GROSS_TURNOVER_KEY,
  INDICATOR_NET_BALANCE_KEY,
  extractInvestorTypeCsvLinks,
  fetchLatestIndexFuturesOiFile,
  fetchLatestInvestorTypeCsvData,
  indexFuturesOiArchiveInput,
  indexFuturesOiToObservations,
  investorTypeCsvArchiveInput,
  investorTypeRowsToObservations,
  isPeriodNotYetPublished,
  parseIndexFuturesOiGrid,
  parseIndexFuturesOiWorkbook,
  parseInvestorTypeCsv,
  type IndexFuturesOiData,
  type InvestorTypeCsvData,
} from "./jpx-derivatives-investor.js";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "private", "jpx-derivatives-investor");
const CSV_FIXTURE = join(FIXTURE_DIR, "jpx-deriv-investor-week-20260907_20260911.csv");
const OI_FIXTURE = join(FIXTURE_DIR, "jpx-futures-oi-20260918-indexfut.xlsx");
const hasCsvFixture = existsSync(CSV_FIXTURE);
const hasOiFixture = existsSync(OI_FIXTURE);

// ---------------------------------------------------------------------------
// (1) 投資部門別取引状況 CSV — フォーマット堅牢性 (synthetic データ、常時実行)
// ---------------------------------------------------------------------------

const CSV_HEADER =
  '"帳票種別 Product type","サイクル区分 Cycle","年月週 Year, Month, Week",' +
  '"報告年月日（自）Period covered - from","報告年月日（至）Period covered - to",' +
  '"投資部門コード Type of Investor","数量金額区分 Volume/Value","売 Sales",' +
  '"売-差引 Balance","買 Purchases","買-差引 Balance","合計 Total"';

// 行の形 (12列・帳票種別/投資部門コード・差引の符号規則) だけ実 CSV に合わせた
// 架空データ。値そのものは実データではない (300/90/60等の丸めた数字)。
function syntheticCsv(rows: string[]): string {
  return ["﻿" + CSV_HEADER, ...rows].join("\n") + "\n";
}

const ROW_301_11_SHORT =
  "301,1,2026092,20260907,20260911,11,1,100,-10,90,0,190"; // 自己・数量・売り越し
const ROW_301_60_LONG =
  "301,1,2026092,20260907,20260911,60,1,50,0,60,10,110"; // 海外投資家・数量・買い越し

describe("parseInvestorTypeCsv (投資部門別取引状況 CSV, synthetic)", () => {
  it("有効な行を正しく解析する (差引の符号規則・合計の突き合わせ含む)", () => {
    const rows = parseInvestorTypeCsv(syntheticCsv([ROW_301_11_SHORT, ROW_301_60_LONG]));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      productCode: "301",
      productName: "日経225先物",
      investorCode: "11",
      investorName: "自己",
      metric: "volume",
      sales: 100,
      purchases: 90,
      total: 190,
      netBalance: -10, // 売り越し
      periodFrom: "2026-09-07",
      periodTo: "2026-09-11",
    });
    expect(rows[1]).toMatchObject({
      investorCode: "60",
      investorName: "海外投資家",
      netBalance: 10, // 買い越し
    });
  });

  it("見出し内のカンマ含み引用フィールド (Year, Month, Week) でも列数を誤らない", () => {
    // CSV_HEADER 自体に埋め込みカンマを含む列があるので、ヘッダ検証が通ること自体が
    // クオート対応 CSV パーサの検証になる。
    expect(() => parseInvestorTypeCsv(syntheticCsv([ROW_301_11_SHORT]))).not.toThrow();
  });

  it("未知の帳票種別コードは throw する (捏造で埋めない)", () => {
    const bad = "999,1,2026092,20260907,20260911,11,1,100,-10,90,0,190";
    expect(() => parseInvestorTypeCsv(syntheticCsv([bad]))).toThrow(/未知の帳票種別コード/);
  });

  it("未知の投資部門コードは throw する", () => {
    const bad = "301,1,2026092,20260907,20260911,99,1,100,-10,90,0,190";
    expect(() => parseInvestorTypeCsv(syntheticCsv([bad]))).toThrow(/未知の投資部門コード/);
  });

  it("週次ファイルなのにサイクル区分が1以外なら throw する", () => {
    const bad = "301,2,2026092,20260907,20260911,11,1,100,-10,90,0,190";
    expect(() => parseInvestorTypeCsv(syntheticCsv([bad]))).toThrow(/サイクル区分/);
  });

  it("合計が売+買と一致しないなら throw する", () => {
    const bad = "301,1,2026092,20260907,20260911,11,1,100,-10,90,0,999";
    expect(() => parseInvestorTypeCsv(syntheticCsv([bad]))).toThrow(/合計が売\+買と一致しません/);
  });

  it("売差引・買差引が両方非ゼロなら throw する (符号規則の前提が崩れている)", () => {
    const bad = "301,1,2026092,20260907,20260911,11,1,100,-10,90,5,190";
    expect(() => parseInvestorTypeCsv(syntheticCsv([bad]))).toThrow(/差引が両方非ゼロ/);
  });

  it("列数が想定(12列)と異なるヘッダは throw する (様式変更の検知)", () => {
    const badHeader = "﻿" + '"帳票種別","サイクル区分"';
    expect(() => parseInvestorTypeCsv([badHeader, ROW_301_11_SHORT].join("\n"))).toThrow(
      /ヘッダ列数が想定と異なります/
    );
  });

  it("データ行が0件なら throw する", () => {
    expect(() => parseInvestorTypeCsv("﻿" + CSV_HEADER + "\n")).toThrow(/データ行がありません/);
  });

  it("差引が 買−売 と一致しない (売り越しを正の値で表す等、符号規則が変わった) なら throw する", () => {
    // 売100・買90 (売り越し10) なのに 売-差引 が +10。旧実装は +10 (買い越し) として黙って記録していた。
    const signFlipped = "301,1,2026092,20260907,20260911,11,1,100,10,90,0,190";
    expect(() => parseInvestorTypeCsv(syntheticCsv([signFlipped]))).toThrow(/買 − 売/);
    // 差引が 買−売 以外の意味 (例: 前週比) の値になっている
    const otherMeaning = "301,1,2026092,20260907,20260911,60,1,50,0,60,25,110";
    expect(() => parseInvestorTypeCsv(syntheticCsv([otherMeaning]))).toThrow(/買 − 売/);
  });

  it("1ファイルに複数の対象週が混在していたら throw する", () => {
    const otherWeek = "301,1,2026091,20260831,20260904,60,1,50,0,60,10,110";
    expect(() => parseInvestorTypeCsv(syntheticCsv([ROW_301_11_SHORT, otherWeek]))).toThrow(
      /複数の対象週が混在/
    );
  });

  it("全行の合計が0 (様式変更告知のサンプルCSV等の全ゼロ埋め) なら実データとして返さず throw する", () => {
    const zeroA = "301,1,2026092,20260907,20260911,11,1,0,0,0,0,0";
    const zeroB = "301,1,2026092,20260907,20260911,60,2,0,0,0,0,0";
    expect(() => parseInvestorTypeCsv(syntheticCsv([zeroA, zeroB]))).toThrow(/全行の合計が 0/);
  });

  it("数値列が空欄なら 0 とみなさず throw する (Number(\"\") === 0 による黙った 0 埋めをしない)", () => {
    // 売・買・合計がすべて空欄の行を、旧実装は「売0・買0・合計0 (取引なし)」として記録していた。
    const blankRow = "449,1,2026092,20260907,20260911,21,2,,,,,";
    expect(() => parseInvestorTypeCsv(syntheticCsv([ROW_301_11_SHORT, blankRow]))).toThrow(
      /整数として解釈できない値です: ""/
    );
    const hexRow = "301,1,2026092,20260907,20260911,60,1,0x32,0,60,10,110";
    expect(() => parseInvestorTypeCsv(syntheticCsv([hexRow]))).toThrow(/整数として解釈できない値です/);
  });

  it("前後の空白は表記揺れとして除去して読む (正規化)", () => {
    const spaced = "301,1,2026092,20260907,20260911,60,1, 50 ,0, 60,10,110 ";
    expect(parseInvestorTypeCsv(syntheticCsv([spaced]))[0]).toMatchObject({ sales: 50, purchases: 60, total: 110, netBalance: 10 });
  });

  it("同じ帳票種別×投資部門×数量金額区分の行が重複したら、後勝ちで黙って上書きせず throw する", () => {
    const dup = "301,1,2026092,20260907,20260911,11,1,80,0,90,10,170";
    expect(() => parseInvestorTypeCsv(syntheticCsv([ROW_301_11_SHORT, dup]))).toThrow(/重複しています/);
    // 数量(1) と 代金(2) は別の行として共存できる
    const valueRow = "301,1,2026092,20260907,20260911,11,2,1000,-100,900,0,1900";
    expect(parseInvestorTypeCsv(syntheticCsv([ROW_301_11_SHORT, valueRow]))).toHaveLength(2);
  });

  it("一部の行だけが0なのは正常 (取引の無い商品×投資部門がある)", () => {
    const zeroRow = "449,1,2026092,20260907,20260911,21,1,0,0,0,0,0";
    expect(parseInvestorTypeCsv(syntheticCsv([ROW_301_11_SHORT, zeroRow]))).toHaveLength(2);
  });
});

describe("extractInvestorTypeCsvLinks (一覧ページ HTML からのリンク抽出, synthetic)", () => {
  const HTML = `
    <html><body><table class="overtable fixedhead">
      <tr><td><a href="/markets/statistics-derivatives/sector/t13vrt000001uhci-att/Tousi_DV_W_20260810_20260814.csv">古い週</a></td></tr>
      <tr><td><a href="/markets/statistics-derivatives/sector/t13vrt000001yi1d-att/Tousi_DV_W_20260907_20260911.csv">最新週</a></td></tr>
      <tr><td><a href="/markets/statistics-derivatives/sector/t13vrt000001yi1d-att/Tousi_DV_pdf_W_20260907_20260911.pdf">PDF版(対象外)</a></td></tr>
    </table></body></html>
  `;

  it("periodTo 降順で返し、CSV のみ抽出する (PDF は対象外)", () => {
    const links = extractInvestorTypeCsvLinks(HTML);
    expect(links).toHaveLength(2);
    expect(links[0]).toMatchObject({ periodFrom: "2026-09-07", periodTo: "2026-09-11" });
    expect(links[1]).toMatchObject({ periodFrom: "2026-08-10", periodTo: "2026-08-14" });
    expect(links[0]!.url).toBe(
      "https://www.jpx.co.jp/markets/statistics-derivatives/sector/t13vrt000001yi1d-att/Tousi_DV_W_20260907_20260911.csv"
    );
  });

  it("リンクが1件も無ければ throw する (様式変更の可能性を握り潰さない)", () => {
    expect(() => extractInvestorTypeCsvLinks("<html></html>")).toThrow(/様式変更の可能性/);
  });

  it("様式変更告知に添付された恒久的な「サンプルファイル」リンクは実データの週次リンクと" +
    "区別して除外する (periodTo が実データより新しくても最新週として選ばれない)", () => {
    // 実ページの構造を再現: 実データの週次テーブル行はアイコン画像のみ (リンクテキスト無し)、
    // 様式変更のお知らせに添付されたサンプルは「…サンプルファイル（ＣＳＶ版）」という
    // 可視テキストを持つ (2026-09-27 実機確認: 一覧ページに2026年4月13日告知添付の
    // Tousi_DV_W_20260413_20260417.csv が今も残存している)。
    const html = `
      <html><body>
        <table class="overtable fixedhead">
          <tr>
            <td><a href="/markets/statistics-derivatives/sector/t13vrt000001yi1d-att/Tousi_DV_W_20260907_20260911.csv" rel="external"><img src="icon-csv.png" alt="icon-csv" /></a></td>
          </tr>
        </table>
        <div class="component-column-important">
          <a href="/markets/statistics-derivatives/sector/tvdivq00000020o8-att/Tousi_DV_W_20261001_20261005.csv" class="link-csv" rel="external">「投資部門別取引状況」サンプルファイル（ＣＳＶ版）</a>
        </div>
      </body></html>
    `;
    const links = extractInvestorTypeCsvLinks(html);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ periodFrom: "2026-09-07", periodTo: "2026-09-11" });
  });

  it("同じ対象週に異なる URL の CSV が並んだら、出現順で黙って選ばず throw する", () => {
    const html = `<table>
      <a href="/markets/statistics-derivatives/sector/t13vrt000001yi1d-att/Tousi_DV_W_20260907_20260911.csv" rel="external"><img alt="icon-csv" /></a>
      <a href="/markets/statistics-derivatives/sector/zzzz-att/Tousi_DV_W_20260907_20260911.csv" rel="external"><img alt="icon-csv" /></a>
    </table>`;
    expect(() => extractInvestorTypeCsvLinks(html)).toThrow(/同じ対象週 \(2026-09-11\) の CSV リンクが複数/);
  });

  it("同一 URL の重複掲載は同じファイルなので 1 件にまとめる", () => {
    const a =
      '<a href="/markets/statistics-derivatives/sector/t13vrt000001yi1d-att/Tousi_DV_W_20260907_20260911.csv" rel="external"><img alt="icon-csv" /></a>';
    expect(extractInvestorTypeCsvLinks(`<table>${a}${a}</table>`)).toHaveLength(1);
  });

  it("週次テーブル (<table>) の外にある告知添付ファイルは、リンク文言に「サンプル」が無くても拾わない", () => {
    // 旧実装は「サンプル」という語の有無だけで除外していたため、次回の様式変更告知が
    // 「新様式ファイル」等の文言だと、表の外の告知添付 CSV (日付が新しい) を最新週として
    // 黙って選んでいた。
    const html = `
      <table class="overtable fixedhead"><tr><td>
        <a href="/markets/statistics-derivatives/sector/t13vrt000001yi1d-att/Tousi_DV_W_20260907_20260911.csv" rel="external"><img alt="icon-csv" /></a>
      </td></tr></table>
      <div class="component-column-important">
        <a href="/markets/statistics-derivatives/sector/tvdivq00000020o8-att/Tousi_DV_W_20261201_20261205.csv" class="link-csv" rel="external">「投資部門別取引状況」新様式ファイル（ＣＳＶ版）</a>
      </div>
    `;
    const links = extractInvestorTypeCsvLinks(html);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ periodFrom: "2026-09-07", periodTo: "2026-09-11" });
  });

  it("表の外にしか CSV リンクが無ければ throw する (週次テーブルの様式変更を握り潰さない)", () => {
    const outside =
      '<div><a href="/markets/statistics-derivatives/sector/t13vrt000001yi1d-att/Tousi_DV_W_20260907_20260911.csv" rel="external"><img alt="icon-csv" /></a></div>';
    expect(() => extractInvestorTypeCsvLinks(outside)).toThrow(/週次テーブル .*様式変更の可能性/);
  });
});

// ---------------------------------------------------------------------------
// (2) 指数先物 取引参加者別建玉残高 — フォーマット堅牢性 (synthetic データ)
// ---------------------------------------------------------------------------

// 実xlsxと同じ列レイアウト (0-7:左ブロック, 8-9:空白, 10-17:右ブロック) だけを
// 再現した架空データ。参加者コード・名称・建玉数量は実データではない。
function syntheticOiGrid(dataRows: unknown[][]): unknown[][] {
  return [
    ["指数先物取引参加者別建玉残高"],
    ["（ 2026年09月18日現在 ）"],
    ["2026年09月24日"],
    ["＜日経225先物＞"],
    ["", "", "（売超参加者）", "", "", "（買超参加者）"],
    ...dataRows,
  ];
}

const SYNTHETIC_OI_ROW: unknown[] = [
  1, "2026年12月限月", "90001", "合成証券A", 1000, "90002", "合成証券B", 2000, "", "",
  1, "2027年03月限月", "90003", "合成証券C", 300, "90004", "合成証券D", 400, "", "", "",
];

describe("parseIndexFuturesOiGrid (指数先物建玉残高, synthetic)", () => {
  it("左右2ブロック・売超/買超4件をそれぞれ正しく抽出する", () => {
    const data = parseIndexFuturesOiGrid(syntheticOiGrid([SYNTHETIC_OI_ROW]));
    expect(data.asOfDate).toBe("2026-09-18");
    expect(data.rows).toHaveLength(4);
    expect(data.rows).toContainEqual({
      product: "日経225先物",
      contractMonth: "2026-12",
      rank: 1,
      side: "net_short",
      participantCode: "90001",
      participantName: "合成証券A",
      openInterest: 1000,
    });
    expect(data.rows).toContainEqual({
      product: "日経225先物",
      contractMonth: "2027-03",
      rank: 1,
      side: "net_long",
      participantCode: "90004",
      participantName: "合成証券D",
      openInterest: 400,
    });
  });

  it("参加者不在のセル (コード/名称/数量すべて空) はスキップし、行を捏造しない", () => {
    const rowWithEmptyRightBlock: unknown[] = [
      1, "2026年12月限月", "90001", "合成証券A", 1000, "90002", "合成証券B", 2000, "", "",
      "", "", "", "", "", "", "", "", "", "", "",
    ];
    const data = parseIndexFuturesOiGrid(syntheticOiGrid([rowWithEmptyRightBlock]));
    expect(data.rows).toHaveLength(2);
    expect(data.rows.every((r) => r.contractMonth === "2026-12")).toBe(true);
  });

  it("タイトル行が想定と異なれば throw する", () => {
    const grid = syntheticOiGrid([SYNTHETIC_OI_ROW]);
    grid[0] = ["日経平均オプション取引参加者別建玉残高"];
    expect(() => parseIndexFuturesOiGrid(grid)).toThrow(/タイトル行が想定と異なります/);
  });

  it("基準日表記が想定と異なれば throw する", () => {
    const grid = syntheticOiGrid([SYNTHETIC_OI_ROW]);
    grid[1] = ["2026年09月18日現在"]; // 括弧が無い不正形式
    expect(() => parseIndexFuturesOiGrid(grid)).toThrow(/基準日表記が想定と異なります/);
  });

  it("商品見出しより前にランキング行が出現したら throw する", () => {
    const grid = [
      ["指数先物取引参加者別建玉残高"],
      ["（ 2026年09月18日現在 ）"],
      SYNTHETIC_OI_ROW, // ＜…＞ 見出しが無いままデータ行
    ];
    expect(() => parseIndexFuturesOiGrid(grid)).toThrow(/商品見出し.*より前にランキング行/);
  });

  it("参加者コード/名称/数量が一部だけ欠けていたら throw する (黙って埋めない)", () => {
    const incomplete: unknown[] = [
      1, "2026年12月限月", "90001", "", 1000, "90002", "合成証券B", 2000, "", "",
      "", "", "", "", "", "", "", "", "", "", "",
    ];
    expect(() => parseIndexFuturesOiGrid(syntheticOiGrid([incomplete]))).toThrow(
      /一部だけが欠けています/
    );
  });

  it("限月表記を解釈できなければ throw する", () => {
    const bad: unknown[] = [
      1, "2026年12月", "90001", "合成証券A", 1000, "", "", "", "", "",
      "", "", "", "", "", "", "", "", "", "", "",
    ];
    expect(() => parseIndexFuturesOiGrid(syntheticOiGrid([bad]))).toThrow(/限月表記を解釈できません/);
  });

  it("有効な行が1件も無ければ throw する", () => {
    const grid = [
      ["指数先物取引参加者別建玉残高"],
      ["（ 2026年09月18日現在 ）"],
      ["＜日経225先物＞"],
    ];
    expect(() => parseIndexFuturesOiGrid(grid)).toThrow(/有効な行を1件も抽出できませんでした/);
  });

  it("右ブロックの方がランキング行数の多い週でも、右側の下位 (左ブロックが空の行) を取りこぼさない", () => {
    // 旧実装は左ブロックの順位 (列0) が空の行を丸ごと読み飛ばし、右側の2位を黙って落としていた。
    const rightOnly: unknown[] = [
      "", "", "", "", "", "", "", "", "", "",
      2, "2027年03月限月", "90005", "合成証券E", 200, "90006", "合成証券F", 100, "", "", "",
    ];
    const data = parseIndexFuturesOiGrid(syntheticOiGrid([SYNTHETIC_OI_ROW, rightOnly]));
    expect(data.rows).toHaveLength(6);
    expect(data.rows).toContainEqual({
      product: "日経225先物",
      contractMonth: "2027-03",
      rank: 2,
      side: "net_short",
      participantCode: "90005",
      participantName: "合成証券E",
      openInterest: 200,
    });
  });

  it("限月が読めない (結合セル等) のに参加者の値があるブロックは黙って捨てず throw する", () => {
    // 限月が縦結合され2位以降の行で空セルになる様式を想定。旧実装は2位以降を黙って落としていた。
    const mergedMonthRow: unknown[] = [
      2, "", "90007", "合成証券G", 900, "90008", "合成証券H", 800, "", "",
      "", "", "", "", "", "", "", "", "", "", "",
    ];
    expect(() =>
      parseIndexFuturesOiGrid(syntheticOiGrid([SYNTHETIC_OI_ROW, mergedMonthRow]))
    ).toThrow(/限月 .*が無いブロックに参加者の値があります/);
  });

  it("建玉数量が空白だけのセルを 0 枚として黙って記録せず throw する", () => {
    // 旧実装は hasOi 判定が生値の "" 比較だけで、" " は Number(" ") === 0 として 0 枚になっていた。
    const spaceOi: unknown[] = [
      1, "2026年12月限月", "90001", "合成証券A", " ", "90002", "合成証券B", 2000, "", "",
    ];
    expect(() => parseIndexFuturesOiGrid(syntheticOiGrid([spaceOi]))).toThrow(/一部だけが欠けています/);
  });

  it("建玉数量が負値・小数なら throw する (売超/買超は正の枚数)", () => {
    for (const bad of [-1000, 12.5, "1,000.5"]) {
      const row: unknown[] = [
        1, "2026年12月限月", "90001", "合成証券A", bad, "90002", "合成証券B", 2000, "", "",
      ];
      expect(() => parseIndexFuturesOiGrid(syntheticOiGrid([row]))).toThrow(/非負の整数として解釈できません/);
    }
    const commaRow: unknown[] = [
      1, "2026年12月限月", "90001", "合成証券A", "31,500", "90002", "合成証券B", 2000, "", "",
    ];
    expect(parseIndexFuturesOiGrid(syntheticOiGrid([commaRow])).rows[0]!.openInterest).toBe(31500);
  });

  it("同じ商品・限月・サイド・順位が重複したら throw する (左右ブロックが同じ限月等)", () => {
    const sameMonthBothBlocks: unknown[] = [
      1, "2026年12月限月", "90001", "合成証券A", 1000, "90002", "合成証券B", 2000, "", "",
      1, "2026年12月限月", "90003", "合成証券C", 300, "90004", "合成証券D", 400,
    ];
    expect(() => parseIndexFuturesOiGrid(syntheticOiGrid([sameMonthBothBlocks]))).toThrow(/重複しています/);
  });

  it("順位が無いのに参加者の値があるブロックは黙って捨てず throw する", () => {
    const noRankRow: unknown[] = [
      1, "2026年12月限月", "90001", "合成証券A", 1000, "90002", "合成証券B", 2000, "", "",
      "", "2027年03月限月", "90009", "合成証券I", 50, "", "", "", "", "", "",
    ];
    expect(() => parseIndexFuturesOiGrid(syntheticOiGrid([noRankRow]))).toThrow(
      /順位 .*が無いブロックに参加者の値があります/
    );
  });
});

// ---------------------------------------------------------------------------
// fetch* (ネットワーク層) — fetch を差し替えて、選択・整合検証のロジックだけを確かめる
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("fetchLatestIndexFuturesOiFile (索引 JSON の選択, fetch 差し替え)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("最新年の最新 TradeDate の指数先物ファイルを選ぶ", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      if (url.endsWith("open_interest_yearlist.json")) {
        return jsonResponse({
          UpdateDate: "2026/09/24 15:31",
          TableDatas: [
            { Year: "2025", Jsonfile: "/x/open_interest_2025.json" },
            { Year: "2026", Jsonfile: "/x/open_interest_2026.json" },
          ],
        });
      }
      if (url.endsWith("open_interest_2026.json")) {
        return jsonResponse({
          UpdateDate: "2026/09/24 15:31",
          TableDatas: [
            { TradeDate: "20260911", IndexFutures: "/f/20260911_indexfut_oi_by_tp.xlsx", IndexOptions: "", SecuritiesOptions: "" },
            { TradeDate: "20260918", IndexFutures: "/f/20260918_indexfut_oi_by_tp.xlsx", IndexOptions: "", SecuritiesOptions: "" },
          ],
        });
      }
      return new Response(new Uint8Array([0x50, 0x4b]), { status: 200 });
    });
    const out = await fetchLatestIndexFuturesOiFile();
    expect(out.tradeDate).toBe("2026-09-18");
    expect(out.url).toBe("https://www.jpx.co.jp/f/20260918_indexfut_oi_by_tp.xlsx");
    expect(calls).toHaveLength(3);
  });

  it("Year が YYYY 形式でなければ throw する (NaN 比較で古い年を黙って選ばない)", async () => {
    vi.stubGlobal("fetch", async () =>
      jsonResponse({
        UpdateDate: "2026/09/24 15:31",
        TableDatas: [
          { Year: "2025", Jsonfile: "/x/open_interest_2025.json" },
          { Year: "2026年", Jsonfile: "/x/open_interest_2026.json" },
        ],
      })
    );
    await expect(fetchLatestIndexFuturesOiFile()).rejects.toThrow(/Year が YYYY 形式ではありません/);
  });

  it("TradeDate が YYYYMMDD 形式でなければ throw する", async () => {
    vi.stubGlobal("fetch", async (url: string) =>
      url.endsWith("open_interest_yearlist.json")
        ? jsonResponse({ UpdateDate: "x", TableDatas: [{ Year: "2026", Jsonfile: "/x/open_interest_2026.json" }] })
        : jsonResponse({
            UpdateDate: "x",
            TableDatas: [{ TradeDate: "2026/09/18", IndexFutures: "/f/a.xlsx", IndexOptions: "", SecuritiesOptions: "" }],
          })
    );
    await expect(fetchLatestIndexFuturesOiFile()).rejects.toThrow(/TradeDate が YYYYMMDD 形式ではありません/);
  });
});

describe("fetchLatestInvestorTypeCsvData (一覧→CSV, fetch 差し替え)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const INDEX_HTML = `
    <table class="overtable fixedhead"><tr><td>
      <a href="/markets/statistics-derivatives/sector/t13vrt000001yi1d-att/Tousi_DV_W_20260907_20260911.csv" rel="external"><img alt="icon-csv" /></a>
    </td></tr></table>
    <a href="/markets/statistics-derivatives/sector/tvdivq00000020o8-att/Tousi_DV_W_20261001_20261005.csv" class="link-csv" rel="external">「投資部門別取引状況」サンプルファイル（ＣＳＶ版）</a>
  `;

  it("サンプルリンクの日付の方が新しくても、実データの最新週 CSV を取得・解析する", async () => {
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      fetched.push(url);
      if (url.endsWith("/sector/index.html")) return new Response(INDEX_HTML, { status: 200 });
      return new Response(syntheticCsv([ROW_301_11_SHORT, ROW_301_60_LONG]), { status: 200 });
    });
    const data = await fetchLatestInvestorTypeCsvData();
    expect(data.link.periodTo).toBe("2026-09-11");
    expect(data.rows).toHaveLength(2);
    expect(fetched[1]).toContain("Tousi_DV_W_20260907_20260911.csv");
  });

  it("ファイル名の対象週と CSV 内の対象週が違えば throw する", async () => {
    const otherWeek = "301,1,2026091,20260831,20260904,60,1,50,0,60,10,110";
    vi.stubGlobal("fetch", async (url: string) =>
      url.endsWith("/sector/index.html")
        ? new Response(INDEX_HTML, { status: 200 })
        : new Response(syntheticCsv([otherWeek]), { status: 200 })
    );
    await expect(fetchLatestInvestorTypeCsvData()).rejects.toThrow(/ファイル名の対象週 .* と CSV 内の対象週 .* が一致しません/);
  });
});

// ---------------------------------------------------------------------------
// 期間・公表判定
// ---------------------------------------------------------------------------

describe("isPeriodNotYetPublished", () => {
  it("target が latestAvailable より新しければ true (まだ公表されていない)", () => {
    expect(
      isPeriodNotYetPublished({ target: "2026-09-18", latestAvailable: "2026-09-11" })
    ).toBe(true);
  });
  it("target が latestAvailable 以下なら false (公表済み)", () => {
    expect(
      isPeriodNotYetPublished({ target: "2026-09-11", latestAvailable: "2026-09-11" })
    ).toBe(false);
    expect(
      isPeriodNotYetPublished({ target: "2026-09-04", latestAvailable: "2026-09-11" })
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 指標定義・観測ログ変換・アーカイブ入力
// ---------------------------------------------------------------------------

describe("INDICATOR_DEFINITIONS", () => {
  it("3指標を要件R3・出典URL・利用条件つきで定義している", () => {
    expect(INDICATOR_DEFINITIONS).toHaveLength(3);
    for (const def of INDICATOR_DEFINITIONS) {
      expect(def.requirements).toContain("R3");
      expect(def.sourceUrl).toMatch(/^https:\/\/www\.jpx\.co\.jp\//);
      expect(def.usageTerms).toMatch(/personal-only|商用/);
      expect(def.limitations.length).toBeGreaterThan(0);
    }
    const keys = INDICATOR_DEFINITIONS.map((d) => d.key);
    expect(keys).toEqual([
      INDICATOR_NET_BALANCE_KEY,
      INDICATOR_GROSS_TURNOVER_KEY,
      INDICATOR_FUTURES_OI_KEY,
    ]);
  });

  it("定義文に誤った/未定義の概念を持ち込まない (ルール7: 定義は財務的に正確に)", () => {
    const byKey = new Map(INDICATOR_DEFINITIONS.map((d) => [d.key, d]));
    const all = (key: string): string => {
      const d = byKey.get(key);
      if (!d) throw new Error(`指標定義がありません: ${key}`);
      return [d.plainDescription, d.definition, ...d.limitations].join("\n");
    };
    // 差引は JPX ガイドに無い「基準値」との差ではなく (買 − 売)
    expect(all(INDICATOR_NET_BALANCE_KEY)).not.toMatch(/基準値/);
    expect(all(INDICATOR_NET_BALANCE_KEY)).toMatch(/\(買取引高又は買代金\) − \(売取引高又は売代金\)/);
    // 取引所の先物・オプションは「相対取引」(店頭の1対1の取引) ではない
    expect(all(INDICATOR_NET_BALANCE_KEY)).not.toMatch(/相対取引/);
    // 建玉ランキングの数量は売超/買超 (売建玉と買建玉の差引) であり総建玉ではない
    expect(all(INDICATOR_FUTURES_OI_KEY)).toMatch(/差引/);
    expect(all(INDICATOR_FUTURES_OI_KEY)).not.toMatch(/『売り建玉が多い順』/);
  });
});

describe("investorTypeRowsToObservations", () => {
  it("1行から純売買・グロス売買代金の2観測レコードを作る", () => {
    const rows = parseInvestorTypeCsv(syntheticCsv([ROW_301_11_SHORT]));
    const obs = investorTypeRowsToObservations(rows);
    expect(obs).toHaveLength(2);
    expect(obs[0]).toMatchObject({
      period: "2026-09-11",
      periodType: "week",
      indicatorKey: INDICATOR_NET_BALANCE_KEY,
      segment: "日経225先物｜自己｜数量",
      value: -10,
      unit: "枚",
      isApproximate: false,
      measurement: "actual",
    });
    expect(obs[1]).toMatchObject({
      indicatorKey: INDICATOR_GROSS_TURNOVER_KEY,
      value: 190,
    });
  });
});

describe("indexFuturesOiToObservations", () => {
  it("建玉残高の行を観測レコードへ変換する", () => {
    const data = parseIndexFuturesOiGrid(syntheticOiGrid([SYNTHETIC_OI_ROW]));
    const obs = indexFuturesOiToObservations(data);
    expect(obs).toHaveLength(4);
    expect(obs).toContainEqual({
      period: "2026-09-18",
      periodType: "week",
      indicatorKey: INDICATOR_FUTURES_OI_KEY,
      segment: "日経225先物｜2026-12限月｜売超1位｜合成証券A",
      value: 1000,
      unit: "枚",
      isApproximate: false,
      measurement: "actual",
    });
  });
});

describe("investorTypeCsvArchiveInput / indexFuturesOiArchiveInput (ルール6)", () => {
  it("投資部門別CSV: 週次冪等キー + CSV実体で記録入力を組む", () => {
    const rows = parseInvestorTypeCsv(syntheticCsv([ROW_301_11_SHORT]));
    const csvBytes = new Uint8Array([0x74, 0x65, 0x73, 0x74]);
    const data: InvestorTypeCsvData = {
      link: {
        url: "https://www.jpx.co.jp/x/Tousi_DV_W_20260907_20260911.csv",
        periodFrom: "2026-09-07",
        periodTo: "2026-09-11",
      },
      rows,
      csvBytes,
    };
    const input = investorTypeCsvArchiveInput(data);
    expect(input.service).toBe("moneyflow");
    expect(input.key).toBe("jpx-deriv-investor-2026-09-11");
    expect(input.source).toBe(data.link.url);
    expect(input.metadata).toMatchObject({ periodFrom: "2026-09-07", periodTo: "2026-09-11", rowCount: 1 });
    expect(input.files).toHaveLength(1);
    expect(input.files[0]!.filename).toBe("jpx-deriv-investor-2026-09-11.csv");
    expect(input.files[0]!.bytes).toBe(csvBytes);
  });

  it("建玉残高: 週次冪等キー + xlsx実体で記録入力を組む", () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    const input = indexFuturesOiArchiveInput({
      tradeDate: "2026-09-18",
      url: "https://www.jpx.co.jp/x/20260918_indexfut_oi_by_tp.xlsx",
      xlsxBytes: bytes,
      rowCount: 4,
    });
    expect(input.service).toBe("moneyflow");
    expect(input.key).toBe("jpx-futures-oi-indexfut-2026-09-18");
    expect(input.metadata).toMatchObject({ tradeDate: "2026-09-18", rowCount: 4 });
    expect(input.files[0]!.filename).toBe("jpx-futures-oi-indexfut-2026-09-18.xlsx");
    expect(input.files[0]!.bytes).toBe(bytes);
  });
});

// ---------------------------------------------------------------------------
// 実フィクスチャによる既知値検証 (fixture 未取得環境では skip する)
// ---------------------------------------------------------------------------

describe.skipIf(!hasCsvFixture)("実フィクスチャ: 投資部門別取引状況 CSV (2026-09-07〜09-11週)", () => {
  const csvText = hasCsvFixture ? readFileSync(CSV_FIXTURE, "utf8") : "";
  const rows: ReturnType<typeof parseInvestorTypeCsv> = hasCsvFixture
    ? parseInvestorTypeCsv(csvText)
    : [];

  it("全1,760行を解析できる (2026-09-27 実機取得時点の実測行数)", () => {
    expect(rows).toHaveLength(1760);
  });

  it("既知値1: 日経225先物・自己・数量 は 売161,521/買153,856/合計315,377/純売買-7,665 (原本CSV該当行を目視確認)", () => {
    const r = rows.find((x) => x.productCode === "301" && x.investorCode === "11" && x.metric === "volume");
    expect(r).toMatchObject({ sales: 161521, purchases: 153856, total: 315377, netBalance: -7665 });
  });

  it("既知値2: 日経225先物・海外投資家・数量 は 売351,234/買359,577/合計710,811/純売買+8,343 (原本CSV該当行を目視確認)", () => {
    const r = rows.find((x) => x.productCode === "301" && x.investorCode === "60" && x.metric === "volume");
    expect(r).toMatchObject({ sales: 351234, purchases: 359577, total: 710811, netBalance: 8343 });
  });

  it("既知値3: 日経225先物・個人・代金(円) は 売986,745,217,800/買1,035,027,202,700/純売買+48,281,984,900 (原本CSV該当行を目視確認)", () => {
    const r = rows.find((x) => x.productCode === "301" && x.investorCode === "51" && x.metric === "value");
    expect(r).toMatchObject({
      sales: 986745217800,
      purchases: 1035027202700,
      total: 2021772420500,
      netBalance: 48281984900,
    });
  });

  it("対象期間は 2026-09-07 〜 2026-09-11", () => {
    expect(rows[0]).toMatchObject({ periodFrom: "2026-09-07", periodTo: "2026-09-11" });
  });
});

describe.skipIf(!hasOiFixture)("実フィクスチャ: 指数先物 取引参加者別建玉残高 (2026-09-18現在)", () => {
  const data: IndexFuturesOiData = hasOiFixture
    ? parseIndexFuturesOiWorkbook(readFileSync(OI_FIXTURE))
    : { asOfDate: "", rows: [] };

  it("基準日は 2026-09-18 (ファイル名・ヘッダ表記と一致)", () => {
    expect(data.asOfDate).toBe("2026-09-18");
  });

  it("既知値1: 日経225先物 2026年12月限月 売超1位はＨＳＢＣ証券 31,500枚 (原本xlsxを目視確認)", () => {
    expect(data.rows).toContainEqual({
      product: "日経225先物",
      contractMonth: "2026-12",
      rank: 1,
      side: "net_short",
      participantCode: "12724",
      participantName: "ＨＳＢＣ証券",
      openInterest: 31500,
    });
  });

  it("既知値2: 日経225先物 2026年12月限月 買超1位は野村証券 33,866枚 (原本xlsxを目視確認)", () => {
    expect(data.rows).toContainEqual({
      product: "日経225先物",
      contractMonth: "2026-12",
      rank: 1,
      side: "net_long",
      participantCode: "12400",
      participantName: "野村証券",
      openInterest: 33866,
    });
  });

  it("既知値3: TOPIX先物 2026年12月限月 売超1位はゴールドマン証券 53,241枚 (原本xlsxを目視確認)", () => {
    expect(data.rows).toContainEqual({
      product: "TOPIX先物",
      contractMonth: "2026-12",
      rank: 1,
      side: "net_short",
      participantCode: "11560",
      participantName: "ゴールドマン証券",
      openInterest: 53241,
    });
  });

  it("既知値4: TOPIX先物 2026年12月限月 買超1位はシティグループ証券 63,708枚 (原本xlsxを目視確認)", () => {
    expect(data.rows).toContainEqual({
      product: "TOPIX先物",
      contractMonth: "2026-12",
      rank: 1,
      side: "net_long",
      participantCode: "11792",
      participantName: "シティグループ証券",
      openInterest: 63708,
    });
  });
});
