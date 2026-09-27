/**
 * JSDA 公社債統計パーサの単体テスト。
 *
 * フィクスチャは本セッション中 (2026-09-27) に実際に取得した生ファイルその
 * ものであり、架空値は一切含まない (CLAUDE.md ルール1)。
 *   - fixtures/jsda-hakkou-index-2026-09-27.html
 *     https://www.jsda.or.jp/shiryoshitsu/toukei/hakkou/index.html
 *   - fixtures/jsda-toushika-index-discontinued-2026-09-27.html
 *     https://www.jsda.or.jp/shiryoshitsu/toukei/toushika/index.html
 *   - fixtures/jsda-hakkou-2026-07.xlsx (430KB)
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
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  investorTurnoverStatus,
  issuanceRedemptionPublicationStatus,
  JSDA_JYOUKEN_PAGE_URL,
  JSDA_TENTOUBAIBAI_PAGE_URL,
  parseHakkouIndexHtml,
  parseIssuanceRedemptionWorkbook,
  toIssuanceRedemptionObservations,
} from "./jsda-bonds.js";

const FX = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fx = (n: string) => readFileSync(join(FX, n), "utf8");
const fxBytes = (n: string) => new Uint8Array(readFileSync(join(FX, n)));

const HAKKOU_HTML = fx("jsda-hakkou-index-2026-09-27.html");
const TOUSHIKA_HTML = fx("jsda-toushika-index-discontinued-2026-09-27.html");
const HAKKOU_XLSX = fxBytes("jsda-hakkou-2026-07.xlsx");

describe("parseHakkouIndexHtml (公社債発行額・償還額 一覧ページ)", () => {
  it("実ページの最新リンクから対象月・掲載日・URL を取り出す", () => {
    const latest = parseHakkouIndexHtml(HAKKOU_HTML);
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
      HAKKOU_HTML,
      "https://www.jsda.or.jp/shiryoshitsu/toukei/hakkou/index.html"
    );
    // ルート相対 ("/...") ではなくディレクトリ相対で解決できることの回帰。
    expect(latest.fileUrl.startsWith("https://www.jsda.or.jp/shiryoshitsu/toukei/hakkou/")).toBe(
      true
    );
  });

  it("様式が変わりリンクを認識できない場合は throw する (捏造しない)", () => {
    expect(() => parseHakkouIndexHtml("<html><body>no link here</body></html>")).toThrow(
      "様式が変わり"
    );
  });
});

describe("issuanceRedemptionPublicationStatus (まだ公表されていない判定)", () => {
  const latest = parseHakkouIndexHtml(HAKKOU_HTML);

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
});

describe("investorTurnoverStatus (公社債投資家別売買高の終了判定)", () => {
  it("実ページの「発表様式の再編」記載から終了状態と後継 URL を返す", () => {
    const status = investorTurnoverStatus(TOUSHIKA_HTML);
    expect(status.kind).toBe("discontinued");
    // 原本を目視確認した値: 掲載ファイルの最終更新日は全て 2018.5.21。
    expect(status.lastUpdatedOn).toBe("2018.5.21");
    const urls = status.successors.map((s) => s.url);
    expect(urls).toContain(JSDA_TENTOUBAIBAI_PAGE_URL);
    expect(urls).toContain(JSDA_JYOUKEN_PAGE_URL);
  });

  it("「発表様式の再編」の記載がなければ throw する (復活を見逃さない)", () => {
    expect(() =>
      investorTurnoverStatus("<html><body>投資家別売買高 最終更新日：2026.9.1</body></html>")
    ).toThrow("見当たりません");
  });
});

describe("parseIssuanceRedemptionWorkbook (実 xlsx フィクスチャ)", () => {
  it("国債（JGB）2026年7月分の発行額・償還額を原本の値どおりに読む", () => {
    const { rows } = parseIssuanceRedemptionWorkbook(HAKKOU_XLSX, "2026-07");
    const jgb = rows.find((r) => r.bondType === "国債（JGB）");
    expect(jgb).toBeDefined();
    // 原本 (国債シート 2026.07 行) を目視確認した値: 単位は百万円。
    //   発行額(a) = 14,524,109 百万円 → 14,524,109,000,000 円
    //   償還合計(b) = 8,048,861 百万円 → 8,048,861,000,000 円
    expect(jgb!.issuance).toBe(14_524_109_000_000);
    expect(jgb!.redemption).toBe(8_048_861_000_000);
  });

  it("列幅が異なるシート (非居住者債。「転換額」列が挟まる) も正しい列を読む", () => {
    const { rows } = parseIssuanceRedemptionWorkbook(HAKKOU_XLSX, "2026-07");
    const nonResident = rows.find((r) => r.bondType === "非居住者債");
    expect(nonResident).toBeDefined();
    // 原本を目視確認した値: 償還合計(b) = 241,900 百万円。
    // 「転換額」列 (常に0) を誤って合計(b)として読むと 0 になってしまうため、
    // 列をラベルで動的に特定できていることの回帰。
    expect(nonResident!.redemption).toBe(241_900_000_000);
  });

  it("9種類の発行額・償還額の合計が「合計（Total）」シートと一致する", () => {
    const { rows } = parseIssuanceRedemptionWorkbook(HAKKOU_XLSX, "2026-07");
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

  it("まだ公表されていない月 (値が空/シートにより0が先埋め) は throw する", () => {
    // 原本確認: 2026.08 行は「国債」等では空文字、「金融債」等では "0" が
    // 先埋めされており不統一 (テンプレートの先埋めであり実測値ではない)。
    // 0 で黙って埋めず、様式相違として明示的に失敗させる (ルール2)。
    expect(() => parseIssuanceRedemptionWorkbook(HAKKOU_XLSX, "2026-08")).toThrow(
      "空です"
    );
  });

  it("targetMonth が YYYY-MM 形式でなければ throw する", () => {
    expect(() => parseIssuanceRedemptionWorkbook(HAKKOU_XLSX, "2026/07")).toThrow(
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
