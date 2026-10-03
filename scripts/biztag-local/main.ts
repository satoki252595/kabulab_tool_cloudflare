/**
 * Mac専用の事業タグ・優待要約定時処理。
 * Nix shell内から preflight / install / run を呼ぶ。自動更新・再試行はしない。
 */
import { spawn, execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { preflight } from "./runtime.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
/** 許可した2処理だけを起動する。未知のjobを取得前に拒否する。 */
export function localJob(kind: string | undefined): { label: string; hour: number; script: string; args: string[] } {
  if (kind === undefined || kind === "biztag") {
    return { label: "com.kabulab-cf.biztag", hour: 20,
      script: "services/yuho-quant/data-scripts/biztag.ts", args: ["run", "--budget-min=20"] };
  }
  if (kind === "yutai-summary") {
    return { label: "com.kabulab-cf.yutai-summary", hour: 21,
      script: "services/otakara-yutai/data-scripts/summary-local.ts", args: ["--limit", "60"] };
  }
  throw new Error("jobはbiztag / yutai-summaryのいずれかを指定してください。");
}

function jobState(state: string, kind: string | undefined): string {
  const path = kind === "yutai-summary" ? join(dirname(state), "yutai-local") : state;
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function install(kind: string | undefined): void {
  const { label, hour } = localJob(kind);
  const flight = preflight(root);
  const revision = flight.revision;
  const state = jobState(flight.state, kind);
  const nix = execFileSync("which", ["nix"], { encoding: "utf8" }).trim();
  if (!nix.startsWith("/nix/")) throw new Error("Nix管理のnix実行ファイルが必要です。");
  const plist = join(homedir(), "Library/LaunchAgents", `${label}.plist`);
  if (existsSync(plist)) throw new Error("既存LaunchAgentがあります。停止・内容確認後に更新してください。");
  const args = [nix, "develop", "--offline", "--command", "pnpm", "exec", "tsx", "scripts/biztag-local/main.ts", "run"];
  if (kind !== undefined) args.push(kind);
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args.map((v) => `<string>${xml(v)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>RunAtLoad</key><true/>
<key>StartCalendarInterval</key><dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>0</integer></dict>
<key>StandardOutPath</key><string>${xml(join(state, "launchd.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(state, "launchd-error.log"))}</string>
<key>Umask</key><integer>63</integer>
</dict></plist>
`;
  mkdirSync(dirname(plist), { recursive: true });
  writeFileSync(plist, content, { mode: 0o600, flag: "wx" });
  execFileSync("plutil", ["-lint", plist], { stdio: "ignore" });
  // bootstrapはRunAtLoadの実処理を始める。installでは作成だけに留める。
  console.info(JSON.stringify({ status: "prepared", revision, label, localTime: `${hour}:00`, runAtLoad: true, bootstrapped: false }));
}

async function run(kind: string | undefined): Promise<void> {
  const job = localJob(kind);
  const flight = preflight(root);
  const revision = flight.revision;
  const state = jobState(flight.state, kind);
  const args = [...job.args];
  if (kind === "yutai-summary") args.push("--state-dir", state);
  const startedAt = new Date().toISOString();
  const receipt = join(state, `${startedAt.replaceAll(":", "-")}-${process.pid}.json`);
  const log = openSync(`${receipt}.log`, "wx", 0o600);
  // 本文/モデル診断は私有ログのみ。spawn環境から不要キーを除くがCLIは.envを再読込する。
  // TypeSafeの利用停止はshared policyが保証する。
  const childEnv = { ...process.env };
  delete childEnv.GH_TOKEN;
  delete childEnv.GITHUB_TOKEN;
  delete childEnv.GITHUB_ACTIONS_TOKEN;
  delete childEnv.TYPESAFE_API_KEY;
  // writer lockはCLIのwithBiztagWriterが保有する。手動CLIも同じ排他境界を通る。
  try {
    const child = spawn("pnpm", ["exec", "tsx", job.script, ...args], {
      cwd: root, env: childEnv, stdio: ["ignore", log, log], detached: true,
    });
    const stop = (): void => { if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM"); };
    const timer = setTimeout(stop, 30 * 60_000);
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    let result: { code: number | null; signal: NodeJS.Signals | null };
    try {
      result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
    } finally {
      clearTimeout(timer);
      process.removeListener("SIGTERM", stop);
      process.removeListener("SIGINT", stop);
    }
    writeFileSync(receipt, JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), revision, ...result, retries: 0 }), { mode: 0o600, flag: "wx" });
    console.info(JSON.stringify({ status: result.code === 0 ? "completed" : "failed", revision, exitCode: result.code, retries: 0 }));
    if (result.code !== 0) process.exitCode = 1;
  } finally {
    closeSync(log);
  }
}

export async function main(mode: string | undefined, kind?: string): Promise<void> {
  localJob(kind);
  if (mode === "preflight") console.info(JSON.stringify({ status: "preflight_pass", revision: preflight(root).revision, networkRequests: 0, writesToData: 0 }));
  else if (mode === "install") install(kind);
  else if (mode === "run") await run(kind);
  else throw new Error("preflight / install / run のいずれかを指定してください。");
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv[2], process.argv[3]).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "biztagローカル処理が失敗しました。");
    process.exitCode = 1;
  });
}
