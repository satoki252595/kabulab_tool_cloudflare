import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { biztagLocalEnv } from "./env.js";
import { createSupplementPublicationJournal } from "./publication-journal.js";
import { syncParent } from "./clef-journal.js";
import { fenceUnconfirmedPublishingInitialization, initializeSharedPublishingWriter, publishingStore, withSharedPublishingWriter, type PublishingInitializationFence } from "../mechanical-publishing/shared-writer.js";

export function assertRevision(expected: string, actual: string, dirty: string): void {
  if (actual !== expected) throw new Error("runtime HEADがBIZTAG_LOCAL_ACCEPTED_REVISIONと一致しません。");
  if (dirty.length > 0) throw new Error("runtimeに追跡対象の変更があります。承認済みmainを使ってください。");
}

export function preflight(root: string, mechanicalOnly = false): { revision: string; state: string } {
  if (!(process.platform === "darwin" && process.arch === "arm64") && !(process.platform === "linux" && mechanicalOnly === true)) {
    throw new Error("biztag実行はApple Silicon Mac、明示的な機械処理だけLinux Nixを使用できます。");
  }
  // 他worktreeの手動実行も、同じprivate .envの実体を通じて同じlockを使う。
  const envFile = realpathSync(join(root, ".env"));
  const envStat = statSync(envFile);
  if (!envStat.isFile() || (envStat.mode & 0o077) !== 0 || envStat.uid !== process.getuid?.()) {
    throw new Error("runtime .env は実行ユーザー所有の通常ファイル・0600が必要です。");
  }
  const loaded = config({ path: envFile, quiet: true, override: true });
  if (loaded.error !== undefined) throw new Error("runtime .env を読み込めません。");
  const revision = biztagLocalEnv.acceptedRevision();
  const git = (args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  assertRevision(revision, git(["rev-parse", "HEAD"]), git(["status", "--porcelain", "--untracked-files=normal"]));
  execFileSync("git", ["merge-base", "--is-ancestor", revision, "origin/main"], { cwd: root, stdio: "ignore" });
  // 較正の欠配置/不一致は実AI判定の直前で拒否する。本文の機械同期は独立して実行できる。
  if (!existsSync(join(root, "node_modules/.bin/tsx"))) throw new Error("Nix内でpnpm install --frozen-lockfileが必要です。");
  const state = join(dirname(envFile), "tmp/biztag-local");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  return { revision, state };
}

/** kernel flockが正。ファイル残存をrunningとせず、プロセス終端で自動解放する。 */
async function withLocalBiztagWriter<T>(execute: (state: string) => Promise<T>, mechanicalOnly = false): Promise<T> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const { revision, state } = preflight(root, mechanicalOnly);
  const python = execFileSync("which", ["python3.12"], { encoding: "utf8" }).trim();
  if (!python.startsWith("/nix/store/")) throw new Error("writer排他にはNixのPython3.12が必要です。");
  // Node自身がFDを保持。Python子のfd3は同じopen file descriptionを共有する。
  // 子が終了/killされても、Nodeのcallback終了まではkernel flockが解放されない。
  const descriptor = openSync(join(state, "writer.lock"), "a+", 0o600);
  try {
    const helper = spawnSync(python, [join(root, "scripts/biztag-local/writer-lock.py"), state, String(process.pid), revision], {
      stdio: ["ignore", "pipe", "ignore", descriptor], encoding: "utf8", timeout: 10_000,
    });
    if (helper.error !== undefined || helper.status !== 0) throw new Error("writer kernel lockの取得通知がありません。保存を開始しません。");
    const response: unknown = JSON.parse(helper.stdout);
    if (typeof response !== "object" || response === null || !("locked" in response)) throw new Error("writer排他応答が不正です。");
    if (response.locked === false) throw new Error("biztagのkernel writer lockは使用中です。同時実行を停止します。");
    if (response.locked !== true) throw new Error("writerのkernel排他を確認できません。");
    return await execute(state);
  } finally {
    closeSync(descriptor);
  }
}

/** The kernel lock still protects the canonical model/state; R2 also protects every remote publisher. */
export async function withBiztagWriter<T>(execute: () => Promise<T>, mechanicalOnly = false, beforeShared?: (state: string) => void): Promise<T> {
  return withLocalBiztagWriter(state => {
    beforeShared?.(state); // Canonical kernel lock is held; no remote publisher ownership yet.
    return withSharedPublishingWriter(execute);
  }, mechanicalOnly);
}

/** Explicit migration only. The immutable baseline pins closed old journals; no old bytes are changed. */
async function withCanonicalPublishingInitialization(execute: (baseline: unknown, cursors: PublishingInitializationFence["initialCursors"], state: string) => Promise<void>): Promise<void> {
  if (!(process.platform === "darwin" && process.arch === "arm64")) throw new Error("共有publisherの移行は受入済みMacで実行してください");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const canonical = join(dirname(realpathSync(join(root, ".env"))), "tmp");
  // Check before normal preflight can mkdir: an empty replacement state is not migration evidence.
  for (const path of [join(canonical, "biztag-local"), join(canonical, "biztag-local/supplement-publications"), join(canonical, "yutai-local")]) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error("移行元の既存canonical stateが必要です");
  }
  await withLocalBiztagWriter(async () => {
    const { revision, state } = preflight(root);
    createSupplementPublicationJournal(state).assertReady();
    const yutaiState = join(dirname(state), "yutai-local");
    if (existsSync(join(yutaiState, "pending-write.json"))) throw new Error("旧優待の未閉鎖intentを移行で解除しません");
    const progress = join(yutaiState, "progress.json");
    let yutaiProgress: string | null = null;
    if (existsSync(progress)) {
      const stat = lstatSync(progress);
      if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > 16_384) throw new Error("旧優待cursorの私有ファイル資格が不正です");
      yutaiProgress = readFileSync(progress, "utf8");
      const value = JSON.parse(yutaiProgress);
      if (value === null || typeof value !== "object" || Object.keys(value).length !== 1 || typeof value.cursor !== "string" || !/^[a-f0-9]{16}$/.test(value.cursor)) throw new Error("旧優待cursorの形が不正です");
    }
    const publications = join(state, "supplement-publications");
    const completed = readdirSync(publications).sort().map(key => ({ key,
      completedSha256: createHash("sha256").update(readFileSync(join(publications, key, "completed.json"))).digest("hex") }));
    await execute({ version: 1, source: "accepted-mac-canonical-journals", revision,
      completed, unresolvedPublications: 0, yutaiPending: false,
      yutaiProgressSha256: yutaiProgress === null ? null : createHash("sha256").update(yutaiProgress).digest("hex"),
      observedAt: new Date().toISOString() }, yutaiProgress === null ? {} : { "yutai-summary": yutaiProgress }, state);
  });
}

export async function initializePublishingFromMac(): Promise<void> {
  await withCanonicalPublishingInitialization((baseline, cursors, state) => {
    if (existsSync(join(state, "shared-publishing-initialization-fence.intent.json"))) throw new Error("既存fence intentを通常初期化で迂回しません");
    return initializeSharedPublishingWriter(baseline, publishingStore(), cursors);
  });
}

/** The failed attempt stays unknown. This explicit cutover fences its terminal authority instead of retrying it. */
export async function fencePublishingInitializationFromMac(failedLogSha256: string): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(failedLogSha256)) throw new Error("失敗ログのSHA256指定が必要です");
  await withCanonicalPublishingInitialization(async (baseline, initialCursors, state) => {
    const log = join(state, "shared-publishing-initialize.log"), stat = lstatSync(log);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size <= 0 || stat.size > 65_536) throw new Error("失敗ログの私有ファイル資格が不正です");
    const raw = readFileSync(log), hash = (body: string | Uint8Array) => createHash("sha256").update(body).digest("hex");
    const lines = new TextDecoder("utf-8", { fatal: true }).decode(raw).split(/\r?\n/);
    if (raw.length !== stat.size || hash(raw) !== failedLogSha256 ||
        lines.filter(line => line === "[mechanical-publishing] initialization_stopped_no_retry").length !== 1 ||
        lines.some(line => line.includes("shared_writer_initialized"))) throw new Error("失敗ログの指定SHA/停止記録が一致しません");
    const plan: PublishingInitializationFence = { baseline: JSON.stringify(baseline) + "\n", initialCursors,
      owner: { id: randomUUID(), startedAt: new Date().toISOString() } };
    const intent = JSON.stringify({ version: 1, kind: "fence-unconfirmed-initialization", failedLogSha256,
      baselineSha256: hash(plan.baseline), cursorSha256: Object.fromEntries(Object.entries(initialCursors).map(([name, body]) => [name, hash(body)])), plan }) + "\n";
    const path = join(state, "shared-publishing-initialization-fence.intent.json"), fd = openSync(path, "wx", 0o600);
    try { writeFileSync(fd, intent); fsyncSync(fd); } finally { closeSync(fd); }
    syncParent(path); // Failure here leaves the exact intent and never starts remote IO.
    await fenceUnconfirmedPublishingInitialization(plan);
  });
}
