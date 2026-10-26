import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runIrCatalogCatchup } from "./ir-catalog-tdnet.js";
import { loadIngestCodeToId } from "../shared/db/active-equity.js";
import { listRange } from "../../services/ir-catalog/src/services/tdnet/client.js";
import { ingestBatch, loadTdnetIdsSince } from "../../services/ir-catalog/src/services/ingest.js";
vi.mock("../shared/db/active-equity.js", () => ({ loadIngestCodeToId: vi.fn(async () => new Map()) }));
vi.mock("../../services/ir-catalog/src/services/tdnet/client.js", () => ({ listRange: vi.fn(async () => []) }));
vi.mock("../../services/ir-catalog/src/services/ingest.js", async () => ({
  ...await vi.importActual<typeof import("../../services/ir-catalog/src/services/ingest.js")>("../../services/ir-catalog/src/services/ingest.js"),
  loadTdnetIdsSince: vi.fn(async () => new Set()),
  ingestBatch: vi.fn(async () => ({ fetched: 0, inUniverse: 0, upserted: 0, unclassified: 0, byPrimaryTag: {}, notionArchive: null, notionByStock: null })),
}));
const now = Date.parse("2026-10-14T10:00:00Z");
const freshUpstream = {
  id: "FRESH1", pubdate: "2026-10-14 18:30:00", company_code: "72030", company_name: "試験",
  title: "試験", document_url: "https://example.invalid/fresh.pdf", url_xbrl: null,
  markets_string: null, update_history: null,
};
beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now); vi.spyOn(console, "info").mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it("同じ41日一覧と12分phaseへだけ絶対締切を追加し、source順序を保つ", async () => {
  const deadline = now + 58.5 * 60_000;
  vi.mocked(listRange).mockResolvedValue([freshUpstream]);
  await runIrCatalogCatchup({} as never, undefined, now, deadline);
  expect(listRange).toHaveBeenCalledWith("20260904-20261014", expect.any(Function));
  expect(ingestBatch).toHaveBeenCalledWith(expect.anything(), [freshUpstream], expect.objectContaining({
    batchKey: "tdnet-daily-2026-10-14", dailySnapshot: true,
    notionByStockBudgetMs: 720_000, notionByStockDeadlineMs: deadline - 10 * 60_000, unsavedLookbackDays: 40,
  }));
  expect(vi.mocked(listRange).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(ingestBatch).mock.invocationCallOrder[0]);
});

it("expired/invalid入口と源一覧中の締切では次のD1/保管へ進めない", async () => {
  for (const deadline of [now, NaN, Infinity]) await expect(runIrCatalogCatchup({} as never, undefined, now, deadline)).rejects.toThrow("絶対締切");
  expect(loadIngestCodeToId).not.toHaveBeenCalled(); expect(listRange).not.toHaveBeenCalled();
  vi.mocked(listRange).mockImplementationOnce(async () => { vi.setSystemTime(now + 11 * 60_000); return []; });
  await expect(runIrCatalogCatchup({} as never, undefined, now, now + 11 * 60_000)).rejects.toThrow("絶対締切");
  expect(loadTdnetIdsSince).not.toHaveBeenCalled(); expect(ingestBatch).not.toHaveBeenCalled();
});
