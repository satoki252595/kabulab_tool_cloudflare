/**
 * EDINET 日次 catchup の応答契約テスト (Sol HOLD2)。
 *
 * 実失敗 (一覧/取込の throw。物理保管失敗を含む) は result の
 * listErrors/ingestErrors に集計され、admin は result 本文付き 500 で
 * CLI exit 1 へ接続する。母集団外・cap・既取込は正当結果で 200 のまま。
 * 外部 (EDINET / 取込本体) は vi.mock で塞ぎ、D1 は本番と同じ
 * migration を流した in-memory SQLite に向ける (ingest-universe と同一方式)。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { ROOT } from "../shared/db/tests/source-scan.js";
import { INSTRUMENT_TYPES } from "../shared/jpx/instrument-type.js";
import { listDocuments } from "../../services/yuho-quant/src/services/edinet/client.js";
import { ingestDocument } from "../../services/yuho-quant/src/services/ingest.js";
import type { Database as YuhoDatabase } from "../../services/yuho-quant/src/db/client.js";
import {
  catchupHttpStatus,
  runYuhoEdinetCatchup,
} from "./yuho-edinet.js";

vi.mock("../../services/yuho-quant/src/services/edinet/client.js", () => ({
  listDocuments: vi.fn(),
}));
vi.mock("../../services/yuho-quant/src/services/ingest.js", () => ({
  ingestDocument: vi.fn(),
}));

function applyD1Migrations(target: DatabaseSync): void {
  const dir = join(ROOT, "drizzle", "d1");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
    for (const stmt of readFileSync(join(dir, f), "utf-8").split("--> statement-breakpoint")) {
      if (stmt.trim()) target.exec(stmt);
    }
  }
}

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

let sqlite: DatabaseSync;
let db: ReturnType<typeof makeProxyDb>;

beforeEach(() => {
  vi.clearAllMocks();
  sqlite = new DatabaseSync(":memory:");
  applyD1Migrations(sqlite);
  sqlite
    .prepare(
      "INSERT INTO core_stocks (id, code, name, market, is_active, instrument_type) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(1, "7203", "テスト7203", "テスト市場", 1, INSTRUMENT_TYPES.equity);
  db = makeProxyDb(sqlite);
});

const annualDoc = (code: string) => ({
  docID: `S100${code}`,
  secCode: `${code}0`,
  ordinanceCode: "010",
  docTypeCode: "120",
  formCode: "030000",
  filerName: `テスト${code}`,
});

async function runCatchup() {
  // 本体は sleep を挟む (60 日分)。setTimeout だけ偽物にして進める。
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const running = runYuhoEdinetCatchup(db as unknown as YuhoDatabase);
    await vi.runAllTimersAsync();
    return await running;
  } finally {
    vi.useRealTimers();
    info.mockRestore();
    err.mockRestore();
  }
}

describe("catchup 応答契約: 実失敗だけ非 2xx", () => {
  it("positive: 母集団外あり・失敗なし → errors 空・200", async () => {
    vi.mocked(listDocuments)
      .mockResolvedValueOnce({ results: [annualDoc("7203"), annualDoc("1208")] } as never)
      .mockResolvedValue({ results: [] } as never);
    vi.mocked(ingestDocument).mockResolvedValue({
      outcome: "ingested",
      parseStatus: "ok_pattern_a",
      overseasParseStatus: "no_segment_note",
      textParseStatus: "no_text",
    } as never);

    const r = await runCatchup();
    expect({ outOfUniverse: r.outOfUniverse, ingested: r.ingested }).toEqual({
      outOfUniverse: 1,
      ingested: 1,
    });
    expect(r.listErrors).toEqual([]);
    expect(r.ingestErrors).toEqual([]);
    expect(catchupHttpStatus(r)).toBe(200);
  });

  it("negative: 一覧失敗の日 → listErrors に日付・500", async () => {
    vi.mocked(listDocuments)
      .mockRejectedValueOnce(new Error("EDINET list down"))
      .mockResolvedValue({ results: [] } as never);
    vi.mocked(ingestDocument).mockResolvedValue({} as never);

    const r = await runCatchup();
    expect(r.listErrors).toHaveLength(1);
    expect(r.ingestErrors).toEqual([]);
    expect(catchupHttpStatus(r)).toBe(500);
  });

  it("negative: 取込失敗 (物理保管失敗を含む) → ingestErrors に docID・500", async () => {
    vi.mocked(listDocuments)
      .mockResolvedValueOnce({ results: [annualDoc("7203")] } as never)
      .mockResolvedValue({ results: [] } as never);
    vi.mocked(ingestDocument).mockRejectedValueOnce(new Error("Notion 記録失敗"));

    const r = await runCatchup();
    expect(r.listErrors).toEqual([]);
    expect(r.ingestErrors).toEqual(["S1007203"]);
    expect(catchupHttpStatus(r)).toBe(500);
  });

  it("境界: cap・既取込・母集団外は失敗に混ぜない (型で保証)", () => {
    // catchupHttpStatus は Pick<listErrors|ingestErrors> だけ見る。
    // reachedCap/outOfUniverse/skippedExisting は引数の型に入らない。
    expect(catchupHttpStatus({ listErrors: [], ingestErrors: [] })).toBe(200);
    expect(catchupHttpStatus({ listErrors: ["2026-09-01"], ingestErrors: [] })).toBe(500);
    expect(catchupHttpStatus({ listErrors: [], ingestErrors: ["S1007203"] })).toBe(500);
  });
});
