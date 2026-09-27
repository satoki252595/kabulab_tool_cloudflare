/**
 * IMAJ (資産運用業協会) 資産増減状況 (B-1) / 公募REIT月末資産増減状況 (D-1)
 * パーサの単体テスト。
 *
 * fixtures/imaj-fund-flows-b1.xlsx と fixtures/imaj-reit-flows-d1.xlsx は
 * 2026-09-27 に下記の実URLから実際にダウンロードした本物のファイルを、
 * 直近14か月分のデータ行だけに切り詰めたもの (値は一切書き換えていない)。
 *   B-1: https://www.toushin.or.jp/tws/toukei_dw/I0112B_pub_m.xlsx
 *   D-1: https://www.toushin.or.jp/tws/toukei_dw/F00B21_pub.xlsx
 * 期待値は同日にダウンロードした原本 (トリム前のフルファイル) を目視で
 * 数値確認したもの。様式が変わった場合に throw することは、別途
 * (XLSX.utils で組み立てた) 合成ワークブックで確認する。
 */
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  IMAJ_FUND_FLOWS_INDICATORS,
  IMAJ_FUND_FLOWS_URL,
  IMAJ_REIT_FLOWS_INDICATORS,
  IMAJ_REIT_FLOWS_URL,
  judgeImajPublicationStatus,
  parseImajFundFlows,
  parseImajReitFlows,
  toImajFundFlowObservations,
  toImajReitFlowObservations,
  imajFundFlowsArchiveInput,
  imajReitFlowsArchiveInput,
} from "./imaj-fund-flows.js";

const FIXTURES_DIR = fileURLToPath(new URL("./fixtures/", import.meta.url));

const FUND_FIXTURE_BYTES = new Uint8Array(
  readFileSync(`${FIXTURES_DIR}imaj-fund-flows-b1.xlsx`)
);
const REIT_FIXTURE_BYTES = new Uint8Array(
  readFileSync(`${FIXTURES_DIR}imaj-reit-flows-d1.xlsx`)
);

describe("parseImajFundFlows (B-1・実ファイル切り詰めフィクスチャ)", () => {
  const rows = parseImajFundFlows(FUND_FIXTURE_BYTES);

  it("5つの商品分類区分すべてを返す", () => {
    const categories = new Set(rows.map((r) => r.category));
    expect(categories).toEqual(
      new Set(["total", "equity", "equity_ex_etf", "equity_etf", "bond"])
    );
  });

  // 原本 (I0112B_pub_m.xlsx, 2026-09-27 ダウンロード) を目視確認した実数値。
  it("総合計 2026年8月分が原本の実数値と一致する", () => {
    const row = rows.find((r) => r.category === "total" && r.period === "2026-08");
    expect(row).toMatchObject({
      sales: 9980178,
      repurchases: 8009642,
      redemptions: 31033,
      netFlow: 1939503,
      totalNetAssets: 364285531,
      fundCount: 5840,
    });
  });

  it("株式投信 2026年8月分が原本の実数値と一致する (資金増減額・純資産総額)", () => {
    const row = rows.find((r) => r.category === "equity" && r.period === "2026-08");
    expect(row).toMatchObject({ netFlow: 2017448, totalNetAssets: 348012550 });
  });

  it("公社債投信 2026年8月分が原本の実数値と一致する (マイナスの資金増減額)", () => {
    const row = rows.find((r) => r.category === "bond" && r.period === "2026-08");
    expect(row).toMatchObject({ netFlow: -77945, totalNetAssets: 16272981 });
  });

  it("株式投信(除ETF) + ETF の資金増減額の合計が株式投信全体と一致する (原本内の整合性)", () => {
    const exEtf = rows.find(
      (r) => r.category === "equity_ex_etf" && r.period === "2026-08"
    );
    const etf = rows.find((r) => r.category === "equity_etf" && r.period === "2026-08");
    const equity = rows.find((r) => r.category === "equity" && r.period === "2026-08");
    expect(exEtf!.netFlow + etf!.netFlow).toBe(equity!.netFlow);
    expect(exEtf!.totalNetAssets + etf!.totalNetAssets).toBe(equity!.totalNetAssets);
  });

  it("原資料の '-' 表記 (発生無し) を 0 に解釈する (ETFの償還額・公社債の償還額)", () => {
    const etfAug = rows.find(
      (r) => r.category === "equity_etf" && r.period === "2026-08"
    );
    expect(etfAug!.redemptions).toBe(0); // 原本セルは "-"
    const bondAug = rows.find((r) => r.category === "bond" && r.period === "2026-08");
    expect(bondAug!.redemptions).toBe(0); // 原本セルは "-"
  });

  it("'-' ではない実在の小さな償還額はそのまま数値として保持する (0に潰さない)", () => {
    // 原本: 株式追加型ETFシート 2026年6月の償還額(C)列は実数値 236 (「-」ではない)
    const etfJune = rows.find(
      (r) => r.category === "equity_etf" && r.period === "2026-06"
    );
    expect(etfJune!.redemptions).toBe(236);
  });
});

describe("parseImajReitFlows (D-1・実ファイル切り詰めフィクスチャ)", () => {
  const rows = parseImajReitFlows(REIT_FIXTURE_BYTES);

  // 原本 (F00B21_pub.xlsx, 2026-09-27 ダウンロード) を目視確認した実数値。
  it("2026年7月分 (最新月) が原本の実数値と一致する", () => {
    const row = rows.find((r) => r.period === "2026-07");
    expect(row).toMatchObject({
      capitalDistribution: 28,
      capitalChange: -28,
      otherChange: 41564,
      assetChange: 41536,
      totalNetAssets: 12341269,
      fundCount: 58,
    });
  });

  it("追加出資金額が '-' (発生無し) の月は 0 として資本金増減額を返す", () => {
    const row = rows.find((r) => r.period === "2026-07");
    expect(row!.capitalIncrease).toBe(0); // 原本セルは "-"
  });

  it("追加出資・払戻とも '-' の月は資本金増減額 0、資産増減額はその他増減額のみ", () => {
    // 原本: 2025年9月・2026年5月は A列・B列ともに "-"
    const row = rows.find((r) => r.period === "2026-05");
    expect(row).toMatchObject({
      capitalIncrease: 0,
      capitalDistribution: 0,
      capitalChange: 0,
      otherChange: 18607,
      assetChange: 18607,
    });
  });
});

describe("judgeImajPublicationStatus (期間判定・「まだ公表されていない」)", () => {
  it("D-1 は B-1 より1か月遅れて公表される (2026-09-27 実測の非対称ラグ)", () => {
    const fundRows = parseImajFundFlows(FUND_FIXTURE_BYTES);
    const reitRows = parseImajReitFlows(REIT_FIXTURE_BYTES);
    expect(judgeImajPublicationStatus("2026-08", fundRows)).toMatchObject({
      status: "published",
      latestAvailablePeriod: "2026-08",
    });
    expect(judgeImajPublicationStatus("2026-08", reitRows)).toMatchObject({
      status: "not_yet_published",
      latestAvailablePeriod: "2026-07",
    });
  });

  it("rows が空なら判定できないので throw する (フォールバックしない)", () => {
    expect(() => judgeImajPublicationStatus("2026-08", [])).toThrow("rows が空");
  });
});

describe("toImajFundFlowObservations / toImajReitFlowObservations (縦長観測レコード)", () => {
  it("1行につき指標2件 (資金増減額・純資産総額) の観測を作る", () => {
    const rows = parseImajFundFlows(FUND_FIXTURE_BYTES);
    const observations = toImajFundFlowObservations(rows);
    expect(observations).toHaveLength(rows.length * 2);
    const totalAug = observations.filter(
      (o) => o.category === "total" && o.period === "2026-08"
    );
    expect(totalAug).toEqual([
      {
        period: "2026-08",
        indicatorKey: "imaj_fund_net_flow",
        category: "total",
        value: 1939503,
        unit: "百万円",
        isApproximate: false,
        isEstimated: false,
      },
      {
        period: "2026-08",
        indicatorKey: "imaj_fund_net_asset_total",
        category: "total",
        value: 364285531,
        unit: "百万円",
        isApproximate: false,
        isEstimated: false,
      },
    ]);
  });

  it("REIT観測は区分 'reit_public' 固定で作る", () => {
    const rows = parseImajReitFlows(REIT_FIXTURE_BYTES);
    const observations = toImajReitFlowObservations(rows);
    expect(observations.every((o) => o.category === "reit_public")).toBe(true);
    expect(observations).toHaveLength(rows.length * 2);
  });
});

describe("指標定義 (IMAJ_FUND_FLOWS_INDICATORS / IMAJ_REIT_FLOWS_INDICATORS)", () => {
  it("必須フィールドが全て揃っている", () => {
    for (const def of [...IMAJ_FUND_FLOWS_INDICATORS, ...IMAJ_REIT_FLOWS_INDICATORS]) {
      expect(def.key.length).toBeGreaterThan(0);
      expect(def.label.length).toBeGreaterThan(0);
      expect(def.requirements.length).toBeGreaterThan(0);
      expect(def.measures.length).toBeGreaterThan(0);
      expect(def.plainExplanation.length).toBeGreaterThan(0);
      expect(def.unit).toBe("百万円");
      expect(def.sourceUrl.startsWith("https://")).toBe(true);
      expect(def.licenseTag).toBe("personal-only");
      expect(def.frequency).toBe("monthly");
      expect(def.limitations.length).toBeGreaterThan(0);
    }
  });

  it("fund_flow / holdings_stock の flowType を使い分けている", () => {
    const byKey = Object.fromEntries(
      [...IMAJ_FUND_FLOWS_INDICATORS, ...IMAJ_REIT_FLOWS_INDICATORS].map((d) => [
        d.key,
        d.flowType,
      ])
    );
    expect(byKey.imaj_fund_net_flow).toBe("fund_flow");
    expect(byKey.imaj_fund_net_asset_total).toBe("holdings_stock");
    expect(byKey.imaj_reit_net_flow).toBe("fund_flow");
    expect(byKey.imaj_reit_net_asset_total).toBe("holdings_stock");
  });

  it("出典URLは固定URL定数と一致する", () => {
    expect(
      IMAJ_FUND_FLOWS_INDICATORS.every((d) => d.sourceUrl === IMAJ_FUND_FLOWS_URL)
    ).toBe(true);
    expect(
      IMAJ_REIT_FLOWS_INDICATORS.every((d) => d.sourceUrl === IMAJ_REIT_FLOWS_URL)
    ).toBe(true);
  });
});

describe("imajFundFlowsArchiveInput / imajReitFlowsArchiveInput (ルール6 入力・Notion書込はしない)", () => {
  it("最新期間で冪等キーを組み、ファイル実体をそのまま渡す", () => {
    const rows = parseImajFundFlows(FUND_FIXTURE_BYTES);
    const input = imajFundFlowsArchiveInput({
      bytes: FUND_FIXTURE_BYTES,
      url: IMAJ_FUND_FLOWS_URL,
      rows,
    });
    expect(input.service).toBe("moneyflow");
    expect(input.key).toBe("imaj-fund-flows-2026-08");
    expect(input.source).toBe(IMAJ_FUND_FLOWS_URL);
    expect(input.files).toHaveLength(1);
    expect(input.files[0]!.bytes).toBe(FUND_FIXTURE_BYTES);
    expect(input.files[0]!.filename).toBe("imaj-fund-flows-2026-08.xlsx");
    expect(input.metadata).toMatchObject({ latestPeriod: "2026-08" });
  });

  it("REIT側は D-1 自身の最新月 (2026-07) でキーを組む", () => {
    const rows = parseImajReitFlows(REIT_FIXTURE_BYTES);
    const input = imajReitFlowsArchiveInput({
      bytes: REIT_FIXTURE_BYTES,
      url: IMAJ_REIT_FLOWS_URL,
      rows,
    });
    expect(input.key).toBe("imaj-reit-flows-2026-07");
    expect(input.files[0]!.filename).toBe("imaj-reit-flows-2026-07.xlsx");
  });
});

// ---------------------------------------------------------------------------
// 様式変更時に throw することの検証 (合成ワークブック。実ファイルは書き換えない)
// ---------------------------------------------------------------------------

function bookWithSheets(sheets: Record<string, unknown[][]>): Uint8Array {
  const wb = XLSX.utils.book_new();
  for (const [name, aoa] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name);
  }
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }));
}

const FUND_HEADER_ROW = [
  null,
  "項目",
  "設定額",
  "解約額",
  "償還額",
  "資金増減額",
  "収益分配額",
  "運用増減額",
  "純資産増減額",
  "純資産総額",
  "ファンド数",
];

describe("様式変更時の throw (B-1)", () => {
  it("必要なシートが無ければ throw する", () => {
    const bytes = bookWithSheets({ 総合計: [FUND_HEADER_ROW, [null, "2026年1月", 1, 1, 1, 0, 1, 1, 0, 100, 1]] });
    expect(() => parseImajFundFlows(bytes)).toThrow("シート");
  });

  it("ヘッダ列が想定と違えば throw する (列名が変わった/ズレた)", () => {
    const brokenHeader = [...FUND_HEADER_ROW];
    brokenHeader[2] = "拠出額"; // "設定額" ではない未知の列名に変わった想定
    const bytes = bookWithSheets({
      総合計: [brokenHeader, [null, "2026年1月", 1, 1, 1, 0, 1, 1, 0, 100, 1]],
      株式: [FUND_HEADER_ROW, [null, "2026年1月", 1, 1, 1, 0, 1, 1, 0, 100, 1]],
      "株式 除ＥＴＦ": [FUND_HEADER_ROW, [null, "2026年1月", 1, 1, 1, 0, 1, 1, 0, 100, 1]],
      "株式 追加型 ＥＴＦ": [FUND_HEADER_ROW, [null, "2026年1月", 1, 1, 1, 0, 1, 1, 0, 100, 1]],
      公社債: [FUND_HEADER_ROW, [null, "2026年1月", 1, 1, 1, 0, 1, 1, 0, 100, 1]],
    });
    expect(() => parseImajFundFlows(bytes)).toThrow("ヘッダ行が見つかりません");
  });

  it("期間ラベルが 'YYYY年M月' でなければ throw する", () => {
    const allSheets = Object.fromEntries(
      ["総合計", "株式", "株式 除ＥＴＦ", "株式 追加型 ＥＴＦ", "公社債"].map((name) => [
        name,
        [FUND_HEADER_ROW, [null, "2026-01", 1, 1, 1, 0, 1, 1, 0, 100, 1]],
      ])
    );
    // 期間ラベルが regex に一致しないので、データ行 0 件として throw される
    expect(() => parseImajFundFlows(bookWithSheets(allSheets))).toThrow(
      "データ行が 0 件"
    );
  });

  it("数値セルが '-'/数値以外の未知の文字列なら throw する (黙って0にしない)", () => {
    const allSheets = Object.fromEntries(
      ["総合計", "株式", "株式 除ＥＴＦ", "株式 追加型 ＥＴＦ", "公社債"].map((name) => [
        name,
        [FUND_HEADER_ROW, [null, "2026年1月", "非公開", 1, 1, 0, 1, 1, 0, 100, 1]],
      ])
    );
    expect(() => parseImajFundFlows(bookWithSheets(allSheets))).toThrow(
      "数値セルが解釈できません"
    );
  });
});

const REIT_HEADER_ROW = [
  null,
  "項目",
  "追加出資金額",
  "出資払戻金額",
  "資本金増減額",
  "その他増減額",
  "資産増減額",
  "純資産総額",
  "資産総額",
  "出資総額",
  "負債総額",
  "組入不動産の総額",
  "月末総口数",
  "ファンド本数",
];

describe("様式変更時の throw (D-1)", () => {
  it("シート「月次」が無ければ throw する", () => {
    const bytes = bookWithSheets({ 年次: [REIT_HEADER_ROW] });
    expect(() => parseImajReitFlows(bytes)).toThrow("シート");
  });

  it("ヘッダ列が想定と違えば throw する", () => {
    const brokenHeader = [...REIT_HEADER_ROW];
    brokenHeader[4] = "純増減額"; // "資本金増減額" ではない
    const bytes = bookWithSheets({
      月次: [brokenHeader, [null, "2026年1月", 1, 1, 0, 1, 1, 100, 100, 1, 1, 1, 1, 1]],
    });
    expect(() => parseImajReitFlows(bytes)).toThrow("ヘッダ行が見つかりません");
  });
});
