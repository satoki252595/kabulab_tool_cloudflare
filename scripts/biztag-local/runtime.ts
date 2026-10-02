import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { biztagLocalEnv } from "./env.js";
import { SEMIF_MODEL } from "../../src/shared/semif/index.js";

export function assertRevision(expected: string, actual: string, dirty: string): void {
  if (actual !== expected) throw new Error("runtime HEADがBIZTAG_LOCAL_ACCEPTED_REVISIONと一致しません。");
  if (dirty.length > 0) throw new Error("runtimeに追跡対象の変更があります。承認済みmainを使ってください。");
}

export function preflight(root: string): { revision: string; state: string } {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("biztag実行はApple Silicon Mac専用です。");
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
  // runtime設定だけ先mergeされても、歴史Jev較正値で本番jobを起動しない。
  const calibration: unknown = JSON.parse(readFileSync(join(root, "services/yuho-quant/src/biztag/calibration.semif.json"), "utf8"));
  if (typeof calibration !== "object" || calibration === null || !("model" in calibration) || calibration.model !== SEMIF_MODEL) {
    throw new Error("新規初回事業タグのSemIf較正ファイルが実modelと一致しません。");
  }
  if (!existsSync(join(root, "node_modules/.bin/tsx"))) throw new Error("Nix内でpnpm install --frozen-lockfileが必要です。");
  const state = join(dirname(envFile), "tmp/biztag-local");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  return { revision, state };
}

/** kernel flockが正。ファイル残存をrunningとせず、プロセス終端で自動解放する。 */
export async function withBiztagWriter<T>(execute: () => Promise<T>): Promise<T> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const { revision, state } = preflight(root);
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
    return await execute();
  } finally {
    closeSync(descriptor);
  }
}
