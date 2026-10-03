import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { describe, expect, it } from "vitest";
import { ROOT } from "../../../../src/shared/db/tests/source-scan.js";
import { loadEdinetTickerMap, resolveAnnualTicker } from "../services/edinet/identity.js";
import { selectMissingDocs } from "../services/edinet/missing.js";
import { edinetDocSchema, isAnnualSecuritiesReport } from "../services/edinet/types.js";

// 公式一覧の実476A会社/文書メタデータのみ。金融本文や私有IDを含まない。
const actual = JSON.parse(readFileSync(join(ROOT, "tests/fixtures/edinet-null-sec-code-476A.json"), "utf8"));
const doc = edinetDocSchema.parse(actual.primary);

function mirrorDb(ticker: string) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE jss_notion_pages (code TEXT NOT NULL, db TEXT NOT NULL, page_id TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(db, code))");
  sqlite.prepare("INSERT INTO jss_notion_pages VALUES (?, ?, ?, ?)")
    .run(doc.edinetCode, "stock_master_by_edinet", ticker, 0);
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
