import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readVerifiedDocText } from "../services/text-backup.js";
vi.mock("../services/text-backup.js", () => ({ readVerifiedDocText: vi.fn(async () => []) }));
import { yuhoEnv } from "../env.js";
import { assertLatestDocCurrent, loadLatestDocs, loadNewStockEligibility, readQualifiedBiztagDocText, BiztagTextQualificationError } from "./source.js";

// 公開済みの実 JPX イベント断片。未来/破損等の変更は資格拒否のための unit input。
const batch = JSON.parse(readFileSync(new URL("../../../../src/cron/__fixtures__/overlay-atomic/batch-excerpt.json", import.meta.url), "utf8"));
const FROM = "2026-09-25";
const TODAY = "2026-09-30";
let sqlite: DatabaseSync;
let queries: string[];
let responses: Array<{ params: unknown[]; rows: number; columns: string[] }>;

function db() {
  return drizzle(async (sql, params, method) => {
    queries.push(sql);
    if (method === "run" || !sql.toLowerCase().startsWith("select")) throw new Error("source test: SELECT 以外は禁止");
    const statement = sqlite.prepare(sql);
    const rows = statement.all(...params as (string | number | null)[]).map((row) => Object.values(row));
    responses.push({ params, rows: rows.length, columns: statement.columns().map(column => column.name) });
    return { rows: method === "get" ? rows[0] : rows };
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("ネットワークは禁止"); }));
  queries = [];
  responses = [];
  vi.mocked(readVerifiedDocText).mockReset().mockResolvedValue([{ sectionKey: "business", itemName: "事業の内容", text: "明示的な合成プロトコル本文" }]);
  vi.stubEnv("NOTION_YUHO_TEXT_DB_ID", "11111111-1111-1111-1111-111111111111");
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../../../../drizzle/d1/0034_edinet_reported_resolutions.sql", import.meta.url), "utf8"));
  sqlite.exec(`
    CREATE TABLE universe_overlay_state (
      id INTEGER PRIMARY KEY, base_as_of TEXT, events_fetched_at TEXT, events_sha TEXT,
      eligibility_as_of TEXT, applied_at TEXT, held_listing_codes TEXT
    );
    CREATE TABLE universe_official_events (
      code TEXT, kind TEXT, effective_date TEXT, fetched_at TEXT, raw_sha TEXT,
      archive_key TEXT, last_seen_fetched_at TEXT
    );
  `);
  sqlite.prepare("INSERT INTO universe_overlay_state VALUES (1, ?, ?, ?, ?, ?, NULL)").run(
    batch.baseAsOf, batch.eventsFetchedAt, batch.eventsSha, batch.eligibilityAsOf, batch.eventsFetchedAt
  );
  for (const row of batch.sources.newListings.rows) {
    sqlite.prepare("INSERT INTO universe_official_events VALUES (?, 'listing', ?, ?, ?, ?, ?)").run(
      row.code, row.listingDate, batch.eventsFetchedAt, batch.sources.newListings.rawSha, batch.archiveKey, batch.eventsFetchedAt
    );
  }
});

describe("固定コードの最新有報をSQLから限定する", () => {
  const saved = JSON.parse(gunzipSync(readFileSync(new URL("./fixtures/latest-docs-saved50-20261017.json.gz", import.meta.url))).toString()) as {
    scopeCodes: string[];
    core: Array<{ id: number; code: string; name: string; sector33: string | null }>;
    documents: Array<{ id: number; stock_id: number; doc_id: string; doc_type_code: string; period_end: string; submitted_at: number; notion_doc_page_id: string | null; text_parse_status: string | null }>;
  };
  function installSavedRows() {
    sqlite.exec(readFileSync(new URL("../../../../drizzle/d1/0032_edinet_reported_changes.sql", import.meta.url), "utf8"));
    sqlite.exec(`CREATE TABLE core_stocks(id INTEGER PRIMARY KEY, code TEXT UNIQUE, name TEXT, sector33 TEXT, is_active INTEGER, instrument_type TEXT);
      CREATE TABLE yuho_documents(id INTEGER PRIMARY KEY, stock_id INTEGER, doc_id TEXT, doc_type_code TEXT, period_end TEXT, submitted_at INTEGER, notion_doc_page_id TEXT, text_parse_status TEXT);`);
    for (const row of saved.core) sqlite.prepare("insert into core_stocks values(?,?,?,?,1,'equity')").run(row.id, row.code, row.name, row.sector33);
    for (const row of saved.documents) sqlite.prepare("insert into yuho_documents values(?,?,?,?,?,?,?,?)").run(
      row.id, row.stock_id, row.doc_id, row.doc_type_code, row.period_end, row.submitted_at, row.notion_doc_page_id, row.text_parse_status);
  }
  const byCode = <T extends { stockCode: string }>(rows: T[]) => rows.sort((a, b) => a.stockCode.localeCompare(b.stockCode));

  it("全量取得の計算列は短い列名だけを返し、SQL式全文を各書類のJSON keyにしない", async () => {
    installSavedRows(); const latest = await loadLatestDocs(db());
    expect(responses[1].columns).toEqual(["id", "stock_id", "doc_id", "doc_type_code", "period_end",
      "submitted_at", "notion_doc_page_id", "text_parse_status", "reported_hold"]);
    expect(Buffer.byteLength(JSON.stringify(responses[1].columns))).toBeLessThanOrEqual(128);
    const current = latest.find(row => row.doc !== null)!;
    await assertLatestDocCurrent(db(), current.stockCode, current.doc!);
    expect(responses[2].columns.at(-1)).toBe("reported_hold");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("本文なし基本メタは現active1社/最新nullを2scopedSELECTで資格し、メタ変更・有報到着を拒否", async () => {
    installSavedRows(); const doc = saved.documents[0], stock = saved.core.find(row => row.id === doc.stock_id)!;
    sqlite.prepare("DELETE FROM yuho_documents WHERE stock_id=?").run(stock.id); queries = []; responses = [];
    await assertLatestDocCurrent(db(), stock.code, null, { companyName: stock.name, sector33: stock.sector33 });
    expect(queries).toHaveLength(2); expect(responses.every(row => row.params.includes(JSON.stringify([stock.code])))).toBe(true);
    sqlite.prepare("UPDATE core_stocks SET name=? WHERE id=?").run(stock.name + "（declared drift）", stock.id);
    await expect(assertLatestDocCurrent(db(), stock.code, null, { companyName: stock.name, sector33: stock.sector33 })).rejects.toThrow("現active");
    sqlite.prepare("UPDATE core_stocks SET name=? WHERE id=?").run(stock.name, stock.id);
    sqlite.prepare("insert into yuho_documents values(?,?,?,?,?,?,?,?)").run(doc.id, doc.stock_id, doc.doc_id, doc.doc_type_code, doc.period_end, doc.submitted_at, doc.notion_doc_page_id, doc.text_parse_status);
    await expect(assertLatestDocCurrent(db(), stock.code, null, { companyName: stock.name, sector33: stock.sector33 })).rejects.toThrow("最新有報");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("実保存50銘柄は旧全量＋Set filterと全値同値、2 SELECTともD1返却scopeを限定する", async () => {
    installSavedRows();
    const all = await loadLatestDocs(db()), wholeDocRows = responses[1].rows;
    const expected = all.filter(row => new Set(saved.scopeCodes).has(row.stockCode));
    expect(queries.every(query => !query.includes("json_each"))).toBe(true);
    queries = []; responses = [];
    const scoped = await loadLatestDocs(db(), saved.scopeCodes);
    expect(byCode(scoped)).toEqual(byCode(expected)); expect(scoped).toHaveLength(50);
    expect(queries).toHaveLength(2); expect(responses[0].rows).toBe(50); expect(responses[1].rows).toBeLessThan(wholeDocRows);
    for (let i = 0; i < 2; i++) {
      expect(queries[i]).toContain('"core_stocks"."code" in (select value from json_each(?))');
      expect(responses[i].params.filter(param => param === JSON.stringify(saved.scopeCodes))).toHaveLength(1);
      expect(responses[i].params.length).toBeLessThanOrEqual(5);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("101実コードと重複指定も1 JSON bindのSet意味を保ち、100bindを超えない", async () => {
    installSavedRows(); const codes = saved.core.map(row => row.code);
    expect(codes).toHaveLength(101);
    const actual = await loadLatestDocs(db(), [...codes, ...codes]);
    expect(new Set(actual.map(row => row.stockCode))).toEqual(new Set(codes)); expect(actual).toHaveLength(101);
    expect(responses.every(row => row.params.length <= 5)).toBe(true);
    expect(responses.every(row => row.params.includes(JSON.stringify(codes)))).toBe(true);
  });

  it("明示empty scopeはSQL0、unknown codeは空、active/最新HOLD資格は旧親へ戻さない", async () => {
    expect(await loadLatestDocs(db(), [])).toEqual([]); expect(queries).toEqual([]);
    installSavedRows(); expect(await loadLatestDocs(db(), ["0000"])).toEqual([]);
    const code = saved.scopeCodes[0], original = (await loadLatestDocs(db(), [code]))[0];
    expect(original.doc).not.toBeNull();
    // 実書類の取下げではない。同じ保存値へ宣言したreported-state protocol fault。
    sqlite.prepare("insert into yuho_edinet_reported_changes(source_page_id,seq_number,source_raw_sha256,doc_id,parent_doc_id,reported_state,observation_json) values(?,?,?,?,?,?,?)").run(
      "declared-source", 1, "declared-not-original-SHA", original.doc!.docId, null, "reported_withdrawal", '{"protocolFault":true}');
    const held = (await loadLatestDocs(db(), [code]))[0];
    expect(held.doc).toEqual(original.doc); expect(held.reportedHoldReason).toBeDefined();
    sqlite.prepare("update core_stocks set is_active=0 where code=?").run(code);
    expect(await loadLatestDocs(db(), [code])).toEqual([]); expect(fetch).not.toHaveBeenCalled();
  });

  it.each([{ codes: ["bad"] }, { codes: ["7247' OR 1=1"] }, { codes: [null] }, { codes: Array(1) }, { codes: "7247" }])("不正scopeはSQLより前に拒否する (%j)", async ({ codes }) => {
    await expect(loadLatestDocs(db(), codes as unknown as string[])).rejects.toThrow("正準証券コード");
    expect(queries).toEqual([]); expect(fetch).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  sqlite.close();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("新規上場の既存証拠だけを読む資格判定", () => {
  it("固定開始日以後の確認済み過去イベントだけ許可し、未来を HOLD にする (2 SELECT・外部通信0)", async () => {
    const result = await loadNewStockEligibility(db(), FROM, TODAY);
    expect([...result.eligibleCodes]).toEqual(["646A"]);
    expect([...result.heldCodes]).toEqual(["640A"]);
    expect(queries).toHaveLength(2);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("開始日より前の過去の新上場を、未判定でも新規として許可しない", async () => {
    const result = await loadNewStockEligibility(db(), "2026-10-02", "2026-10-02");
    expect(result.eligibleCodes.size).toBe(0);
    expect(result.heldCodes.size).toBe(0);
  });

  it("現世代から消えた過去イベントは機械判定への既存扱いにせず HOLD", async () => {
    sqlite.exec("UPDATE universe_official_events SET last_seen_fetched_at = NULL WHERE code = '646A'");
    const result = await loadNewStockEligibility(db(), FROM, TODAY);
    expect(result.eligibleCodes.has("646A")).toBe(false);
    expect(result.heldCodes.has("646A")).toBe(true);
  });

  it("世代 state の per-code HOLD を優先する", async () => {
    sqlite.exec(`UPDATE universe_overlay_state SET held_listing_codes = '["646A"]'`);
    const result = await loadNewStockEligibility(db(), FROM, TODAY);
    expect(result.eligibleCodes.has("646A")).toBe(false);
    expect(result.heldCodes.has("646A")).toBe(true);
  });

  it("同一コードの複数上場日は選択せず HOLD", async () => {
    sqlite.exec("INSERT INTO universe_official_events SELECT code, kind, '2026-09-28', fetched_at, raw_sha, archive_key, last_seen_fetched_at FROM universe_official_events WHERE code = '646A'");
    const result = await loadNewStockEligibility(db(), FROM, TODAY);
    expect(result.eligibleCodes.has("646A")).toBe(false);
    expect(result.heldCodes.has("646A")).toBe(true);
  });

  it.each([
    ["raw_sha", "未確認"],
    ["archive_key", ""],
    ["archive_key", "universe-official-events-2026-08-31-2026-09-29-sha-000000000000"],
    ["fetched_at", "2026-09-29T00:00:00.000Z"],
  ])("イベント証拠 %s の欠落/別世代を HOLD", async (column, value) => {
    sqlite.prepare(`UPDATE universe_official_events SET ${column} = ? WHERE code = '646A'`).run(value);
    const result = await loadNewStockEligibility(db(), FROM, TODAY);
    expect(result.eligibleCodes.has("646A")).toBe(false);
    expect(result.heldCodes.has("646A")).toBe(true);
  });

  it.each(["base_as_of", "events_fetched_at", "events_sha", "eligibility_as_of", "applied_at"])("世代 %s が欠けたら明示停止し、イベントを追加照会しない", async (column) => {
    sqlite.exec(`UPDATE universe_overlay_state SET ${column} = NULL`);
    await expect(loadNewStockEligibility(db(), FROM, TODAY)).rejects.toThrow("世代証拠が不完全");
    expect(queries).toHaveLength(1);
  });

  it("state 不在は既存扱いへ縮退せず停止", async () => {
    sqlite.exec("DELETE FROM universe_overlay_state");
    await expect(loadNewStockEligibility(db(), FROM, TODAY)).rejects.toThrow("世代証拠が不完全");
  });

  it.each([
    ["eligibility_as_of", "2026-10-01"],
    ["eligibility_as_of", "2026-02-30"],
    ["applied_at", "2026-09-29T00:00:00.000Z"],
    ["held_listing_codes", "{}"],
  ])("世代の不正な %s は止める", async (column, value) => {
    sqlite.prepare(`UPDATE universe_overlay_state SET ${column} = ?`).run(value);
    await expect(loadNewStockEligibility(db(), FROM, TODAY)).rejects.toThrow();
  });

  it("上場日が存在しない日付なら不明を捨てず停止", async () => {
    sqlite.exec("UPDATE universe_official_events SET effective_date = '2026-09-31' WHERE code = '646A'");
    await expect(loadNewStockEligibility(db(), FROM, TODAY)).rejects.toThrow("実在する YYYY-MM-DD");
  });

  it("発効日が過去でも取得/適用の実時刻が未来なら停止する", async () => {
    sqlite.exec("UPDATE universe_overlay_state SET events_fetched_at = '2026-10-01T00:00:00.000Z', applied_at = '2026-10-01T00:00:00.000Z'");
    await expect(loadNewStockEligibility(db(), FROM, TODAY)).rejects.toThrow("世代日付が矛盾");
    expect(queries).toHaveLength(1);
  });
});

describe("固定開始日の型付き環境変数", () => {
  it("未設定は停止する", () => {
    vi.stubEnv("BIZTAG_NEW_LISTING_FROM", "");
    expect(() => yuhoEnv.BIZTAG_NEW_LISTING_FROM()).toThrow("設定されていません");
  });
  it.each(["2026-2-03", "2026-02-30", "2026-09-31", "today"])("不正な開始日 %s は停止する", async (value) => {
    vi.stubEnv("BIZTAG_NEW_LISTING_FROM", value);
    expect(() => yuhoEnv.BIZTAG_NEW_LISTING_FROM()).toThrow("実在する YYYY-MM-DD");
    await expect(loadNewStockEligibility(db(), value, TODAY)).rejects.toThrow();
    expect(queries).toHaveLength(0);
  });
  it("実在するうるう日を固定値として読む", () => {
    vi.stubEnv("BIZTAG_NEW_LISTING_FROM", "2024-02-29");
    expect(yuhoEnv.BIZTAG_NEW_LISTING_FROM()).toBe("2024-02-29");
  });
});


describe("最新有報の決定的な選択", () => {
  function latestFixture() {
    sqlite.exec(readFileSync(new URL("../../../../drizzle/d1/0032_edinet_reported_changes.sql", import.meta.url), "utf8"));
    sqlite.exec(`CREATE TABLE core_stocks(id INTEGER, code TEXT, name TEXT, sector33 TEXT, is_active INTEGER, instrument_type TEXT);
      CREATE TABLE yuho_documents(id INTEGER, stock_id INTEGER, doc_id TEXT, doc_type_code TEXT, period_end TEXT, submitted_at INTEGER, notion_doc_page_id TEXT, text_parse_status TEXT);
      INSERT INTO core_stocks VALUES(1,'1414','ショーボンドホールディングス',NULL,1,'equity');
      INSERT INTO yuho_documents VALUES(1,1,'S100Z3O3','120','2026-06-30',1788220800,'original','ok');
      INSERT INTO yuho_documents VALUES(2,1,'S100Z5EY','130','2026-06-30',1788220800,'correction','ok');`);
  }
  it("同一期末・同一提出時刻はD1 idが新しい訂正有報を選ぶ（人工tieの構造回帰）", async () => {
    latestFixture();
    const latest = await loadLatestDocs(db());
    expect(latest).toHaveLength(1);
    expect(latest[0].doc?.docId).toBe("S100Z5EY");
    expect(latest[0].doc?.notionDocPageId).toBe("correction");
    expect(queries).toHaveLength(2); expect(fetch).not.toHaveBeenCalled();
  });
  it("宣言した旧doc取下げfaultは同FYの独立した最新130を保留しない（SQL自己相関の負例）", async () => {
    latestFixture();
    sqlite.prepare("insert into yuho_edinet_reported_changes (source_page_id,seq_number,source_raw_sha256,doc_id,parent_doc_id,reported_state,observation_json) values(?,?,?,?,?,?,?)").run(
      "declared-source", 1, "declared-not-original-SHA", "S100Z3O3", null, "reported_withdrawal", "{\"protocolFault\":true}");
    const latest = await loadLatestDocs(db());
    expect(latest[0].doc?.docId).toBe("S100Z5EY");
    expect(latest[0].reportedHoldReason).toBeUndefined();
    await expect(assertLatestDocCurrent(db(), "1414", latest[0].doc!)).resolves.toBeUndefined();
  });
  it("write直前は対象1社の1 SELECTで最新doc/期末/本文pointerを照合する", async () => {
    latestFixture(); const expected = (await loadLatestDocs(db()))[0].doc!; queries=[];
    await assertLatestDocCurrent(db(), "1414", expected);
    expect(queries).toHaveLength(1); expect(queries[0]).toContain('order by');
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    "UPDATE yuho_documents SET notion_doc_page_id='changed' WHERE id=2",
    "UPDATE yuho_documents SET text_parse_status='error' WHERE id=2",
    "INSERT INTO yuho_documents SELECT 3,stock_id,'OFFLINE_NEW_DOC','130',period_end,submitted_at+1,'newer','ok' FROM yuho_documents WHERE id=2",
    "UPDATE core_stocks SET is_active=0",
  ])("plan/model待ち後の変更を古いdoc/pointerで受け入れない (%s)", async (mutation) => {
    latestFixture(); const expected = (await loadLatestDocs(db()))[0].doc!;
    sqlite.exec(mutation); queries=[];
    await expect(assertLatestDocCurrent(db(), "1414", expected)).rejects.toThrow("旧値を保持してHOLD");
    expect(queries).toHaveLength(1); expect(fetch).not.toHaveBeenCalled();
  });
  it("consumer rechecks only its exact D1 doc/issuer before shared seven-property reader", async () => {
    latestFixture(); const current = (await loadLatestDocs(db()))[0]; queries = []; responses = [];
    await readQualifiedBiztagDocText(db(), current.stockCode, current.doc!);
    expect(queries).toHaveLength(1); expect(queries[0]).toContain('limit ?');
    expect(responses[0].params).toContain(current.stockCode); expect(responses[0].params).toContain(current.doc!.docId);
    expect(readVerifiedDocText).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ stockCode: current.stockCode,
      docId: current.doc!.docId, d1DocumentId: 2, rowPageId: current.doc!.notionDocPageId, deriveCountsFromBody: true }));
    vi.mocked(readVerifiedDocText).mockClear();
    await expect(readQualifiedBiztagDocText(db(), "6963", current.doc!)).rejects.toBeInstanceOf(BiztagTextQualificationError);
    expect(readVerifiedDocText).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

});
