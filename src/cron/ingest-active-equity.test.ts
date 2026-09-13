/**
 * 証券コードから `stock_id` を引く取込が、日次・公開面と同じ母集団
 * (`core_stocks` の active かつ equity、src/shared/db/active-equity.ts) だけを見ることの検証。
 *
 * 固定したい契約:
 *
 *   1. `loadActiveEquityCodeToId` / `findActiveEquityStockId` は active かつ equity だけを
 *      返し、次は全部落とす: active の非普通株 (reit_fund)、active で区分が NULL、
 *      上場廃止 (is_active = 0) の普通株、`core_stocks` に無いコード。**値**で見る。
 *   2. TDnet の日次キャッチアップ (`runIrCatalogCatchup`) は、母集団外の開示を
 *      ir_disclosures に書かず、Notion (一次データの確定 JSON・銘柄別 DB) にも渡さない。
 *   3. `ingestBatch` に code→id を注入しない既定の経路も、同じ母集団で絞る。
 *   4. EDINET の日次キャッチアップ (`runYuhoEdinetCatchup`) は、母集団外の有報を
 *      取り込まない。
 *   5. code→id を `core_stocks` の全行から作る形 (`select({ id, code }).from(stocks)` の
 *      後に WHERE が無い) が src / services / scripts のどこにも残っていない。
 *      ir / yuho の backfill CLI は import すると main() が走るので値では試せず、
 *      この静的検査だけが担保している。
 *
 * 背景: 2026-09-13 のユーザー決定で、日次取込と公開面の母集団を active かつ equity に
 * 絞った (PR #30)。取込だけが全行でコードを引くと、公開面から外した銘柄の開示が
 * 取り込まれ、Notion に記録され、ir-catalog の一覧と検索に出る (ir-catalog の読み手は
 * この述語で絞っていない)。P4b が非普通株 (+725 行) を core_stocks に INSERT した時点で、
 * その全銘柄について自動で始まる。
 *
 * 外部 (TDnet / EDINET / Notion) は vi.mock で塞ぐ。D1 は daily-targets.test.ts と同じく、
 * drizzle/d1 のマイグレーションを流したローカル SQLite に sqlite-proxy で向ける。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import {
  findActiveEquityStockId,
  loadActiveEquityCodeToId,
} from "../shared/db/active-equity.js";
import { ROOT, collectSources, stripComments } from "../shared/db/tests/source-scan.js";
import {
  recordPrimaryData,
  upsertDisclosuresByStock,
} from "../shared/notion-archive/index.js";
import { listRange } from "../../services/ir-catalog/src/services/tdnet/client.js";
import type { TdnetItemRaw } from "../../services/ir-catalog/src/services/tdnet/types.js";
import { ingestBatch } from "../../services/ir-catalog/src/services/ingest.js";
import type { Database as IrDatabase } from "../../services/ir-catalog/src/db/client.js";
import { listDocuments } from "../../services/yuho-quant/src/services/edinet/client.js";
import { ingestDocument } from "../../services/yuho-quant/src/services/ingest.js";
import type { Database as YuhoDatabase } from "../../services/yuho-quant/src/db/client.js";
import { runIrCatalogCatchup } from "./ir-catalog-tdnet.js";
import { runYuhoEdinetCatchup } from "./yuho-edinet.js";

vi.mock("../../services/ir-catalog/src/services/tdnet/client.js", () => ({
  listRange: vi.fn(),
}));
vi.mock("../shared/notion-archive/index.js", () => ({
  recordPrimaryData: vi.fn(),
  upsertDisclosuresByStock: vi.fn(),
}));
vi.mock("../../services/yuho-quant/src/services/edinet/client.js", () => ({
  listDocuments: vi.fn(),
}));
vi.mock("../../services/yuho-quant/src/services/ingest.js", () => ({
  ingestDocument: vi.fn(),
}));

/** drizzle/d1 の全マイグレーションを番号順に流す (本番 D1 と同じ形)。 */
function applyD1Migrations(target: DatabaseSync): void {
  const dir = join(ROOT, "drizzle", "d1");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
    for (const stmt of readFileSync(join(dir, f), "utf-8").split("--> statement-breakpoint")) {
      if (stmt.trim()) target.exec(stmt);
    }
  }
}

/** createD1HttpDb と同じ sqlite-proxy 経路をローカル SQLite に向ける。 */
function makeProxyDb(target: DatabaseSync) {
  return drizzle(async (sqlStr, params, method) => {
    const stmt = target.prepare(sqlStr);
    const bind = params as (null | number | bigint | string | Uint8Array)[];
    if (method === "run") {
      stmt.run(...bind);
      return { rows: [] };
    }
    const rows = (stmt.all(...bind) as Record<string, unknown>[]).map((o) => Object.values(o));
    return { rows: method === "get" ? (rows[0] ?? []) : rows };
  });
}

/**
 * 4 銘柄 + core_stocks に無い 1 コード。取り込んでよいのは 7203 だけ。
 * `instrument_type` と `is_active` 以外 (名前・市場) は揃えてある。
 */
const STOCKS = [
  { id: 1, code: "7203", active: 1, instrumentType: "equity" },
  { id: 2, code: "8951", active: 1, instrumentType: "reit_fund" },
  { id: 3, code: "9999", active: 1, instrumentType: null },
  { id: 4, code: "6501", active: 0, instrumentType: "equity" },
] as const;
const ABSENT_CODE = "1301";
const ALL_CODES = [...STOCKS.map((s) => s.code), ABSENT_CODE];

let sqlite: DatabaseSync;
let db: ReturnType<typeof makeProxyDb>;

beforeEach(() => {
  vi.clearAllMocks();
  sqlite = new DatabaseSync(":memory:");
  applyD1Migrations(sqlite);
  const ins = sqlite.prepare(
    "INSERT INTO core_stocks (id, code, name, market, is_active, instrument_type) VALUES (?, ?, ?, 'テスト市場', ?, ?)"
  );
  for (const s of STOCKS) ins.run(s.id, s.code, `テスト${s.code}`, s.active, s.instrumentType);
  db = makeProxyDb(sqlite);
});

afterEach(() => {
  sqlite.close();
});

/** TDnet の 1 開示。company_code は 5 文字 (4 文字ティッカー + 検査文字)。 */
function tdnetItem(code: string): TdnetItemRaw {
  return {
    id: `T${code}`,
    pubdate: "2026-09-11 15:00:00",
    company_code: `${code}0`,
    company_name: `テスト${code}`,
    title: "テスト開示",
    document_url: `https://example.invalid/${code}.pdf`,
    url_xbrl: null,
    markets_string: null,
  } as TdnetItemRaw;
}

describe("取込用の code→id は active かつ equity だけ", () => {
  it("loadActiveEquityCodeToId は 7203 だけを返す", async () => {
    const map = await loadActiveEquityCodeToId(db);
    expect([...map.entries()]).toEqual([["7203", 1]]);
  });

  it("findActiveEquityStockId は母集団外のコードに null を返す", async () => {
    expect(await findActiveEquityStockId(db, "7203")).toBe(1);
    for (const code of ["8951", "9999", "6501", ABSENT_CODE]) {
      expect(await findActiveEquityStockId(db, code), code).toBeNull();
    }
  });
});

describe("TDnet の取込は母集団外の開示を書かず、Notion にも渡さない", () => {
  it("runIrCatalogCatchup (日次キャッチアップ)", async () => {
    vi.mocked(listRange).mockResolvedValue(ALL_CODES.map(tdnetItem));
    vi.mocked(recordPrimaryData).mockResolvedValue({
      outcome: "created",
      fileTooLarge: false,
    } as never);
    vi.mocked(upsertDisclosuresByStock).mockResolvedValue({
      stocksTouched: 1,
      created: 1,
      updated: 0,
      skippedExisting: 0,
      skippedNoFile: 0,
      rejudged: 0,
      rowErrors: 0,
      reachedDeadline: false,
    } as never);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    const r = await runIrCatalogCatchup(db as unknown as IrDatabase);
    info.mockRestore();

    expect({ fetched: r.fetched, inUniverse: r.inUniverse, upserted: r.upserted }).toEqual({
      fetched: ALL_CODES.length,
      inUniverse: 1,
      upserted: 1,
    });
    expect(sqlite.prepare("SELECT stock_id, company_code FROM ir_disclosures").all()).toEqual([
      { stock_id: 1, company_code: "72030" },
    ]);

    // 一次データの確定 JSON に載るのも母集団内の 1 件だけ
    const archivedFile = vi.mocked(recordPrimaryData).mock.calls[0][0].files?.[0];
    expect(archivedFile).toBeDefined();
    const archived = JSON.parse(new TextDecoder().decode(archivedFile!.bytes)) as {
      ticker: string;
    }[];
    expect(archived.map((a) => a.ticker)).toEqual(["7203"]);
    // 銘柄別 DB へ渡す行も同じ
    const byStock = vi.mocked(upsertDisclosuresByStock).mock.calls[0][0];
    expect(byStock.rows.map((row) => row.ticker)).toEqual(["7203"]);
  });

  it("ingestBatch に code→id を注入しない既定の経路", async () => {
    const r = await ingestBatch(db as unknown as IrDatabase, ALL_CODES.map(tdnetItem), {
      batchKey: "test",
      source: "test",
      archiveToNotion: false,
      notionByStock: false,
    });

    expect(r.inUniverse).toBe(1);
    expect(sqlite.prepare("SELECT stock_id FROM ir_disclosures").all()).toEqual([
      { stock_id: 1 },
    ]);
    expect(recordPrimaryData).not.toHaveBeenCalled();
    expect(upsertDisclosuresByStock).not.toHaveBeenCalled();
  });
});

describe("EDINET の取込は母集団外の有報を取り込まない", () => {
  it("runYuhoEdinetCatchup (日次キャッチアップ)", async () => {
    const docs = ALL_CODES.map((code) => ({
      docID: `S100${code}`,
      secCode: `${code}0`,
      ordinanceCode: "010",
      docTypeCode: "120",
      formCode: "030000",
      filerName: `テスト${code}`,
    }));
    // 最初の日だけ 5 件を返し、残りの日は空。
    vi.mocked(listDocuments)
      .mockResolvedValueOnce({ results: docs } as never)
      .mockResolvedValue({ results: [] } as never);
    vi.mocked(ingestDocument).mockResolvedValue({
      outcome: "ingested",
      parseStatus: "ok_pattern_a",
      overseasParseStatus: "no_segment_note",
    } as never);

    // 本体は 1 日ごとに sleep(150)、1 件ごとに sleep(300) を挟む (60 日で約 9 秒)。
    // setTimeout だけを偽物にして進める (Date.now は本物のまま = 時間予算の判定は変えない)。
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    let r: Awaited<ReturnType<typeof runYuhoEdinetCatchup>>;
    try {
      const running = runYuhoEdinetCatchup(db as unknown as YuhoDatabase);
      await vi.runAllTimersAsync();
      r = await running;
    } finally {
      vi.useRealTimers();
      info.mockRestore();
    }

    expect(vi.mocked(listDocuments)).toHaveBeenCalledTimes(60);
    expect(vi.mocked(ingestDocument).mock.calls.map(([, opts]) => opts.stockId)).toEqual([1]);
    expect({ matched: r.matched, ingested: r.ingested }).toEqual({ matched: 1, ingested: 1 });
  });
});

/**
 * code→id を `core_stocks` の全行から作る形。`.from(<...>stocks)` の直後に `.where(` が
 * 続かないものを拾う。表の側は `stocks` で終わる識別子 (`stocks` / `coreSchema.stocks`)。
 */
const CODE_TO_ID_FROM_ALL_ROWS =
  /\.select\(\s*\{\s*id:\s*(?:\w+\.)*\w*[Ss]tocks\.id\s*,\s*code:\s*(?:\w+\.)*\w*[Ss]tocks\.code\s*,?\s*\}\s*\)\s*\.from\(\s*(?:\w+\.)*\w*[Ss]tocks\s*\)(?!\s*\.\s*where\s*\()/g;

function findCodeToIdFromAllRows(source: string): string[] {
  return [...stripComments(source).matchAll(CODE_TO_ID_FROM_ALL_ROWS)].map((m) => m[0]);
}

/** 証券コードから stock_id を引く取込。どれも共有の loader を呼ぶ。 */
const INGEST_CODE_TO_ID_CALLERS = [
  "src/cron/ir-catalog-tdnet.ts",
  "src/cron/yuho-edinet.ts",
  "services/ir-catalog/src/services/ingest.ts",
  "services/ir-catalog/data-scripts/backfill.ts",
  "services/yuho-quant/data-scripts/backfill.ts",
];

describe("code→id を core_stocks の全行から作る形が残っていない", () => {
  it("src / services / scripts に 0 件", () => {
    const sources = ["src", "services", "scripts"].flatMap((dir) => collectSources(join(ROOT, dir)));
    // 走査が空振りすると下の検査は無条件に緑になる。
    expect(sources.length).toBeGreaterThan(100);
    const offenders = sources.flatMap((path) =>
      findCodeToIdFromAllRows(readFileSync(path, "utf-8")).map(
        (m) => `${relative(ROOT, path).split(sep).join("/")}: ${m.replace(/\s+/g, " ")}`
      )
    );
    expect(
      offenders,
      "取込で証券コードから stock_id を引くなら src/shared/db/active-equity.ts の" +
        " loadActiveEquityCodeToId() を使うこと。全行で引くと、公開面から外した銘柄まで取り込む",
    ).toEqual([]);
  });

  it.each(INGEST_CODE_TO_ID_CALLERS)("%s は loadActiveEquityCodeToId を呼ぶ", (rel) => {
    const code = stripComments(readFileSync(join(ROOT, rel), "utf-8"));
    expect(code).toMatch(/\bloadActiveEquityCodeToId\(\s*db\s*\)/);
  });

  it("検出器が書き方を問わず拾い、WHERE 付きとコメントは拾わない", () => {
    // 拾うべきもの
    expect(
      findCodeToIdFromAllRows("await db.select({ id: stocks.id, code: stocks.code }).from(stocks);")
    ).toHaveLength(1);
    expect(
      findCodeToIdFromAllRows(
        "await db\n    .select({ id: coreSchema.stocks.id, code: coreSchema.stocks.code })\n    .from(coreSchema.stocks);"
      )
    ).toHaveLength(1);
    expect(
      findCodeToIdFromAllRows("db.select({ id: stocks.id, code: stocks.code }).from(stocks).orderBy(stocks.code)")
    ).toHaveLength(1);
    // 拾ってはいけないもの
    expect(
      findCodeToIdFromAllRows(
        "db.select({ id: stocks.id, code: stocks.code })\n  .from(stocks)\n  .where(activeEquityCondition());"
      )
    ).toEqual([]);
    expect(
      findCodeToIdFromAllRows(
        "db.select({ id: stocks.id, code: stocks.code }).from(stocks).where(eq(stocks.isYutai, true))"
      )
    ).toEqual([]);
    expect(
      findCodeToIdFromAllRows("// db.select({ id: stocks.id, code: stocks.code }).from(stocks);")
    ).toEqual([]);
    expect(
      findCodeToIdFromAllRows("db.select({ id: stocks.id }).from(stocks);")
    ).toEqual([]);
  });
});
