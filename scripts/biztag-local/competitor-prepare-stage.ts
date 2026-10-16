/** 既存20時jobの末尾で使う有限stage。競合判断ではなく実入力準備の巡回cursor。 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { parseStockCode } from "../../src/shared/jpx/stock-code.js";

const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const stop = (): never => { throw new Error("競合準備stageのscope/cursor/物理receiptが不正です。自動再送せず停止します"); };
export function planPrepareStage(scope: readonly string[], state: string) {
  const codes = [...scope].sort();
  if (codes.length === 0 || codes.length > 100 || new Set(codes).size !== codes.length || codes.some(c => parseStockCode(c) !== c)) stop();
  const outDir = join(state, "competitor-prepared");
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const pendingPath = join(outDir, "stage-pending.json");
  if (existsSync(pendingPath)) stop(); // 入力SHAが変わっても、未知の前stageを自動再送しない。
  const cursorPath = join(outDir, "cursor.json"), scopeSha256 = sha(JSON.stringify(codes));
  const previous = existsSync(cursorPath) ? readFileSync(cursorPath, "utf8") : null;
  let afterCode: string | null = null;
  if (previous !== null) {
    const p = JSON.parse(previous);
    if (p.version !== 1 || p.scopeSha256 !== scopeSha256 || typeof p.afterCode !== "string" || !codes.includes(p.afterCode)) stop();
    afterCode = p.afterCode;
  }
  // 末尾の次は先頭へ巡回する。同入力skipの社でも毎回cursorを進め、変更を次巡回で確認する。
  const remaining = afterCode === null || afterCode === codes[codes.length - 1] ? codes : codes.filter(c => c > afterCode!);
  const selected = remaining.slice(0, 5);
  return { cursorPath, previous, pendingPath, outDir, scopeSha256, codes: selected,
    args: ["competitors", "--prepare-only", "--judge=semif", `--codes=${selected.join(",")}`, `--limit=${selected.length}`,
      "--budget-min=6", "--notion-max-rps=0.3", `--out=${outDir}`] };
}

/** child起動前に固定scope/cursor/selectedへ束縛した私有markerを永続化する。 */
export function startPrepareStage(plan: ReturnType<typeof planPrepareStage>): void {
  if ((existsSync(plan.cursorPath) ? readFileSync(plan.cursorPath, "utf8") : null) !== plan.previous) stop();
  writeFileSync(plan.pendingPath, JSON.stringify({ version: 1, scopeSha256: plan.scopeSha256,
    previousCursorSha256: plan.previous === null ? null : sha(plan.previous), selected: plan.codes,
    startedAt: new Date().toISOString(), purpose: "input-preparation-only;unknown-blocks-all-next-inputs" }), { mode: 0o600, flag: "wx" });
}

/** CLI正常終了後だけ呼ぶ。HOLDは保存済みの保留分類であり、競合なし/判定完了ではない。 */
export function acceptPrepareStage(plan: ReturnType<typeof planPrepareStage>, stdout: string, deadlineMs: number): void {
  if (!Number.isSafeInteger(deadlineMs) || Date.now() >= deadlineMs) stop();
  const pendingRaw = readFileSync(plan.pendingPath, "utf8"), pending = JSON.parse(pendingRaw);
  if (pending.version !== 1 || pending.scopeSha256 !== plan.scopeSha256 ||
    pending.previousCursorSha256 !== (plan.previous === null ? null : sha(plan.previous)) ||
    JSON.stringify(pending.selected) !== JSON.stringify(plan.codes)) stop();
  const s = JSON.parse(stdout);
  if (typeof pending.startedAt !== "string" || !Number.isFinite(Date.parse(pending.startedAt)) ||
    typeof s.startedAt !== "string" || !Number.isFinite(Date.parse(s.startedAt)) || Date.parse(s.startedAt) < Date.parse(pending.startedAt) ||
    typeof s.finishedAt !== "string" || !Number.isFinite(Date.parse(s.finishedAt)) || Date.parse(s.finishedAt) < Date.parse(s.startedAt) ||
    Date.parse(s.finishedAt) > Date.now()) stop();
  if (s.mode !== "prepare-only" || !["prepared-input-only", "prepared-input-with-holds"].includes(s.status) ||
    s.physicalArchiveVerified !== true || s.requested !== plan.codes.length || s.preparedScope !== plan.codes.length ||
    !Array.isArray(s.notStartedCodes) || s.notStartedCodes.length !== 0 || !Array.isArray(s.holds) ||
    !Number.isSafeInteger(s.ready) || s.ready < 0 || s.ready + s.holds.length !== plan.codes.length ||
    s.holds.some((h: { stockCode?: unknown }) => !plan.codes.includes(String(h.stockCode))) || new Set(s.holds.map((h: { stockCode: string }) => h.stockCode)).size !== s.holds.length ||
    s.modelCalls !== 0 || s.competitorWrites !== 0 || s.schemaWrites !== 0 ||
    typeof s.inputSha256 !== "string" || !/^[0-9a-f]{64}$/.test(s.inputSha256) ||
    typeof s.gzipSha256 !== "string" || !/^[0-9a-f]{64}$/.test(s.gzipSha256)) stop();
  const dir = join(plan.outDir, s.inputSha256), path = join(dir, "input.json.gz");
  if (typeof s.path !== "string" || resolve(s.path) !== resolve(path)) stop();
  const bytes = readFileSync(path), receipt = JSON.parse(readFileSync(join(dir, "archive-receipt.json"), "utf8"));
  if (bytes.length !== s.bytes || sha(bytes) !== s.gzipSha256 || receipt.inputSha256 !== s.inputSha256 ||
    receipt.gzipSha256 !== s.gzipSha256 || receipt.archivePageId !== s.archivePageId || receipt.bytes !== s.bytes ||
    !Number.isFinite(Date.parse(receipt.verifiedAt)) || receipt.modelCalls !== 0 || receipt.competitorWrites !== 0 || receipt.schemaWrites !== 0) stop();
  const json = gunzipSync(bytes);
  if (sha(json) !== s.inputSha256) stop();
  const manifest = JSON.parse(json.toString("utf8"));
  if (manifest.version !== "competitor-prepared-input-v1" || manifest.purpose !== "input-preparation-only" ||
    JSON.stringify(manifest.targetCodes) !== JSON.stringify(plan.codes) || !Array.isArray(manifest.prepared) ||
    JSON.stringify(manifest.prepared.map((p: { stockCode: string }) => p.stockCode)) !== JSON.stringify(plan.codes) ||
    manifest.prepared.some((p: { status: string }) => !["prepared", "hold"].includes(p.status)) ||
    manifest.modelCalls !== 0 || manifest.competitorWrites !== 0 || manifest.schemaWrites !== 0) stop();
  const held = manifest.prepared.filter((p: { status: string }) => p.status === "hold");
  const holdKeys = (items: { stockCode: string; heldCodes: string[] }[]) => items.map(h => [h.stockCode, h.heldCodes]);
  if (!Array.isArray(manifest.holds) || held.some((p: { heldCodes: unknown }) => !Array.isArray(p.heldCodes)) ||
    JSON.stringify(holdKeys(held)) !== JSON.stringify(holdKeys(manifest.holds)) ||
    JSON.stringify(holdKeys(held)) !== JSON.stringify(holdKeys(s.holds)) || s.ready !== manifest.prepared.length - held.length ||
    s.status !== (held.length === 0 ? "prepared-input-only" : "prepared-input-with-holds")) stop();
  // 同時起動/手動編集があれば既存cursorを上書きしない。
  if ((existsSync(plan.cursorPath) ? readFileSync(plan.cursorPath, "utf8") : null) !== plan.previous) stop();
  if (Date.now() >= deadlineMs) stop();
  const pendingSha256 = sha(pendingRaw), closure = join(plan.outDir, `stage-closed-${pendingSha256}.json`);
  writeFileSync(closure, JSON.stringify({ pending, pendingSha256, inputSha256: s.inputSha256, gzipSha256: s.gzipSha256,
    archivePageId: s.archivePageId, firstArchiveVerifiedAt: receipt.verifiedAt, attemptStartedAt: s.startedAt, attemptFinishedAt: s.finishedAt,
    holds: s.holds }), { mode: 0o600, flag: "wx" });
  const next = `${plan.cursorPath}.${process.pid}.next`;
  if (Date.now() >= deadlineMs) stop();
  writeFileSync(next, JSON.stringify({ version: 1, scopeSha256: plan.scopeSha256, afterCode: plan.codes[plan.codes.length - 1],
    preparedScope: plan.codes, inputSha256: s.inputSha256, gzipSha256: s.gzipSha256,
    archivePageId: s.archivePageId, firstArchiveVerifiedAt: receipt.verifiedAt, attemptStartedAt: s.startedAt, attemptFinishedAt: s.finishedAt,
    holds: s.holds, stagePendingSha256: pendingSha256,
    purpose: "input-preparation-only;not-a-competitor-decision" }), { mode: 0o600, flag: "wx" });
  renameSync(next, plan.cursorPath);
  unlinkSync(plan.pendingPath); // この順序ならcursor直後にkillされてもpendingが残って安全側にSTOPする。
}
