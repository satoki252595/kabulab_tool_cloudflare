/**
 * IMAJ (資産運用業協会) 資産増減状況 (B-1) / 公募REIT月末資産増減状況 (D-1)
 * パーサの単体テスト。
 *
 * fixtures/private/imaj-fund-flows/imaj-fund-flows-b1.xlsx と
 * fixtures/private/imaj-fund-flows/imaj-reit-flows-d1.xlsx は
 * 2026-09-27 に下記の実URLから実際にダウンロードした本物のファイルを、
 * 直近14か月分のデータ行だけに切り詰めたもの (値は一切書き換えていない)。
 *   B-1: https://www.toushin.or.jp/tws/toukei_dw/I0112B_pub_m.xlsx
 *   D-1: https://www.toushin.or.jp/tws/toukei_dw/F00B21_pub.xlsx
 * 期待値は同日にダウンロードした原本 (トリム前のフルファイル) を目視で
 * 数値確認したもの。様式が変わった場合に throw することは、別途
 * (XLSX.utils で組み立てた) 合成ワークブックで確認する。
 *
 * 資産運用業協会の統計は再配布不可 (personal-only) のため、フィクスチャは
 * `fixtures/private/imaj-fund-flows/` (gitignore 済み) に置き commit しない。
 * 未取得の環境 (CI) では実ファイルを読むテストだけ `describe.skipIf` で skip し、
 * 合成ワークブック・指標定義のテストは常に走らせる。
 */
import { beforeAll, describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { existsSync, readFileSync } from "node:fs";
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

const FIXTURES_DIR = fileURLToPath(new URL("./fixtures/private/imaj-fund-flows/", import.meta.url));
const FUND_FIXTURE_PATH = `${FIXTURES_DIR}imaj-fund-flows-b1.xlsx`;
const REIT_FIXTURE_PATH = `${FIXTURES_DIR}imaj-reit-flows-d1.xlsx`;
const hasFixtures = existsSync(FUND_FIXTURE_PATH) && existsSync(REIT_FIXTURE_PATH);

// import 時には読まない (未取得の環境で import 自体が throw しないように)。
// 同一インスタンスを返すようメモ化する (ファイル実体をそのまま渡すことの検証に使う)。
let fundFixtureCache: Uint8Array | undefined;
let reitFixtureCache: Uint8Array | undefined;
function fundFixtureBytes(): Uint8Array {
  fundFixtureCache ??= new Uint8Array(readFileSync(FUND_FIXTURE_PATH));
  return fundFixtureCache;
}
function reitFixtureBytes(): Uint8Array {
  reitFixtureCache ??= new Uint8Array(readFileSync(REIT_FIXTURE_PATH));
  return reitFixtureCache;
}

describe.skipIf(!hasFixtures)("parseImajFundFlows (B-1・実ファイル切り詰めフィクスチャ)", () => {
  let rows: ReturnType<typeof parseImajFundFlows>;
  beforeAll(() => {
    rows = parseImajFundFlows(fundFixtureBytes());
  });

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

describe.skipIf(!hasFixtures)("parseImajReitFlows (D-1・実ファイル切り詰めフィクスチャ)", () => {
  let rows: ReturnType<typeof parseImajReitFlows>;
  beforeAll(() => {
    rows = parseImajReitFlows(reitFixtureBytes());
  });

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
  describe.skipIf(!hasFixtures)("実フィクスチャ", () => {
    it("D-1 は B-1 より1か月遅れて公表される (2026-09-27 実測の非対称ラグ)", () => {
      const fundRows = parseImajFundFlows(fundFixtureBytes());
      const reitRows = parseImajReitFlows(reitFixtureBytes());
      expect(judgeImajPublicationStatus("2026-08", fundRows)).toMatchObject({
        status: "published",
        latestAvailablePeriod: "2026-08",
      });
      expect(judgeImajPublicationStatus("2026-08", reitRows)).toMatchObject({
        status: "not_yet_published",
        latestAvailablePeriod: "2026-07",
      });
    });
  });

  it("rows が空なら判定できないので throw する (フォールバックしない)", () => {
    expect(() => judgeImajPublicationStatus("2026-08", [])).toThrow("rows が空");
  });
});

describe.skipIf(!hasFixtures)("toImajFundFlowObservations / toImajReitFlowObservations (縦長観測レコード)", () => {
  it("1行につき指標2件 (資金増減額・純資産総額) の観測を作る", () => {
    const rows = parseImajFundFlows(fundFixtureBytes());
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
    const rows = parseImajReitFlows(reitFixtureBytes());
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

describe.skipIf(!hasFixtures)("imajFundFlowsArchiveInput / imajReitFlowsArchiveInput (ルール6 入力・Notion書込はしない)", () => {
  it("最新期間で冪等キーを組み、ファイル実体をそのまま渡す", () => {
    const rows = parseImajFundFlows(fundFixtureBytes());
    const input = imajFundFlowsArchiveInput({
      bytes: fundFixtureBytes(),
      url: IMAJ_FUND_FLOWS_URL,
      rows,
    });
    expect(input.service).toBe("moneyflow");
    expect(input.key).toBe("imaj-fund-flows-2026-08");
    expect(input.source).toBe(IMAJ_FUND_FLOWS_URL);
    expect(input.files).toHaveLength(1);
    expect(input.files[0]!.bytes).toBe(fundFixtureBytes());
    expect(input.files[0]!.filename).toBe("imaj-fund-flows-2026-08.xlsx");
    expect(input.metadata).toMatchObject({ latestPeriod: "2026-08" });
  });

  it("REIT側は D-1 自身の最新月 (2026-07) でキーを組む", () => {
    const rows = parseImajReitFlows(reitFixtureBytes());
    const input = imajReitFlowsArchiveInput({
      bytes: reitFixtureBytes(),
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

// ---------------------------------------------------------------------------
// 反証レビュー (2026-09-27) で見つかった不具合の回帰テスト
// ---------------------------------------------------------------------------

function fundBookWithRow(dataRow: unknown[], header: unknown[] = FUND_HEADER_ROW): Uint8Array {
  return bookWithSheets(
    Object.fromEntries(
      ["総合計", "株式", "株式 除ＥＴＦ", "株式 追加型 ＥＴＦ", "公社債"].map((name) => [
        name,
        [header, dataRow],
      ])
    )
  );
}

describe("回帰: 全データ列のヘッダ検証 (列の入替を黙って取り込まない)", () => {
  it("B-1 列8 (純資産増減額) が別の見出しに変わったら throw する", () => {
    const header = [...FUND_HEADER_ROW];
    header[8] = "分配後純資産"; // 「増減額」を含まない別列
    expect(() =>
      parseImajFundFlows(fundBookWithRow([null, "2026年1月", 1, 1, 1, 0, 1, 1, 0, 100, 1], header))
    ).toThrow("ヘッダ行が見つかりません");
  });

  it("D-1 列10〜11 (負債総額/組入不動産の総額) が入れ替わったら throw する", () => {
    const header = [...REIT_HEADER_ROW];
    [header[10], header[11]] = [header[11], header[10]];
    const bytes = bookWithSheets({
      月次: [header, [null, "2026年1月", 1, 1, 0, 1, 1, 100, 100, 1, 1, 1, 1, 1]],
    });
    expect(() => parseImajReitFlows(bytes)).toThrow("ヘッダ行が見つかりません");
  });

  it("D-1 列12〜13 (月末総口数/ファンド本数) が入れ替わったら throw する", () => {
    const header = [...REIT_HEADER_ROW];
    [header[12], header[13]] = [header[13], header[12]];
    const bytes = bookWithSheets({
      月次: [header, [null, "2026年1月", 1, 1, 0, 1, 1, 100, 100, 1, 1, 1, 1, 1]],
    });
    expect(() => parseImajReitFlows(bytes)).toThrow("ヘッダ行が見つかりません");
  });

  describe.skipIf(!hasFixtures)("実フィクスチャ", () => {
    it("実ファイル (改行入り見出し) では全列の検証を通過する", () => {
      expect(parseImajReitFlows(reitFixtureBytes()).length).toBe(14);
      expect(parseImajFundFlows(fundFixtureBytes()).length).toBe(70);
    });
  });
});

describe("回帰: 収益分配額の '-' を 0 と決め打ちしない", () => {
  it("収益分配額セルが '-' なら null (不明) を返す", () => {
    // 原本 総合計 1989年1月 の行: 収益分配額(E) は "-" (1989-01〜1997-03 は別掲されていない)
    const rows = parseImajFundFlows(
      fundBookWithRow([null, "1989年1月", 2388331, 2203440, 29715, 155176, "-", 900321, 1055497, 53952793, 3308])
    );
    expect(rows.every((r) => r.profitDistributions === null)).toBe(true);
    // 他の列の '-' 以外の値はそのまま
    expect(rows[0]).toMatchObject({ netFlow: 155176, totalNetAssets: 53952793 });
  });

  describe.skipIf(!hasFixtures)("実フィクスチャ", () => {
    it("実在の収益分配額は数値のまま保持する (原本 ETF 2026年7月 = 1,785,617 百万円)", () => {
      const row = parseImajFundFlows(fundFixtureBytes()).find(
        (r) => r.category === "equity_etf" && r.period === "2026-07"
      );
      expect(row!.profitDistributions).toBe(1785617);
    });
  });

  it("収益分配額が '-'/数値以外の未知の文字列なら throw する", () => {
    expect(() =>
      parseImajFundFlows(fundBookWithRow([null, "2026年1月", 1, 1, 1, 0, "*", 1, 0, 100, 1]))
    ).toThrow("数値セルが解釈できません");
  });
});

describe.skipIf(!hasFixtures)("回帰: judgeImajPublicationStatus の期間形式検証", () => {
  it("ゼロ埋めでない 'YYYY-M' は誤判定せず throw する", () => {
    const rows = parseImajFundFlows(fundFixtureBytes());
    // "2026-8" は文字列比較で "2026-08" より大きく、公表済みなのに未公表と誤判定していた
    expect(() => judgeImajPublicationStatus("2026-8", rows)).toThrow("'YYYY-MM' 形式");
    expect(() => judgeImajPublicationStatus("2026-13", rows)).toThrow("'YYYY-MM' 形式");
  });
});

describe("回帰: 公募REIT純資産総額の定義 (ルール7: 帳簿価額であり時価ではない)", () => {
  describe.skipIf(!hasFixtures)("実フィクスチャ", () => {
    it("前月比の増減が資本金増減額+その他増減額と一致する (投資口価格を反映しない) ことを実データで確認", () => {
      const rows = parseImajReitFlows(reitFixtureBytes());
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i]!.totalNetAssets - rows[i - 1]!.totalNetAssets).toBe(
          rows[i]!.capitalChange + rows[i]!.otherChange
        );
      }
    });
  });

  it("説明文が「値上がり・値下がりの影響も含む」と誤って教えない", () => {
    const def = IMAJ_REIT_FLOWS_INDICATORS.find((d) => d.key === "imaj_reit_net_asset_total")!;
    expect(def.plainExplanation).not.toContain("値上がり・値下がりの影響も含む");
    expect(def.plainExplanation).toContain("含まない");
    expect(def.measures).toContain("時価総額) ではない");
  });
});
