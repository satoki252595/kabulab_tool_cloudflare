import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { describe, expect, it } from "vitest";
import { ROOT } from "../../../../src/shared/db/tests/source-scan.js";
import { loadEdinetTickerMap, resolveAnnualTicker } from "../services/edinet/identity.js";
import { selectMissingDocs } from "../services/edinet/missing.js";
import { edinetDocSchema, isAnnualSecuritiesReport } from "../services/edinet/types.js";
import { isUnassignedEdinetSecCode, secCodeToTicker } from "../services/edinet/types.js";

// 公式一覧の実476A会社/文書メタデータのみ。金融本文や私有IDを含まない。
const actual = JSON.parse(readFileSync(join(ROOT, "tests/fixtures/edinet-null-sec-code-476A.json"), "utf8"));
const doc = edinetDocSchema.parse(actual.primary);

function mirrorDb(ticker: string, edinetCode = doc.edinetCode) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE jss_notion_pages (code TEXT NOT NULL, db TEXT NOT NULL, page_id TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(db, code))");
  sqlite.prepare("INSERT INTO jss_notion_pages VALUES (?, ?, ?, ?)")
    .run(edinetCode, "stock_master_by_edinet", ticker, 0);
  return drizzle(async (query, params, method) => {
    const rows = sqlite.prepare(query).all(...params as (string | number | null)[])
      .map((row) => Object.values(row));
    return { rows: method === "get" ? rows[0] : rows };
  });
}

describe("NULL証券コードの実476A有報", () => {
  it("提出者逆引き→対象coreだけを取り込み、rawNULLを保持する", async () => {
    const map = await loadEdinetTickerMap(mirrorDb(actual.stockCode), [doc.edinetCode!]);
    expect(isAnnualSecuritiesReport(doc)).toBe(true);
    expect(resolveAnnualTicker(doc, map)).toBe(actual.stockCode);
    const selected = selectMissingDocs([doc], new Set(), new Map([[actual.stockCode, 1]]), false, map);
    expect(selected.missing.map(({stockCode, stockId}) => ({stockCode, stockId})))
      .toEqual([{stockCode: actual.stockCode, stockId: 1}]);
    expect(doc.secCode).toBeNull();
  });

  it("未観測マスタ/母集団外を作成せず、明示した不正証券コードも逆引きで丸めない", () => {
    expect(resolveAnnualTicker(doc, new Map())).toBeNull();
    const map = new Map([[doc.edinetCode!, actual.stockCode]]);
    expect(selectMissingDocs([doc], new Set(), new Map(), false, map).outOfUniverse).toBe(1);
    expect(resolveAnnualTicker({...doc, secCode: "25935"}, map)).toBeNull();
    expect(selectMissingDocs([{...doc, docTypeCode: "140"}], new Set(), new Map([[actual.stockCode, 1]]), false, map).missing).toEqual([]);
  });

  it("不正な逆引きは取込前に停止する", async () => {
    await expect(loadEdinetTickerMap(mirrorDb(""), [doc.edinetCode!])).rejects.toThrow("不正または非一意");
  });
});

describe("実646A有報の未割当00000", () => {
  const source = JSON.parse(readFileSync(join(ROOT, "tests/fixtures/edinet-unassigned-sec-code-646A.json"), "utf8"));
  const annual = edinetDocSchema.parse(source.primary);
  const map = new Map([[annual.edinetCode!, source.stockCode]]);

  it("実codeListの同一提出者へ逆引きし、0000銘柄を生成しない", async () => {
    const mirrored = await loadEdinetTickerMap(mirrorDb(source.stockCode, annual.edinetCode), [annual.edinetCode!]);
    expect(annual.secCode).toBe("00000");
    expect(isUnassignedEdinetSecCode(annual.secCode)).toBe(true);
    expect(secCodeToTicker(annual.secCode)).toBeNull();
    expect(resolveAnnualTicker(annual, map)).toBe("646A");
    expect(resolveAnnualTicker(annual, mirrored)).toBe(source.officialCodeList.securityCode.slice(0, 4));
    expect(selectMissingDocs([annual], new Set(), new Map([["646A", 1]]), false, map).missing)
      .toMatchObject([{stockCode: "646A", stockId: 1}]);
    expect(annual.secCode).toBe("00000");
  });

  it("未観測・非0不正・非年次・他社issuer・無効原本へ拡張しない", () => {
    expect(resolveAnnualTicker(annual, new Map())).toBeNull();
    expect(resolveAnnualTicker(annual, new Map([["E00001", "646A"]]))).toBeNull();
    for (const secCode of ["00005", "25935", "", " 00000", "00000 "])
      expect(resolveAnnualTicker({...annual, secCode}, map)).toBeNull();
    expect(resolveAnnualTicker({...annual, docTypeCode: "160"}, map)).toBeNull();
    expect(resolveAnnualTicker({...annual, ordinanceCode: "020"}, map)).toBeNull();
    expect(resolveAnnualTicker({...annual, withdrawalStatus: "1"}, map)).toBeNull();
    expect(resolveAnnualTicker({...annual, docInfoEditStatus: "1"}, map)).toBeNull();
    expect(resolveAnnualTicker({...annual, disclosureStatus: "1"}, map)).toBeNull();
  });
});
