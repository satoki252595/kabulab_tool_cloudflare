import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import type { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { acceptPrepareStage, planPrepareStage, startPrepareStage } from "./competitor-prepare-stage.js";
import { localJobRemainingMs, main } from "./main.js";
import { BIZTAG_DATA_PREFIX } from "./receipt.js";

type Child = EventEmitter & { pid: number; exitCode: number | null; signalCode: string | null; stdout: EventEmitter; args: string[] };
const harness = vi.hoisted(() => ({ state: "", receiptDelay: 0, autoFirstSuccess: false, children: [] as Child[] }));
vi.mock("./runtime.js", () => ({ preflight: () => ({ state: harness.state, revision: "aff271ff9503742dd986447220002eab2a0c1e4d" }) }));
vi.mock("./receipt.js", async importActual => ({ ...await importActual<object>(),
  startLocalJobReceipt: async () => { if (harness.receiptDelay > 0) await new Promise(r => setTimeout(r, harness.receiptDelay)); return "protocol-version"; },
  mirrorLocalJobReceipt: vi.fn() }));
vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  return { execFileSync: vi.fn(() => { throw new Error("external command forbidden"); }), spawn: vi.fn((_program, args: string[], options: { stdio: unknown[] }) => {
    const child = Object.assign(new EventEmitter(), { pid: process.pid, exitCode: null as number | null,
      signalCode: null as string | null, stdout: new EventEmitter(), args });
    harness.children.push(child);
    if (harness.autoFirstSuccess && args.includes("run")) {
      writeFileSync(options.stdio[1] as number, BIZTAG_DATA_PREFIX + JSON.stringify({ scope: "daily_window", status: "checked_scope_complete",
        totalStocks: 0, selectedForTextCheck: 0, textChecked: 0, textUnchecked: 0, textMismatched: 0, textRepaired: 0,
        metadataRepaired: 0, remaining: 0, failures: 0, qualificationHeld: 0, wholeSupplementComplete: false }) + "\n");
      queueMicrotask(() => { child.exitCode = 0; child.emit("exit", 0, null); child.emit("close", 0, null); });
    }
    return child;
  }) };
});

const actual = JSON.parse(gunzipSync(readFileSync(new URL("../../services/yuho-quant/src/biztag/competitors/fixtures/prepare-actual-20261017.json.gz", import.meta.url))).toString());
// 実保存A33の先頭7。来歴crosscheck SHA aa8383ef16ca4a94863f10eae9c6e1a1be7131630424c1332390e92bf8d9e310。
const scope = ["130A", "138A", "145A", "153A", "155A", "166A", "175A"];
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const exitCodeBefore = process.exitCode;
beforeEach(() => {
  vi.clearAllMocks(); harness.state = mkdtempSync(join(tmpdir(), "competitor-stage-"));
  harness.children = []; harness.receiptDelay = 0; harness.autoFirstSuccess = false;
  vi.stubEnv("BIZTAG_COMPETITOR_PREPARE_CODES", undefined);
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("live HTTP forbidden"); }));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); process.exitCode = exitCodeBefore; rmSync(harness.state, { recursive: true, force: true }); });

// ACK envelopeのprotocol検査。実本文を保持するが、外部保管を実行/検証したという証跡ではない。
function packet(plan: ReturnType<typeof planPrepareStage>, bodyChange?: (body: Record<string, unknown>) => void) {
  const body: Record<string, unknown> = { version: "competitor-prepared-input-v1", purpose: "input-preparation-only", targetCodes: plan.codes,
    prepared: plan.codes.map((stockCode, i) => ({ stockCode, status: i === 0 ? "hold" : "prepared", heldCodes: i === 0 ? [stockCode] : [] })),
    holds: [{ stockCode: plan.codes[0], heldCodes: [plan.codes[0]] }], actualNativeFixture: actual, modelCalls: 0, competitorWrites: 0, schemaWrites: 0 };
  bodyChange?.(body);
  const json = JSON.stringify(body), inputSha256 = sha(json), bytes = gzipSync(json), gzipSha256 = sha(bytes);
  const dir = join(plan.outDir, inputSha256), path = join(dir, "input.json.gz"); mkdirSync(dir, { recursive: true }); writeFileSync(path, bytes);
  const summary = { mode: "prepare-only", status: "prepared-input-with-holds", physicalArchiveVerified: true,
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    requested: plan.codes.length, preparedScope: plan.codes.length, notStartedCodes: [], ready: plan.codes.length - 1,
    holds: body.holds as { stockCode: string; heldCodes: string[] }[], inputSha256, gzipSha256, path, bytes: bytes.length,
    archivePageId: "protocol-ack-only", modelCalls: 0, competitorWrites: 0, schemaWrites: 0 };
  writeReceipt(summary);
  return summary;
}
function writeReceipt(summary: ReturnType<typeof packet>): void {
  writeFileSync(join(summary.path, "..", "archive-receipt.json"), JSON.stringify({ ...summary, verifiedAt: new Date().toISOString() }));
}

it("stage unknownは入力SHAが変わっても次巡回を止め、物理ACK後だけ次5件へ進みHOLDを保持する", () => {
  const first = planPrepareStage(scope, harness.state); expect(first.codes).toEqual(scope.slice(0, 5)); startPrepareStage(first);
  expect(() => planPrepareStage(scope, harness.state)).toThrow("自動再送");
  expect(existsSync(first.cursorPath)).toBe(false);
  const summary = packet(first); acceptPrepareStage(first, JSON.stringify(summary), Date.now() + 60_000);
  expect(existsSync(first.pendingPath)).toBe(false); expect(readdirSync(first.outDir).filter(p => p.startsWith("stage-closed-")).length).toBe(1);
  const second = planPrepareStage(scope, harness.state); expect(second.codes).toEqual(scope.slice(5));
  expect(JSON.parse(readFileSync(second.cursorPath, "utf8")).holds).toEqual(summary.holds);
  expect(() => acceptPrepareStage(first, JSON.stringify(summary), Date.now() + 60_000)).toThrow();
  expect(() => planPrepareStage(scope.slice(1), harness.state)).toThrow();
  writeFileSync(second.cursorPath, JSON.stringify({ version: 1, scopeSha256: first.scopeSha256, afterCode: scope.at(-1) }));
  expect(planPrepareStage(scope, harness.state).codes).toEqual(scope.slice(0, 5));
  expect(fetch).not.toHaveBeenCalled();
});

it.each(["body-sha", "targets", "duplicate-hold", "status", "physical-ack", "stale-attempt", "deadline"])("%s不一致ではcursorを進めずpendingを保持する", fault => {
  const plan = planPrepareStage(scope, harness.state); startPrepareStage(plan);
  const summary = packet(plan, fault === "targets" ? b => { b.targetCodes = [...plan.codes].reverse(); } : undefined);
  if (fault === "body-sha") {
    const bytes = gzipSync(JSON.stringify({ ...JSON.parse(gunzipSync(readFileSync(summary.path)).toString()), protocolChanged: true }));
    writeFileSync(summary.path, bytes); summary.gzipSha256 = sha(bytes); summary.bytes = bytes.length; writeReceipt(summary);
  }
  if (fault === "duplicate-hold") { summary.holds.push(summary.holds[0]); summary.ready--; }
  if (fault === "status") summary.status = "prepared-input-only";
  if (fault === "physical-ack") summary.physicalArchiveVerified = false;
  if (fault === "stale-attempt") summary.startedAt = actual.latest[0].doc.submittedAt;
  expect(() => acceptPrepareStage(plan, JSON.stringify(summary), fault === "deadline" ? Date.now() : Date.now() + 60_000)).toThrow();
  expect(existsSync(plan.cursorPath)).toBe(false); expect(existsSync(plan.pendingPath)).toBe(true);
  expect(() => planPrepareStage(scope, harness.state)).toThrow(); expect(fetch).not.toHaveBeenCalled();
});

it("startup receiptの10分も全体30分に含め、期限前に延長せず既存childを止める", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] }); vi.setSystemTime(new Date(actual.latest[0].doc.submittedAt));
  harness.receiptDelay = 10 * 60_000;
  const kill = vi.spyOn(process, "kill").mockImplementation(() => { const child = harness.children.at(-1)!; child.signalCode = "SIGTERM"; child.emit("exit", null, "SIGTERM"); child.emit("close", null, "SIGTERM"); return true; });
  const run = main("run", "biztag"); await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(harness.children).toHaveLength(1); await vi.advanceTimersByTimeAsync(20 * 60_000 - 1); expect(kill).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); await run; expect(kill).toHaveBeenCalledOnce();
  expect(fetch).not.toHaveBeenCalled();
});

it("第二stageは7分SIGTERMでpendingを残し、次runは別入力へ再送せず通常CLI第二childを起動しない", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] }); vi.setSystemTime(new Date(actual.latest[0].doc.submittedAt));
  vi.stubEnv("BIZTAG_COMPETITOR_PREPARE_CODES", scope.join(",")); harness.autoFirstSuccess = true;
  vi.spyOn(process, "kill").mockImplementation(() => { const child = harness.children.at(-1)!; child.signalCode = "SIGTERM"; child.emit("exit", null, "SIGTERM"); child.emit("close", null, "SIGTERM"); return true; });
  const run = main("run", "biztag"); await vi.advanceTimersByTimeAsync(0);
  expect(harness.children).toHaveLength(2); expect(harness.children[1].args).toEqual(expect.arrayContaining(["competitors", "--prepare-only", "--budget-min=6", "--notion-max-rps=0.3"]));
  await vi.advanceTimersByTimeAsync(7 * 60_000); await run;
  expect(existsSync(join(harness.state, "competitor-prepared/stage-pending.json"))).toBe(true);
  expect(existsSync(join(harness.state, "competitor-prepared/cursor.json"))).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  const next = main("run", "biztag").catch(error => error); await vi.runAllTimersAsync();
  expect(await next).toBeInstanceOf(Error); expect(harness.children).toHaveLength(3); expect(fetch).not.toHaveBeenCalled();
});

it.each([30, 31])("startup receiptが%s分ならchildを開始しない", async minutes => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] }); vi.setSystemTime(new Date(actual.latest[0].doc.submittedAt));
  harness.receiptDelay = minutes * 60_000;
  const result = main("run", "biztag").catch(error => error);
  await vi.advanceTimersByTimeAsync(minutes * 60_000);
  expect(await result).toBeInstanceOf(Error); expect(harness.children).toHaveLength(0); expect(fetch).not.toHaveBeenCalled();
});

it("30分ちょうど以降の残時間を0にし、startup分を追加しない", () => {
  const start = actual.latest[0].doc.submittedAt, at = Date.parse(start);
  expect(localJobRemainingMs(start, at + 10 * 60_000)).toBe(20 * 60_000);
  expect(localJobRemainingMs(start, at + 30 * 60_000)).toBe(0); expect(localJobRemainingMs(start, at + 31 * 60_000)).toBe(0);
});
