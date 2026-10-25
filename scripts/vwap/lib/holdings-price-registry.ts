/** Activate fully accounted ordinary runs. Source HOLDs remain excluded; raw bodies stay in Notion. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { z } from "zod";
import { r2GetVersion, r2Put, type R2ReadOptions } from "./r2.js";
import { priceActiveSchema, priceSnapshotSchema, PRICE_ACTIVE_KEY, type PriceReference, type PriceSnapshot } from "../../../src/shared/holdings/price-registry.js";
import type { IngestCodeOutcome } from "./ingest-guard.js";
import { resolveLatestHoldingsCodeList } from "../../sync/holdings-code-list.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const ACTIVATION_KEY = "ops/holdings-price/activation.json";
const stateSchema = z.object({ version: z.literal(1), phase: z.enum(["inflight", "complete"]),
  snapshotId: z.string(), registryKey: z.string(), registrySha256: z.string().regex(/^[a-f0-9]{64}$/),
  beforeActiveSha256: z.string().regex(/^[a-f0-9]{64}$/), at: z.string().datetime(),
}).strict();
const get = (key: string, maxBytes: number, ioOptions?: Pick<R2ReadOptions, "abortSignal" | "beforeAttempt">) =>
  r2GetVersion(key, { singleAttempt: true, maxBytes, ...ioOptions });

async function readActive(ioOptions?: Pick<R2ReadOptions, "abortSignal" | "beforeAttempt">) {
  const state = await get(ACTIVATION_KEY, 4096, ioOptions);
  const receipt = state === null ? null : stateSchema.parse(JSON.parse(state.body));
  if (receipt !== null) assert.equal(receipt.phase, "complete", "価格snapshotの前回activationが結果未確定です。再送せず照合してください");
  const active = await get(PRICE_ACTIVE_KEY, 4096, ioOptions);
  if (receipt !== null) assert.ok(active, "価格snapshotの完了receiptとactiveが一致しません");
  if (active === null) return { state, active, snapshot: null };
  const pointer = priceActiveSchema.parse(JSON.parse(active.body));
  if (receipt !== null) {
    assert.equal(receipt.snapshotId, pointer.snapshotId); assert.equal(receipt.registryKey, pointer.registryKey);
    assert.equal(receipt.registrySha256, pointer.registrySha256); assert.equal(receipt.at, pointer.activatedAt);
  }
  const registry = await get(pointer.registryKey, 8 * 1024 * 1024, ioOptions);
  assert.ok(registry && hash(registry.body) === pointer.registrySha256, "価格snapshotの全文SHAが不一致です");
  const snapshot = priceSnapshotSchema.parse(JSON.parse(registry.body));
  assert.equal(snapshot.snapshotId, pointer.snapshotId);
  assert.equal(pointer.registryKey, `ops/holdings-price/snapshot-${pointer.snapshotId}-${pointer.registrySha256}.json`);
  return { state, active, snapshot };
}

/** Read-only; pending activation blocks use rather than selecting a different snapshot. */
export async function readActivatedPriceSnapshot(): Promise<PriceSnapshot | null> {
  return (await readActive()).snapshot;
}

/** Explicit first activation only. Fresh whole-file qualification must finish before metadata writes. */
export async function bootstrapPriceSnapshot(snapshot: PriceSnapshot, verifyFreshSources: () => Promise<void>): Promise<void> {
  const fixed = priceSnapshotSchema.parse(snapshot);
  assert.equal(fixed.snapshotId, "37202207552.1"); assert.equal(fixed.sessionDate, "2026-10-02");
  assert.equal(Object.keys(fixed.members).length, 3456);
  assert.equal(new Set(Object.values(fixed.members).map(ref => `${ref.file.archivePageId}/${ref.file.filename}/${ref.file.sha256}`)).size, 116);
  assert.ok(Object.values(fixed.members).every(ref => ref.receivedAt >= "2026-10-04T12:28:34.484Z" && ref.receivedAt <= "2026-10-04T13:53:00.889Z"));
  for (const key of [ACTIVATION_KEY, PRICE_ACTIVE_KEY]) assert.equal(await get(key, 4096), null, "初回価格activationの既存状態があり再送/上書きしません");
  await verifyFreshSources();
  // Qualification can take minutes; re-read both guards immediately before the sole intent CAS.
  for (const key of [ACTIVATION_KEY, PRICE_ACTIVE_KEY]) assert.equal(await get(key, 4096), null, "初回価格activationの状態が変化しました");
  const body = JSON.stringify(fixed), digest = hash(body), registryKey = `ops/holdings-price/snapshot-${fixed.snapshotId}-${digest}.json`;
  const state = { version: 1, phase: "inflight", snapshotId: fixed.snapshotId, registryKey, registrySha256: digest,
    beforeActiveSha256: hash("null"), at: new Date().toISOString() };
  const intentBody = JSON.stringify(state);
  await r2Put(ACTIVATION_KEY, intentBody, null);
  const intent = await get(ACTIVATION_KEY, 4096); assert.ok(intent); assert.equal(intent.body, intentBody);
  const existing = await get(registryKey, 8 * 1024 * 1024);
  if (existing !== null) assert.equal(existing.body, body, "初回価格manifestが不一致です。上書きしません");
  else { await r2Put(registryKey, body, null); assert.equal((await get(registryKey, 8 * 1024 * 1024))?.body, body); }
  const activeBody = JSON.stringify(priceActiveSchema.parse({ version: 1, snapshotId: fixed.snapshotId, registryKey,
    registrySha256: digest, activatedAt: state.at }));
  await r2Put(PRICE_ACTIVE_KEY, activeBody, null);
  assert.equal((await get(PRICE_ACTIVE_KEY, 4096))?.body, activeBody);
  const completeBody = JSON.stringify({ ...state, phase: "complete" });
  await r2Put(ACTIVATION_KEY, completeBody, intent.etag);
  assert.equal((await get(ACTIVATION_KEY, 4096))?.body, completeBody);
}

/** Every mutation is single-attempt CAS with complete readback. Inflight remains on unknown. */
export async function publishDailyPriceSnapshot(args: {
  runId: string; sessionDate: string; finishedAt: string; universe: readonly string[];
  codes: readonly string[]; references: ReadonlyMap<string, PriceReference>; complete: boolean;
  outcomes?: Readonly<Record<string, IngestCodeOutcome>>;
  beforeMutation?: () => void;
  ioOptions?: Pick<R2ReadOptions, "abortSignal" | "beforeAttempt">;
}): Promise<{ status: "activated" | "unchanged" } | { status: "held"; reason: string }> {
  if (!args.complete || JSON.stringify([...args.codes].sort()) !== JSON.stringify([...args.universe].sort())) {
    return { status: "held", reason: "通常全母集団の受入が未完了です。旧価格snapshotを維持します" };
  }
  if (new Set(args.codes).size !== args.codes.length) return { status: "held", reason: "通常日足の母集団が重複しています" };
  const outcomes = args.outcomes;
  if (outcomes !== undefined && (JSON.stringify(Object.keys(outcomes).sort()) !== JSON.stringify([...args.codes].sort()) ||
    Object.values(outcomes).some(value => !["written", "skipped", "empty", "error"].includes(value.status)))) {
    return { status: "held", reason: "通常日足に未着手・結果未確定・未accounted対象があります。旧価格snapshotを維持します" };
  }
  const eligible = outcomes === undefined ? args.codes : args.codes.filter(code => outcomes[code].status === "written" || outcomes[code].status === "skipped");
  if (eligible.length === 0 || eligible.some(code => !args.references.has(code))) {
    return { status: "held", reason: "資格済日足の物理原本参照がありません。旧価格snapshotを維持します" };
  }
  const coverage = outcomes === undefined ? undefined : { outcomes: Object.fromEntries([...args.codes].sort().map(code => [code, outcomes[code].status === "written" || outcomes[code].status === "skipped" ? "accepted" : outcomes[code].status])) };
  const before = await readActive(args.ioOptions);
  if (before.active === null || before.snapshot === null) return { status: "held", reason: "初期snapshotのfresh物理受入・有効化が未実施です" };
  assert.ok(args.sessionDate >= before.snapshot.sessionDate, "価格snapshotの対象sessionが後退しています");
  const codeList = await resolveLatestHoldingsCodeList(before.snapshot.codeList, args.finishedAt);
  if (codeList.status === "held") return codeList;
  const members = Object.fromEntries([...eligible].sort().map(code => [`${code}.T`, args.references.get(code)!]));
  const snapshot = priceSnapshotSchema.parse({ version: 1, snapshotId: args.runId, sessionDate: args.sessionDate,
    createdAt: args.finishedAt, codeList: codeList.file, members, ...(coverage === undefined ? {} : { coverage }) });
  assert.ok(Object.values(snapshot.members).every(ref => Date.parse(ref.receivedAt) <= Date.parse(args.finishedAt)), "価格原本の実時計がrun完了後です");
  const evidence = (s: PriceSnapshot) => JSON.stringify({ sessionDate: s.sessionDate, codeList: s.codeList, members: s.members, ...(s.coverage === undefined ? {} : { coverage: s.coverage }) });
  if (evidence(snapshot) === evidence(before.snapshot)) return { status: "unchanged" };
  const body = JSON.stringify(snapshot), digest = hash(body), registryKey = `ops/holdings-price/snapshot-${args.runId}-${digest}.json`;
  const existing = await get(registryKey, 8 * 1024 * 1024, args.ioOptions);
  if (existing !== null) assert.equal(existing.body, body, "価格registryの既存bytesが一致しません。上書きしません");
  else { args.beforeMutation?.(); await r2Put(registryKey, body, null, undefined, args.ioOptions); const actual = await get(registryKey, 8 * 1024 * 1024, args.ioOptions); assert.equal(actual?.body, body); }
  const state = { version: 1 as const, phase: "inflight" as const, snapshotId: args.runId, registryKey,
    registrySha256: digest, beforeActiveSha256: hash(before.active.body), at: args.finishedAt };
  const intentBody = JSON.stringify(state);
  args.beforeMutation?.();
  await r2Put(ACTIVATION_KEY, intentBody, before.state?.etag ?? null, undefined, args.ioOptions);
  const intent = await get(ACTIVATION_KEY, 4096, args.ioOptions); assert.ok(intent); assert.equal(intent.body, intentBody);
  const active = priceActiveSchema.parse({ version: 1, snapshotId: args.runId, registryKey, registrySha256: digest, activatedAt: args.finishedAt });
  const activeBody = JSON.stringify(active);
  args.beforeMutation?.();
  await r2Put(PRICE_ACTIVE_KEY, activeBody, before.active.etag, undefined, args.ioOptions);
  const activated = await get(PRICE_ACTIVE_KEY, 4096, args.ioOptions); assert.equal(activated?.body, activeBody);
  const completedBody = JSON.stringify({ ...state, phase: "complete" });
  // activeは既知ACK＋全文readback済み。native終了前の5分枠で受領記録だけ閉じ、CLIの期限失敗を保持する。
  await r2Put(ACTIVATION_KEY, completedBody, intent.etag);
  assert.equal((await get(ACTIVATION_KEY, 4096))?.body, completedBody);
  return { status: "activated" };
}
