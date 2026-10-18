/**
 * Mac専用の事業タグ・優待要約定時処理。
 * Nix shell内から preflight / install / install-next / run を呼ぶ。自動更新・再試行はしない。
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { preflight } from "./runtime.js";
import { LOCAL_JOB_HOURS, localJobScheduledFor, parseLocalJobReceipt, startLocalJobReceipt, mirrorLocalJobReceipt, readBiztagDataStatus, type BiztagDataStatus } from "./receipt.js";
import { biztagLocalEnv } from "./env.js";
import { acceptPrepareStage, planPrepareStage, startPrepareStage } from "./competitor-prepare-stage.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
/** startup receiptの所要も30分へ含める。child起動から30分へ延長しない。 */
export function localJobRemainingMs(startedAt: string, nowMs: number): number {
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start) || !Number.isFinite(nowMs) || nowMs < start) throw new Error("ローカルjobの有限時計が不正です。");
  return Math.max(0, start + 30 * 60_000 - nowMs);
}
/** 許可した2処理だけを起動する。未知のjobを取得前に拒否する。 */
export function localJob(kind: string | undefined): { label: string; hour: number; script: string; args: string[] } {
  if (kind === undefined || kind === "biztag") {
    return { label: "com.kabulab-cf.biztag", hour: LOCAL_JOB_HOURS.biztag.localHour,
      script: "services/yuho-quant/data-scripts/biztag.ts", args: ["run", "--budget-min=20"] };
  }
  if (kind === "yutai-summary") {
    return { label: "com.kabulab-cf.yutai-summary", hour: LOCAL_JOB_HOURS["yutai-summary"].localHour,
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

function install(kind: string | undefined, runAtLoad: boolean): void {
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
<key>RunAtLoad</key><${runAtLoad ? "true" : "false"}/>
<key>StartCalendarInterval</key><dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>0</integer></dict>
<key>StandardOutPath</key><string>${xml(join(state, "launchd.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(state, "launchd-error.log"))}</string>
<key>Umask</key><integer>63</integer>
</dict></plist>
`;
  mkdirSync(dirname(plist), { recursive: true });
  writeFileSync(plist, content, { mode: 0o600, flag: "wx" });
  execFileSync("plutil", ["-lint", plist], { stdio: "ignore" });
  // RunAtLoad=trueならbootstrapが実処理を始める。installerでは作成だけに留める。
  console.info(JSON.stringify({ status: "prepared", revision, label, localTime: `${hour}:00`, runAtLoad, bootstrapped: false }));
}

async function run(kind: string | undefined): Promise<void> {
  const job = localJob(kind);
  const flight = preflight(root);
  const revision = flight.revision;
  const state = jobState(flight.state, kind);
  const args = [...job.args];
  if (kind === "yutai-summary") args.push("--state-dir", state);
  const startedAt = new Date().toISOString();
  const jobKind = kind === "yutai-summary" ? "yutai-summary" : "biztag";
  const running = parseLocalJobReceipt({ version: 1, kind: jobKind, phase: "running", scheduledFor: localJobScheduledFor(jobKind, startedAt),
    startedAt, finishedAt: null, revision, acceptedRevision: revision, code: null, signal: null, retries: 0 });
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
    writeFileSync(`${receipt}.started.json`, JSON.stringify(running), { mode: 0o600, flag: "wx" });
    const mirroredVersion = await startLocalJobReceipt(running, undefined, `${receipt}.previous-incomplete.json`);
    let child: ChildProcess | undefined;
    let stopped = false;
    const stop = (): void => {
      stopped = true;
      if (child?.pid !== undefined && child.exitCode === null && child.signalCode === null) process.kill(-child.pid, "SIGTERM");
    };
    const remainingMs = localJobRemainingMs(startedAt, Date.now());
    const timer = setTimeout(stop, Math.max(0, remainingMs));
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    let result: { code: number | null; signal: NodeJS.Signals | null } = { code: null, signal: null };
    let biztagData: BiztagDataStatus | undefined;
    try {
      if (remainingMs <= 0) throw new Error("receipt開始照合中に全体30分を超えました。childを起動しません。");
      const first = spawn("pnpm", ["exec", "tsx", job.script, ...args], {
        cwd: root, env: childEnv, stdio: ["ignore", log, log], detached: true,
      });
      child = first;
      result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        first.once("error", reject);
        first.once("exit", (code, signal) => resolve({ code, signal }));
      });
      if (jobKind === "biztag" && result.code === 0 && !stopped) {
        if (statSync(`${receipt}.log`).size > 2 * 1024 ** 2) throw new Error("補足summaryの私有ログが読取上限を超えています");
        biztagData = readBiztagDataStatus(readFileSync(`${receipt}.log`, "utf8"));
      }
      const scope = jobKind === "biztag" ? biztagLocalEnv.competitorPrepareCodes() : undefined;
      if (result.code === 0 && !stopped && scope !== undefined) {
        // 同じ30分timerをresetしない。stage7分＋receipt1分の余地がなければ開始しない。
        if (Date.now() - Date.parse(startedAt) >= 22 * 60_000) {
          writeFileSync(`${receipt}.prepare-not-started.json`, JSON.stringify({ status: "not-started", reason: "insufficient-overall-budget" }), { mode: 0o600, flag: "wx" });
          result = { code: 1, signal: null };
        } else {
          const stage = planPrepareStage(scope, state);
          startPrepareStage(stage);
          const stageDeadline = Math.min(Date.now() + 7 * 60_000, Date.parse(startedAt) + 29 * 60_000);
          const second = spawn("pnpm", ["exec", "tsx", job.script, ...stage.args], {
            cwd: root, env: childEnv, stdio: ["ignore", "pipe", log], detached: true,
          });
          child = second;
          const chunks: Buffer[] = []; let stdoutBytes = 0;
          second.stdout!.on("data", (bytes: Buffer) => {
            stdoutBytes += bytes.length;
            if (stdoutBytes > 1024 * 1024) stop();
            else chunks.push(bytes);
          });
          const stageTimer = setTimeout(stop, Math.max(0, stageDeadline - Date.now()));
          try {
            result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
              second.once("error", reject); second.once("close", (code, signal) => resolve({ code, signal }));
            });
            const stdout = Buffer.concat(chunks).toString("utf8");
            writeFileSync(`${receipt}.prepare-summary.json`, stdout, { mode: 0o600, flag: "wx" });
            if (result.code === 0 && !stopped) acceptPrepareStage(stage, stdout, stageDeadline);
            else if (result.code === 0) result = { code: 1, signal: null };
          } finally { clearTimeout(stageTimer); }
        }
      }
    } catch (error) {
      result = { code: 1, signal: null }; throw error;
    } finally {
      clearTimeout(timer);
      process.removeListener("SIGTERM", stop);
      process.removeListener("SIGINT", stop);
      const finished = parseLocalJobReceipt({ ...running, phase: "finished", finishedAt: new Date().toISOString(), ...result,
        ...(biztagData === undefined ? {} : { biztagData }) });
      writeFileSync(receipt, JSON.stringify(finished), { mode: 0o600, flag: "wx" });
      await mirrorLocalJobReceipt(finished, mirroredVersion);
    }
    console.info(JSON.stringify({ status: result.code === 0 ? "completed" : "failed", revision, exitCode: result.code, retries: 0 }));
    if (result.code !== 0) process.exitCode = 1;
  } finally {
    closeSync(log);
  }
}

export async function main(mode: string | undefined, kind?: string): Promise<void> {
  localJob(kind);
  if (mode === "preflight") console.info(JSON.stringify({ status: "preflight_pass", revision: preflight(root).revision, networkRequests: 0, writesToData: 0 }));
  else if (mode === "install" || mode === "install-next") install(kind, mode === "install");
  else if (mode === "run") await run(kind);
  else throw new Error("preflight / install / install-next / run のいずれかを指定してください。");
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv[2], process.argv[3]).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "biztagローカル処理が失敗しました。");
    process.exitCode = 1;
  });
}
