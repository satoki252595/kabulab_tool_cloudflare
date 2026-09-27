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
 *
 * 末尾の「再検証で追加した回帰テスト」の様式変更検知テストは、実ファイル/実ページの
 * 1セル・1行だけをテスト内で書き換えた入力を使う (`mutateCell` 等。書き換えた箇所は
 * 各テストに明記)。これは「想定外の様式なら throw する」ことを確かめるための入力で、
 * 数値の正しさの根拠には使っていない (数値の検証は書き換えない実ファイルのみで行う)。
 *
 * JPX の統計・ページは personal-only (再配布不可) のため、フィクスチャは
 * `fixtures/private/jpx-investor-equity/` (gitignore 済み) に置き commit しない。
 * 未取得の環境 (CI) では実ファイル/実ページを読むテストだけ `describe.skipIf` で
 * skip し、合成データ・指標定義のテストは常に走らせる。describe 直下の読み込みは
 * skip 時にも評価されるため、すべて beforeAll で行う。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import {
  JPX_INVESTOR_EQUITY_INDICATORS,
  KNOWN_LIMITATIONS,
  jpxInvestorEquityArchiveInput,
  latestWeeklyEntry,
  mergeValueAndVolumeRecords,
  parseInvestorEquityWorkbook,
  parseJpxAmount,
  parseMonthlyIndexHtml,
  parseUnifiedFilenamePeriod,
  parseWeeklyIndexHtml,
  pickLatestPublishedMonth,
  toObservationRows,
  type FetchedInvestorEquity,
  type InvestorEquityRecord,
} from "./jpx-investor-equity.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "private", "jpx-investor-equity");
const FIXTURE_NAMES = [
  "monthly-index-2026-09-27.html",
  "monthly-unified-sample-jpx-official.xlsx",
  "monthly-value-2026-08.xls",
  "monthly-volume-2026-08.xls",
  "unified-format-sample-jpx-official.xlsx",
  "weekly-index-2026-09-27.html",
  "weekly-value-2026-w1-0831-0904.xls",
  "weekly-value-2026-w2-0907-0911.xls",
  "weekly-volume-2026-w1-0831-0904.xls",
  "weekly-volume-2026-w2-0907-0911.xls",
];
const hasFixtures = FIXTURE_NAMES.every((name) => existsSync(join(FIXTURES, name)));

function loadBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES, name)));
}
function loadText(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf-8");
}

/** 実ファイルの1セルだけを書き換えたブックを返す (様式変更検知のテスト用。
 *  書き換えるセル以外はすべて実ファイルのまま)。 */
function mutateCell(name: string, sheetName: string, address: string, value: string): Uint8Array {
  const wb = XLSX.read(loadBytes(name), { type: "array" });
  const sheet = wb.Sheets[sheetName];
  if (!sheet) throw new Error(`テストフィクスチャ ${name} にシート ${sheetName} がありません`);
  sheet[address] = { t: "s", v: value };
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }));
}

/** JPX 公式の新様式サンプル (週次) を、見出しの単位「千株/千円」に合わせて数値セルを
 *  1/1000 にしたブックを返す。サンプルは全数値セルが 1000 の倍数で、見出しどおり千円と
 *  して読むと桁がありえない (週次プライム自己現金の売りだけで約6,000兆円) — つまり値は
 *  円/株単位のまま。パーサはそれを桁の検査で throw する (下の「桁の検査」テスト) ので、
 *  列位置・見出し・差引の符号・マージ展開といった構造の検証には、単位と桁が整合する
 *  入力として全数値セルを 1000 で割ったもの (原本の値の単位換算そのもの。割り切れない
 *  セルがあれば throw) を使う。年月週コード (A列) は数値でも割らない。 */
function unifiedSampleScaledWorkbook(): XLSX.WorkBook {
  const wb = XLSX.read(loadBytes("unified-format-sample-jpx-official.xlsx"), { type: "array" });
  const sheet = wb.Sheets["sheet1"];
  if (!sheet) throw new Error("sample sheet1 がありません");
  let scaled = 0;
  for (const [address, cell] of Object.entries(sheet)) {
    if (address.startsWith("!") || typeof cell !== "object" || cell === null) continue;
    const c = cell as XLSX.CellObject;
    if (c.t !== "n" || XLSX.utils.decode_cell(address).c < 3) continue;
    const v = c.v as number;
    if (v % 1000 !== 0) throw new Error(`サンプルの ${address}=${v} が1000で割り切れません`);
    sheet[address] = { t: "n", v: v / 1000 };
    scaled++;
  }
  if (scaled !== 14 * 4 * 8) throw new Error(`サンプルの数値セル数が想定外です: ${scaled}`);
  return wb;
}

function workbookBytes(wb: XLSX.WorkBook): Uint8Array {
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }));
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

describe.skipIf(!hasFixtures)("旧様式パーサ: 週次 (2026年9月第2週 9/7-9/11, 実ファイル)", () => {
  let valueRecords: InvestorEquityRecord[];
  let volumeRecords: InvestorEquityRecord[];
  beforeAll(() => {
    const valueBytes = loadBytes("weekly-value-2026-w2-0907-0911.xls");
    const volumeBytes = loadBytes("weekly-volume-2026-w2-0907-0911.xls");
    valueRecords = parseInvestorEquityWorkbook(valueBytes, "stock_val_1_260902.xls");
    volumeRecords = parseInvestorEquityWorkbook(volumeBytes, "stock_vol_1_260902.xls");
  });

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

  it("isAggregateCategory が既知の集計行にのみ立つ (自己計は内訳を出さないので葉)", () => {
    expect(find(valueRecords, "TSE Prime", "委託計").isAggregateCategory).toBe(true);
    expect(find(valueRecords, "TSE Prime", "自己計").isAggregateCategory).toBe(false);
    expect(find(valueRecords, "TSE Prime", "海外投資家").isAggregateCategory).toBe(false);
  });

  it("periodMonth は表題の年月 (9月第2週 → 2026-09)", () => {
    expect(find(valueRecords, "TSE Prime", "自己計").periodMonth).toBe("2026-09");
  });

  it("4市場 × 15投資部門 = 60レコード/ファイル", () => {
    expect(valueRecords.length).toBe(4 * 15);
  });
});

describe.skipIf(!hasFixtures)("旧様式パーサ: 週次 (2026年9月第1週 8/31-9/4, 月またぎ, 実ファイル)", () => {
  it("開始日が前月・終了日が当月でも年をまたがず正しく解決する", () => {
    const bytes = loadBytes("weekly-value-2026-w1-0831-0904.xls");
    const records = parseInvestorEquityWorkbook(bytes, "stock_val_1_260901.xls");
    const rec = find(records, "TSE Prime", "自己計");
    expect(rec.periodLabel).toBe("2026年9月第1週");
    expect(rec.periodStart).toBe("2026-08-31");
    expect(rec.periodEnd).toBe("2026-09-04");
    // 開始日は8月だが JPX の帰属月は9月 (月の識別に periodStart を使ってはいけない根拠)
    expect(rec.periodMonth).toBe("2026-09");
  });
});

describe.skipIf(!hasFixtures)("旧様式パーサ: 月次 (2026年8月, 実ファイル)", () => {
  let records: InvestorEquityRecord[];
  beforeAll(() => {
    records = parseInvestorEquityWorkbook(loadBytes("monthly-value-2026-08.xls"), "stock_val_1_m2608.xls");
  });

  it("期間 (月次・単一ブロック) を正しく判定する", () => {
    const rec = find(records, "TSE Prime", "自己計");
    expect(rec.periodType).toBe("monthly");
    expect(rec.periodLabel).toBe("2026年8月");
    expect(rec.periodStart).toBe("2026-08-03");
    // 8/31 (月) は営業日だが8月分に含まれない = 月次も週単位で区切られている
    expect(rec.periodEnd).toBe("2026-08-28");
    expect(rec.periodMonth).toBe("2026-08");
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

  it("isAggregateCategory が15投資部門すべてで正しい (法人・金融機関も集計行、自己計は葉)", () => {
    // 実ファイル (monthly-value-2026-08.xls, TSE Prime シート) を目視確認した実測値で、
    // 「法人」が「金融機関」と全く同じ構造 (自分の子カテゴリの合算) の集計行であることを
    // 検証する。isAggregateCategory=false の行だけを合算して市場合計を作るような
    // 下流集計コードが、法人とその子を二重計上しないための回帰テスト。
    // 「自己計」は内訳 (自己現金/自己信用) をレコードとして出さないので葉 (false)。
    // true にすると false の行の合計が総計から自己取引分だけ欠ける (下の分割テスト参照)。
    const byLabel = (label: string) => find(records, "TSE Prime", label);
    const aggregateLabels = ["委託計", "総計", "法人", "金融機関"];
    const leafLabels = [
      "自己計",
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

describe.skipIf(!hasFixtures)("新様式パーサ (JPX公式サンプルファイル。実データではない仕様サンプル)", () => {
  it("桁の検査: サンプル原本は見出し「千株/千円」に対し値が円/株単位 (1000倍) なので throw する", () => {
    // 原本 D8 (プライム自己現金 金額 売り) = 6,094,207,109,000。千円として読むと約6,000兆円で、
    // 旧様式実ファイルの二市場総計 (2026年8月の1か月、売買合計) 407,516,356,670 千円の約15倍。
    expect(() =>
      parseInvestorEquityWorkbook(
        loadBytes("unified-format-sample-jpx-official.xlsx"),
        "stock_1_w_YYYYMMDD_YYYYMMDD.xlsx"
      )
    ).toThrow(/桁としてありえません/);
  });

  // 以下は単位と桁を整合させた (全数値セル÷1000) サンプルで構造だけを検証する。
  // サンプルはファイル名が "stock_1_w_YYYYMMDD_YYYYMMDD.xlsx" のまま (未置換) なので
  // periodStart/periodEnd は復元できず null になる想定。
  let records: InvestorEquityRecord[];
  beforeAll(() => {
    records = parseInvestorEquityWorkbook(
      workbookBytes(unifiedSampleScaledWorkbook()),
      "stock_1_w_YYYYMMDD_YYYYMMDD.xlsx"
    );
  });

  it("様式を unified と判定し、期間ラベルは復元できるが実日付は null になる", () => {
    const rec = find(records, "TSE Prime", "自己現金");
    expect(rec.formatVersion).toBe("unified_single_file");
    expect(rec.periodLabel).toBe("2026年4月第1週");
    expect(rec.periodStart).toBeNull();
    expect(rec.periodEnd).toBeNull();
  });

  it("サンプル原本の値 (÷1000) と一致する (TSE Prime, 自己現金, 株数/金額)", () => {
    const volumeRec = records.find(
      (r) => r.market === "TSE Prime" && r.investorCategory === "自己現金" && r.metric === "volume"
    );
    const valueRec = records.find(
      (r) => r.market === "TSE Prime" && r.investorCategory === "自己現金" && r.metric === "value"
    );
    // 原本 D7/E7 = 2,282,656,000 / 1,826,950,000、D8/E8 = 6,094,207,109,000 / 4,740,824,669,000
    expect(volumeRec?.sell).toBe(2282656);
    expect(volumeRec?.buy).toBe(1826950);
    expect(valueRec?.sell).toBe(6094207109);
    expect(valueRec?.buy).toBe(4740824669);
    expect(valueRec?.net).toBe(4740824669 - 6094207109);
  });

  it("14カテゴリ × 4市場 × 2指標 = 112レコード", () => {
    expect(records.length).toBe(14 * 4 * 2);
  });
});

describe.skipIf(!hasFixtures)("月次専用の新様式サンプル (2026-10-08 掲載分から予告。週次の新様式(2026-09-29)とは" +
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

  it("ファイル名の日付が暦日として不正なら throw する", () => {
    expect(() => parseUnifiedFilenamePeriod("stock_1_w_20261305_20261309.xlsx")).toThrow(/暦日/);
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

describe.skipIf(!hasFixtures)("週次一覧ページの解析 (実ページ, 2026-09-27時点)", () => {
  let entries: ReturnType<typeof parseWeeklyIndexHtml>;
  beforeAll(() => {
    entries = parseWeeklyIndexHtml(loadText("weekly-index-2026-09-27.html"));
  });

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

describe.skipIf(!hasFixtures)("月次一覧ページの解析: まだ公表されていない月の判定 (実ページ, 2026-09-27時点)", () => {
  let entries: ReturnType<typeof parseMonthlyIndexHtml>;
  beforeAll(() => {
    entries = parseMonthlyIndexHtml(loadText("monthly-index-2026-09-27.html"));
  });

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

describe.skipIf(!hasFixtures)("toObservationRows (観測ログ用の縦長レコード)", () => {
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

// ===========================================================================
// 2026-09-27 再検証で追加した回帰テスト
// ===========================================================================

const REAL_LEGACY_FILES: ReadonlyArray<[fixture: string, originalName: string]> = [
  ["weekly-value-2026-w2-0907-0911.xls", "stock_val_1_260902.xls"],
  ["weekly-volume-2026-w2-0907-0911.xls", "stock_vol_1_260902.xls"],
  ["weekly-value-2026-w1-0831-0904.xls", "stock_val_1_260901.xls"],
  ["weekly-volume-2026-w1-0831-0904.xls", "stock_vol_1_260901.xls"],
  ["monthly-value-2026-08.xls", "stock_val_1_m2608.xls"],
  ["monthly-volume-2026-08.xls", "stock_vol_1_m2608.xls"],
];
const MARKETS: ReadonlyArray<InvestorEquityRecord["market"]> = [
  "TSE Prime",
  "TSE Standard",
  "TSE Growth",
  "Tokyo & Nagoya",
];

describe.skipIf(!hasFixtures)("isAggregateCategory=false の行は総計を過不足なく分割する (実ファイル全6本×4市場)", () => {
  for (const [fixture, originalName] of REAL_LEGACY_FILES) {
    it(`${fixture}: 葉の売り・買いの合計 = 総計`, () => {
      const records = parseInvestorEquityWorkbook(loadBytes(fixture), originalName);
      for (const market of MARKETS) {
        const leaves = records.filter((r) => r.market === market && !r.isAggregateCategory);
        const total = find(records, market, "総計");
        expect(leaves.map((r) => r.investorCategory)).toEqual([
          "自己計",
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
        ]);
        expect(leaves.reduce((a, r) => a + r.sell, 0)).toBe(total.sell);
        expect(leaves.reduce((a, r) => a + r.buy, 0)).toBe(total.buy);
      }
    });
  }
});

describe.skipIf(!hasFixtures)("旧様式パーサの様式変更検知 (実ファイルの1セルだけを書き換えて確認)", () => {
  const W2 = "weekly-value-2026-w2-0907-0911.xls";

  it("単位表記 (K5: 千円,%) が千円でなければ throw する (値の桁を決め打ちしない)", () => {
    const bytes = mutateCell(W2, "TSE Growth", "K5", "円,%  yen, %");
    expect(() => parseInvestorEquityWorkbook(bytes)).toThrow(/単位表記/);
  });

  it("差引き欄 (JPX の 買い-売り) と符号が合わなければ throw する", () => {
    // 実ファイル TSE Prime 自己計の差引き (K14) は +310,876,847 (買い越し)
    const bytes = mutateCell(W2, "TSE Prime", "K14", "-310,876,847");
    expect(() => parseInvestorEquityWorkbook(bytes)).toThrow(/差引き欄/);
  });

  it("売り/買い/合計の組に投資部門名が無ければ読み飛ばさず throw する", () => {
    const bytes = mutateCell(W2, "TSE Standard", "A27", "");
    expect(() => parseInvestorEquityWorkbook(bytes)).toThrow(/投資部門名がありません/);
  });

  it("投資部門の並びが想定と違えば throw する", () => {
    const bytes = mutateCell(W2, "TSE Prime", "A27", "個人投資家");
    expect(() => parseInvestorEquityWorkbook(bytes)).toThrow(/投資部門の並び/);
  });

  it("4シートの期間が食い違えば throw する", () => {
    const bytes = mutateCell(W2, "Tokyo & Nagoya", "A4", "2026年9月第1週 2026/9 week1  ( 8/31 - 9/4 )");
    expect(() => parseInvestorEquityWorkbook(bytes)).toThrow(/他のシート/);
  });
});

describe.skipIf(!hasFixtures)("新様式パーサの様式変更検知 (JPX公式サンプル(÷1000)の1セルだけを書き換えて確認)", () => {
  // 単位と桁を整合させた (全数値セル÷1000) JPX 公式サンプルの1セルを書き換えて確認する。

  it("単位表記 (C7) が千株/千円でなければ throw する", () => {
    const wb = unifiedSampleScaledWorkbook();
    const sheet = wb.Sheets["sheet1"];
    if (!sheet) throw new Error("sample sheet1 がありません");
    sheet["C7"] = { t: "s", v: "株数／金額 Shares／Value 株／円" };
    const bytes = workbookBytes(wb);
    expect(() => parseInvestorEquityWorkbook(bytes)).toThrow(/単位表記/);
  });

  it("大分類 (自己/個人) の列が入れ替わったら throw する (自己現金と個人現金を取り違えない)", () => {
    const wb = unifiedSampleScaledWorkbook();
    const sheet = wb.Sheets["sheet1"];
    if (!sheet) throw new Error("sample sheet1 がありません");
    sheet["D4"] = { t: "s", v: "個人 Individuals" };
    sheet["L4"] = { t: "s", v: "自己 Proprietary" };
    const bytes = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }));
    expect(() => parseInvestorEquityWorkbook(bytes)).toThrow(/大分類/);
  });

  it("差引 (Balance) が 買い-売り と合わなければ throw する", () => {
    const wb = unifiedSampleScaledWorkbook();
    const sheet = wb.Sheets["sheet1"];
    if (!sheet) throw new Error("sample sheet1 がありません");
    sheet["F8"] = { t: "n", v: 455706 }; // 原本は -455,706,000 (÷1000 で -455,706。売り越し)
    const bytes = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }));
    expect(() => parseInvestorEquityWorkbook(bytes)).toThrow(/差引欄/);
  });

  it("同じ市場×株数/金額の行が重複したら throw する (マージセルの引き継ぎ誤りの検知)", () => {
    const wb = unifiedSampleScaledWorkbook();
    const sheet = wb.Sheets["sheet1"];
    if (!sheet) throw new Error("sample sheet1 がありません");
    sheet["B10"] = { t: "s", v: "東証プライム\nTSE Prime Market" };
    const bytes = workbookBytes(wb);
    expect(() => parseInvestorEquityWorkbook(bytes)).toThrow(/重複/);
  });

  it("ファイル名の期間が年月週コードの月と重なれば日付を採る (月またぎの週も可)", () => {
    // サンプルのコード 2026041 (2026年4月第1週) に対し、月またぎの週 3/30〜4/3 の名前
    const records = parseInvestorEquityWorkbook(workbookBytes(unifiedSampleScaledWorkbook()), "stock_1_w_20260330_20260403.xlsx");
    const rec = find(records, "TSE Prime", "自己現金");
    expect(rec.periodStart).toBe("2026-03-30");
    expect(rec.periodEnd).toBe("2026-04-03");
    expect(rec.periodMonth).toBe("2026-04");
  });

  it("ファイル名の期間が年月週コードの月と重ならなければ throw する", () => {
    expect(() =>
      parseInvestorEquityWorkbook(workbookBytes(unifiedSampleScaledWorkbook()), "stock_1_w_20260921_20260925.xlsx")
    ).toThrow(/重なりません/);
  });

});

describe.skipIf(!hasFixtures)("週次一覧: 新様式の行を読み飛ばして古い週を返さない (実ページ 2026-09-27 に1行差し込み)", () => {
  let html: string;
  let firstRowAt: number;
  beforeAll(() => {
    html = loadText("weekly-index-2026-09-27.html");
    firstRowAt = html.indexOf("<tr>", html.indexOf('<th colspan="2">金額</th>'));
  });
  const insertTopRow = (row: string): string => html.slice(0, firstRowAt) + row + html.slice(firstRowAt);

  it("実ページは5週 (9月第2週〜8月第2週) を新しい順に返す", () => {
    const entries = parseWeeklyIndexHtml(html);
    expect(entries.map((e) => e.label)).toEqual([
      "2026年9月第2週(9月7日～9月11日)",
      "2026年9月第1週(8月31日～9月4日)",
      "2026年8月第4週(8月24日～8月28日)",
      "2026年8月第3週(8月17日～8月21日)",
      "2026年8月第2週(8月10日～8月14日)",
    ]);
    expect(entries[0]?.valueXlsUrl).toBe(
      "https://www.jpx.co.jp/markets/statistics-equities/investor-type/t13vrt000001yhs9-att/stock_val_1_260902.xls"
    );
  });

  it("告知どおりの新様式ファイル (stock_1_w_<8桁>_<8桁>) の行があれば throw する", () => {
    // 修正前は、この行と次の「9月第2週」の行をまたいで正規表現が一致して両方を読み飛ばし、
    // 「9月第1週」を最新週として返していた (再検証で再現)。
    const row =
      '<tr><td width="40%" class="a-center">2026年9月第3週(9月14日～9月18日)</td>' +
      '<td class="a-center"><a href="/x/stock_1_w_20260914_20260918.pdf">PDF</a></td>' +
      '<td class="a-center"><a href="/x/stock_1_w_20260914_20260918.xlsx">Excel</a></td></tr>';
    expect(() => parseWeeklyIndexHtml(insertTopRow(row))).toThrow(/新様式のファイル/);
  });

  it("告知と違う名前でも、表に4リンク行でない行があれば throw する", () => {
    const row =
      '<tr><td class="a-center">2026年9月第3週(9月14日～9月18日)</td>' +
      '<td class="a-center"><a href="/x/stock_1_260903.pdf">PDF</a></td>' +
      '<td class="a-center"><a href="/x/stock_1_260903.xlsx">Excel</a></td></tr>';
    expect(() => parseWeeklyIndexHtml(insertTopRow(row))).toThrow(/4リンク行ではない行/);
  });

  it("行が新しい順に並んでいなければ throw する (先頭行=最新週の前提)", () => {
    const row2At = html.indexOf("<tr>", firstRowAt + 1);
    const row3At = html.indexOf("<tr>", row2At + 1);
    const swapped =
      html.slice(0, firstRowAt) + html.slice(row2At, row3At) + html.slice(firstRowAt, row2At) + html.slice(row3At);
    expect(() => parseWeeklyIndexHtml(swapped)).toThrow(/新しい週から順/);
  });

  it("1行の株数/金額リンクが別の週を指していれば throw する", () => {
    const broken = html.replace("stock_vol_1_260902.xls", "stock_vol_1_260901.xls");
    expect(() => parseWeeklyIndexHtml(broken)).toThrow(/週コードが揃っていません/);
  });

  it("行の日付ラベルとリンクの週コードが別の週なら throw する (ラベルは最新週なのに前週のファイルを取らない)", () => {
    // 先頭行 (9月第2週) の4リンクを実ページにある9月第1週 (260901) の実リンクに差し替え、
    // 元の9月第1週の行を削除する。4リンクの週コードは揃い、並び順も新しい順のままなので、
    // 修正前はラベル「9月第2週」のまま stock_val_1_260901.xls を最新として返していた。
    const row2At = html.indexOf("<tr>", firstRowAt + 1);
    const row3At = html.indexOf("<tr>", row2At + 1);
    const row1 = html
      .slice(firstRowAt, row2At)
      .replace(/t13vrt000001yhs9-att\/stock_(vol|val)_1_260902/g, "t13vrt000001y0ho-att/stock_$1_1_260901");
    const mutated = html.slice(0, firstRowAt) + row1 + html.slice(row3At);
    expect(mutated).toContain("2026年9月第2週(9月7日～9月11日)");
    expect(mutated).not.toContain("stock_val_1_260902");
    expect(() => parseWeeklyIndexHtml(mutated)).toThrow(/日付ラベル.*週コード \(260901\) が一致しません/);
  });
});

describe.skipIf(!hasFixtures)("月次一覧: 新様式の月を「未公表」と誤認しない (実ページ 2026-09-27 の9月欄を書き換え)", () => {
  let html: string;
  beforeAll(() => {
    html = loadText("monthly-index-2026-09-27.html");
  });
  /** 4行 (株数PDF/株数Excel/金額PDF/金額Excel) それぞれの9月欄 (各行で最初の "-") を置換する */
  const replaceSeptemberCells = (make: (rowIdx: number) => string): string => {
    let n = 0;
    return html.replace(/<td class="a-center (tb-color00[12])">-<\/td>/g, (m, cls: string) => {
      n++;
      return n % 4 === 1 ? `<td class="a-center ${cls}">${make((n - 1) / 4)}</td>` : m;
    });
  };
  const AUG_VALUE_XLS_CELL =
    /(<td class="a-center tb-color002">)<a href="[^"]*stock_val_1_m2608\.xls"[^>]*>[\s\S]*?<\/a>(<\/td>)/;

  it("告知どおりの新様式ファイル (stock_1_m<数字>) が載ったら throw する", () => {
    // 修正前は9月を未公表とみなし、8月を最新として黙って返していた (再検証で再現)。
    const newFormat = replaceSeptemberCells(
      (i) => `<a href="/x/stock_1_m202609.${i % 2 === 0 ? "pdf" : "xlsx"}" rel="external">x</a>`
    );
    expect(() => parseMonthlyIndexHtml(newFormat)).toThrow(/新様式のファイル/);
  });

  it('月欄が "-" でも旧様式のその月のリンクでもなければ throw する', () => {
    const unexpected = replaceSeptemberCells(() => `<a href="/x/stock_all_1_m2609.xlsx">x</a>`);
    expect(() => parseMonthlyIndexHtml(unexpected)).toThrow(/旧様式ファイルへのリンクでもありません/);
  });

  it("別の月のファイルが入っていれば throw する (列ずれの検知)", () => {
    const shifted = html.replace(AUG_VALUE_XLS_CELL, '$1<a href="/x/stock_val_1_m2607.xls">x</a>$2');
    expect(shifted).not.toBe(html);
    expect(() => parseMonthlyIndexHtml(shifted)).toThrow(/旧様式ファイルへのリンクでもありません/);
  });

  it("PDF と Excel で公表済みの月が食い違えば throw する", () => {
    const partial = html.replace(AUG_VALUE_XLS_CELL, "$1-$2");
    expect(partial).not.toBe(html);
    expect(() => parseMonthlyIndexHtml(partial)).toThrow(/公表済みの月が一致しません/);
  });
});

describe.skipIf(!hasFixtures)("mergeValueAndVolumeRecords (金額ファイル+株数ファイルを1バッチに)", () => {
  let value: InvestorEquityRecord[];
  let volume: InvestorEquityRecord[];
  beforeAll(() => {
    value = parseInvestorEquityWorkbook(loadBytes("weekly-value-2026-w2-0907-0911.xls"));
    volume = parseInvestorEquityWorkbook(loadBytes("weekly-volume-2026-w2-0907-0911.xls"));
  });

  it("同じ週の金額60件+株数60件=120件になる", () => {
    expect(mergeValueAndVolumeRecords(value, volume, "weekly").length).toBe(120);
  });
  it("金額と株数の取り違えは throw する", () => {
    expect(() => mergeValueAndVolumeRecords(volume, value, "weekly")).toThrow(/金額ファイルのはず/);
  });
  it("別の週のファイル同士は throw する", () => {
    const volumeW1 = parseInvestorEquityWorkbook(loadBytes("weekly-volume-2026-w1-0831-0904.xls"));
    expect(() => mergeValueAndVolumeRecords(value, volumeW1, "weekly")).toThrow(/期間が食い違/);
  });
  it("週次のはずが月次なら throw する", () => {
    const mValue = parseInvestorEquityWorkbook(loadBytes("monthly-value-2026-08.xls"));
    const mVolume = parseInvestorEquityWorkbook(loadBytes("monthly-volume-2026-08.xls"));
    expect(() => mergeValueAndVolumeRecords(mValue, mVolume, "weekly")).toThrow(/weekly のはずが monthly/);
  });
});

describe.skipIf(!hasFixtures)("jpxInvestorEquityArchiveInput (ルール6 の一次データ入力・冪等キー)", () => {
  const JPX = "https://www.jpx.co.jp/markets/statistics-equities/investor-type";
  const fetchedFrom = (
    periodType: FetchedInvestorEquity["periodType"],
    valueFixture: string,
    volumeFixture: string,
    valueUrl: string,
    volumeUrl: string
  ): FetchedInvestorEquity => {
    const valueBytes = loadBytes(valueFixture);
    const volumeBytes = loadBytes(volumeFixture);
    return {
      periodType,
      valueUrl,
      volumeUrl,
      valueBytes,
      volumeBytes,
      records: mergeValueAndVolumeRecords(
        parseInvestorEquityWorkbook(valueBytes),
        parseInvestorEquityWorkbook(volumeBytes),
        periodType
      ),
    };
  };
  // URL は 2026-09-27 の実一覧ページ (weekly/monthly-index-2026-09-27.html) に載っているもの
  let weekly: FetchedInvestorEquity;
  let monthly: FetchedInvestorEquity;
  beforeAll(() => {
    weekly = fetchedFrom(
      "weekly",
      "weekly-value-2026-w2-0907-0911.xls",
      "weekly-volume-2026-w2-0907-0911.xls",
      `${JPX}/t13vrt000001yhs9-att/stock_val_1_260902.xls`,
      `${JPX}/t13vrt000001yhs9-att/stock_vol_1_260902.xls`
    );
    monthly = fetchedFrom(
      "monthly",
      "monthly-value-2026-08.xls",
      "monthly-volume-2026-08.xls",
      `${JPX}/t13vrt000001vcuo-att/stock_val_1_m2608.xls`,
      `${JPX}/t13vrt000001vcuo-att/stock_vol_1_m2608.xls`
    );
  });

  it("週次: キーは期間終了日、ファイルは取得したバイト列そのまま (実体アップロード用)", () => {
    const input = jpxInvestorEquityArchiveInput(weekly);
    expect(input.key).toBe("jpx-investor-equity-weekly-2026-09-11");
    expect(input.service).toBe("moneyflow");
    expect(input.files.map((f) => f.filename)).toEqual([
      "investor-equity-value-stock_val_1_260902.xls",
      "investor-equity-volume-stock_vol_1_260902.xls",
    ]);
    expect(input.files[0]?.bytes).toBe(weekly.valueBytes);
    expect(input.files[1]?.bytes).toBe(weekly.volumeBytes);
    expect(input.files[0]?.contentType).toBe("application/vnd.ms-excel");
    expect(input.metadata.recordCount).toBe(120);
  });

  it("月次: キーは JPX の帰属年月 (2026年8月 → 2026-08)", () => {
    expect(jpxInvestorEquityArchiveInput(monthly).key).toBe("jpx-investor-equity-monthly-2026-08");
  });

  it("月次: 開始日が前月に入る月 (9月分 = 8/31〜) でも前月と同じキーにならない", () => {
    // 実ファイルの事実: 8月分は 8/3〜8/28 (営業日の 8/31 を含まない)、週次の
    // 「2026年9月第1週」は 8/31〜9/4。よって9月の月次は 8/31 から始まる。修正前は
    // periodStart の月 (2026-08) をキーにしていたため、9月分が8月分と同じキーになり
    // 「保管済み」として一次データが保存されなかった。
    const september: FetchedInvestorEquity = {
      ...monthly,
      records: monthly.records.map((r) => ({
        ...r,
        periodLabel: "2026年9月",
        periodMonth: "2026-09",
        periodStart: "2026-08-31",
        periodEnd: "2026-09-25",
      })),
    };
    expect(jpxInvestorEquityArchiveInput(september).key).toBe("jpx-investor-equity-monthly-2026-09");
    expect(jpxInvestorEquityArchiveInput(september).key).not.toBe(jpxInvestorEquityArchiveInput(monthly).key);
  });

  it("週次で期間終了日が不明なら、ラベル等の別表記キーにせず throw する", () => {
    const noDate: FetchedInvestorEquity = {
      ...weekly,
      records: weekly.records.map((r) => ({ ...r, periodStart: null, periodEnd: null })),
    };
    expect(() => jpxInvestorEquityArchiveInput(noDate)).toThrow(/期間終了日が不明/);
  });

  it("バッチ内で期間が食い違えば、先頭の1件を代表にせず throw する", () => {
    const mixed: FetchedInvestorEquity = {
      ...weekly,
      records: [
        ...weekly.records.slice(0, 60),
        ...parseInvestorEquityWorkbook(loadBytes("weekly-volume-2026-w1-0831-0904.xls")),
      ],
    };
    expect(() => jpxInvestorEquityArchiveInput(mixed)).toThrow(/期間が食い違/);
  });
});

describe.skipIf(!hasFixtures)("指標定義の公表頻度は JPX 一覧ページの実文言に基づく (検証指摘: 月次『第8営業日』は誤り)", () => {
  it("一覧ページ (2026-09-27 実ページ) の文言と一致する", () => {
    expect(loadText("weekly-index-2026-09-27.html")).toContain(
      "毎週第4営業日（通常は木曜日、祝日等非営業日がある場合はその分後ろ倒し） 午後3時30分に資料を掲載します。"
    );
    expect(loadText("monthly-index-2026-09-27.html")).toContain(
      "前月最終週の週間と同日の午後3時30分に資料を掲載します。"
    );
    for (const def of JPX_INVESTOR_EQUITY_INDICATORS) {
      expect(def.frequency).toContain("毎週第4営業日");
      expect(def.frequency).toContain("前月最終週の週次発表と同日");
      expect(def.frequency).not.toContain("第8営業日");
    }
  });
});
