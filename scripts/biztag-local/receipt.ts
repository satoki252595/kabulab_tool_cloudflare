/** Mac処理の実行事実と、実CLIが測定した補足検査の件数をR2へ写す。 */
import { z } from "../../src/shared/zod-mini.js";
import policy from "../../src/shared/local-job-receipt.json";
import type { r2GetVersion, r2Put } from "../vwap/lib/r2.js";
import { sharedEnv } from "../../src/shared/env.js";
import { readFileSync, writeFileSync } from "node:fs";

export type LocalJobKind = keyof typeof policy.jobs;
export const LOCAL_JOB_HOURS = policy.jobs;
export const BIZTAG_DATA_PREFIX = "[biztag-field-coverage] ";
const Count = z.number().check(z.int(), z.nonnegative());
const BiztagData = z.strictObject({
  scope: z.enum(["explicit_codes", "daily_window"]),
  status: z.enum(["checked_scope_complete", "partial", "attention"]),
  totalStocks: Count, selectedForTextCheck: Count, textChecked: Count, textUnchecked: Count,
  textMismatched: Count, textRepaired: Count, metadataRepaired: Count,
  remaining: Count, failures: Count, qualificationHeld: Count, wholeSupplementComplete: z.literal(false),
});
export type BiztagDataStatus = z.infer<typeof BiztagData>;
/** stdoutの専用行だけを受理する。本文・エラー原文や終了codeから件数を推測しない。 */
export function readBiztagDataStatus(log: string): BiztagDataStatus {
  const lines = log.split("\n").filter(line => line.startsWith(BIZTAG_DATA_PREFIX));
  if (lines.length !== 1) throw new Error("補足の実測summaryが欠落・重複しています");
  let value: unknown;
  try { value = JSON.parse(lines[0].slice(BIZTAG_DATA_PREFIX.length)); }
  catch { throw new Error("補足の実測summaryのJSONが不正です"); }
  const data = BiztagData.parse(value);
  if (data.textChecked + data.textUnchecked !== data.selectedForTextCheck ||
      (data.scope === "daily_window" && data.selectedForTextCheck > data.totalStocks) || data.textMismatched > data.textChecked ||
      data.textRepaired > data.textMismatched || data.metadataRepaired > data.totalStocks) {
    throw new Error("補足の実測summaryの件数が矛盾しています");
  }
  return data;
}
const Receipt = z.strictObject({
  version: z.literal(1), kind: z.enum(["biztag", "yutai-summary"]), phase: z.enum(["running", "finished"]),
  scheduledFor: z.iso.datetime(), startedAt: z.iso.datetime(), finishedAt: z.nullable(z.iso.datetime()),
  revision: z.string().check(z.regex(/^[0-9a-f]{40}$/)), acceptedRevision: z.string().check(z.regex(/^[0-9a-f]{40}$/)),
  code: z.nullable(z.number().check(z.int())), signal: z.nullable(z.string().check(z.regex(/^SIG[A-Z0-9]+$/))),
  retries: z.literal(0),
  biztagData: z.optional(BiztagData),
});
export type LocalJobReceipt = z.infer<typeof Receipt>;

/** JSTの日次予定のうち、実開始より後ではない直近時刻。遅いRunAtLoadも遅配のまま記録する。 */
export function localJobScheduledFor(kind: LocalJobKind, at: string): string {
  const moment = Date.parse(at);
  if (!Number.isFinite(moment)) throw new Error("ローカル処理の時計が不正です");
  const day = new Date(moment + 9 * 3600_000).toISOString().slice(0, 10);
  let scheduled = Date.parse(`${day}T${String(policy.jobs[kind].localHour - 9).padStart(2, "0")}:00:00.000Z`);
  if (scheduled > moment) scheduled -= 24 * 3600_000;
  return new Date(scheduled).toISOString();
}

/** strict schemaだけを受け付け、実行済み・成功・時計を補完しない。 */
export function parseLocalJobReceipt(value: unknown): LocalJobReceipt {
  const receipt = Receipt.parse(value);
  if (receipt.scheduledFor !== localJobScheduledFor(receipt.kind, receipt.startedAt) ||
      (receipt.phase === "running" ? receipt.finishedAt !== null || receipt.code !== null || receipt.signal !== null
        : receipt.finishedAt === null || Date.parse(receipt.finishedAt) < Date.parse(receipt.startedAt)) ||
      (receipt.code !== null && receipt.signal !== null) ||
      (receipt.biztagData !== undefined && (receipt.kind !== "biztag" || receipt.phase !== "finished"))) {
    throw new Error("ローカル実行receiptの時計・終了状態が不正です");
  }
  if (receipt.biztagData !== undefined) readBiztagDataStatus(BIZTAG_DATA_PREFIX + JSON.stringify(receipt.biztagData));
  return receipt;
}

const keyOf = (kind: LocalJobKind) => `local-jobs/${kind}/latest.json`;
type MirrorIo = {
  get: typeof r2GetVersion;
  put: typeof r2Put;
};
async function remote(): Promise<MirrorIo> {
  if (sharedEnv.LOCAL_OUT() !== undefined) throw new Error("Mac receipt監視はLOCAL_OUTを本番R2の代用にできません");
  // preflightの.env読取後にR2設定を確定する。import時のpreview設定を持ち越さない。
  const r2 = await import("../vwap/lib/r2.js");
  return { get: key => r2.r2GetVersion(key, { maxBytes: 16384, abortSignal: AbortSignal.timeout(60_000) }), put: r2.r2Put };
}

/** 1PUTのCASと全文readback。競合・結果不明・差分で停止し、PUTを再送しない。 */
export async function mirrorLocalJobReceipt(receipt: LocalJobReceipt, etag: string | null, io?: MirrorIo): Promise<string> {
  const target = io === undefined ? await remote() : io;
  const checked = parseLocalJobReceipt(receipt);
  const body = JSON.stringify(checked), key = keyOf(checked.kind);
  await target.put(key, body, etag);
  const readback = await target.get(key);
  if (readback === null || readback.body !== body) throw new Error("ローカル処理receiptのR2全文照合に失敗しました（再送しません）");
  parseLocalJobReceipt(JSON.parse(readback.body));
  return readback.etag;
}

/** 先行版をGETして開始をCAS保存する。previewを本番mirrorと誤認しない。 */
export async function startLocalJobReceipt(receipt: LocalJobReceipt, io?: MirrorIo, previousIncompletePath?: string): Promise<string> {
  if (sharedEnv.LOCAL_OUT() !== undefined) throw new Error("Mac receipt監視はLOCAL_OUTを本番R2の代用にできません");
  const target = io === undefined ? await remote() : io;
  const checked = parseLocalJobReceipt(receipt);
  if (checked.phase !== "running") throw new Error("開始receiptが必要です");
  const previous = await target.get(keyOf(checked.kind));
  if (previous !== null) {
    let old: LocalJobReceipt;
    try { old = parseLocalJobReceipt(JSON.parse(previous.body)); }
    catch { throw new Error("先行Mac receiptのJSON/契約が不正です（内容を公開せず停止）"); }
    if (old.kind !== checked.kind || Date.parse(old.startedAt) >= Date.parse(checked.startedAt)) throw new Error("Mac receiptの時刻後退・job混在で停止します");
    if (old.phase === "running") {
      if (old.scheduledFor === checked.scheduledFor) throw new Error("同一job・同一予定の開始receiptが未完です。先行runを置換せず停止します");
      if (previousIncompletePath === undefined) throw new Error("前slotの未完receiptを保全する保存先がありません");
      writeFileSync(previousIncompletePath, previous.body, { mode: 0o600, flag: "wx" });
      if (readFileSync(previousIncompletePath, "utf8") !== previous.body) throw new Error("前slotの未完receiptの私有保全を照合できません");
      console.warn(JSON.stringify({ status: "previous_incomplete", kind: old.kind, scheduledFor: old.scheduledFor, startedAt: old.startedAt }));
    }
  }
  return mirrorLocalJobReceipt(checked, previous === null ? null : previous.etag, target);
}
