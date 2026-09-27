/**
 * services/moneyflow/lib/sources/jpx-investor-equity.ts の単体テスト。
 *
 * フィクスチャは 2026-09-27 に JPX の実サイト
 * (https://www.jpx.co.jp/markets/statistics-equities/investor-type/) から
 * ブラウザ相当 UA で実際に取得した実ファイルそのもの (合成データではない)。
 * 検証している数値は、下記フィクスチャファイルを Excel 等で直接開いて目視で
 * 確認できる値と一致する (このテストのコメントに原本上のシート名・行を明記)。
 *
 * 唯一の例外は `unified-format-sample-jpx-official.xlsx` — これは JPX が
 * 2026-09-29 の様式変更を予告する一覧ページに掲載している「サンプルファイル」
 * そのもの (ファイル名も `YYYYMMDD` の未置換プレースホルダで、JPX 自身が
 * 「サンプル」と明記している仕様サンプル)。実データではないため、このテストでは
 * 「新様式パーサが JPX 公式サンプルの構造を正しく読める」ことのみを検証し、
 * period{Start,End} は null (ファイル名から復元不能) であることも確認する。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import {
  JPX_INVESTOR_EQUITY_INDICATORS,
  KNOWN_LIMITATIONS,
  latestWeeklyEntry,
  parseInvestorEquityWorkbook,
  parseJpxAmount,
  parseMonthlyIndexHtml,
  parseUnifiedFilenamePeriod,
  parseWeeklyIndexHtml,
  pickLatestPublishedMonth,
  toObservationRows,
  type InvestorEquityRecord,
} from "./jpx-investor-equity.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "jpx-investor-equity");

function loadBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES, name)));
}
function loadText(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf-8");
}

function find(
  records: readonly InvestorEquityRecord[],
  market: InvestorEquityRecord["market"],
  category: string
): InvestorEquityRecord {
  const rec = records.find((r) => r.market === market && r.investorCategory === category);
  if (!rec) {
    throw new Error(`テストフィクスチャに ${market}/${category} が見つかりません`);
  }
  return rec;
}

describe("parseJpxAmount", () => {
  it("カンマ区切り文字列を数値化する", () => {
    expect(parseJpxAmount("5,349,098,396")).toBe(5349098396);
  });
  it("▲ をマイナスとして扱う", () => {
    expect(parseJpxAmount("▲ 68,115,353")).toBe(-68115353);
  });
  it("数値型はそのまま返す", () => {
    expect(parseJpxAmount(1234)).toBe(1234);
  });
  it("空文字は throw する (フォールバック禁止)", () => {
    expect(() => parseJpxAmount("")).toThrow();
  });
  it("解釈不能な文字列は throw する", () => {
    expect(() => parseJpxAmount("N/A")).toThrow();
  });
});

describe("旧様式パーサ: 週次 (2026年9月第2週 9/7-9/11, 実ファイル)", () => {
  const valueBytes = loadBytes("weekly-value-2026-w2-0907-0911.xls");
  const volumeBytes = loadBytes("weekly-volume-2026-w2-0907-0911.xls");
  const valueRecords = parseInvestorEquityWorkbook(valueBytes, "stock_val_1_260902.xls");
  const volumeRecords = parseInvestorEquityWorkbook(volumeBytes, "stock_vol_1_260902.xls");

  it("期間・様式を正しく判定する", () => {
    const rec = find(valueRecords, "TSE Prime", "自己計");
    expect(rec.formatVersion).toBe("legacy_split_files");
    expect(rec.periodType).toBe("weekly");
    expect(rec.periodLabel).toBe("2026年9月第2週");
    expect(rec.periodStart).toBe("2026-09-07");
    expect(rec.periodEnd).toBe("2026-09-11");
    expect(rec.metric).toBe("value");
    expect(rec.unit).toBe("thousand_yen");
  });

  it("原本 (TSE Prime シート) の実測値と一致する: 自己計・委託計・総計", () => {
    // フィクスチャを Excel で開き、シート "TSE Prime" 行12-20 (右側=今週ブロック) を
    // 目視確認した値。
    const proprietary = find(valueRecords, "TSE Prime", "自己計");
    expect(proprietary.sell).toBe(5349098396);
    expect(proprietary.buy).toBe(5659975243);
    expect(proprietary.total).toBe(11009073639);
    expect(proprietary.net).toBe(5659975243 - 5349098396);

    const brokerage = find(valueRecords, "TSE Prime", "委託計");
    expect(brokerage.sell).toBe(42450622602);
    expect(brokerage.buy).toBe(42124207788);

    const total = find(valueRecords, "TSE Prime", "総計");
    expect(total.sell).toBe(47799720998);
    expect(total.buy).toBe(47784183031);
    expect(total.total).toBe(95583904029);
  });

  it("原本の実測値と一致する: 委託内訳・法人内訳・金融機関内訳", () => {
    expect(find(valueRecords, "TSE Prime", "海外投資家").sell).toBe(28570404573);
    expect(find(valueRecords, "TSE Prime", "海外投資家").buy).toBe(28295470330);
    expect(find(valueRecords, "TSE Prime", "個人").sell).toBe(11296015753);
    expect(find(valueRecords, "TSE Prime", "個人").buy).toBe(11722484832);
    expect(find(valueRecords, "TSE Prime", "投資信託").buy).toBe(650422935);
    expect(find(valueRecords, "TSE Prime", "信託銀行").sell).toBe(1074253395);
  });

  it("原本 (Tokyo & Nagoya / 株数) の実測値と一致する", () => {
    const total = find(volumeRecords, "Tokyo & Nagoya", "総計");
    expect(total.total).toBe(35820577);
    expect(total.unit).toBe("thousand_shares");
    expect(total.metric).toBe("volume");
  });

  it("isAggregateCategory が既知の集計行にのみ立つ", () => {
    expect(find(valueRecords, "TSE Prime", "自己計").isAggregateCategory).toBe(true);
    expect(find(valueRecords, "TSE Prime", "海外投資家").isAggregateCategory).toBe(false);
  });

  it("4市場 × 15投資部門 = 60レコード/ファイル", () => {
    expect(valueRecords.length).toBe(4 * 15);
  });
});

describe("旧様式パーサ: 週次 (2026年9月第1週 8/31-9/4, 月またぎ, 実ファイル)", () => {
  it("開始日が前月・終了日が当月でも年をまたがず正しく解決する", () => {
    const bytes = loadBytes("weekly-value-2026-w1-0831-0904.xls");
    const records = parseInvestorEquityWorkbook(bytes, "stock_val_1_260901.xls");
    const rec = find(records, "TSE Prime", "自己計");
    expect(rec.periodLabel).toBe("2026年9月第1週");
    expect(rec.periodStart).toBe("2026-08-31");
    expect(rec.periodEnd).toBe("2026-09-04");
  });
});

describe("旧様式パーサ: 月次 (2026年8月, 実ファイル)", () => {
  const valueBytes = loadBytes("monthly-value-2026-08.xls");
  const records = parseInvestorEquityWorkbook(valueBytes, "stock_val_1_m2608.xls");

  it("期間 (月次・単一ブロック) を正しく判定する", () => {
    const rec = find(records, "TSE Prime", "自己計");
    expect(rec.periodType).toBe("monthly");
    expect(rec.periodLabel).toBe("2026年8月");
    expect(rec.periodStart).toBe("2026-08-03");
    expect(rec.periodEnd).toBe("2026-08-28");
  });

  it("原本 (TSE Prime シート) の実測値と一致する", () => {
    const proprietary = find(records, "TSE Prime", "自己計");
    expect(proprietary.sell).toBe(18077441828);
    expect(proprietary.buy).toBe(18547327192);
    expect(proprietary.total).toBe(36624769020);

    const institutions = find(records, "TSE Prime", "法人");
    expect(institutions.sell).toBe(9660474336);
    expect(institutions.buy).toBe(10257358034);
  });

  it("原本 (Tokyo & Nagoya シート) の実測値と一致する", () => {
    const total = find(records, "Tokyo & Nagoya", "総計");
    expect(total.total).toBe(407516356670);
  });

  it("isAggregateCategory が15投資部門すべてで正しい (法人・金融機関も集計行)", () => {
    // 実ファイル (monthly-value-2026-08.xls, TSE Prime シート) を目視確認した実測値で、
    // 「法人」が「金融機関」と全く同じ構造 (自分の子カテゴリの合算) の集計行であることを
    // 検証する。isAggregateCategory=false の行だけを合算して市場合計を作るような
    // 下流集計コードが、法人とその子を二重計上しないための回帰テスト。
    const byLabel = (label: string) => find(records, "TSE Prime", label);
    const aggregateLabels = ["自己計", "委託計", "総計", "法人", "金融機関"];
    const leafLabels = [
      "個人",
      "海外投資家",
      "証券会社",
      "投資信託",
      "事業法人",
      "その他法人等",
      "生保・損保",
      "都銀・地銀等",
      "信託銀行",
      "その他金融機関",
    ];
    for (const label of aggregateLabels) {
      expect(byLabel(label).isAggregateCategory).toBe(true);
    }
    for (const label of leafLabels) {
      expect(byLabel(label).isAggregateCategory).toBe(false);
    }
    // 全15投資部門を網羅していることの確認 (4市場×15=60レコードは既存テストで検証済み)
    expect(aggregateLabels.length + leafLabels.length).toBe(15);
  });

  it("委託計=法人+個人+海外投資家+証券会社、法人=投資信託+事業法人+その他法人等+金融機関、" +
    "金融機関=生保・損保+都銀・地銀等+信託銀行+その他金融機関、総計=自己計+委託計 (sum恒等式)", () => {
    const byLabel = (label: string) => find(records, "TSE Prime", label);
    const sumSellBuy = (labels: string[]) =>
      labels.reduce(
        (acc, l) => ({ sell: acc.sell + byLabel(l).sell, buy: acc.buy + byLabel(l).buy }),
        { sell: 0, buy: 0 }
      );

    const brokerageParts = sumSellBuy(["法人", "個人", "海外投資家", "証券会社"]);
    expect(brokerageParts).toEqual({ sell: byLabel("委託計").sell, buy: byLabel("委託計").buy });

    const institutionParts = sumSellBuy(["投資信託", "事業法人", "その他法人等", "金融機関"]);
    expect(institutionParts).toEqual({ sell: byLabel("法人").sell, buy: byLabel("法人").buy });

    const financialParts = sumSellBuy(["生保・損保", "都銀・地銀等", "信託銀行", "その他金融機関"]);
    expect(financialParts).toEqual({ sell: byLabel("金融機関").sell, buy: byLabel("金融機関").buy });

    const totalParts = sumSellBuy(["自己計", "委託計"]);
    expect(totalParts).toEqual({ sell: byLabel("総計").sell, buy: byLabel("総計").buy });
  });
});

describe("新様式パーサ (JPX公式サンプルファイル。実データではない仕様サンプル)", () => {
  const bytes = loadBytes("unified-format-sample-jpx-official.xlsx");
  // サンプルはファイル名が "stock_1_w_YYYYMMDD_YYYYMMDD.xlsx" のまま (未置換) なので
  // periodStart/periodEnd は復元できず null になる想定。
  const records = parseInvestorEquityWorkbook(bytes, "stock_1_w_YYYYMMDD_YYYYMMDD.xlsx");

  it("様式を unified と判定し、期間ラベルは復元できるが実日付は null になる", () => {
    const rec = find(records, "TSE Prime", "自己現金");
    expect(rec.formatVersion).toBe("unified_single_file");
    expect(rec.periodLabel).toBe("2026年4月第1週");
    expect(rec.periodStart).toBeNull();
    expect(rec.periodEnd).toBeNull();
  });

  it("サンプル原本の値と一致する (TSE Prime, 自己現金, 株数/金額)", () => {
    const volumeRec = records.find(
      (r) => r.market === "TSE Prime" && r.investorCategory === "自己現金" && r.metric === "volume"
    );
    const valueRec = records.find(
      (r) => r.market === "TSE Prime" && r.investorCategory === "自己現金" && r.metric === "value"
    );
    expect(volumeRec?.sell).toBe(2282656000);
    expect(volumeRec?.buy).toBe(1826950000);
    expect(valueRec?.sell).toBe(6094207109000);
    expect(valueRec?.buy).toBe(4740824669000);
  });

  it("14カテゴリ × 4市場 × 2指標 = 112レコード", () => {
    expect(records.length).toBe(14 * 4 * 2);
  });
});

describe("月次専用の新様式サンプル (2026-10-08 掲載分から予告。週次の新様式(2026-09-29)とは" +
  "別建てのJPX公式サンプル。実データではなく仕様サンプル)", () => {
  it("ヘッダ行が「年月週」ではなく「年月」で始まる別レイアウトのため、現行の" +
    "parseUnifiedSheet(週次新様式用)はヘッダ行を検知できず throw する " +
    "(フォールバックして誤った値を返さない。ルール2)", () => {
    const bytes = loadBytes("monthly-unified-sample-jpx-official.xlsx");
    expect(() => parseInvestorEquityWorkbook(bytes, "stock_1_mYYYYMM.xlsx")).toThrow(
      /ヘッダ行/
    );
  });
});

describe("parseUnifiedFilenamePeriod", () => {
  it("実ファイル名からISO日付を復元する", () => {
    expect(parseUnifiedFilenamePeriod("stock_1_w_20261005_20261009.xlsx")).toEqual({
      periodStart: "2026-10-05",
      periodEnd: "2026-10-09",
    });
  });
  it("サンプルの未置換プレースホルダ名は null を返す (捏造しない)", () => {
    expect(parseUnifiedFilenamePeriod("stock_1_w_YYYYMMDD_YYYYMMDD.xlsx")).toBeNull();
  });
});

describe("様式が想定と違えば throw する", () => {
  it("シート構成が旧様式・新様式のどちらとも一致しないブックは throw する", () => {
    // 2シート (旧様式=4シート、新様式=1シートのいずれとも一致しない)
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["dummy"]]), "SheetA");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["dummy"]]), "SheetB");
    const bytes = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }));
    expect(() => parseInvestorEquityWorkbook(bytes)).toThrow(/未知のブック形式/);
  });

  it("4シート名が旧様式と一致しても中身のタイトル行が想定外なら throw する", () => {
    const wb = XLSX.utils.book_new();
    for (const name of ["TSE Prime", "TSE Standard", "TSE Growth", "Tokyo & Nagoya"]) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["想定外のタイトル"]]), name);
    }
    const bytes = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }));
    expect(() => parseInvestorEquityWorkbook(bytes)).toThrow(/\[金額\]\/\[株数\]/);
  });

  it("週次一覧ページの様式が変わって想定した行が無ければ throw する", () => {
    expect(() => parseWeeklyIndexHtml("<html><body>no rows here</body></html>")).toThrow(
      /様式変更/
    );
  });

  it("月次一覧ページの様式が変わって年見出しが無ければ throw する", () => {
    expect(() => parseMonthlyIndexHtml("<html><body>no header</body></html>")).toThrow(
      /様式変更/
    );
  });
});

describe("週次一覧ページの解析 (実ページ, 2026-09-27時点)", () => {
  const html = loadText("weekly-index-2026-09-27.html");
  const entries = parseWeeklyIndexHtml(html);

  it("最新行 (2026年9月第2週) が先頭に来る", () => {
    const latest = latestWeeklyEntry(entries);
    expect(latest.label).toContain("2026年9月第2週");
    expect(latest.valueXlsUrl).toContain("stock_val_1_260902.xls");
    expect(latest.volumeXlsUrl).toContain("stock_vol_1_260902.xls");
  });

  it("過去の週も後続に列挙される (2026年8月第2週まで確認)", () => {
    const labels = entries.map((e) => e.label);
    expect(labels.some((l) => l.includes("2026年8月第2週"))).toBe(true);
  });
});

describe("月次一覧ページの解析: まだ公表されていない月の判定 (実ページ, 2026-09-27時点)", () => {
  const html = loadText("monthly-index-2026-09-27.html");
  const entries = parseMonthlyIndexHtml(html);

  it("2026年1〜8月は公表済み、9〜12月は未公表(リンク無し)と判定する", () => {
    const publishedMonths = entries.filter((e) => e.valueXlsUrl !== null).map((e) => e.month);
    const unpublishedMonths = entries.filter((e) => e.valueXlsUrl === null).map((e) => e.month);
    expect(publishedMonths).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(unpublishedMonths).toEqual([9, 10, 11, 12]);
    // volume(株数)側も同じ月だけ公表されている
    expect(entries.filter((e) => e.volumeXlsUrl !== null).map((e) => e.month)).toEqual(
      publishedMonths
    );
  });

  it("pickLatestPublishedMonth は8月 (直近の公表済み月) を返す", () => {
    const latest = pickLatestPublishedMonth(entries);
    expect(latest.year).toBe(2026);
    expect(latest.month).toBe(8);
    expect(latest.valueXlsUrl).toContain("stock_val_1_m2608.xls");
  });

  it("全月未公表なら throw する", () => {
    const allUnpublished = entries.map((e) => ({ ...e, valueXlsUrl: null, volumeXlsUrl: null }));
    expect(() => pickLatestPublishedMonth(allUnpublished)).toThrow(/公表されていません/);
  });

  it("最新月が片方の指標だけ公表なら throw する (想定外の部分公開)", () => {
    const partial = entries.map((e) =>
      e.month === 8 ? { ...e, volumeXlsUrl: null } : e
    );
    expect(() => pickLatestPublishedMonth(partial)).toThrow(/一方のみ公表/);
  });
});

describe("指標定義 (JPX_INVESTOR_EQUITY_INDICATORS)", () => {
  it("キーが一意で、必須フィールドが揃っている", () => {
    const keys = JPX_INVESTOR_EQUITY_INDICATORS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const def of JPX_INVESTOR_EQUITY_INDICATORS) {
      expect(def.explanation.length).toBeGreaterThan(0);
      expect(def.definition.length).toBeGreaterThan(0);
      expect(def.sourceUrl).toMatch(/^https:\/\/www\.jpx\.co\.jp\//);
      expect(def.requirement.length).toBeGreaterThan(0);
    }
  });

  it("net_flow と gross_turnover の両方をカバーする", () => {
    const kinds = new Set(JPX_INVESTOR_EQUITY_INDICATORS.map((d) => d.measures));
    expect(kinds.has("net_flow")).toBe(true);
    expect(kinds.has("gross_turnover")).toBe(true);
  });
});

describe("toObservationRows (観測ログ用の縦長レコード)", () => {
  it("1レコードにつき net_flow・gross_turnover の2行を出す", () => {
    const bytes = loadBytes("weekly-value-2026-w2-0907-0911.xls");
    const records = parseInvestorEquityWorkbook(bytes, "stock_val_1_260902.xls");
    const rows = toObservationRows(records);
    expect(rows.length).toBe(records.length * 2);

    const rec = find(records, "TSE Prime", "海外投資家");
    const netRow = rows.find(
      (r) =>
        r.indicatorKey === "jpx_investor_equity_net_flow_value" &&
        r.marketSegment === "TSE Prime" &&
        r.breakdownValue === "海外投資家"
    );
    expect(netRow?.value).toBe(rec.net);
    expect(netRow?.breakdownKind).toBe("investor_type");
    expect(netRow?.isApproximate).toBe(false);
    expect(netRow?.isEstimated).toBe(false);

    const grossRow = rows.find(
      (r) =>
        r.indicatorKey === "jpx_investor_equity_gross_turnover_value" &&
        r.marketSegment === "TSE Prime" &&
        r.breakdownValue === "海外投資家"
    );
    expect(grossRow?.value).toBe(rec.total);
  });
});

describe("KNOWN_LIMITATIONS", () => {
  it("空でない説明文の配列である", () => {
    expect(KNOWN_LIMITATIONS.length).toBeGreaterThan(0);
    for (const l of KNOWN_LIMITATIONS) {
      expect(l.length).toBeGreaterThan(0);
    }
  });
});
