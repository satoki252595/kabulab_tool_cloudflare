import { beforeEach, expect, it, vi } from "vitest";
import { main } from "./backfill.js";
import { listDocuments } from "../src/services/edinet/client.js";
import { ingestDocument } from "../src/services/ingest.js";
vi.mock("../../../src/shared/db/d1-http-client.js", () => ({createD1HttpDb: vi.fn(() => ({})), createD1HttpBatchSender: vi.fn(() => vi.fn())}));
vi.mock("../../../src/shared/db/active-equity.js", () => ({loadIngestCodeToId: vi.fn(async () => new Map([["7203", 1]]))}));
vi.mock("../src/services/edinet/client.js", () => ({listDocuments: vi.fn()}));
vi.mock("../src/services/ingest.js", () => ({ingestDocument: vi.fn()}));
beforeEach(() => vi.clearAllMocks());
it("two workers halt new claims, await already-started doc, then reject without next day/completion", async () => {
  const argv = process.argv;
  process.argv = [...argv.slice(0, 2), "--from=2026-09-29", "--to=2026-09-30", "--concurrency=2"];
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.useFakeTimers({toFake: ["setTimeout"]});
  let fail!: (e: Error) => void, finish!: (value: never) => void;
  const first = new Promise<never>((_, reject) => {fail = reject;});
  const second = new Promise<never>(resolve => {finish = resolve;});
  vi.mocked(listDocuments).mockResolvedValue({results: [1, 2, 3].map(n => ({docID: `control-${n}`, secCode: "72030", ordinanceCode: "010", docTypeCode: "120", formCode: "030000"}))} as never);
  vi.mocked(ingestDocument).mockReturnValueOnce(first).mockReturnValueOnce(second);
  let settled = false;
  try {
    const run = main().then(() => {settled = true; return undefined;}, e => {settled = true; return e;});
    await vi.waitFor(() => expect(ingestDocument).toHaveBeenCalledTimes(2));
    fail(new Error("unknown result"));
    await Promise.resolve(); await Promise.resolve();
    expect(settled).toBe(false);
    finish({outcome: "skipped_existing", parseStatus: "no_order_table"} as never);
    await vi.runAllTimersAsync();
    expect(await run).toBeInstanceOf(Error);
    expect(ingestDocument).toHaveBeenCalledTimes(2);
    expect(listDocuments).toHaveBeenCalledTimes(1);
    expect(info.mock.calls.flat().join(" ")).not.toContain("[backfill] 完了");
  } finally {process.argv = argv; vi.useRealTimers(); info.mockRestore(); error.mockRestore();}
});

it("list failure does not print completion or resolve successfully", async () => {
  const argv = process.argv;
  process.argv = [...argv.slice(0, 2), "--from=2026-09-29", "--to=2026-09-30"];
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.useFakeTimers({toFake: ["setTimeout"]});
  vi.mocked(listDocuments).mockRejectedValueOnce(new Error("untrusted"));
  try {
    const run = main().catch(e => e);
    await vi.runAllTimersAsync();
    expect(await run).toBeInstanceOf(Error);
    expect(ingestDocument).not.toHaveBeenCalled();
    expect(listDocuments).toHaveBeenCalledTimes(1);
    expect(info.mock.calls.flat().join(" ")).not.toContain("[backfill] 完了");
  } finally {process.argv = argv; vi.useRealTimers(); info.mockRestore(); error.mockRestore();}
});
