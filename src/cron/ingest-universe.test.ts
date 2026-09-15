/**
 * TDnet 開示・EDINET 有報の取込が、証券コードから `stock_id` を引くときに**取込の母集団**
 * (src/shared/db/active-equity.ts の `disclosureIngestCondition`) だけを見ることの検証。
 * あわせて、優待の取込が使う `findActiveEquityStockId` が active かつ equity のままであることも見る。
 *
 * 固定したい契約:
 *
 *   1. `loadIngestCodeToId` は次の 3 通りだけを返す。**値**で見る。
 *      - 取り込む: active の equity / inactive の equity / inactive で区分が NULL
 *        (地域取引所にだけ上場を続ける会社を想定)
 *      - 取り込まない: active で区分が NULL / active の非普通株 / inactive の非普通株 /
 *        `core_stocks` に無いコード
 *   2. `findActiveEquityStockId` (優待の取込) は active の equity だけを返す。
 *   3. TDnet の日次キャッチアップ (`runIrCatalogCatchup`) は、母集団外の開示を
 *      ir_disclosures に書かず、Notion (一次データの確定 JSON・銘柄別 DB) にも渡さない。
 *      inactive の 2 通りの開示は書いて渡す。
 *   4. `ingestBatch` に code→id を注入しない既定の経路も、同じ母集団で絞る。
 *   5. EDINET の日次キャッチアップ (`runYuhoEdinetCatchup`) も同じ母集団で絞り、
 *      落とした件数を戻り値に出す。
 *   6. code→id を `core_stocks` の全行から作る形 (`select({ id, code }).from(stocks)` の
 *      後に WHERE が無い。キーの順は問わない) が src / services / scripts のどこにも
 *      残っておらず、取込の呼び出し元は `loadIngestCodeToId` を経由する。
 *      ir / yuho の backfill CLI は import すると main() が走るので値では試せず、
 *      静的検査だけが担保している。そのため backfill は、code→id の出どころを
 *      `const codeToId = await loadIngestCodeToId(db)` の 1 つに固定する (代入は 1 つだけ・
 *      core_stocks を drizzle でも生 SQL でも直接引かない・core スキーマを
 *      import しない・`ingestBatch` には `codeToId` を渡す)。
 *
 * 背景: 2026-09-13 のユーザー決定で、日次取込と公開面の母集団を active かつ equity に
 * 絞った (PR #30)。取込が全行でコードを引いたままだと、P4b が非普通株を core_stocks に
 * INSERT した時点で、その開示が取り込まれ、Notion に記録され、ir-catalog の一覧と検索に
 * 出る (ir-catalog の読み手は母集団で絞っていない)。一方で取込を active かつ equity に
 * 絞ると、上場廃止や地域取引所の単独上場の会社 (is_active = 0) の開示が止まる。
 * ユーザー決定は非普通株を外すことだけなので、取込は is_active = 0 を取り込み続ける。
 *
 * コードは 7203 以外すべて合成 (JPX の上場銘柄一覧 2026-08-31 版にも本番 core_stocks にも
 * 無い)。外部 (TDnet / EDINET / Notion) は vi.mock で塞ぐ。D1 は daily-targets.test.ts と
 * 同じく、drizzle/d1 のマイグレーションを流したローカル SQLite に sqlite-proxy で向ける。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import {
  findActiveEquityStockId,
  loadIngestCodeToId,
} from "../shared/db/active-equity.js";
import { ROOT, collectSources, stripComments } from "../shared/db/tests/source-scan.js";
import { INSTRUMENT_TYPES } from "../shared/jpx/instrument-type.js";
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
 * `is_active` と `instrument_type` の 6 通り + `core_stocks` に無い 1 コード。
 * 名前は揃え、市場は合成値 (地域取引所を想定した行だけ別の値)。
 */
const STOCKS = [
  // 取り込む
  { id: 1, code: "7203", active: 1, instrumentType: INSTRUMENT_TYPES.equity, market: "テスト市場" },
  { id: 2, code: "1203", active: 0, instrumentType: INSTRUMENT_TYPES.equity, market: "テスト市場" },
  // 地域取引所にだけ上場を続ける会社を想定 (東証の一覧に無いので対象外化され、区分は未充填)
  { id: 3, code: "1204", active: 0, instrumentType: null, market: "テスト地域取引所" },
  // 取り込まない
  { id: 4, code: "1205", active: 1, instrumentType: null, market: "テスト市場" },
  { id: 5, code: "1206", active: 1, instrumentType: INSTRUMENT_TYPES.reitFund, market: "テスト市場" },
  { id: 6, code: "1207", active: 0, instrumentType: INSTRUMENT_TYPES.etfEtn, market: "テスト市場" },
] as const;
const ABSENT_CODE = "1208";
const ALL_CODES = [...STOCKS.map((s) => s.code), ABSENT_CODE];
/** 取り込む 3 銘柄 (id 昇順)。 */
const INGESTED = STOCKS.filter((s) => s.id <= 3);
const INGESTED_TICKERS = INGESTED.map((s) => s.code).sort();

let sqlite: DatabaseSync;
let db: ReturnType<typeof makeProxyDb>;

beforeEach(() => {
  vi.clearAllMocks();
  sqlite = new DatabaseSync(":memory:");
  applyD1Migrations(sqlite);
  const ins = sqlite.prepare(
    "INSERT INTO core_stocks (id, code, name, market, is_active, instrument_type) VALUES (?, ?, ?, ?, ?, ?)"
  );
  for (const s of STOCKS) {
    ins.run(s.id, s.code, `テスト${s.code}`, s.market, s.active, s.instrumentType);
  }
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

describe("取込の code→id は非普通株と、区分が NULL の active 行だけを除く", () => {
  it("loadIngestCodeToId は active の equity・inactive の equity・inactive で区分が NULL を返す", async () => {
    const map = await loadIngestCodeToId(db);
    expect([...map.entries()].sort((a, b) => a[1] - b[1])).toEqual(
      INGESTED.map((s) => [s.code, s.id])
    );
  });
});

describe("優待の取込の銘柄引きは active かつ equity のまま", () => {
  it("findActiveEquityStockId は active の equity 以外に null を返す", async () => {
    expect(await findActiveEquityStockId(db, "7203")).toBe(1);
    for (const code of ALL_CODES.filter((c) => c !== "7203")) {
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
      stocksTouched: INGESTED.length,
      created: INGESTED.length,
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
      inUniverse: INGESTED.length,
      upserted: INGESTED.length,
    });
    expect(
      sqlite.prepare("SELECT stock_id, company_code FROM ir_disclosures ORDER BY stock_id").all()
    ).toEqual(INGESTED.map((s) => ({ stock_id: s.id, company_code: `${s.code}0` })));

    // 一次データの確定 JSON に載るのも母集団内の 3 件だけ
    const archivedFile = vi.mocked(recordPrimaryData).mock.calls[0][0].files?.[0];
    expect(archivedFile).toBeDefined();
    const archived = JSON.parse(new TextDecoder().decode(archivedFile!.bytes)) as {
      ticker: string;
    }[];
    expect(archived.map((a) => a.ticker).sort()).toEqual(INGESTED_TICKERS);
    // 銘柄別 DB へ渡す行も同じ
    const byStock = vi.mocked(upsertDisclosuresByStock).mock.calls[0][0];
    expect(byStock.rows.map((row) => row.ticker).sort()).toEqual(INGESTED_TICKERS);
  });

  it("ingestBatch に code→id を注入しない既定の経路", async () => {
    const r = await ingestBatch(db as unknown as IrDatabase, ALL_CODES.map(tdnetItem), {
      batchKey: "test",
      source: "test",
      archiveToNotion: false,
      notionByStock: false,
    });

    expect(r.inUniverse).toBe(INGESTED.length);
    expect(sqlite.prepare("SELECT stock_id FROM ir_disclosures ORDER BY stock_id").all()).toEqual(
      INGESTED.map((s) => ({ stock_id: s.id }))
    );
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
    // 最初の日だけ 7 件を返し、残りの日は空。
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
    expect(vi.mocked(ingestDocument).mock.calls.map(([, opts]) => opts.stockId)).toEqual(
      INGESTED.map((s) => s.id)
    );
    // 母集団外の 4 件は取り込まず、落とした件数を戻り値に出す
    expect({ matched: r.matched, ingested: r.ingested, outOfUniverse: r.outOfUniverse }).toEqual({
      matched: INGESTED.length,
      ingested: INGESTED.length,
      outOfUniverse: ALL_CODES.length - INGESTED.length,
    });
  });
});

/**
 * code→id を `core_stocks` の全行から作る形。`.from(<...>stocks)` の直後に `.where(` が
 * 続かないものを拾う。表の側は `stocks` で終わる識別子 (`stocks` / `coreSchema.stocks`)。
 * select のキーは id と code の 2 つで、順は問わない (`{ code, id }` もすり抜けない)。
 */
const STOCKS_TABLE = String.raw`(?:\w+\.)*\w*[Ss]tocks`;
const ID_KEY = String.raw`id:\s*${STOCKS_TABLE}\.id`;
const CODE_KEY = String.raw`code:\s*${STOCKS_TABLE}\.code`;
const CODE_TO_ID_FROM_ALL_ROWS = new RegExp(
  String.raw`\.select\(\s*\{\s*(?:${ID_KEY}\s*,\s*${CODE_KEY}|${CODE_KEY}\s*,\s*${ID_KEY})\s*,?\s*\}\s*\)` +
    String.raw`\s*\.from\(\s*${STOCKS_TABLE}\s*\)(?!\s*\.\s*where\s*\()`,
  "g",
);

function findCodeToIdFromAllRows(source: string): string[] {
  return [...stripComments(source).matchAll(CODE_TO_ID_FROM_ALL_ROWS)].map((m) => m[0]);
}

/** 証券コードから stock_id を引く取込 (と、その共有の入口)。どれも `loadIngestCodeToId` を呼ぶ。 */
const INGEST_CODE_TO_ID_CALLERS = [
  "src/cron/ir-catalog-tdnet.ts",
  "src/cron/yuho-edinet.ts",
  "services/ir-catalog/src/services/ingest.ts",
  "services/ir-catalog/data-scripts/backfill.ts",
  "services/yuho-quant/data-scripts/backfill.ts",
];

/** 値で試せない取込の backfill CLI (import すると main() が走る)。 */
const BACKFILL_CLIS = [
  "services/ir-catalog/data-scripts/backfill.ts",
  "services/yuho-quant/data-scripts/backfill.ts",
];

/** `callee(` から対応する `)` までの呼び出しを返す (括弧の深さだけで数える)。 */
function callSites(code: string, callee: string): string[] {
  const sites: string[] = [];
  for (const m of code.matchAll(new RegExp(String.raw`\b${callee}\(`, "g"))) {
    let depth = 0;
    let end = m.index + m[0].length - 1;
    for (; end < code.length; end++) {
      if (code[end] === "(") depth++;
      else if (code[end] === ")" && --depth === 0) break;
    }
    sites.push(code.slice(m.index, end + 1));
  }
  return sites;
}

/**
 * backfill の code→id の出どころが `loadIngestCodeToId(db)` の 1 つだけかを見る。
 * コメントを除いた本文を渡す。違反の説明を返し、空なら通る。
 */
function findBackfillCodeToIdViolations(code: string): string[] {
  const violations: string[] = [];
  if (!/\bconst\s+codeToId\s*=\s*await\s+loadIngestCodeToId\(\s*db\s*\)/.test(code)) {
    violations.push("`const codeToId = await loadIngestCodeToId(db)` が無い");
  }
  const assigns = code.match(/\bcodeToId\s*=(?![=>])/g) ?? [];
  if (assigns.length !== 1) violations.push(`codeToId への代入が ${assigns.length} 個`);
  if (new RegExp(String.raw`\.from\(\s*${STOCKS_TABLE}\s*\)`).test(code)) {
    violations.push("core_stocks を drizzle で直接引いている");
  }
  if (/\bfrom\s+["'`]?core_stocks\b/i.test(code)) violations.push("core_stocks を生 SQL で引いている");
  if (/\bimport\b[^;]*\bfrom\s*["'][^"']*\/core-schema(?:\.js)?["']/.test(code)) {
    violations.push("core スキーマを import している");
  }
  for (const call of callSites(code, "ingestBatch")) {
    if (!/\bcodeToId(?:\s*:\s*codeToId)?\s*[,}]/.test(call)) {
      violations.push("ingestBatch に codeToId を渡していない");
    }
  }
  return violations;
}

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
        " loadIngestCodeToId() を使うこと。全行で引くと、P4b で入る非普通株まで取り込む",
    ).toEqual([]);
  });

  it.each(INGEST_CODE_TO_ID_CALLERS)("%s は loadIngestCodeToId を呼ぶ", (rel) => {
    const code = stripComments(readFileSync(join(ROOT, rel), "utf-8"));
    expect(code).toMatch(/\bloadIngestCodeToId\(\s*db\s*\)/);
  });

  // backfill CLI は import すると main() が走るので値では試せない。上の 2 つは
  // 「全行から引く形が無い」「loadIngestCodeToId をどこかで呼ぶ」しか見ないので、
  // loadIngestCodeToId を残したまま WHERE 付きの別の map を取込に渡す改修を通してしまう。
  // code→id の出どころを loadIngestCodeToId の 1 つに固定し、core_stocks を直接引かせない。
  it.each(BACKFILL_CLIS)("%s は code→id を loadIngestCodeToId だけから作り、core_stocks を直接引かない", (rel) => {
    const code = stripComments(readFileSync(join(ROOT, rel), "utf-8"));
    expect(findBackfillCodeToIdViolations(code)).toEqual([]);
  });

  it("backfill の検査が別の map・core_stocks の直接参照・注入漏れを拾う", () => {
    const ok = [
      "const codeToId = await loadIngestCodeToId(db);",
      "const r = await ingestBatch(db, items, { batchKey, codeToId, archiveToNotion });",
      "if (!codeToId.has(t)) return false;",
    ].join("\n");
    expect(findBackfillCodeToIdViolations(ok)).toEqual([]);
    // yuho の形 (ingestBatch を呼ばず codeToId.get で引く)
    expect(
      findBackfillCodeToIdViolations(
        "const codeToId = await loadIngestCodeToId(db);\nconst stockId = codeToId.get(ticker)!;"
      )
    ).toEqual([]);
    // WHERE 付きの別の map を作って渡す
    expect(
      findBackfillCodeToIdViolations(
        ok.replace(
          "codeToId, archiveToNotion",
          "codeToId: activeMap, archiveToNotion"
        ) +
          "\nconst activeMap = new Map((await db.select({ id: stocks.id, code: stocks.code })" +
          ".from(stocks).where(eq(stocks.isActive, true))).map((r) => [r.code, r.id]));"
      )
    ).not.toEqual([]);
    // codeToId を別の値で作り直す
    expect(
      findBackfillCodeToIdViolations(ok + "\ncodeToId = new Map();")
    ).not.toEqual([]);
    expect(
      findBackfillCodeToIdViolations(
        ok.replace("const codeToId = await loadIngestCodeToId(db);", "let codeToId = await loadIngestCodeToId(db);") +
          "\nconst x = 1;"
      )
    ).not.toEqual([]);
    // 生 SQL で core_stocks を引く
    expect(
      findBackfillCodeToIdViolations(ok + "\nawait db.run(sql`SELECT id, code FROM core_stocks`);")
    ).not.toEqual([]);
    // ingestBatch に codeToId を渡さない (既定経路は同じ母集団だが、ここでは注入を固定する)
    expect(
      findBackfillCodeToIdViolations(ok.replace("codeToId, archiveToNotion", "archiveToNotion"))
    ).not.toEqual([]);
    // ログの文言に core_stocks と書くのは拾わない
    expect(
      findBackfillCodeToIdViolations(ok + "\nconsole.info(`core_stocks (取込の母集団) ${codeToId.size} 社`);")
    ).toEqual([]);
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
    // キーの順が逆でも拾う
    expect(
      findCodeToIdFromAllRows("await db.select({ code: stocks.code, id: stocks.id }).from(stocks);")
    ).toHaveLength(1);
    // 拾ってはいけないもの
    expect(
      findCodeToIdFromAllRows(
        "db.select({ id: stocks.id, code: stocks.code })\n  .from(stocks)\n  .where(disclosureIngestCondition());"
      )
    ).toEqual([]);
    expect(
      findCodeToIdFromAllRows(
        "db.select({ code: stocks.code, id: stocks.id }).from(stocks).where(activeEquityCondition())"
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
