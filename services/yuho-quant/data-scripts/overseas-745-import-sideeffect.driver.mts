/**
 * 745 select-proof の import 副作用 regression 用 child driver (offline)。
 * 呼び出し側のfetch を置き換えないこと + 旧 tree の ban 署名 +
 * 直接 CLI の read-only guard 維持を、実現象ベースで検証する。
 * 全 phase で実 forward 0 (stub は数えて throw する)。
 *
 * - `importer`: stub fetch → merged adapter import → fetch 同一性 +
 *   caller guard intact (stub calls 2・native HTTP 0)。
 * - `cli <tmpout>`: argv[1] を 745 にして import (直接 CLI 相当) →
 *   guard 設置 + main() は env 不在 HOLD (送信 0) → exit 1 を
 *   ExitError として回収し、設置後 guard の ban を検証する。
 * (旧 tree の ban 再現は private actual-old proof で行う。
 * 本 tree の guard を手で置くのは tautology のため置かない。)
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
// 否定 batch は定数 envelope で足りる (数値 fixture 不要)。
const BATCH_REFUSAL_BODY = JSON.stringify({ batch: [] });

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
  eq(forwards, before + 2, "importer stub calls 2 (native HTTP 0)");
  // 745 自体の import でも fetch は置き換わらない。
  await import("./overseas-745-select-proof.js");
  if (globalThis.fetch !== wrapper) fail("745 import が fetch を置き換えた");
  console.info("IMPORTER-OK identity-kept caller-intact stub2 native0");
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
  await throwsExact(
    globalThis.fetch(D1_URL, { method: "POST", body: BATCH_REFUSAL_BODY }),
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
