/**
 * INC-20261026: やのしんが items:[] / 止まった最新 pubdate を返しても
 * 日次完了にしてはならない。修正前はこのテストが失敗する。
 */
import { beforeEach, expect, it, vi } from "vitest";
import { runIrCatalogCatchup } from "./ir-catalog-tdnet.js";
import { listRange } from "../../services/ir-catalog/src/services/tdnet/client.js";
import { ingestBatch } from "../../services/ir-catalog/src/services/ingest.js";
import type { TdnetItemRaw } from "../../services/ir-catalog/src/services/tdnet/types.js";

vi.mock("../shared/db/active-equity.js", () => ({ loadIngestCodeToId: vi.fn(async () => new Map()) }));
vi.mock("../../services/ir-catalog/src/services/tdnet/client.js", () => ({ listRange: vi.fn(async () => []) }));
vi.mock("../../services/ir-catalog/src/services/ingest.js", async () => ({
  ...(await vi.importActual<typeof import("../../services/ir-catalog/src/services/ingest.js")>(
    "../../services/ir-catalog/src/services/ingest.js",
  )),
  loadTdnetIdsSince: vi.fn(async () => new Set()),
  ingestBatch: vi.fn(async () => ({
    fetched: 0, inUniverse: 0, upserted: 0, unclassified: 0,
    byPrimaryTag: {}, notionArchive: null, notionByStock: null,
  })),
}));

/** 2026-10-26 19:00 JST。catchup の定時帯。 */
const NOW = Date.parse("2026-10-26T10:00:00Z");

function staleItem(): TdnetItemRaw {
  return {
    id: "STALE1",
    pubdate: "2026-10-24 13:15:00",
    company_code: "72030",
    company_name: "試験",
    title: "試験開示",
    document_url: "https://example.invalid/stale.pdf",
    url_xbrl: null,
    markets_string: null,
    update_history: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

it("items:[] のやのしんは日次完了にしない", async () => {
  vi.mocked(listRange).mockResolvedValue([]);
  await expect(runIrCatalogCatchup({} as never, undefined, NOW)).rejects.toThrow(/upstream stopped/);
  const logs = vi.mocked(console.info).mock.calls.map((call) => call.join(" ")).join("\n");
  expect(logs).not.toContain("日次完了");
  expect(ingestBatch).not.toHaveBeenCalled();
});

it("最新 pubdate が 10/24 13:15 の一覧は日次完了にしない", async () => {
  vi.mocked(listRange).mockResolvedValue([staleItem()]);
  await expect(runIrCatalogCatchup({} as never, undefined, NOW)).rejects.toThrow(/upstream stopped/);
  const logs = vi.mocked(console.info).mock.calls.map((call) => call.join(" ")).join("\n");
  expect(logs).not.toContain("日次完了");
  expect(logs).toContain("newest_pubdate=2026-10-24T13:15:00+09:00");
  expect(logs).toContain("elapsed_watch_seconds=36000");
  expect(logs).toContain("judgement=upstream_stopped");
  expect(ingestBatch).not.toHaveBeenCalled();
});

it("fresh な最新 pubdate の一覧は日次完了する", async () => {
  const fresh = { ...staleItem(), id: "FRESH1", pubdate: "2026-10-26 18:30:00" };
  vi.mocked(listRange).mockResolvedValue([fresh]);
  const result = await runIrCatalogCatchup({} as never, undefined, NOW);
  expect(result.ran).toBe(true);
  const logs = vi.mocked(console.info).mock.calls.map((call) => call.join(" ")).join("\n");
  expect(logs).toContain("日次完了");
  expect(logs).toContain("judgement=fresh");
  expect(logs).toContain("elapsed_watch_seconds=1800");
  expect(ingestBatch).toHaveBeenCalled();
});
