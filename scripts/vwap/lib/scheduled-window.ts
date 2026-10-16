import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertVwapAdmission, assertVwapContinuation } from "../../../src/shared/vwap-schedule.js";

interface Admission {
  version: 1;
  runId: string;
  plannedDate: string;
  admittedAt: string;
}

/** 日足が受付時計を1回保存し、同runの5分足だけがその時計を継承する。外部通信なし。 */
export function scheduledVwapGuard(options: {
  plannedDate: string | undefined; runId: string; phase: "daily" | "intra";
  nowMs?: number; directory?: string; maxStartSeconds?: string;
}): { admission: Admission | null; startBudget?: { startedAt: string; deadline: string; seconds: number }; assertActive(): void } {
  const nowMs = options.nowMs === undefined ? Date.now() : options.nowMs;
  if (options.maxStartSeconds !== undefined) {
    if (options.plannedDate !== undefined || options.phase !== "intra" ||
        !/^[1-9]\d{0,2}$/.test(options.maxStartSeconds) || Number(options.maxStartSeconds) > 900) {
      throw new Error("有限5分足の新規開始予算は手動intra専用の1〜900整数秒です");
    }
    const seconds = Number(options.maxStartSeconds), deadline = nowMs + seconds * 1000;
    return { admission: null, startBudget: { startedAt: new Date(nowMs).toISOString(), deadline: new Date(deadline).toISOString(), seconds },
      assertActive() {
        const now = Date.now();
        if (now < nowMs || now >= deadline) throw new Error("有限5分足の新規開始期限外です");
      } };
  }
  if (options.plannedDate === undefined) return { admission: null, assertActive() {} };
  if (!/^\d+(?:\.\d+)?$/.test(options.runId)) throw new Error("定時VWAPは同Actions run IDが必要です");
  const dir = options.directory === undefined ? join(process.cwd(), ".vwap-summaries") : options.directory;
  const path = join(dir, `vwap-scheduled-admission-${options.runId}.json`);
  let admission: Admission;
  if (options.phase === "daily") {
    // 遅配はファイル作成・D1・R2・Yahooのすべてより先に停止。
    assertVwapAdmission(options.plannedDate, nowMs);
    admission = { version: 1, runId: options.runId, plannedDate: options.plannedDate,
      admittedAt: new Date(nowMs).toISOString() };
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(admission), { flag: "wx", mode: 0o600, flush: true });
  } else {
    if (statSync(path).size > 2048) throw new Error("VWAP admissionのサイズが不正です");
    const stored = JSON.parse(readFileSync(path, "utf8")) as Admission;
    if (stored === null || stored.version !== 1 || stored.runId !== options.runId ||
        stored.plannedDate !== options.plannedDate || typeof stored.admittedAt !== "string" ||
        Object.keys(stored).sort().join(",") !== "admittedAt,plannedDate,runId,version") {
      throw new Error("VWAP admissionが同run/予定日と一致しません");
    }
    admission = stored;
  }
  assertVwapContinuation(admission.plannedDate, admission.admittedAt, nowMs);
  return { admission, assertActive() {
    assertVwapContinuation(admission.plannedDate, admission.admittedAt, Date.now());
  } };
}
