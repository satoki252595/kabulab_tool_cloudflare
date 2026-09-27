/**
 * JSDA 公社債統計パーサの単体テスト。
 *
 * フィクスチャは本セッション中 (2026-09-27) に実際に取得した生ファイルその
 * ものであり、架空値は一切含まない (CLAUDE.md ルール1)。
 * 置き場所は fixtures/private/jsda-bonds/ (JSDA の資料は再配布不可のため commit しない。
 * `.gitignore` 済み)。置いていない環境 (CI) では実ファイルを読むテストだけを
 * `describe.skipIf(!hasFixtures)` で skip する。
 *   - fixtures/private/jsda-bonds/jsda-hakkou-index-2026-09-27.html
 *     https://www.jsda.or.jp/shiryoshitsu/toukei/hakkou/index.html
 *   - fixtures/private/jsda-bonds/jsda-toushika-index-discontinued-2026-09-27.html
 *     https://www.jsda.or.jp/shiryoshitsu/toukei/toushika/index.html
 *   - fixtures/private/jsda-bonds/jsda-hakkou-2026-07.xlsx (430KB)
 *     https://www.jsda.or.jp/shiryoshitsu/toukei/hakkou/hakkougakushoukanngaku.xlsx
 *     (上の index.html が指す実ファイルそのもの。取得は JSDA 側の 429 レート
 *     制限のため通常のバックオフ (60/120/240秒) では解消せず、10分の長い
 *     バックオフでようやく成功した)
 *
 * xlsx の期待値は Node (`xlsx` パッケージ) で原本を直接開いて目視確認した
 * セルの値そのもの。「国債（JGB）」シート 2026.07 行の発行額・償還額に加え、
 * 9種類の発行額・償還額をそれぞれ合計すると「合計（Total）」シートの値と
 * 完全一致することも確認済み (パーサの列特定ロジックが正しいことの独立した
 * 裏取り)。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";
import {
  fetchFromJsda,
  investorTurnoverStatus,
  issuanceRedemptionPublicationStatus,
  JSDA_BONDS_INDICATORS,
  JSDA_JYOUKEN_PAGE_URL,
  JSDA_TENTOUBAIBAI_PAGE_URL,
  parseHakkouIndexHtml,
  parseIssuanceRedemptionWorkbook,
  toIssuanceRedemptionObservations,
} from "./jsda-bonds.js";

const FX = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "private", "jsda-bonds");
const HAKKOU_HTML_FILE = "jsda-hakkou-index-2026-09-27.html";
const TOUSHIKA_HTML_FILE = "jsda-toushika-index-discontinued-2026-09-27.html";
const HAKKOU_XLSX_FILE = "jsda-hakkou-2026-07.xlsx";
const hasFixtures = [HAKKOU_HTML_FILE, TOUSHIKA_HTML_FILE, HAKKOU_XLSX_FILE].every((n) => existsSync(join(FX, n)));

// 実ファイルは skip されないテストの中でだけ読む (未取得の環境で import 時に throw させない)。
const hakkouHtml = () => readFileSync(join(FX, HAKKOU_HTML_FILE), "utf8");
const toushikaHtml = () => readFileSync(join(FX, TOUSHIKA_HTML_FILE), "utf8");
let hakkouXlsxCache: Uint8Array | undefined;
const hakkouXlsx = (): Uint8Array => {
  if (hakkouXlsxCache === undefined) hakkouXlsxCache = new Uint8Array(readFileSync(join(FX, HAKKOU_XLSX_FILE)));
  return hakkouXlsxCache;
};

describe.skipIf(!hasFixtures)("parseHakkouIndexHtml (公社債発行額・償還額 一覧ページ, 実ページ)", () => {
  it("実ページの最新リンクから対象月・掲載日・URL を取り出す", () => {
    const latest = parseHakkouIndexHtml(hakkouHtml());
    // 原本を目視確認した値そのもの:
    //   「公社債発行額・償還額（2026年7月分更新）」(掲載日：2026.9.10）
    //   <a href="hakkougakushoukanngaku.xlsx">
    expect(latest.periodMonth).toBe("2026-07");
    expect(latest.publishedOn).toBe("2026-09-10");
    expect(latest.filename).toBe("hakkougakushoukanngaku.xlsx");
    expect(latest.fileUrl).toBe(
      "https://www.jsda.or.jp/shiryoshitsu/toukei/hakkou/hakkougakushoukanngaku.xlsx"
    );
  });

  it("相対 href をページ URL 基準の絶対 URL に解決する (ディレクトリ相対)", () => {
    const latest = parseHakkouIndexHtml(
      hakkouHtml(),
      "https://www.jsda.or.jp/shiryoshitsu/toukei/hakkou/index.html"
    );
    // ルート相対 ("/...") ではなくディレクトリ相対で解決できることの回帰。
    expect(latest.fileUrl.startsWith("https://www.jsda.or.jp/shiryoshitsu/toukei/hakkou/")).toBe(
      true
    );
  });
});

describe("parseHakkouIndexHtml (公社債発行額・償還額 一覧ページ)", () => {
  it("様式が変わりリンクを認識できない場合は throw する (捏造しない)", () => {
    expect(() => parseHakkouIndexHtml("<html><body>no link here</body></html>")).toThrow(
      "様式が変わり"
    );
  });

  it("最新リンク自体に掲載日が無ければ、後続の別リンクの掲載日を借用せず throw する (回帰)", () => {
    // 実ページでは最新リンク直後の「（掲載日：2026.9.10）」の後に、2019年3月分
    // までの旧ファイルへのリンク「（掲載日：2019.6.26）」が続く。最新リンク側の
    // 掲載日表記だけが消えた場合に、300 字以内にある別リンクの掲載日を最新
    // ファイルの掲載日として黙って採用しないこと (ルール2)。
    const html = [
      '<li><a href="hakkougakushoukanngaku.xlsx"><span style="font-size: 110%;">',
      "公社債発行額・償還額（2026年8月分更新）</span></a></li>",
      '<li><a href="hakkougakushoukanngaku201903.xls">（2019年3月分まで）公社債発行額・償還額</a>',
      "（掲載日：2019.6.26）</li>",
    ].join("");
    expect(() => parseHakkouIndexHtml(html)).toThrow("様式が変わり");
  });
});

describe.skipIf(!hasFixtures)("issuanceRedemptionPublicationStatus (まだ公表されていない判定)", () => {
  let latest: ReturnType<typeof parseHakkouIndexHtml>;
  beforeAll(() => {
    latest = parseHakkouIndexHtml(hakkouHtml());
  });

  it("最新月そのものは published + 実際の掲載日を返す", () => {
    expect(issuanceRedemptionPublicationStatus(latest, "2026-07")).toEqual({
      kind: "published",
      period: "2026-07",
      publishedOn: "2026-09-10",
    });
  });

  it("最新月より先の月は not_yet_published を返す", () => {
    const status = issuanceRedemptionPublicationStatus(latest, "2026-08");
    expect(status.kind).toBe("not_yet_published");
    if (status.kind === "not_yet_published") {
      expect(status.expectedPeriod).toBe("2026-08");
    }
  });

  it("過去月は published だが掲載日は捏造せず undefined を返す", () => {
    const status = issuanceRedemptionPublicationStatus(latest, "2026-06");
    expect(status).toEqual({ kind: "published", period: "2026-06", publishedOn: undefined });
  });

  it("targetMonth が YYYY-MM 形式でなければ throw する (辞書式比較で誤判定しない, 回帰)", () => {
    // "2026-1" (1月のつもり) は "2026-07" と辞書式比較すると '1' > '0' で
    // 「未公表」と誤判定される。ゼロ埋めされていない値は判定せずに失敗させる。
    expect(() => issuanceRedemptionPublicationStatus(latest, "2026-1")).toThrow("YYYY-MM 形式");
    expect(() => issuanceRedemptionPublicationStatus(latest, "2026-13")).toThrow("YYYY-MM 形式");
  });
});

describe.skipIf(!hasFixtures)("investorTurnoverStatus (公社債投資家別売買高の終了判定, 実ページ)", () => {
  it("実ページの「発表様式の再編」記載から終了状態と後継 URL を返す", () => {
    const status = investorTurnoverStatus(toushikaHtml());
    expect(status.kind).toBe("discontinued");
    // 原本を目視確認した値: 実データ .xls 2 件の最終更新日は共に 2018.5.21
    // (解説PDF等の付随資料 2015.8.20 / 2016.3.22 は対象外)。
    expect(status.lastUpdatedOn).toBe("2018.5.21");
    const urls = status.successors.map((s) => s.url);
    expect(urls).toContain(JSDA_TENTOUBAIBAI_PAGE_URL);
    expect(urls).toContain(JSDA_JYOUKEN_PAGE_URL);
  });
});

describe("investorTurnoverStatus (公社債投資家別売買高の終了判定)", () => {
  it("「発表様式の再編」の記載がなければ throw する (復活を見逃さない)", () => {
    expect(() =>
      investorTurnoverStatus("<html><body>投資家別売買高 最終更新日：2026.9.1</body></html>")
    ).toThrow("見当たりません");
  });

  it("解説PDF等の付随資料の「最終更新日」は拾わず、実データ(.xls)の日付だけを見る (回帰)", () => {
    // 実ページには解説PDF (files/tkb.pdf 等) の更新日 (2015.8.20/2016.3.22) が
    // 実データxlsの更新日 (2018.5.21) と混在している。ここでは解説PDF側に
    // 実データより新しい日付 (2099.1.1) を仕込んでも、xls側の日付だけが
    // 採用されることを検証する — 将来解説PDFだけが更新されても、統計本体の
    // 「最終更新日」として誤報告しないことの担保。
    const html = [
      "<html><body>",
      "発表様式の再編等について",
      '<li><a href="files/tkb.pdf">解説資料</a>（最終更新日：2099.1.1）</li>',
      '<li><a href="tkb/files/koushasai1804.xls">公社債投資家別売買高</a>(最終更新日：2018.5.21）</li>',
      '<a href="/shiryoshitsu/toukei/tentoubaibai/index.html">公社債店頭売買高</a>',
      "</body></html>",
    ].join("\n");
    const status = investorTurnoverStatus(html);
    expect(status.lastUpdatedOn).toBe("2018.5.21");
  });

  it(".xls リンク自体に日付が無い場合、直後の解説PDFリンクの日付を借用しない (回帰)", () => {
    // .xls リンクの後ろ 200 字以内に別リンク (解説PDF) の「最終更新日」がある
    // 並びでも、それを .xls の更新日として拾わないこと。
    const html = [
      "<html><body>",
      "発表様式の再編等について",
      '<li><a href="tkb/files/koushasai1804.xls">公社債投資家別売買高</a>(最終更新日：2018.5.21）</li>',
      '<li><a href="tkb/files/koushasaiichiran.xls">公社債投資家別売買高（一覧）</a></li>',
      '<li><a href="files/tkb.pdf">解説資料</a>（最終更新日：2099.1.1）</li>',
      '<a href="/shiryoshitsu/toukei/tentoubaibai/index.html">公社債店頭売買高</a>',
      "</body></html>",
    ].join("\n");
    expect(investorTurnoverStatus(html).lastUpdatedOn).toBe("2018.5.21");
  });

  it("最終更新日の最大値は日付として比較する (文字列の辞書式順序で比べない, 回帰)", () => {
    // 文字列比較だと "2018.5.21" > "2018.12.3" になり、古い方を「最終」と誤報告する。
    const html = [
      "<html><body>",
      "発表様式の再編等について",
      '<li><a href="tkb/files/a.xls">公社債投資家別売買高</a>(最終更新日：2018.5.21）</li>',
      '<li><a href="tkb/files/b.xls">公社債投資家別売買高（一覧）</a>(最終更新日：2018.12.3）</li>',
      '<a href="/shiryoshitsu/toukei/tentoubaibai/index.html">公社債店頭売買高</a>',
      "</body></html>",
    ].join("\n");
    expect(investorTurnoverStatus(html).lastUpdatedOn).toBe("2018.12.3");
  });
});

describe.skipIf(!hasFixtures)("parseIssuanceRedemptionWorkbook (実 xlsx フィクスチャ)", () => {
  it("国債（JGB）2026年7月分の発行額・償還額を原本の値どおりに読む", () => {
    const { rows } = parseIssuanceRedemptionWorkbook(hakkouXlsx(), "2026-07");
    const jgb = rows.find((r) => r.bondType === "国債（JGB）");
    expect(jgb).toBeDefined();
    // 原本 (国債シート 2026.07 行) を目視確認した値: 単位は百万円。
    //   発行額(a) = 14,524,109 百万円 → 14,524,109,000,000 円
    //   償還合計(b) = 8,048,861 百万円 → 8,048,861,000,000 円
    expect(jgb!.issuance).toBe(14_524_109_000_000);
    expect(jgb!.redemption).toBe(8_048_861_000_000);
  });

  it("列幅が異なるシート (非居住者債。「転換額」列が挟まる) も正しい列を読む", () => {
    const { rows } = parseIssuanceRedemptionWorkbook(hakkouXlsx(), "2026-07");
    const nonResident = rows.find((r) => r.bondType === "非居住者債");
    expect(nonResident).toBeDefined();
    // 原本を目視確認した値: 償還合計(b) = 241,900 百万円。
    // 「転換額」列 (常に0) を誤って合計(b)として読むと 0 になってしまうため、
    // 列をラベルで動的に特定できていることの回帰。
    expect(nonResident!.redemption).toBe(241_900_000_000);
  });

  it("9種類の発行額・償還額の合計が「合計（Total）」シートと一致する", () => {
    const { rows } = parseIssuanceRedemptionWorkbook(hakkouXlsx(), "2026-07");
    const total = rows.find((r) => r.bondType === "合計（Total）");
    const byType = rows.filter((r) => r.bondType !== "合計（Total）");
    expect(total).toBeDefined();
    const sumIssuance = byType.reduce((a, r) => a + r.issuance, 0);
    const sumRedemption = byType.reduce((a, r) => a + r.redemption, 0);
    expect(sumIssuance).toBe(total!.issuance);
    expect(sumRedemption).toBe(total!.redemption);
    // 原本を目視確認した合計シートの値。
    expect(total!.issuance).toBe(18_459_539_000_000);
    expect(total!.redemption).toBe(10_634_271_000_000);
  });

  it("月ラベルが数値セル/文字列セルのどちらの月でも行を特定でき、9種類の合計が「合計（Total）」と一致する", () => {
    // 原本の月ラベルは、シート・月によって数値セル (例: 国債シートの 2020.04、
    // 2023.04 は全シート数値) と文字列セル (例: 10月は全シート '2024.10' 等) が
    // 混在している (openpyxl で確認)。その各パターンの代表月で行を特定でき、
    // かつ列の取り違えが無いこと (9種類の和 = 合計シート) を確認する回帰。
    // (2026-09-27 再検証: 2019.04〜2026.07 の全88か月 × 10シートの 1,760 値を
    // openpyxl で独立に読んだ値と照合し全一致。全月をここで回すと xlsx の再
    // 読込で約18秒かかるため、テストは代表月に絞る。)
    const months = [
      "2019-04", // 先頭月 (全シート文字列)
      "2019-10", // 10月 (全シート文字列)
      "2020-04", // 国債シートのみ数値、他は文字列
      "2023-04", // 全シート数値
      "2024-10", // 10月 (全シート文字列)
      "2026-01", // 全シート数値
      "2026-07", // 最新月
    ];
    for (const ym of months) {
      const { rows } = parseIssuanceRedemptionWorkbook(hakkouXlsx(), ym);
      expect(rows).toHaveLength(10);
      const total = rows.find((r) => r.bondType === "合計（Total）")!;
      const byType = rows.filter((r) => r.bondType !== "合計（Total）");
      expect(byType.reduce((a, r) => a + r.issuance, 0)).toBe(total.issuance);
      expect(byType.reduce((a, r) => a + r.redemption, 0)).toBe(total.redemption);
    }
  }, 30_000);

  it("転換社債(CB)の償還額(合計b)には株式への転換額も合算される — 現金償還のみを表す値ではない (原本で確認)", () => {
    // 原本 (転換社債（CB）シート 2026.07 行) を目視確認した内訳:
    //   満期償還額=0・定時償還額=0・買入消却額=0・転換額=600 (百万円)
    //   → 合計(b)=600 百万円 は全額が株式への転換によるもので、
    //     現金による償還は0円だった。jsda_bond_redemption の説明文
    //     (「償還期日到来による現金償還」ではない旨) の裏付けとなる回帰。
    const { rows } = parseIssuanceRedemptionWorkbook(hakkouXlsx(), "2026-07");
    const cb = rows.find((r) => r.bondType === "転換社債（CB）");
    expect(cb).toBeDefined();
    expect(cb!.redemption).toBe(600_000_000);
  });

  it("償還額の指標定義は原本の注記どおり転換額を含むと説明する (「償還期日到来分」と誤定義しない, 回帰)", () => {
    // 原本「合計（Total）」シートの注記 6「買入消却額には、転換額を含みます。」
    // を実ファイルから読み、指標定義の説明・限界がそれと矛盾しないことを確認する。
    const wb = XLSX.read(hakkouXlsx(), { type: "array" });
    const cells = XLSX.utils
      .sheet_to_json<unknown[]>(wb.Sheets["合計（Total）"]!, { header: 1, defval: "" })
      .flat()
      .map(String);
    expect(cells.some((c) => c.includes("買入消却額には、転換額を含みます"))).toBe(true);

    const def = JSDA_BONDS_INDICATORS.find((d) => d.key === "jsda_bond_redemption");
    expect(def).toBeDefined();
    expect(def!.description).toContain("転換");
    expect(def!.limitations).toContain("転換");
    // 修正前の誤解を招く定義文 (償還期日を迎えた分だけであるかのような説明) に戻さない。
    expect(def!.description).not.toContain("償還期日を迎えた公社債の金額");
  });

  it("まだ公表されていない月 (値が空/シートにより0が先埋め) は throw する", () => {
    // 原本確認: 2026.08 行は「国債」等では空文字、「金融債」等では "0" が
    // 先埋めされており不統一 (テンプレートの先埋めであり実測値ではない)。
    // 0 で黙って埋めず、様式相違として明示的に失敗させる (ルール2)。
    expect(() => parseIssuanceRedemptionWorkbook(hakkouXlsx(), "2026-08")).toThrow(
      "空です"
    );
  });

  it("targetMonth が YYYY-MM 形式でなければ throw する", () => {
    expect(() => parseIssuanceRedemptionWorkbook(hakkouXlsx(), "2026/07")).toThrow(
      "YYYY-MM 形式"
    );
  });
});

describe("toIssuanceRedemptionObservations (観測ログ用の縦長レコード)", () => {
  it("種類別 1 行から発行額・償還額 2 レコードを作る", () => {
    const rows = toIssuanceRedemptionObservations({
      periodMonth: "2026-07",
      rows: [
        { bondType: "国債", issuance: 30_000_000_000_000, redemption: 25_000_000_000_000 },
        { bondType: "普通社債", issuance: 1_000_000_000_000, redemption: 900_000_000_000 },
      ],
    });
    expect(rows).toHaveLength(4);
    expect(rows[0]).toEqual({
      period: "2026-07",
      periodGranularity: "month",
      indicatorKey: "jsda_bond_issuance",
      segment: "国債",
      segmentKind: "bond_type",
      value: 30_000_000_000_000,
      unit: "円",
      isApproximate: false,
      isEstimated: false,
    });
    expect(rows[1].indicatorKey).toBe("jsda_bond_redemption");
    expect(rows[1].value).toBe(25_000_000_000_000);
  });
});

describe("fetchFromJsda (429 のバックオフ)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // 待ち時間 (setTimeout の delay) を記録し、実際には即時に進める。
  const captureWaits = (): number[] => {
    const waits: number[] = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      waits.push(ms ?? NaN);
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    return waits;
  };
  const stub429 = (retryAfter: string | null) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("busy", {
          status: 429,
          headers: retryAfter === null ? {} : { "Retry-After": retryAfter },
        })
      )
    );

  it("Retry-After が空・負数・HTTP-date なら解釈せず予定のバックオフで待つ (即時連打しない, 回帰)", async () => {
    for (const ra of ["", "-30", "Wed, 21 Oct 2026 07:28:00 GMT", null]) {
      const waits = captureWaits();
      stub429(ra);
      await expect(fetchFromJsda("https://example.invalid/x", {}, "t", [1000, 2000, 3000])).rejects.toThrow(
        /3 回のバックオフ/
      );
      expect(waits, `Retry-After=${JSON.stringify(ra)}`).toEqual([1000, 2000, 3000]);
      vi.restoreAllMocks();
    }
  });

  it("Retry-After が秒数なら それ + 0.5 秒待つ", async () => {
    const waits = captureWaits();
    stub429("7");
    await expect(fetchFromJsda("https://example.invalid/x", {}, "t", [1000])).rejects.toThrow();
    expect(waits).toEqual([7500]);
  });
});
