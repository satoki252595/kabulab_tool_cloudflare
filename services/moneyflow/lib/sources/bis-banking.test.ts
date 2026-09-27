/**
 * BIS Locational Banking Statistics パーサのテスト。
 *
 * フィクスチャ (fixtures/bis-lbs-{claims,liabilities}-jp.csv) は
 * 2026-09-27 に実際に BIS Data Portal SDMX API から取得した実データ
 * (加工・間引き無し。CLAUDE.md ルール1: 架空値を混ぜない)。
 *
 *   GET https://stats.bis.org/api/v2/data/dataflow/BIS/WS_LBS_D_PUB/1.0/
 *       Q.S.C.A.TO1.A.5J.A.JP.A..N?format=csv&lastNObservations=2   (claims)
 *   GET https://stats.bis.org/api/v2/data/dataflow/BIS/WS_LBS_D_PUB/1.0/
 *       Q.S.L.A.TO1.A.5J.A.JP.A..N?format=csv&lastNObservations=2   (liabilities)
 *
 * 検証する既知値 (原本 CSV を目視で確認済み。fixtures 内の該当行そのもの):
 *   claims 2026-Q1:      US=2,379,304.268 / GB=458,048.538 / DE=128,644.097
 *                        (百万米ドル、L_POSITION=C, L_POS_TYPE=N, L_CP_SECTOR=A)
 *   liabilities 2026-Q1: US=525,905.198  / GB=473,663.377 / DE=40,403.103
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BIS_BANKING_INDICATORS,
  bisBankingUrl,
  latestQuarterFromRows,
  mostRecentEndedQuarter,
  parseBisBankingCsv,
  resolvePublicationStatus,
  toMoneyflowObservations,
  type BisBankingRawRow,
} from "./bis-banking.js";

const FX = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fx = (name: string) => readFileSync(join(FX, name), "utf8");

const CLAIMS_CSV = fx("bis-lbs-claims-jp.csv");
const LIABILITIES_CSV = fx("bis-lbs-liabilities-jp.csv");

describe("bisBankingUrl (URL 解決)", () => {
  it("BIS SDMX v2 API の決定的な URL を組み立てる", () => {
    const url = bisBankingUrl("claims", 2);
    expect(url).toBe(
      "https://stats.bis.org/api/v2/data/dataflow/BIS/WS_LBS_D_PUB/1.0/" +
        "Q.S.C.A.TO1.A.5J.A.JP.A..N?format=csv&lastNObservations=2"
    );
  });

  it("liabilities は L_POSITION=L になる", () => {
    const url = bisBankingUrl("liabilities", 1);
    expect(url).toContain("Q.S.L.A.TO1.A.5J.A.JP.A..N");
    expect(url).toContain("lastNObservations=1");
  });
});

describe("parseBisBankingCsv (実フィクスチャの既知値検証)", () => {
  const claimsRows = parseBisBankingCsv(CLAIMS_CSV, "claims");
  const liabilitiesRows = parseBisBankingCsv(LIABILITIES_CSV, "liabilities");

  function find(
    rows: BisBankingRawRow[],
    country: string,
    quarter: string
  ): BisBankingRawRow | undefined {
    return rows.find(
      (r) =>
        r.counterpartyCountry === country &&
        r.quarter === quarter &&
        r.counterpartySector === "A"
    );
  }

  it("対米与信残高 2026-Q1 が原本の値と一致する (既知値1)", () => {
    const row = find(claimsRows, "US", "2026-Q1");
    expect(row?.valueUsdMillion).toBe(2379304.268);
  });

  it("対英与信残高 2026-Q1 が原本の値と一致する (既知値2)", () => {
    const row = find(claimsRows, "GB", "2026-Q1");
    expect(row?.valueUsdMillion).toBe(458048.538);
  });

  it("対独与信残高 2026-Q1 が原本の値と一致する (既知値3)", () => {
    const row = find(claimsRows, "DE", "2026-Q1");
    expect(row?.valueUsdMillion).toBe(128644.097);
  });

  it("対米負債残高 2026-Q1 が原本の値と一致する (既知値4)", () => {
    const row = find(liabilitiesRows, "US", "2026-Q1");
    expect(row?.valueUsdMillion).toBe(525905.198);
  });

  it("対英負債残高 2026-Q1 が原本の値と一致する (既知値5)", () => {
    const row = find(liabilitiesRows, "GB", "2026-Q1");
    expect(row?.valueUsdMillion).toBe(473663.377);
  });

  it("対独負債残高 2026-Q1 が原本の値と一致する (既知値6)", () => {
    const row = find(liabilitiesRows, "DE", "2026-Q1");
    expect(row?.valueUsdMillion).toBe(40403.103);
  });

  it("position を各行に正しく付与する", () => {
    expect(claimsRows.every((r) => r.position === "claims")).toBe(true);
    expect(liabilitiesRows.every((r) => r.position === "liabilities")).toBe(
      true
    );
  });

  it("全世界合計行 (5J) も除外せず取り込む (国別除外は別関数の責務)", () => {
    const anchor = claimsRows.find(
      (r) => r.counterpartyCountry === "5J" && r.quarter === "2026-Q1"
    );
    expect(anchor?.valueUsdMillion).toBe(5257195.619);
  });
});

describe("parseBisBankingCsv の様式異常検知 (throw すること)", () => {
  it("必須列が無いヘッダは throw する", () => {
    const broken = "FREQ,L_MEASURE\nQ,S\n";
    expect(() => parseBisBankingCsv(broken, "claims")).toThrow(
      /列.*見つかりません/
    );
  });

  it("列数がヘッダとずれる行は throw する", () => {
    const header = CLAIMS_CSV.split("\n")[0];
    const broken = `${header}\nQ,S,C,A,TO1,A,5J,A,JP,A,US,N\n`; // 12列しかない
    expect(() => parseBisBankingCsv(broken, "claims")).toThrow(
      /列数.*一致しません/
    );
  });

  it("OBS_VALUE が数値にも NaN 文字列にも解釈できない行は throw する", () => {
    const lines = CLAIMS_CSV.split("\n");
    const header = lines[0];
    const sample = lines.find((l) => l.includes(",2026-Q1,")) ?? lines[1];
    const cols = sample.split(",");
    const obsValueIdx = header.split(",").indexOf("OBS_VALUE");
    cols[obsValueIdx] = "見つかりません";
    const broken = `${header}\n${cols.join(",")}\n`;
    expect(() => parseBisBankingCsv(broken, "claims")).toThrow(
      /数値として解釈できません/
    );
  });

  it("UNIT_MEASURE/UNIT_MULT が想定外の行は throw する (百万米ドル前提が崩れる)", () => {
    const lines = CLAIMS_CSV.split("\n");
    const header = lines[0];
    const sample = lines.find((l) => l.includes(",2026-Q1,")) ?? lines[1];
    const cols = sample.split(",");
    const unitMultIdx = header.split(",").indexOf("UNIT_MULT");
    cols[unitMultIdx] = "3"; // 千単位に変わったふりをする
    const broken = `${header}\n${cols.join(",")}\n`;
    expect(() => parseBisBankingCsv(broken, "claims")).toThrow(
      /単位が想定外/
    );
  });

  it("データ行が 0 件なら throw する", () => {
    const header = CLAIMS_CSV.split("\n")[0];
    expect(() => parseBisBankingCsv(`${header}\n`, "claims")).toThrow(
      /データ行が 0 件/
    );
  });

  it("空文字列は throw する", () => {
    expect(() => parseBisBankingCsv("", "claims")).toThrow(/空の応答/);
  });
});

describe("latestQuarterFromRows / 公表判定 (期間と「まだ公表されていない」)", () => {
  const claimsRows = parseBisBankingCsv(CLAIMS_CSV, "claims");

  it("フィクスチャの実在する最新四半期は 2026-Q1 (5J 錨で判定)", () => {
    expect(latestQuarterFromRows(claimsRows)).toBe("2026-Q1");
  });

  it("mostRecentEndedQuarter は進行中の四半期を含めない", () => {
    // 2026-09-27 (Q3進行中) の直近に終わった四半期は 2026-Q2 (4-6月期)。
    expect(mostRecentEndedQuarter(new Date("2026-09-27T00:00:00Z"))).toBe(
      "2026-Q2"
    );
    // 年をまたぐケース (1月は前年Q4が直近に終わった四半期)。
    expect(mostRecentEndedQuarter(new Date("2027-01-15T00:00:00Z"))).toBe(
      "2026-Q4"
    );
  });

  it(
    "実データでは 2026-Q2 がまだ BIS に公表されておらず isCaughtUp=false になる " +
      "(2026-09-27 に stats.bis.org へ 2026-Q2 を直接問い合わせ、404/該当なしを実機確認済み)",
    () => {
      const status = resolvePublicationStatus(
        claimsRows,
        new Date("2026-09-27T00:00:00Z")
      );
      expect(status.latestAvailableQuarter).toBe("2026-Q1");
      expect(status.mostRecentEndedQuarter).toBe("2026-Q2");
      expect(status.isCaughtUp).toBe(false);
    }
  );

  it("公表が暦に追いついていれば isCaughtUp=true になる", () => {
    const status = resolvePublicationStatus(
      claimsRows,
      new Date("2026-06-01T00:00:00Z") // 直近に終わった四半期は 2026-Q1
    );
    expect(status.mostRecentEndedQuarter).toBe("2026-Q1");
    expect(status.isCaughtUp).toBe(true);
  });

  it("5J 錨行が無ければ throw する", () => {
    const withoutAnchor = claimsRows.filter(
      (r) => r.counterpartyCountry !== "5J"
    );
    expect(() => latestQuarterFromRows(withoutAnchor)).toThrow(
      /全世界合計行/
    );
  });
});

describe("toMoneyflowObservations (縦長レコードへの変換)", () => {
  const claimsRows = parseBisBankingCsv(CLAIMS_CSV, "claims");
  const observations = toMoneyflowObservations(claimsRows);

  it("全世界合計行 (5J) を除外する", () => {
    expect(observations.some((o) => o.category === "5J")).toBe(false);
  });

  it("国際機関行 (1C) は「相手国」ではないため除外する", () => {
    // フィクスチャに 1C (International organisations) の非欠測行が実在する
    // 前提の確認 (この前提が崩れたら本テストは何も検証していないことになる)。
    const rawAnchor = claimsRows.find(
      (r) => r.counterpartyCountry === "1C" && r.quarter === "2026-Q1"
    );
    expect(rawAnchor?.valueUsdMillion).toBe(14873.514);

    expect(observations.some((o) => o.category === "1C")).toBe(false);
  });

  it("欠測 (NaN) 行を 0 で埋めずに除外する", () => {
    const nanRows = claimsRows.filter((r) => r.valueUsdMillion === null);
    expect(nanRows.length).toBeGreaterThan(0); // フィクスチャに欠測行が実在する前提の確認
    for (const nanRow of nanRows) {
      expect(
        observations.some(
          (o) =>
            o.category === nanRow.counterpartyCountry &&
            o.period === nanRow.quarter
        )
      ).toBe(false);
    }
  });

  it("対米与信残高 2026-Q1 が指標キー付きの縦長レコードになる", () => {
    const rec = observations.find(
      (o) => o.category === "US" && o.period === "2026-Q1"
    );
    expect(rec).toMatchObject({
      indicatorKey: "bis_lbs_cross_border_claims_jp",
      value: 2379304.268,
      unit: "USD_million",
      isApproximate: true,
      isEstimated: false,
    });
  });

  it("liabilities は別の指標キーになる", () => {
    const liabilitiesRows = parseBisBankingCsv(LIABILITIES_CSV, "liabilities");
    const liabObservations = toMoneyflowObservations(liabilitiesRows);
    const rec = liabObservations.find(
      (o) => o.category === "US" && o.period === "2026-Q1"
    );
    expect(rec?.indicatorKey).toBe("bis_lbs_cross_border_liabilities_jp");
    expect(rec?.value).toBe(525905.198);
  });
});

describe("BIS_BANKING_INDICATORS (指標定義)", () => {
  it("claims/liabilities の2指標を、必須フィールドを揃えてexportする", () => {
    expect(BIS_BANKING_INDICATORS).toHaveLength(2);
    for (const def of BIS_BANKING_INDICATORS) {
      expect(def.key).toMatch(/^bis_lbs_cross_border_(claims|liabilities)_jp$/);
      expect(def.flowType).toBe("holdings_stock");
      expect(def.requirements).toContain("R4");
      expect(def.unit).toBe("USD_million");
      expect(def.frequency).toBe("quarterly");
      expect(def.sourceUrl).toContain("data.bis.org");
      expect(def.plainExplanation.length).toBeGreaterThan(0);
      expect(def.preciseDefinition.length).toBeGreaterThan(0);
      expect(def.termsOfUse).toContain("BIS");
      expect(def.limitations.length).toBeGreaterThan(0);
    }
  });

  it("指標キーは toMoneyflowObservations が出すキーと一致する", () => {
    const claimsRows = parseBisBankingCsv(CLAIMS_CSV, "claims");
    const observedKeys = new Set(
      toMoneyflowObservations(claimsRows).map((o) => o.indicatorKey)
    );
    const definedKeys = new Set(BIS_BANKING_INDICATORS.map((d) => d.key));
    for (const key of observedKeys) {
      expect(definedKeys.has(key)).toBe(true);
    }
  });
});
