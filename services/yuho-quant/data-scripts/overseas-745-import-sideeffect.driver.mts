/**
 * 745 select-proof の import 副作用 regression 用 child driver (offline)。
 * 呼び出し側のfetch を置き換えないこと + 旧 tree の ban 署名 +
 * 直接 CLI の read-only guard 維持を、実現象ベースで検証する。
 * 全 phase で実 forward 0 (stub は数えて throw する)。
 *
 * - `importer`: stub fetch → merged adapter import → fetch 同一性 +
 *   caller guard intact + 旧 import 相当の manual install で
 *   frozen batch / Notion search の ban 署名を再現する。
 * - `cli <tmpout>`: argv[1] を 745 にして import (直接 CLI 相当) →
 *   guard 設置 + main() は env 不在 HOLD (送信 0) → exit 1 を
 *   ExitError として回収し、設置後 guard の ban を検証する。
 */
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

const fail = (why: string): never => {
  console.error(`DRIVER-FAIL: ${why}`);
  process.exit(1);
};
const eq = (a: unknown, b: unknown, what: string): void => {
  if (a !== b) fail(`${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
};

const D1_URL = "https://api.cloudflare.com/client/v4/accounts/ACCT/d1/database/DB/query";
const NOTION_SEARCH = "https://api.notion.com/v1/search";
// 原本 receipt (price40 ONE live, local 0600 証拠保持) の abortReason。
const RECEIPT_ABORT = "chunk-0:SELECT proof: batch envelope 禁止 (単発 SELECT のみ)";

let forwards = 0;
const stub = (async () => {
  forwards += 1;
  throw new Error("must-not-forward");
}) as typeof fetch;

async function throwsExact(p: Promise<unknown>, want: string, what: string): Promise<void> {
  try {
    await p;
  } catch (e) {
    eq((e as Error).message, want, what);
    return;
  }
  fail(`${what}: throw しない`);
}

async function importerPhase(): Promise<void> {
  globalThis.fetch = stub;
  const before = forwards;
  await import("../../../scripts/sync/price40-cas-execute.js");
  if (globalThis.fetch !== stub) fail("adapter import が fetch を置き換えた");
  eq(forwards, before, "import 時 forward");
  // caller guard intact: 呼び出し側 wrapper が素通しできる。
  const seen: string[] = [];
  const wrapper = (async (u: unknown, i?: RequestInit) => {
    seen.push(String(u));
    return stub(String(u), i);
  }) as typeof fetch;
  globalThis.fetch = wrapper;
  await wrapper(D1_URL, { method: "POST", body: "{}" }).then(
    () => fail("wrapper 素通し"),
    () => {}
  );
  await wrapper(NOTION_SEARCH, { method: "POST", body: "{}" }).then(
    () => fail("wrapper 素通し"),
    () => {}
  );
  eq(seen.length, 2, "caller wrapper 到達");
  eq(forwards, before + 2, "caller wrapper forward");
  // 旧 tree 署名: 旧 import 相当 (= 本関数を global に置く) の ban を再現。
  const mod = await import("./overseas-745-select-proof.js");
  if (globalThis.fetch !== wrapper) fail("745 import が fetch を置き換えた");
  const guarded = mod.createBoundedFetch(stub, 36, { observed: 0, failed: 0 });
  const frozen = await frozenBatchBody();
  const atBan = forwards;
  await throwsExact(
    guarded(D1_URL, { method: "POST", body: JSON.stringify({ batch: frozen }) }),
    "SELECT proof: batch envelope 禁止 (単発 SELECT のみ)",
    "frozen batch ban"
  );
  await throwsExact(
    guarded(NOTION_SEARCH, { method: "POST", body: "{}" }),
    `SELECT proof: D1 query 以外への到達を拒否: ${NOTION_SEARCH}`,
    "notion search ban"
  );
  eq(forwards, atBan, "ban は forward 前");
  eq(`chunk-0:SELECT proof: batch envelope 禁止 (単発 SELECT のみ)`, RECEIPT_ABORT, "receipt abortReason 一致");
  console.info("IMPORTER-OK identity-kept caller-intact batch-ban search-ban forward0");
}

/** 既存 builders による frozen 形 batch 本体 (pure。fixture 由来のみ)。 */
async function frozenBatchBody(): Promise<unknown[]> {
  const mod = await import("../../../src/shared/repair-preflight.js");
  const rows = [1, 2].map((n) => ({
    stockId: 1000 + n,
    code: `100${n}`,
    date: "2026-09-29",
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 10,
    adj: 100,
  }));
  return [mod.buildOhlcvInsertStatement(rows)];
}

async function cliPhase(tmpOut: string): Promise<void> {
  globalThis.fetch = stub;
  const codes = { exit: -1 };
  (process as unknown as { exit: (c: number) => never }).exit = ((c: number): never => {
    codes.exit = c;
    throw new Error(`ExitError:${c}`);
  }) as never;
  const proofPath = realpathSync(new URL("./overseas-745-select-proof.ts", import.meta.url));
  process.argv = [process.argv[0], proofPath, `--out-dir=${tmpOut}`, "--env-file=/nonexistent-745-regression-env"];
  const before = forwards;
  try {
    await import(pathToFileURL(proofPath).href);
  } catch (e) {
    eq((e as Error).message, "ExitError:1", "直接 CLI は env 不在 HOLD exit 1");
  }
  if (codes.exit !== 1) fail("直接 CLI の exit 1 なし");
  if (globalThis.fetch === stub) fail("直接 CLI で guard 未設置");
  eq(forwards, before, "直接 CLI の main 前 forward");
  const frozen = await frozenBatchBody();
  await throwsExact(
    globalThis.fetch(D1_URL, { method: "POST", body: JSON.stringify({ batch: frozen }) }),
    "SELECT proof: batch envelope 禁止 (単発 SELECT のみ)",
    "cli batch ban"
  );
  await throwsExact(
    globalThis.fetch(NOTION_SEARCH, { method: "POST", body: "{}" }),
    `SELECT proof: D1 query 以外への到達を拒否: ${NOTION_SEARCH}`,
    "cli search ban"
  );
  eq(forwards, before, "直接 CLI の ban は forward 前");
  console.info("CLI-GUARD-OK installed exit1 sends0 batch-ban search-ban");
}

const phase = process.argv[2];
if (phase === "importer") {
  await importerPhase();
} else if (phase === "cli") {
  const tmpOut = process.argv[3];
  if (!tmpOut) fail("cli には tmp out-dir が必要");
  await cliPhase(tmpOut);
} else {
  fail(`phase 不明: ${phase}`);
}
