/**
 * BIS Locational Banking Statistics パーサのテスト。
 *
 * フィクスチャ (fixtures/public/bis-banking/bis-lbs-{claims,liabilities}-jp.csv) は
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

const FX = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "public", "bis-banking");
const fx = (name: string) => readFileSync(join(FX, name), "utf8");

const CLAIMS_CSV = fx("bis-lbs-claims-jp.csv");
const LIABILITIES_CSV = fx("bis-lbs-liabilities-jp.csv");

/**
 * 実フィクスチャから「相手国 country・四半期 quarter」の 1 行を取り出し、
 * 指定列だけ書き換えた CSV (ヘッダ + その 1 行) を作る。異常系テスト用
 * (該当行が無ければ throw — 別の行で黙ってテストしない)。
 */
function csvWithEditedRow(
  csv: string,
  country: string,
  quarter: string,
  edits: Record<string, string>
): string {
  const lines = csv.split("\n");
  const header = lines[0];
  const names = header.split(",");
  const countryIdx = names.indexOf("L_CP_COUNTRY");
  const periodIdx = names.indexOf("TIME_PERIOD");
  const hits = lines
    .slice(1)
    .filter((l) => {
      const c = l.split(",");
      return c[countryIdx] === country && c[periodIdx] === quarter;
    });
  if (hits.length !== 1) {
    throw new Error(
      `フィクスチャに ${country} ${quarter} の行が ${hits.length} 件 (1 件であるべき)`
    );
  }
  const cols = hits[0].split(",");
  for (const [column, value] of Object.entries(edits)) {
    const idx = names.indexOf(column);
    if (idx < 0) throw new Error(`フィクスチャに列 ${column} がありません`);
    cols[idx] = value;
  }
  return `${header}\n${cols.join(",")}\n`;
}

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
    const broken = csvWithEditedRow(CLAIMS_CSV, "US", "2026-Q1", {
      OBS_VALUE: "見つかりません",
    });
    expect(() => parseBisBankingCsv(broken, "claims")).toThrow(
      /数値として解釈できません/
    );
  });

  it("UNIT_MEASURE/UNIT_MULT が想定外の行は throw する (百万米ドル前提が崩れる)", () => {
    // 千単位に変わったふりをする
    const broken = csvWithEditedRow(CLAIMS_CSV, "US", "2026-Q1", {
      UNIT_MULT: "3",
    });
    expect(() => parseBisBankingCsv(broken, "claims")).toThrow(
      /単位が想定外/
    );
  });

  it("取得物の取り違え (claims の CSV を liabilities として解析) は throw する", () => {
    // 修正前は position 引数を行の L_POSITION と照合せず、対外与信の値を
    // 対外負債として黙って返していた (2026-09-27 再検証で発見)。
    expect(() => parseBisBankingCsv(CLAIMS_CSV, "liabilities")).toThrow(
      /L_POSITION=C.*一致しません/
    );
    expect(() => parseBisBankingCsv(LIABILITIES_CSV, "claims")).toThrow(
      /L_POSITION=L.*一致しません/
    );
  });

  it("要求した key と違う次元の行 (例: 越境でなく国内 L_POS_TYPE=R) は throw する", () => {
    const broken = csvWithEditedRow(CLAIMS_CSV, "US", "2026-Q1", {
      L_POS_TYPE: "R",
    });
    expect(() => parseBisBankingCsv(broken, "claims")).toThrow(
      /L_POS_TYPE=R.*一致しません/
    );
  });

  it("key の次元列がヘッダに無ければ throw する", () => {
    const [header, ...rest] = CLAIMS_CSV.split("\n");
    const broken = [header.replace("L_POSITION", "L_POSITION_X"), ...rest].join(
      "\n"
    );
    expect(() => parseBisBankingCsv(broken, "claims")).toThrow(
      /"L_POSITION".*見つかりません/
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

    // liabilities 側にも 1C の非欠測行が実在し、同様に除外される。
    const liabilitiesRows = parseBisBankingCsv(LIABILITIES_CSV, "liabilities");
    expect(
      liabilitiesRows.find(
        (r) => r.counterpartyCountry === "1C" && r.quarter === "2026-Q1"
      )?.valueUsdMillion
    ).toBe(890.125);
    expect(
      toMoneyflowObservations(liabilitiesRows).some((o) => o.category === "1C")
    ).toBe(false);
  });

  it("実データ (2026-09-27 取得) の観測行数: 各 253 行、うち最新 2026-Q1 は claims 110 / liabilities 114", () => {
    const liabObservations = toMoneyflowObservations(
      parseBisBankingCsv(LIABILITIES_CSV, "liabilities")
    );
    expect(observations).toHaveLength(253);
    expect(liabObservations).toHaveLength(253);
    expect(observations.filter((o) => o.period === "2026-Q1")).toHaveLength(110);
    expect(
      liabObservations.filter((o) => o.period === "2026-Q1")
    ).toHaveLength(114);
    // lastNObservations=2 は系列ごとの「最後の2観測」なので、報告が途絶えた
    // 国・地域は過去の四半期の行として出る (例: DD 東ドイツ 1990-Q2)。
    expect(
      observations.find((o) => o.category === "DD" && o.period === "1990-Q2")
        ?.value
    ).toBe(1062);
  });

  it("実データの観測行はすべて OBS_STATUS=A 由来で、系列の断層フラグは false", () => {
    expect(observations.every((o) => o.breakInSeries === false)).toBe(true);
  });

  it("OBS_STATUS=B (系列の断層) の値は breakInSeries=true で出す", () => {
    const rows = parseBisBankingCsv(
      csvWithEditedRow(CLAIMS_CSV, "US", "2026-Q1", { OBS_STATUS: "B" }),
      "claims"
    );
    expect(toMoneyflowObservations(rows)).toEqual([
      expect.objectContaining({
        category: "US",
        period: "2026-Q1",
        value: 2379304.268,
        breakInSeries: true,
        isEstimated: false,
      }),
    ]);
  });

  it.each(["5M", "9Z", "5R", "4T"])(
    "未分類の集計・未配分コード %s は架空の国として黙って出さず throw する",
    (code) => {
      // コードは実在の CL_BIS_IF_REF_AREA (5M=Unallocated location /
      // 9Z=Unallocated counterparty country / 5R=Advanced economies /
      // 4T=Emerging market and developing economies)。修正前は 5J/1C 以外を
      // すべて国として出していた。
      const rows = parseBisBankingCsv(
        csvWithEditedRow(CLAIMS_CSV, "US", "2026-Q1", { L_CP_COUNTRY: code }),
        "claims"
      );
      expect(() => toMoneyflowObservations(rows)).toThrow(
        new RegExp(`相手国コード "${code}"`)
      );
    }
  );

  it.each(["EU", "XM", "XW"])(
    "英字2文字の集計コード %s (EU/ユーロ圏/世界) は国別内訳から除外する",
    (code) => {
      const rows = parseBisBankingCsv(
        csvWithEditedRow(CLAIMS_CSV, "US", "2026-Q1", { L_CP_COUNTRY: code }),
        "claims"
      );
      expect(toMoneyflowObservations(rows)).toEqual([]);
    }
  );

  it("実データに実在する旧国コード (2T/2U/C9) は国・地域として残す", () => {
    const liabilitiesObs = toMoneyflowObservations(
      parseBisBankingCsv(LIABILITIES_CSV, "liabilities")
    );
    const categories = new Set(
      [...observations, ...liabilitiesObs].map((o) => o.category)
    );
    for (const code of ["2T", "2U", "C9"]) {
      expect(categories.has(code)).toBe(true);
    }
  });

  it.each(["E", "P", "U", "Q"])(
    "OBS_STATUS=%s の値は実測値として黙って通さず throw する",
    (status) => {
      // 修正前は OBS_STATUS を見ずに isEstimated=false (実測) で出していた。
      const rows = parseBisBankingCsv(
        csvWithEditedRow(CLAIMS_CSV, "US", "2026-Q1", { OBS_STATUS: status }),
        "claims"
      );
      expect(() => toMoneyflowObservations(rows)).toThrow(
        new RegExp(`OBS_STATUS="${status}"`)
      );
    }
  );

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

  it("表示名の矢印は資金の出し手→受け手: 与信は日本所在銀行→相手国、負債は相手国→日本所在銀行", () => {
    const byKey = new Map(BIS_BANKING_INDICATORS.map((d) => [d.key, d]));
    expect(byKey.get("bis_lbs_cross_border_claims_jp")?.displayName).toContain(
      "日本所在銀行→相手国"
    );
    // 修正前は負債も「日本所在銀行→相手国」で、向きが逆に読めた。
    const liabilities = byKey.get("bis_lbs_cross_border_liabilities_jp");
    expect(liabilities?.displayName).toContain("相手国→日本所在銀行");
    expect(liabilities?.displayName).not.toContain("日本所在銀行→相手国");
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
