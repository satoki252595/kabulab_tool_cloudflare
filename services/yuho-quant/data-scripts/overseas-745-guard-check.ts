/**
 * SELECT-proof guard の ACTUAL offline check (tracked)。
 *
 * producer 本体 (./overseas-745-select-proof.ts) の実関数
 * (assertPerDocCounts / createBoundedFetch) を import して呼ぶ。
 * producer guard の削除・改変は本 check に波及する。
 * private pinned snapshot (select-live.json / select-union.json) の読取のみ。
 * 新 GET 0。raw 値の Git 持込 0 (SHA・counts のみ)。
 * stdout は counts/SHA のみ (IDs/値 0)。
 *
 * 実行: pnpm exec tsx services/yuho-quant/data-scripts/overseas-745-guard-check.ts
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  assertPerDocCounts,
  createBoundedFetch,
} from "./overseas-745-select-proof.js";

const DIR = "/tmp/overseas745-select-20260930";
const sha256Hex = (d: Uint8Array | string): string => createHash("sha256").update(d).digest("hex");

function fail(msg: string): never {
  console.error(JSON.stringify({ result: "HOLD", reason: msg }));
  process.exit(1);
}

// 保存済み artifact の pins (select-proof PASS 時の値)。
const liveBytes = readFileSync(`${DIR}/select-live.json`);
if (sha256Hex(liveBytes) !== "4a4cbc049d11e6cc7b617cb298092c85b5feaaf921fbb07ad4c11b253adeb517") {
  fail("select-live pin不一致");
}
const union = (JSON.parse(readFileSync(`${DIR}/select-union.json`).toString("utf8")) as { ids: string[] }).ids;
if (union.length !== 1781) fail("union 件数外");
const chunks: string[][] = [];
for (let i = 0; i < union.length; i += 100) chunks.push(union.slice(i, i + 100));
if (chunks.length !== 18) fail("chunk 数外");

const live = JSON.parse(liveBytes.toString("utf8")) as {
  q1: Array<{ docId: string; factsCount: number }>;
  q2: Array<{ docId: string }>;
};
if (live.q1.length !== 1781 || live.q2.length !== 10257) fail("snapshot 件数外");
const q1map = new Map(live.q1.map((d) => [d.docId, d.factsCount]));

// (a) 実関数へ実データ 18 chunks: 全 pass (throw 即 HOLD)。
for (let ci = 0; ci < chunks.length; ci++) {
  const chunk = chunks[ci] as string[];
  const ids = live.q2.filter((r) => chunk.includes(r.docId)).map((r) => r.docId);
  try {
    assertPerDocCounts(chunk, q1map, ids, `actual-chunk${ci}`);
  } catch (e) {
    fail(`実データで実関数が HOLD: ${(e as Error).message.slice(0, 60)}`);
  }
}

// (b) 同一 chunk 内 2 doc の count 相殺 mutation → actual HOLD。
const c0 = chunks[0] as string[];
const c0ids = live.q2.filter((r) => c0.includes(r.docId)).map((r) => r.docId);
const counts = new Map<string, number>();
for (const id of c0ids) counts.set(id, (counts.get(id) ?? 0) + 1);
const docA = (c0 as string[]).find((d) => (counts.get(d) ?? 0) > 0) as string;
const docB = (c0 as string[]).find((d) => d !== docA) as string;
const mutated = [...c0ids];
(mutated as string[])[mutated.indexOf(docA)] = docB;
let threw = false;
try {
  assertPerDocCounts(c0, q1map, mutated, "actual-mutation");
} catch {
  threw = true;
}
if (!threw) fail("mutation でも実関数が HOLD しない");
// chunk 合計は mutation 前後で不変 (旧合計 check の盲を実証)。
if (c0ids.length !== mutated.length) fail("mutation が chunk 合計を変えた");

// (c) 実 fetch-boundary guard: 37 件目は native 到達 0。
let mockCalls = 0;
const mockNative = (async () => {
  mockCalls += 1;
  return new Response("{}", { status: 200 });
}) as typeof fetch;
const counters = { observed: 0, failed: 0 };
const guarded = createBoundedFetch(mockNative, 36, counters);
const d1url = "https://api.cloudflare.com/client/v4/accounts/T/d1/database/T/query";
const body = JSON.stringify({ sql: "select 1", params: [] });
for (let i = 0; i < 36; i++) {
  await guarded(d1url, { method: "POST", body });
}
let denied = false;
try {
  await guarded(d1url, { method: "POST", body });
} catch {
  denied = true;
}
if (!denied) fail("37 件目が拒否されない");
if (mockCalls !== 36) fail(`拒否分が native 到達: mockCalls=${mockCalls}`);
if (counters.observed !== 36 || counters.failed !== 1) fail("boundary counters 外");
// 非 D1 到達も native 0 で拒否 (別 instance)。
let mockCalls2 = 0;
const mock2 = (async () => {
  mockCalls2 += 1;
  return new Response("{}", { status: 200 });
}) as typeof fetch;
let denied2 = false;
try {
  await createBoundedFetch(mock2, 36, { observed: 0, failed: 0 })("https://example.com/x", { method: "POST", body });
} catch {
  denied2 = true;
}
if (!denied2 || mockCalls2 !== 0) fail("非 D1 拒否の native 到達あり");

console.info(JSON.stringify({
  result: "PASS",
  actualFn: true,
  realChunks: 18,
  realMismatch: 0,
  mutationHold: true,
  chunkTotalsBlind: true,
  guard36pass: true,
  guard37denied: true,
  deniedNativeCalls: 0,
  nonD1deniedNativeCalls: 0,
}));
