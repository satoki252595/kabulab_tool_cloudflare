// 日本銀行 資金循環統計アダプタのテスト。
//
// フィクスチャ:
//   - fixtures/private/boj-flow-of-funds/boj-sjpre-2026q2.xlsx
//       2026-09-27 に https://www.boj.or.jp/statistics/sj/sjpre.xlsx から実際に
//       取得した速報Excel本体 (2026年第2四半期(4〜6月期)分、加工なし)。
//   - fixtures/private/boj-flow-of-funds/boj-sj-index-2026-09-27.html
//       同日に https://www.boj.or.jp/statistics/sj/index.htm から実際に
//       取得したトップページのHTML本体 (加工なし)。
//   いずれも日本銀行の再配布条件を確認していないため private (commit しない、
//   .gitignore 済み)。無い環境 (CI) ではフィクスチャを読むテストだけ skip する。
//
// 下記の期待値は、上記フィクスチャをExcelビューア相当(本セッションのnode+xlsx)で
// 目視確認した実際のセル値であり、架空の値ではない (CLAUDE.mdルール1)。
// 独立した裏取りとして、同日取得した長期時系列ファイル (sjlong.xlsx シート"18"
// 「26 株式等・投資信託受益証券<E>による資金運用・調達額」、シート"43"
// 「26 株式等・投資信託受益証券<E>の残高」) の 2026/2Q(P) 列でも同じ値が
// 得られることを確認済み (このテストでは容量削減のためsjlong.xlsxは同梱しない)。
//   - フロー(金融取引表)「（１）全体表」E行(株式等・投資信託受益証券)・資産側:
//       家計       = 37,452 億円
//       海外       = 100,506 億円
//       地方公共団体 = 78 億円
//       社会保障基金 = -30,449 億円
//   - ストック(金融資産・負債残高表)「（１）全体表」E行・資産側 (2026年6月末):
//       家計 = 6,789,608 億円
//       海外 = 5,528,421 億円
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import {
  BOJ_FLOW_OF_FUNDS_INDICATORS,
  BOJ_INSTRUMENTS,
  BOJ_SECTORS,
  buildArchiveInput,
  estimateNextReleaseWindow,
  isPeriodAlreadyPublished,
  parseBojFlowOfFunds,
  parseFlowPeriodLabel,
  parseIndexPageForLatestFile,
  parseStockPeriodLabel,
  toObservations,
} from "./boj-flow-of-funds.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "fixtures", "private", "boj-flow-of-funds");
const HAS_FIXTURES =
  existsSync(join(FIXTURES_DIR, "boj-sjpre-2026q2.xlsx")) &&
  existsSync(join(FIXTURES_DIR, "boj-sj-index-2026-09-27.html"));

function readFixtureBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES_DIR, name)));
}
function readFixtureText(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), "utf-8");
}

describe("parseFlowPeriodLabel / parseStockPeriodLabel", () => {
  it("フロー表の四半期見出しを構造化する", () => {
    const period = parseFlowPeriodLabel("2026年  4～6月期(速報)");
    expect(period).toEqual({
      year: 2026,
      quarter: 2,
      vintage: "preliminary",
      rawLabel: "2026年  4～6月期(速報)",
    });
  });

  it("ストック表の月末見出しを四半期に変換する", () => {
    const period = parseStockPeriodLabel("2026年 6月末(速報)");
    expect(period.year).toBe(2026);
    expect(period.quarter).toBe(2);
    expect(period.vintage).toBe("preliminary");
  });

  it("確報ラベルも解釈できる", () => {
    expect(parseFlowPeriodLabel("2025年  1～3月期(確報)").vintage).toBe("final");
  });

  it("暦年の4つの四半期をそれぞれ正しく判定する", () => {
    expect(parseFlowPeriodLabel("2026年  1～3月期(速報)").quarter).toBe(1);
    expect(parseFlowPeriodLabel("2026年  7～9月期(速報)").quarter).toBe(3);
    expect(parseFlowPeriodLabel("2026年 10～12月期(速報)").quarter).toBe(4);
    expect(parseStockPeriodLabel("2026年 3月末(速報)").quarter).toBe(1);
    expect(parseStockPeriodLabel("2026年 9月末(速報)").quarter).toBe(3);
    expect(parseStockPeriodLabel("2026年12月末(確報)").quarter).toBe(4);
  });

  // 回帰テスト: 以前は開始月/月末の月を Math.ceil(月/3) で丸めていたため、
  // 半期「1～6月期」を Q1、「5月末」を Q2、「13月末」を存在しない Q5 として黙って返していた。
  it("四半期でない期間見出しは四半期に丸めずthrowする", () => {
    expect(() => parseFlowPeriodLabel("2026年  1～6月期(速報)")).toThrow(/暦年の四半期/);
    expect(() => parseFlowPeriodLabel("2026年  5～7月期(速報)")).toThrow(/暦年の四半期/);
    expect(() => parseStockPeriodLabel("2026年 5月末(速報)")).toThrow(/四半期末/);
    expect(() => parseStockPeriodLabel("2026年 13月末(速報)")).toThrow(/四半期末/);
  });

  it("想定外の書式はthrowする(フォールバックしない)", () => {
    expect(() => parseFlowPeriodLabel("不明な期間")).toThrow(/解釈できません/);
    expect(() => parseStockPeriodLabel("不明な期間")).toThrow(/解釈できません/);
  });
});

describe("isPeriodAlreadyPublished / estimateNextReleaseWindow", () => {
  it("対象期が最新公表期以前なら公表済みと判定する", () => {
    expect(
      isPeriodAlreadyPublished({ year: 2026, quarter: 1 }, { year: 2026, quarter: 2 })
    ).toBe(true);
    expect(
      isPeriodAlreadyPublished({ year: 2026, quarter: 2 }, { year: 2026, quarter: 2 })
    ).toBe(true);
  });

  it("対象期が最新公表期より先ならまだ公表されていないと判定する", () => {
    expect(
      isPeriodAlreadyPublished({ year: 2026, quarter: 3 }, { year: 2026, quarter: 2 })
    ).toBe(false);
    expect(
      isPeriodAlreadyPublished({ year: 2027, quarter: 1 }, { year: 2026, quarter: 4 })
    ).toBe(false);
  });

  it("次の四半期の公表予想窓を四半期末+2〜4か月で返す(近似の目安)", () => {
    const window = estimateNextReleaseWindow({ year: 2026, quarter: 2 });
    expect(window.targetPeriod).toEqual({ year: 2026, quarter: 3 });
    // 3Q末=2026-09-30
    expect(window.earliestExpected).toBe("2026-11-30");
    expect(window.latestExpected).toBe("2027-01-30");
  });

  it("年をまたぐ四半期(4Q→翌年1Q)も正しく繰り上がる", () => {
    const window = estimateNextReleaseWindow({ year: 2026, quarter: 4 });
    expect(window.targetPeriod).toEqual({ year: 2027, quarter: 1 });
    // 1Q末=2027-03-31
    expect(window.earliestExpected).toBe("2027-05-31");
    expect(window.latestExpected).toBe("2027-07-31");
  });

  // 回帰テスト: 4Q末(12/31)+2か月を setUTCMonth で計算すると 2/31 → 3/3 に
  // あふれていた。行き先の月の末日で止める。
  it("4Q末(12/31)からの窓は2月末・4月末で止まり、翌月へあふれない", () => {
    const window = estimateNextReleaseWindow({ year: 2026, quarter: 3 });
    expect(window.targetPeriod).toEqual({ year: 2026, quarter: 4 });
    expect(window.earliestExpected).toBe("2027-02-28");
    expect(window.latestExpected).toBe("2027-04-30");
  });
});

describe.skipIf(!HAS_FIXTURES)("parseIndexPageForLatestFile (実フィクスチャ)", () => {
  // skip された describe でも factory は実行されるため、読込は各テスト内で行う
  const html = () => readFixtureText("boj-sj-index-2026-09-27.html");

  it("速報Excel(sjpre.xlsx)への絶対URLを解決する", () => {
    const resolved = parseIndexPageForLatestFile(html());
    expect(resolved.url).toBe("https://www.boj.or.jp/statistics/sj/sjpre.xlsx");
  });

  it("掲載日(2026年9月17日)をヒントとして拾う", () => {
    const resolved = parseIndexPageForLatestFile(html());
    expect(resolved.announcedAt).toBe("2026-09-17");
  });
});

describe("parseIndexPageForLatestFile (様式異常)", () => {
  it("様式が変わりリンクが見つからない場合はthrowする", () => {
    expect(() => parseIndexPageForLatestFile("<html><body>no link here</body></html>")).toThrow(
      /見つかりません/
    );
  });
});

describe.skipIf(!HAS_FIXTURES)("parseBojFlowOfFunds (実フィクスチャ boj-sjpre-2026q2.xlsx)", () => {
  // skip された describe でも factory は実行されるため、読込は beforeAll で行う
  let doc: ReturnType<typeof parseBojFlowOfFunds>;
  beforeAll(() => {
    doc = parseBojFlowOfFunds(readFixtureBytes("boj-sjpre-2026q2.xlsx"));
  });

  it("フロー表・ストック表それぞれの対象期間を正しく読み取る", () => {
    expect(doc.flow.period).toEqual({
      year: 2026,
      quarter: 2,
      vintage: "preliminary",
      rawLabel: "2026年  4～6月期(速報)",
    });
    expect(doc.stock.period.year).toBe(2026);
    expect(doc.stock.period.quarter).toBe(2);
    expect(doc.stock.period.vintage).toBe("preliminary");
  });

  it("単位が億円であることを確認する", () => {
    expect(doc.flow.unit).toBe("億円");
    expect(doc.stock.unit).toBe("億円");
  });

  function flowValue(sectorCode: string, position: "asset" | "liability"): number | undefined {
    return doc.flow.records.find(
      (r) => r.rowCode === "E" && r.sectorCode === sectorCode && r.position === position
    )?.value;
  }
  function stockValue(sectorCode: string, position: "asset" | "liability"): number | undefined {
    return doc.stock.records.find(
      (r) => r.rowCode === "E" && r.sectorCode === sectorCode && r.position === position
    )?.value;
  }

  // 以下は原本(sjpre.xlsx)を目視確認した実際の値 (架空値ではない)。
  it("フロー: 家計の株式等・投資信託受益証券(資産側)は37,452億円", () => {
    expect(flowValue("4", "asset")).toBe(37452);
  });

  it("フロー: 海外の株式等・投資信託受益証券(資産側)は100,506億円", () => {
    expect(flowValue("6", "asset")).toBe(100506);
  });

  it("フロー: 地方公共団体の株式等・投資信託受益証券(資産側)は78億円", () => {
    expect(flowValue("32", "asset")).toBe(78);
  });

  it("フロー: 社会保障基金の株式等・投資信託受益証券(資産側)は-30,449億円", () => {
    expect(flowValue("33", "asset")).toBe(-30449);
  });

  it("ストック: 家計の株式等・投資信託受益証券(資産側、2026年6月末)は6,789,608億円", () => {
    expect(stockValue("4", "asset")).toBe(6789608);
  });

  it("ストック: 海外の株式等・投資信託受益証券(資産側、2026年6月末)は5,528,421億円", () => {
    expect(stockValue("6", "asset")).toBe(5528421);
  });

  it("集計コード(2/3/331)も生レコードには残るが、既知の制度部門である", () => {
    const codes = new Set(doc.flow.records.map((r) => r.sectorCode));
    for (const code of ["1", "2", "21", "22", "3", "31", "32", "33", "4", "5", "6"]) {
      expect(codes.has(code)).toBe(true);
    }
  });
});

describe("parseBojFlowOfFunds: 様式異常の検出", () => {
  it("全体表シートが見つからない書式ではthrowする", () => {
    // ヘッダのみで実データを持たない最小Excelを渡す
    const wb = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([["hello", "world"]]);
    XLSX.utils.book_append_sheet(wb, sheet, "1");
    const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
    expect(() => parseBojFlowOfFunds(new Uint8Array(buf))).toThrow(
      /全体表シートが見つかりません/
    );
  });

  // 以下は実フィクスチャ (private、CI には無い) を壊して使う
  describe.skipIf(!HAS_FIXTURES)("実フィクスチャを壊した入力", () => {
    // 回帰テスト: ストック表(金融資産・負債残高表) page2 シートの行コード列は
    // 右端付近にあるが、シートの !ref (ワークシート次元) は実データより1列広く
    // 確保されており、最終列は常に空白 (実データで確認)。この余剰列を行コード
    // 列と誤認すると、page1/page2の行対応チェック (「page1とpage2で行コードが
    // 一致しません」の throw) が常に不発になり、行がズレても例外を投げずに
    // 誤った値を黙って返してしまう (CLAUDE.md ルール2違反)。実データの
    // ストックpage2シート内でE行・F行の内容を丸ごと入れ替えて行ズレを再現し、
    // 必ずthrowすることを保証する。
    it("ストック表page2側で行がズレると(E行/F行を入替)、必ずthrowする", () => {
      const bytes = readFixtureBytes("boj-sjpre-2026q2.xlsx");
      const workbook = XLSX.read(bytes, { type: "array" });
      const stockPage2 = workbook.Sheets["20"];
      const range = XLSX.utils.decode_range(stockPage2["!ref"]!);

      // Q列(行コード列)の値が "E"/"F" となっている行を実データから特定する
      // (ハードコードの行番号ではなく、その場で探す。表の版が変わっても
      // このテスト自体が意図せず無効化されないようにするため)。
      const qCol = XLSX.utils.decode_col("Q");
      let rowE = -1;
      let rowF = -1;
      for (let r = range.s.r; r <= range.e.r; r++) {
        const cell = stockPage2[XLSX.utils.encode_cell({ r, c: qCol })];
        const v = cell && typeof cell.v === "string" ? cell.v.trim() : "";
        if (v === "E") rowE = r;
        if (v === "F") rowF = r;
      }
      expect(rowE).toBeGreaterThanOrEqual(0);
      expect(rowF).toBeGreaterThanOrEqual(0);

      // page2 (stockPage2) のE行とF行を丸ごと入れ替える。page1は無改変のまま
      // なので、page1側の行コード("E"/"F")とpage2側の行コード("F"/"E")が
      // 一致しなくなる。
      for (let c = range.s.c; c <= range.e.c; c++) {
        const cellE = stockPage2[XLSX.utils.encode_cell({ r: rowE, c })];
        const cellF = stockPage2[XLSX.utils.encode_cell({ r: rowF, c })];
        const addrE = XLSX.utils.encode_cell({ r: rowE, c });
        const addrF = XLSX.utils.encode_cell({ r: rowF, c });
        if (cellF) stockPage2[addrE] = cellF;
        else delete stockPage2[addrE];
        if (cellE) stockPage2[addrF] = cellE;
        else delete stockPage2[addrF];
      }

      const corruptedBuf = XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
      expect(() => parseBojFlowOfFunds(new Uint8Array(corruptedBuf))).toThrow(
        /page1とpage2で行コードが一致しません/
      );
    });

    // 以下は実フィクスチャを1か所だけ壊して「黙って欠けた/重複した出力を返さない」
    // ことを確かめる回帰テスト (ルール2)。修正前は、いずれも例外を投げずに
    // 観測行が欠けた (または重複した) 結果を「成功」として返していた。
    function loadFixtureWorkbook(): XLSX.WorkBook {
      return XLSX.read(readFixtureBytes("boj-sjpre-2026q2.xlsx"), { type: "array" });
    }
    function toBytes(workbook: XLSX.WorkBook): Uint8Array {
      return new Uint8Array(XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
    }
    /** 指定列で値が value のセル番地を、ハードコードせず実データから探す (1件のみ許す)。 */
    function findCellInColumn(sheet: XLSX.WorkSheet, col: string, value: string): string {
      const range = XLSX.utils.decode_range(sheet["!ref"]!);
      const c = XLSX.utils.decode_col(col);
      const hits: string[] = [];
      for (let r = range.s.r; r <= range.e.r; r++) {
        const addr = XLSX.utils.encode_cell({ r, c });
        const cell = sheet[addr];
        if (cell && String(cell.v).trim() === value) hits.push(addr);
      }
      expect(hits).toHaveLength(1);
      return hits[0]!;
    }

    it("制度部門コードのセルが消えると(フロー表page2の家計)、その部門を黙って落とさずthrowする", () => {
      const workbook = loadFixtureWorkbook();
      const flowPage2 = workbook.Sheets["2"];
      // 部門コード行 (「資産(A)」見出し行の1つ上) で家計のコード 4 を持つセルを探す
      const range = XLSX.utils.decode_range(flowPage2["!ref"]!);
      const hits: string[] = [];
      for (let r = range.s.r; r <= range.s.r + 10; r++) {
        for (let c = range.s.c; c <= range.e.c; c++) {
          const addr = XLSX.utils.encode_cell({ r, c });
          if (flowPage2[addr] && String(flowPage2[addr].v).trim() === "4") hits.push(addr);
        }
      }
      expect(hits).toHaveLength(1);
      delete flowPage2[hits[0]!];
      expect(() => parseBojFlowOfFunds(toBytes(workbook))).toThrow(
        /フロー表\(金融取引表\)で制度部門の列が見つかりません: 家計\(4\)の資産\(A\), 家計\(4\)の負債\(L\)/
      );
    });

    it("観測対象の行コード(Db 国債・財投債)が表から消えると、黙って行を欠かさずthrowする", () => {
      const workbook = loadFixtureWorkbook();
      const flowPage1 = workbook.Sheets["1"];
      delete flowPage1[findCellInColumn(flowPage1, "C", "Db")];
      expect(() => parseBojFlowOfFunds(toBytes(workbook))).toThrow(
        /フロー表\(金融取引表\)に観測対象の行コードがありません: Db/
      );
    });

    // 回帰テスト: フロー表とストック表の対象期の食い違いを検査していなかったため、
    // ストック側だけ別の期になったファイルでも、フロー期のアーカイブキーのまま黙って通っていた。
    it("フロー表とストック表の対象期が食い違うとthrowする", () => {
      const workbook = loadFixtureWorkbook();
      let replaced = 0;
      for (const name of ["19", "20"]) {
        const sheet = workbook.Sheets[name]!;
        for (const addr of Object.keys(sheet)) {
          if (addr.startsWith("!")) continue;
          const cell = sheet[addr] as XLSX.CellObject;
          if (typeof cell.v === "string" && cell.v.includes("6月末(速報)")) {
            sheet[addr] = { t: "s", v: cell.v.replace("6月末(速報)", "3月末(速報)") };
            replaced++;
          }
        }
      }
      expect(replaced).toBeGreaterThan(0);
      expect(() => parseBojFlowOfFunds(toBytes(workbook))).toThrow(
        /フロー表とストック表の対象期が一致しません/
      );
    });

    it("行コードが重複すると(Dc行をDbに書換)、同じ観測キーの行を2つ作らずthrowする", () => {
      const workbook = loadFixtureWorkbook();
      const stockPage1 = workbook.Sheets["19"];
      const stockPage2 = workbook.Sheets["20"];
      stockPage1[findCellInColumn(stockPage1, "C", "Dc")] = { t: "s", v: "Db" };
      stockPage2[findCellInColumn(stockPage2, "Q", "Dc")] = { t: "s", v: "Db" };
      expect(() => parseBojFlowOfFunds(toBytes(workbook))).toThrow(
        /ストック表\(金融資産・負債残高表\)で行コード"Db"が重複しています/
      );
    });
  });
});

describe.skipIf(!HAS_FIXTURES)("toObservations", () => {
  // skip された describe でも factory は実行されるため、読込は beforeAll で行う
  let doc: ReturnType<typeof parseBojFlowOfFunds>;
  let observations: ReturnType<typeof toObservations>;
  beforeAll(() => {
    doc = parseBojFlowOfFunds(readFixtureBytes("boj-sjpre-2026q2.xlsx"));
    observations = toObservations(doc);
  });

  it("家計×株式等・投資信託受益証券×フロー×資産の観測行を1件だけ生成する", () => {
    const matches = observations.filter(
      (o) =>
        o.category === "家計(資産)" &&
        o.indicatorKey === "boj_ffa_equity_and_investment_fund_shares_flow"
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      period: "2026Q2",
      value: 37452,
      unit: "億円",
      isApproximate: false,
      isEstimated: false,
      vintage: "preliminary",
    });
  });

  it("集計コード(2/3/331)の部門は観測行に出さない(二重計上防止)", () => {
    expect(observations.some((o) => o.category.startsWith("非金融法人企業"))).toBe(false);
    expect(observations.some((o) => o.category.startsWith("一般政府"))).toBe(false);
  });

  it("採用していない行コード(例: G 金融派生商品)の観測行は出さない", () => {
    // BOJ_INSTRUMENTS に G は含めていない
    expect(observations.some((o) => o.indicatorKey.includes("_g_"))).toBe(false);
  });

  it("観測行は指標定義(BOJ_FLOW_OF_FUNDS_INDICATORS)のkeyのいずれかに必ず一致する", () => {
    const definedKeys = new Set(BOJ_FLOW_OF_FUNDS_INDICATORS.map((d) => d.key));
    for (const o of observations) {
      expect(definedKeys.has(o.indicatorKey)).toBe(true);
    }
  });
});

describe("指標定義・部門定義のエクスポート", () => {
  it("12商品 × flow/stock = 24件の指標定義を持つ", () => {
    expect(BOJ_INSTRUMENTS).toHaveLength(12);
    expect(BOJ_FLOW_OF_FUNDS_INDICATORS).toHaveLength(24);
  });

  it("各指標定義がR1〜R4のいずれかの要件・出典URL・利用条件・頻度を持つ", () => {
    for (const def of BOJ_FLOW_OF_FUNDS_INDICATORS) {
      expect(def.requirements.length).toBeGreaterThan(0);
      expect(def.sourceUrl).toContain("boj.or.jp");
      expect(def.usageTerms.length).toBeGreaterThan(0);
      expect(def.frequency).toBe("四半期");
    }
  });

  it("R1(33業種)を主張する指標は無い(このデータに業種別内訳は存在しないため)", () => {
    for (const def of BOJ_FLOW_OF_FUNDS_INDICATORS) {
      expect(def.requirements).not.toContain("R1");
    }
  });

  // 定義文の正確性の回帰テスト (ルール7: 噛み砕きと引き換えに誤った定義を教えない)。
  function indicator(key: string) {
    const def = BOJ_FLOW_OF_FUNDS_INDICATORS.find((d) => d.key === key);
    expect(def).toBeDefined();
    return def!;
  }

  it("国債・財投債: 財投債を『財投機関債』と取り違えない(別物で含まれないと明記)", () => {
    const def = indicator("boj_ffa_jgb_and_filp_bonds_stock");
    expect(def.definition).not.toMatch(/財投機関債である財投債/);
    expect(def.definition).toMatch(/財投機関債』は財投債とは別物で、この項目には含まれない/);
  });

  it("対外直接投資: 『経営支配』ではなく議決権10%以上の継続的影響力で定義する", () => {
    const def = indicator("boj_ffa_outward_direct_investment_stock");
    expect(def.definition).not.toMatch(/経営支配を伴う出資/);
    expect(def.definition).toMatch(/議決権の10%以上/);
  });

  it("事業債: 普通社債・事業法人に限定しない(実データの負債側に金融機関・公的非金融法人企業がある)", () => {
    const def = indicator("boj_ffa_corporate_bonds_stock");
    expect(def.definition).not.toMatch(/普通社債/);
    expect(def.definition).toMatch(/金融機関/);
  });

  // 回帰テスト: 以前の定義「金融債(De)以外の社債」は、同じ表で別行の政府関係機関債(Dd)・
  // 居住者発行外債(Dg、2026年6月末で事業債より大きい約90兆円)まで含むように読めた。
  it("事業債: 別行の政府関係機関債(Dd)・居住者発行外債(Dg)を含むように書かない", () => {
    const def = indicator("boj_ffa_corporate_bonds_stock");
    expect(def.definition).not.toMatch(/金融債\(De\)以外の社債/);
    expect(def.definition).toMatch(/政府関係機関債\(Dd\)/);
    expect(def.definition).toMatch(/居住者発行外債\(Dg/);
  });

  // 上の2つの定義文テストの裏付けを実データで取る部分 (private フィクスチャが要る)
  describe.skipIf(!HAS_FIXTURES)("事業債の定義文の実データ裏付け (実フィクスチャ)", () => {
    it("事業債の負債側に金融機関・公的非金融法人企業・民間非金融法人企業の3部門が実際に計上されている", () => {
      // 実データ(2026年6月末速報)で、事業債の負債側に3部門が実際に計上されていることを確認する
      // (葉レベル部門のみ。集計コード 2=非金融法人企業 は 21+22 の合計なので除く)
      const leafCodes = new Set<string>(BOJ_SECTORS.map((s) => s.code));
      const doc = parseBojFlowOfFunds(readFixtureBytes("boj-sjpre-2026q2.xlsx"));
      const issuers = doc.stock.records
        .filter(
          (r) => r.rowCode === "Df" && r.position === "liability" && r.value !== 0 && leafCodes.has(r.sectorCode)
        )
        .map((r) => r.sectorCode)
        .sort();
      expect(issuers).toEqual(["1", "21", "22"]);
    });

    it("D = Da〜Dj の合計で、政府関係機関債(Dd)・居住者発行外債(Dg)は事業債(Df)とは別行", () => {
      // 実データで D = Da〜Dj の合計(内訳は互いに重複しない)であることを確かめる
      const doc = parseBojFlowOfFunds(readFixtureBytes("boj-sjpre-2026q2.xlsx"));
      const stockValue = (rowCode: string) =>
        doc.stock.records.find((r) => r.rowCode === rowCode && r.sectorCode === "1" && r.position === "asset")
          ?.value;
      const parts = ["Da", "Db", "Dc", "Dd", "De", "Df", "Dg", "Dh", "Di", "Dj"].map((c) => {
        const v = stockValue(c);
        expect(v, `金融機関(資産)の${c}`).toBeTypeOf("number");
        return v!;
      });
      expect(stockValue("D")).toBe(parts.reduce((a, b) => a + b, 0));
      expect(stockValue("Dd")).toBe(313552);
      expect(stockValue("Dg")).toBe(97270);
    });
  });

  it("フロー指標とストック指標で説明を取り違えない(フローに評価損益・為替差を含むと書かない)", () => {
    for (const def of BOJ_FLOW_OF_FUNDS_INDICATORS) {
      // 「単位は」の後ろに単位以外(フロー/ストック)を書かない
      expect(def.definition).not.toMatch(/単位はフロー|単位はストック/);
      expect(def.definition).toMatch(/単位は億円。$/);
      if (def.table === "flow") {
        expect(def.label).toContain("取引による純増減");
        expect(def.measures).toMatch(/※この指標はフロー/);
      } else {
        expect(def.measures).toMatch(/※この指標はストック/);
      }
    }
    // 為替による評価差はストックだけの話であることを明記する
    const cashFlow = indicator("boj_ffa_cash_and_deposits_flow");
    expect(cashFlow.limitations.join("")).not.toMatch(/為替変動による評価差を含む/);
    expect(cashFlow.limitations.join("")).toMatch(/フローは取引額のみ/);
    // 投信: フロー(取引額)を「残高変動」と書かない
    const fundFlow = indicator("boj_ffa_investment_fund_shares_flow");
    expect(fundFlow.limitations.join("")).not.toMatch(/残高変動/);
  });

  it("9つの葉レベル制度部門を定義している", () => {
    expect(BOJ_SECTORS).toHaveLength(9);
    expect(BOJ_SECTORS.map((s) => s.key)).toContain("households");
    expect(BOJ_SECTORS.map((s) => s.key)).toContain("overseas");
  });
});

describe.skipIf(!HAS_FIXTURES)("buildArchiveInput (ルール6)", () => {
  it("四半期+速報/確報の冪等キーとxlsx実体を組み立てる", () => {
    const bytes = readFixtureBytes("boj-sjpre-2026q2.xlsx");
    const doc = parseBojFlowOfFunds(bytes);
    const input = buildArchiveInput(
      { bytes, url: "https://www.boj.or.jp/statistics/sj/sjpre.xlsx" },
      doc
    );
    expect(input.service).toBe("moneyflow");
    expect(input.key).toBe("boj-flow-of-funds-2026Q2-preliminary");
    expect(input.files).toHaveLength(1);
    expect(input.files[0]!.bytes).toBe(bytes);
    expect(input.metadata).toMatchObject({ flowRecordCount: expect.any(Number) });
  });
});
