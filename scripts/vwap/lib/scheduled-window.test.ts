import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertVwapAdmission, assertVwapContinuation, scheduledVwapWindow } from "../../../src/shared/vwap-schedule.js";
import { scheduledVwapGuard } from "./scheduled-window.js";

afterEach(() => vi.useRealTimers());
const date = "2026-10-14";
const start = Date.parse(`${date}T08:00:00.000Z`);

describe("VWAP定時窓と同run受付時計", () => {
  it.each(["2026-10-12", date, "2026-10-16"])("月水金 %s を17時から23:30に固定する", (day) => {
    const window = scheduledVwapWindow(day);
    expect(window.completionCutoff - window.start).toBe(390 * 60_000);
    expect(window.admissionCutoff - window.start).toBe(10 * 60_000);
  });
  it.each(["", "2026-10-13", "2026-10-15", "2026-10-17", "2026-02-30", "2026-10-14T00:00:00Z"])("不正な予定日 %s を拒否", (day) => {
    expect(() => scheduledVwapWindow(day)).toThrow("plannedDate");
  });
  it.each([start - 1, start + 600_001, start + 26_400_000, NaN])("遅配/早発/不正時計 %s は受付しない", (nowMs) => {
    expect(() => assertVwapAdmission(date, nowMs)).toThrow("開始期限");
  });
  it("受付端と終了直前は許可し、原時計を更新せず次run/日/終了端以降を拒否する", () => {
    const directory = mkdtempSync(join(tmpdir(), "vwap-window-"));
    const input = { plannedDate: date, runId: "38570657322.1", directory };
    const admitted = scheduledVwapGuard({ ...input, phase: "daily", nowMs: start + 600_000 });
    const file = join(directory, readdirSync(directory)[0]);
    const before = readFileSync(file, "utf8");
    const continued = scheduledVwapGuard({ ...input, phase: "intra", nowMs: start + 390 * 60_000 - 1 });
    expect(continued.admission).toEqual(admitted.admission);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(() => scheduledVwapGuard({ ...input, phase: "daily", nowMs: start + 600_000 })).toThrow();
    for (const nowMs of [start + 390 * 60_000, start + 390 * 60_000 + 1]) {
      expect(() => scheduledVwapGuard({ ...input, phase: "intra", nowMs })).toThrow("完了期限");
    }
    expect(() => scheduledVwapGuard({ ...input, runId: "38570657322.2", phase: "intra", nowMs: start + 60_000 })).toThrow();
    expect(() => scheduledVwapGuard({ ...input, plannedDate: "2026-10-16", phase: "intra", nowMs: start + 60_000 })).toThrow("一致");
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(start + 390 * 60_000 + 1));
    expect(() => continued.assertActive()).toThrow("完了期限");
  });
  it.each(["invalid", "2026-10-14T08:00:00Z", "2026-10-14T07:59:59.999Z"])("不正な元admission %s を継承しない", (admittedAt) => {
    expect(() => assertVwapContinuation(date, admittedAt, start + 60_000)).toThrow();
  });
  it("破損/未知field/他runの記録と欠測を黙って受付しない", () => {
    const directory = mkdtempSync(join(tmpdir(), "vwap-window-"));
    const input = { plannedDate: date, runId: "101.1", directory, phase: "intra" as const, nowMs: start };
    expect(() => scheduledVwapGuard(input)).toThrow();
    for (const raw of ["null", "[]", "not-json", JSON.stringify({ version: 1, runId: "101.2", plannedDate: date, admittedAt: new Date(start).toISOString() }),
      JSON.stringify({ version: 1, runId: "101.1", plannedDate: date, admittedAt: new Date(start).toISOString(), extra: true })]) {
      writeFileSync(join(directory, "vwap-scheduled-admission-101.1.json"), raw);
      expect(() => scheduledVwapGuard(input)).toThrow();
    }
  });
  it("明示手動実行は定時記録を作らず既存動作を維持する", () => {
    const directory = mkdtempSync(join(tmpdir(), "vwap-window-"));
    const guard = scheduledVwapGuard({ plannedDate: undefined, runId: "local-unchanged", directory, phase: "intra" });
    expect(guard.admission).toBeNull(); guard.assertActive();
    expect(readdirSync(directory)).toEqual([]);
  });
  it("明示した手動intraの予算だけを固定し、期限ちょうどと不正/定時併用を拒否する", () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(start);
    const input = { plannedDate: undefined, runId: "local-finite", phase: "intra" as const, maxStartSeconds: "900" };
    const guard = scheduledVwapGuard(input);
    expect(guard.startBudget).toEqual({ startedAt: new Date(start).toISOString(), deadline: new Date(start + 900_000).toISOString(), seconds: 900 });
    vi.setSystemTime(start + 899_999); guard.assertActive();
    vi.setSystemTime(start + 900_000); expect(() => guard.assertActive()).toThrow("開始期限");
    vi.setSystemTime(start - 1); expect(() => guard.assertActive()).toThrow("開始期限");
    for (const maxStartSeconds of ["", "0", "901", "-1", "1.5", "01", "NaN"]) {
      expect(() => scheduledVwapGuard({ ...input, maxStartSeconds })).toThrow("整数秒");
    }
    expect(() => scheduledVwapGuard({ ...input, plannedDate: date })).toThrow();
    expect(() => scheduledVwapGuard({ ...input, phase: "daily" })).toThrow();
  });
});
