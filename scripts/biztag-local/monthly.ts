/** 月次の手動入口。日次LaunchAgent/receiptを再開せず、受入済みruntimeの通常CLIを使う。 */
import { execFileSync, spawn } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { preflight } from "./runtime.js";
import { biztagLocalEnv } from "./env.js";
import { acceptPrepareStage, planPrepareStage, startPrepareStage } from "./competitor-prepare-stage.js";
import { parseStockCode } from "../../src/shared/jpx/stock-code.js";

export function parseMonthlyArgs(args: readonly string[]): { runtime: string; preflight: boolean } {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
    runtime: { type: "string" }, preflight: { type: "boolean", default: false },
  } });
  if (values.runtime === undefined || values.runtime.trim() === "") throw new Error("--runtime に受入済みruntimeを明示してください");
  return { runtime: resolve(values.runtime), preflight: values.preflight === true };
}

export function verifyMonthlyRuntime(runtime: string): { revision: string; state: string } {
  if (!realpathSync(process.execPath).startsWith("/nix/store/")) throw new Error("NixのNodeが必要です");
  for (const binary of ["git", "pnpm", "python3.12"]) {
    const path = execFileSync("which", [binary], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    if (!realpathSync(path).startsWith("/nix/store/")) throw new Error("Nixの実行系が揃っていません");
  }
  const state = join(dirname(realpathSync(join(runtime, ".env"))), "tmp/biztag-local");
  // 旧stateの初期化や場所の変更をしない。既存preflightのmkdirも新規作成にしない。
  for (const path of [state, join(dirname(state), "yutai-local")]) {
    const info = statSync(path);
    if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error("既存のprivate stateが必要です");
  }
  const checked = preflight(runtime); // .env/所有者/0600、clean、accepted revision、main ancestorを通常契約で検査。
  if (checked.state !== state) throw new Error("canonical stateが一致しません");
  return checked;
}

export type MonthlyStep = { name: string; script: string; args: string[]; timeoutMs: number; capture: boolean };
type RunStep = (runtime: string, step: MonthlyStep) => Promise<string>;

/** 子全体を同じprocess groupで止める。再試行・後続へのfallbackはない。 */
function runStep(runtime: string, step: MonthlyStep): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn("pnpm", ["exec", "tsx", step.script, ...step.args], {
      cwd: runtime, detached: true, stdio: ["ignore", step.capture ? "pipe" : "inherit", "inherit"],
    });
    let stopped = false, closed = false, bytes = 0;
    const chunks: Buffer[] = [];
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const signal = (value: NodeJS.Signals) => {
      if (child.pid !== undefined && !closed) {
        try { process.kill(-child.pid, value); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") fail(new Error("月次childを停止できません")); }
      }
    };
    const stop = () => { stopped = true; signal("SIGTERM"); if (forceTimer === undefined) forceTimer = setTimeout(() => signal("SIGKILL"), 5_000); };
    const timer = setTimeout(stop, step.timeoutMs);
    process.once("SIGTERM", stop); process.once("SIGINT", stop);
    child.stdout?.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) stop(); else chunks.push(chunk);
    });
    const cleanup = () => { closed = true; clearTimeout(timer); clearTimeout(forceTimer); process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop); };
    child.once("error", () => { cleanup(); fail(new Error("月次childを開始できません")); });
    child.once("close", (code, termination) => {
      // TERMでleaderだけ先に閉じても、残る同groupをcleanup前に止める。
      if (stopped) signal("SIGKILL");
      cleanup();
      if (stopped || code !== 0 || termination !== null) fail(new Error("月次stageが未完です。後続を実行せず停止します"));
      else done(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

export async function executeMonthly(runtime: string, state: string, scope: string[] | undefined, run: RunStep = runStep): Promise<void> {
  const script = "services/yuho-quant/data-scripts/biztag.ts";
  await run(runtime, { name: "biztag", script, args: ["run", "--budget-min=20"], timeoutMs: 30 * 60_000, capture: false });
  if (scope !== undefined) {
    const stage = planPrepareStage(scope, state);
    startPrepareStage(stage);
    const deadline = Date.now() + 7 * 60_000;
    const output = await run(runtime, { name: "competitor-prepare-only", script, args: stage.args, timeoutMs: 7 * 60_000, capture: true });
    acceptPrepareStage(stage, output, deadline);
  }
  await run(runtime, { name: "yutai-summary-mechanical", script: "services/otakara-yutai/data-scripts/summary-local.ts",
    args: ["--limit", "60", "--state-dir", join(dirname(state), "yutai-local")], timeoutMs: 30 * 60_000, capture: false });
}

export async function monthlyMain(options: { runtime: string; preflight: boolean }, check = verifyMonthlyRuntime, execute = executeMonthly): Promise<void> {
  const flight = check(options.runtime);
  const scope = biztagLocalEnv.competitorPrepareCodes();
  if (scope !== undefined && (scope.length === 0 || scope.length > 100 || new Set(scope).size !== scope.length ||
      scope.some(code => parseStockCode(code) !== code))) throw new Error("競合準備の固定scopeが不正です");
  console.info(JSON.stringify({ status: "monthly_manual_preflight_pass", runtime: options.runtime, revision: flight.revision,
    biztagBudgetMinutes: 20, competitorPrepareConfigured: scope !== undefined, yutaiLimit: 60,
    plannedStages: ["biztag", ...(scope === undefined ? [] : ["competitor-prepare-only"]), "yutai-summary-mechanical"],
    dailyReceiptUpdated: false, wholeDataComplete: false }));
  if (options.preflight) return;
  await execute(options.runtime, flight.state, scope);
  console.info(JSON.stringify({ status: "monthly_manual_finite_steps_finished", dailyReceiptUpdated: false,
    wholeDataComplete: false, nextAction: "各通常CLIのsummary・残件・HOLDを私有ログで確認してください" }));
}

/** 固定の原因だけ公開する。Git/OS/モデル等の任意exception本文やenv値は出さない。 */
export function monthlyFailureCode(error: unknown): string {
  if (!(error instanceof Error)) return "unexpected_failure";
  const known = new Map([
    ["--runtime に受入済みruntimeを明示してください", "runtime_argument_required"],
    ["NixのNodeが必要です", "nix_node_required"], ["Nixの実行系が揃っていません", "nix_toolchain_required"],
    ["既存のprivate stateが必要です", "canonical_state_permissions"], ["canonical stateが一致しません", "canonical_state_mismatch"],
    ["biztag実行はApple Silicon Mac、明示的な機械処理だけLinux Nixを使用できます。", "mac_arm64_required"],
    ["runtime .env は実行ユーザー所有の通常ファイル・0600が必要です。", "runtime_env_permissions"],
    ["runtime .env を読み込めません。", "runtime_env_unreadable"],
    ["BIZTAG_LOCAL_ACCEPTED_REVISION に承認済み main の40桁SHAが必要です。", "accepted_revision_invalid"],
    ["runtime HEADがBIZTAG_LOCAL_ACCEPTED_REVISIONと一致しません。", "runtime_revision_mismatch"],
    ["runtimeに追跡対象の変更があります。承認済みmainを使ってください。", "runtime_not_clean"],
    ["Nix内でpnpm install --frozen-lockfileが必要です。", "runtime_dependencies_missing"],
    ["競合準備の固定scopeが不正です", "competitor_scope_invalid"],
    ["月次stageが未完です。後続を実行せず停止します", "stage_incomplete"],
    ["月次childを開始できません", "child_start_failed"], ["月次childを停止できません", "child_stop_failed"],
  ]);
  const reason = known.get(error.message);
  if (reason !== undefined) return reason;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return "local_dependency_missing";
  if (code === "EACCES" || code === "EPERM") return "local_permission_denied";
  return "runtime_or_stage_failure";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  (async () => monthlyMain(parseMonthlyArgs(process.argv.slice(2))))().catch((error: unknown) => {
    console.error(`[biztag:monthly] STOP reason=${monthlyFailureCode(error)}。私有ログと未完journalを確認してください。自動再試行しません。`);
    process.exitCode = 1;
  });
}
