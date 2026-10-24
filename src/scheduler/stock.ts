import { marketClosure, type MarketClosure } from "../shared/market-calendar.js";
import { parseScheduledAt, scheduledAtIso } from "../shared/scheduled-admission.js";
import { assertVwapAdmission, scheduledVwapWindow, VWAP_DISPATCH_CRON, VWAP_READCHECK_CRON } from "../shared/vwap-schedule.js";
export { VWAP_DISPATCH_CRON, VWAP_READCHECK_CRON } from "../shared/vwap-schedule.js";

/**
 * 株式・マクロ sync の CF スケジューラ (Worker scheduled handler 本体)。
 *
 * 背景: GitHub Actions の schedule イベントが 250/318 分の生成遅配を 2 回連続で
 * 起こし (runner 待ちは 3 秒)、06:00 JST 基準 guard が正しく STOP した。
 * 株式とマクロの起動時刻を Cloudflare Cron Trigger へ移し、実実行は従来どおり
 * GitHub Actions (stock-sync.yml workflow_dispatch) に任せる。cron 前倒しは
 * Yahoo 確定証拠なしで不採用。詳細は docs/stock-scheduler.md。
 *
 * Worker-safe: node 専用 import なし。env/bucket/fetch は引数で受ける。
 * ログに秘密 (token)・リクエスト URL・run URL の値は出さない。
 */

/** 株式は取引日当日18:00 JSTに起動。実開始・追加IOの時刻契約はCLIでも検査する。 */
export const DISPATCH_CRON = "0 9 * * MON-FRI";
/** 完了窓の上限（14:30 UTC = 23:30 JST）の直後。Yahoo は取らない。 */
export const READCHECK_CRON = "35 14 * * MON-FRI";
export const CONTEXT_DISPATCH_CRON = "0 21 * * MON-FRI";
export const CONTEXT_READCHECK_CRON = "5 22 * * MON-FRI";
const CONTEXT_DISPATCH_TARGET = "scheduled-context";
/** 独立取得元は株価・日米休場に依存させない。既存source直列lockを共有する。 */
export const MONEYFLOW_DISPATCH_CRON = "15 9 * * MON-FRI";
export const MONEYFLOW_READCHECK_CRON = "45 14 * * MON-FRI";
/** 開示はMac20時writerより前の平日19時。市場休場日は除外しない。 */
export const CATCHUP_DISPATCH_CRON = "0 10 * * MON-FRI";
export const CATCHUP_READCHECK_CRON = "5 11 * * MON-FRI";
export const CATCHUP_START_TIME = "10:00:00.000Z";
export const CATCHUP_JOIN_CUTOFF_TIME = "10:53:00.000Z";
export const CATCHUP_COMPLETION_CUTOFF_TIME = "10:54:00.000Z";
const CONTEXT_START_DEADLINE_MINUTES = 30;

/** dispatch 先 repo は固定 (設定で差し替えない)。 */
export const GITHUB_OWNER = "satoki252595";
export const GITHUB_REPO = "kabulab_tool_cloudflare";
export const WORKFLOW_FILE = "stock-sync.yml";
export const GITHUB_API_VERSION = "2026-03-10";
export const DISPATCH_TARGET = "scheduled-stocks";
export const GITHUB_USER_AGENT =
  "kabulab-stock-scheduler/1.0 (+https://github.com/satoki252595/kabulab_tool_cloudflare)";

/**
 * dispatch 開始期限。CF cron は通常ほぼ定刻に発火するため、予定時刻から
 * 60 分を超えた起動は異常 (旧 GH schedule 遅配と同種の事故) として POST 前に
 * 落とす。各CLIの完了期限への波及を待たない。
 */
export const DISPATCH_START_DEADLINE_MINUTES = 60;

/**
 * 株式 step 完了の上限。D 23:30 JST = 14:30 UTC。
 * 旧 21:00 UTC（翌 06:00 JST）は null 帯の中なので、帯の開始まで縮めた。
 * 定時CLIも23:30へ揃え、手動の従来上限は維持する。
 */
export const COMPLETION_CUTOFF_TIME = "14:30:00.000Z";
/** 株式 step 完了の下限 (同日 dispatch 予定時刻)。古い別日の成功を通さない。 */
export const COMPLETION_FLOOR_TIME = "09:00:00.000Z";

/**
 * Jobs API の最大ページ数。全頁が必要だが、無制限の照会を防ぐため
 * 超過は明示 error (成功偽装なし)。1 run の job は通常 2 件のため、
 * 10 頁 (1000 job) 超は異常とみなす。
 */
export const MAX_JOB_PAGES = 10;

const RECEIPT_PREFIX = "stock-scheduler/receipt-";
const RECEIPT_VERSION = 1;

const JOB_NAME_SYNC = "sync";
const STEP_STOCK = "stock daily sync";
const STEP_TOLERATED_COMMENT = "許容内失敗があれば Issue にコメント";

/**
 * R2 BUCKET の最小構造型 (vwap-analysis の Bindings と同じ方式)。
 * onlyIf は Headers (If-None-Match: * の claim 用) か R2Conditional の
 * etagMatches (CAS 用。値は R2Object.etag の raw 形式) を取る。
 */
export interface SchedulerBucket {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  put(
    key: string,
    value: string,
    options?: { onlyIf?: Headers | { etagMatches: string } }
  ): Promise<{ etag: string } | null>;
}

export interface SchedulerEnv {
  BUCKET: SchedulerBucket;
  GITHUB_ACTIONS_TOKEN?: string;
}

export interface ScheduledControllerLike {
  cron: string;
  scheduledTime: number;
}

export type SchedulerRoute = "dispatch" | "readcheck" | "context-dispatch" | "context-readcheck" | "moneyflow-dispatch" | "moneyflow-readcheck" | "catchup-dispatch" | "catchup-readcheck" | "vwap-dispatch" | "vwap-readcheck";
type SyncKind = "stocks" | "context" | "moneyflow" | "catchup" | "vwap";

export interface StockReceipt {
  version: number;
  scheduledDate: string;
  scheduledAt?: string;
  cron: string;
  status: "claimed" | "dispatched";
  claimedAt: string;
  dispatchedAt?: string;
  workflowRunId?: number;
  runUrl?: string;
  htmlUrl?: string;
}

/**
 * WorkerEnv からの型付きアクセサ。token 未設定は即 throw (秘密なしで
 * dispatch/照会へ進まない。fail-closed)。
 */
export function schedulerToken(env: SchedulerEnv): string {
  const v = env.GITHUB_ACTIONS_TOKEN;
  if (typeof v !== "string" || v.trim() === "") {
    throw new Error(
      "GITHUB_ACTIONS_TOKEN が設定されていません。" +
        "Root が `wrangler secret put GITHUB_ACTIONS_TOKEN` で登録してください。"
    );
  }
  return v;
}

/** cron 文字列 → 処理分岐。未知は POST/照会の前に落とす。 */
export function routeCron(cron: string): SchedulerRoute {
  if (cron === DISPATCH_CRON) return "dispatch";
  if (cron === READCHECK_CRON) return "readcheck";
  if (cron === CONTEXT_DISPATCH_CRON) return "context-dispatch";
  if (cron === CONTEXT_READCHECK_CRON) return "context-readcheck";
  if (cron === MONEYFLOW_DISPATCH_CRON) return "moneyflow-dispatch";
  if (cron === MONEYFLOW_READCHECK_CRON) return "moneyflow-readcheck";
  if (cron === CATCHUP_DISPATCH_CRON) return "catchup-dispatch";
  if (cron === CATCHUP_READCHECK_CRON) return "catchup-readcheck";
  if (cron === VWAP_DISPATCH_CRON) return "vwap-dispatch";
  if (cron === VWAP_READCHECK_CRON) return "vwap-readcheck";
  throw new Error(
    `未知の cron です: ${cron} (想定: ${DISPATCH_CRON} / ${READCHECK_CRON} / ${CONTEXT_DISPATCH_CRON} / ${CONTEXT_READCHECK_CRON} / ${MONEYFLOW_DISPATCH_CRON} / ${MONEYFLOW_READCHECK_CRON} / ${CATCHUP_DISPATCH_CRON} / ${CATCHUP_READCHECK_CRON} / ${VWAP_DISPATCH_CRON} / ${VWAP_READCHECK_CRON})`
  );
}

function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * controller.scheduledTime から予定 UTC 日を確定する。
 *
 * - 未来の予定時刻 → error (まだ来ていない日の dispatch/照会はしない)
 * - 土日 → error (両 cron は MON-FRI。曜日違いの発火は想定外)
 * - UTC 日跨ぎ (予定日 ≠ 実行日) → error (対象日が曖昧なまま進まない)
 * - dispatch のみ: 開始期限 (60 分) 超過 → error
 */
export function resolveRunDate(
  route: SchedulerRoute,
  scheduledTimeMs: number,
  nowMs: number
): string {
  if (!Number.isFinite(scheduledTimeMs) || !Number.isFinite(nowMs)) {
    throw new Error("scheduledTime/now が時刻として不正です");
  }
  if (scheduledTimeMs > nowMs) {
    throw new Error(
      `予定時刻が未来です: scheduled=${new Date(scheduledTimeMs).toISOString()}`
    );
  }
  const scheduledDay = new Date(scheduledTimeMs).getUTCDay();
  if (scheduledDay === 0 || scheduledDay === 6) {
    throw new Error(
      `予定日が土日です: ${utcDate(scheduledTimeMs)} (MON-FRI のみ)`
    );
  }
  const scheduledDate = utcDate(scheduledTimeMs);
  if (scheduledDate !== utcDate(nowMs)) {
    throw new Error(
      `UTC 日跨ぎのため対象日が曖昧です: scheduled=${scheduledDate}`
    );
  }
  if (route === "vwap-dispatch" || route === "vwap-readcheck") {
    const window = scheduledVwapWindow(scheduledDate); // 月水金だけ。休場は後段で明示skip。
    if (route === "vwap-dispatch") {
      // Cronは分の契約。scheduledTimeには本番で17:00:52のような秒も含まれる。
      // 17:00〜17:10は起動受付窓。23:30は終値NULL帯の新規IO締切で、実時計のまま残す。
      if (Math.floor(scheduledTimeMs / 60_000) !== window.start / 60_000) throw new Error("VWAP予定時刻が17:00 JSTの分ではありません");
      assertVwapAdmission(scheduledDate, scheduledTimeMs);
      if (nowMs >= window.completionCutoff) {
        throw new Error("VWAP完了期限の範囲外です (予定日23:30 JSTより前)。新規取得・価格PUTしません");
      }
    }
  }
  if (route === "catchup-dispatch") {
    const floor = Date.parse(`${scheduledDate}T${CATCHUP_START_TIME}`);
    const join = Date.parse(`${scheduledDate}T${CATCHUP_JOIN_CUTOFF_TIME}`);
    if (scheduledTimeMs < floor || scheduledTimeMs > floor + 5 * 60_000) {
      throw new Error("dispatch 開始期限を超過しました: 予定時刻が19:00〜19:05 JSTの範囲外です");
    }
    if (nowMs >= join) throw new Error("catchupの絶対締切です（未完・再送なし）");
  }
  if (route === "dispatch" || route === "context-dispatch" || route === "moneyflow-dispatch") {
    const delayMs = nowMs - scheduledTimeMs;
    const deadlineMinutes = route === "context-dispatch"
      ? CONTEXT_START_DEADLINE_MINUTES : DISPATCH_START_DEADLINE_MINUTES;
    if (delayMs > deadlineMinutes * 60 * 1000) {
      throw new Error(
        `dispatch 開始期限を超過しました: 遅延=${Math.floor(delayMs / 60000)}分` +
          ` (上限 ${deadlineMinutes}分)`
      );
    }
  }
  return scheduledDate;
}

export function receiptKey(scheduledDate: string): string {
  return `${RECEIPT_PREFIX}${scheduledDate}.json`;
}

export function contextReceiptKey(scheduledDate: string): string {
  return `stock-scheduler/context-receipt-${scheduledDate}.json`;
}

export function moneyflowReceiptKey(scheduledDate: string): string {
  return `stock-scheduler/moneyflow-receipt-${scheduledDate}.json`;
}

export function catchupReceiptKey(scheduledDate: string): string {
  return `stock-scheduler/catchup-receipt-${scheduledDate}.json`;
}

export function vwapReceiptKey(scheduledDate: string): string {
  return `stock-scheduler/vwap-receipt-${scheduledDate}.json`;
}

/**
 * 予定 UTC 日の receipt を原子的 conditional PUT で claim する。
 * 同時・逐次の二重 dispatch は R2 側で弾かれる (put は null を返す)。
 * 取得者のみ POST する。accepted duplicate は追加 POST 0。
 */
export async function claimReceipt(
  bucket: SchedulerBucket,
  key: string,
  receipt: StockReceipt
): Promise<{ claimed: boolean; etag: string | null }> {
  const put = await bucket.put(key, JSON.stringify(receipt), {
    onlyIf: new Headers({ "If-None-Match": "*" }),
  });
  if (put === null) return { claimed: false, etag: null };
  return { claimed: true, etag: put.etag };
}

export interface DispatchDetails {
  workflowRunId: number;
  runUrl: string;
  htmlUrl: string;
}

function httpsUrl(value: unknown, name: string, what = "dispatch 応答"): URL {
  if (typeof value !== "string" || value === "") {
    throw new Error(`${what}の ${name} が不正です (空・非文字列)`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${what}の ${name} が URL として不正です`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`${what}の ${name} が https ではありません`);
  }
  return url;
}

/**
 * dispatch 応答の run URL が同一 repo・同一 run のものか検証する。
 * 別 repo/run の URL が混ざっても後の readcheck が別物を検証しない。
 */
function assertRunUrl(
  value: unknown,
  name: "run_url" | "html_url",
  host: string,
  runId: number,
  what = "dispatch 応答"
): string {
  const url = httpsUrl(value, name, what);
  if (url.host !== host) {
    throw new Error(`${what}の ${name} の host が不正です`);
  }
  // API の run_url は /repos 付き、html_url は /repos 無し (公式の実形)。
  const want =
    name === "run_url"
      ? `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/runs/${runId}`
      : `/${GITHUB_OWNER}/${GITHUB_REPO}/actions/runs/${runId}`;
  if (url.pathname !== want) {
    throw new Error(`${what}の ${name} が同一 repo/run ではありません`);
  }
  return value as string;
}

/**
 * GitHub workflow_dispatch POST。HTTP 200 + workflow_run_id/run_url/html_url
 * の検証を通したものだけ返す。それ以外は throw (pending/結果不明を成功に
 * しない。自動再 POST もしない)。秘密・URL 値はログに出さない。
 */
export async function postStockDispatch(
  fetchFn: typeof fetch,
  token: string,
  scheduledDate: string
): Promise<DispatchDetails> {
  return postWorkflowDispatch(fetchFn, token, WORKFLOW_FILE, {
    target: DISPATCH_TARGET, scheduled_date: scheduledDate,
  });
}

/** 固定workflowのone-shot POST。unknownは再送しない。 */
export async function postWorkflowDispatch(
  fetchFn: typeof fetch, token: string, workflow: string, inputs: Record<string, string>
): Promise<DispatchDetails> {
  const res = await fetchFn(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}` +
      `/actions/workflows/${workflow}/dispatches`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": GITHUB_USER_AGENT,
      },
      body: JSON.stringify({
        ref: "main",
        inputs,
      }),
    }
  );
  if (res.status !== 200) {
    // 任意の応答 body を error へ含めない (非出力保証を関数境界で満たす)。
    // 切り分けは HTTP status で十分。
    throw new Error(`dispatch POST が失敗しました: HTTP ${res.status}`);
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new Error("dispatch 応答が JSON ではありません (HTTP 200)");
  }
  if (typeof json !== "object" || json === null) {
    throw new Error("dispatch 応答の形式が不正です");
  }
  const r = json as Record<string, unknown>;
  if (!Number.isSafeInteger(r["workflow_run_id"])) {
    throw new Error("dispatch 応答に workflow_run_id (整数) がありません");
  }
  const workflowRunId = r["workflow_run_id"] as number;
  if (workflowRunId <= 0) {
    throw new Error("dispatch 応答の workflow_run_id が正ではありません");
  }
  return {
    workflowRunId,
    runUrl: assertRunUrl(r["run_url"], "run_url", "api.github.com", workflowRunId),
    htmlUrl: assertRunUrl(r["html_url"], "html_url", "github.com", workflowRunId),
  };
}

/**
 * POST 検証後の receipt 更新を CAS で保存する。条件は native
 * `etagMatches` (R2Object.etag の raw 形式。HTTP If-Match へ raw etag を
 * 入れるのは仕様不一致のため使わない)。
 * 更新競合 (null) は上書きせず throw (POST 済みのため再 POST もしない。
 * 手動トリアージ対象として readcheck が error にする)。
 */
export async function saveDispatchResult(
  bucket: SchedulerBucket,
  key: string,
  claimEtag: string,
  receipt: StockReceipt
): Promise<void> {
  const put = await bucket.put(key, JSON.stringify(receipt), {
    onlyIf: { etagMatches: claimEtag },
  });
  if (put === null) {
    throw new Error(
      `receipt の CAS 保存に失敗しました (競合): date=${receipt.scheduledDate}`
    );
  }
}

export type DispatchOutcome =
  | { status: "dispatched"; workflowRunId: number }
  | { status: "duplicate"; workflowRunId: number };

interface DispatchDeps {
  bucket: SchedulerBucket;
  token: string;
  cron: string;
  scheduledDate: string;
  /** 定時dispatchのGitHub入力。receiptのslot照合には使わない。 */
  scheduledAt?: string;
  nowMs: number;
  fetchFn: typeof fetch;
}

export function runStockDispatch(deps: DispatchDeps): Promise<DispatchOutcome> {
  return runScheduledDispatch(deps, "stocks");
}

export function runContextDispatch(deps: DispatchDeps): Promise<DispatchOutcome> {
  return runScheduledDispatch(deps, "context");
}

export function runCatchupDispatch(deps: DispatchDeps): Promise<DispatchOutcome> {
  return runScheduledDispatch(deps, "catchup");
}

export function runVwapDispatch(deps: DispatchDeps): Promise<DispatchOutcome> {
  return runScheduledDispatch(deps, "vwap");
}

async function runScheduledDispatch(deps: DispatchDeps, kind: SyncKind): Promise<DispatchOutcome> {
  parseScheduledAt(deps.scheduledAt);
  if (deps.scheduledAt === undefined) throw new Error("scheduled_atが無いかUTC時刻として不正です");
  const scheduledAt = deps.scheduledAt;
  const expectedCron = kind === "stocks" ? DISPATCH_CRON : kind === "context"
    ? CONTEXT_DISPATCH_CRON : kind === "moneyflow" ? MONEYFLOW_DISPATCH_CRON : kind === "vwap" ? VWAP_DISPATCH_CRON : CATCHUP_DISPATCH_CRON;
  if (deps.cron !== expectedCron) throw new Error("dispatch の種別と cron が一致しません");
  const key = kind === "stocks" ? receiptKey(deps.scheduledDate) : kind === "context"
    ? contextReceiptKey(deps.scheduledDate) : kind === "moneyflow" ? moneyflowReceiptKey(deps.scheduledDate) : kind === "vwap" ? vwapReceiptKey(deps.scheduledDate) : catchupReceiptKey(deps.scheduledDate);
  const workflow = kind === "catchup" ? "catchup.yml" : kind === "moneyflow" ? "moneyflow.yml" : kind === "vwap" ? "vwap-ingest.yml" : WORKFLOW_FILE;
  const inputs: Record<string, string> = kind === "moneyflow" ? { only: "independent", scheduled_date: deps.scheduledDate, scheduled_at: scheduledAt } : {
    target: kind === "stocks" ? DISPATCH_TARGET : kind === "context" ? CONTEXT_DISPATCH_TARGET : kind === "vwap" ? "scheduled-daily-intra" : "scheduled-catchup",
    scheduled_date: deps.scheduledDate,
    scheduled_at: scheduledAt,
    ...(kind === "vwap" ? { daily_session_source: "yahoo-direct" } : {}),
  };
  // 受付の遅れはreceiptの5分slot検査で二重起動にしない。claimはR2の条件付きPUTのまま。
  return runWorkflowDispatch({ ...deps, scheduledAt: undefined, key, workflow, inputs });
}

/** 起動資格確定後のR2 claim→POST1回→CASを全定時workflowで共有する。 */
export async function runWorkflowDispatch(deps: DispatchDeps & {
  key: string; workflow: string; inputs: Record<string, string>; scheduledAt?: string;
  claimWindowMs?: number;
}): Promise<DispatchOutcome> {
  const key = deps.key;
  const slot = deps.scheduledAt === undefined ? {} : { scheduledAt: deps.scheduledAt };
  const { claimed, etag } = await claimReceipt(deps.bucket, key, {
    version: RECEIPT_VERSION,
    scheduledDate: deps.scheduledDate,
    ...slot,
    cron: deps.cron,
    status: "claimed",
    claimedAt: new Date(deps.nowMs).toISOString(),
  });
  if (!claimed || etag === null) {
    // blind に正常 return しない。既存 receipt を読戻し、同予定日・
    // valid schema・dispatched・同 run 対応のときだけ正常 duplicate。
    // claimed/unknown/破損は error 継続 (再 POST はしない)。
    const existing = await deps.bucket.get(key);
    if (existing === null) {
      throw new Error(`duplicate の読戻しで receipt が消えています: ${key}`);
    }
    const receipt = parseStoredReceipt(
      await existing.text(),
      key,
      deps.scheduledDate,
      deps.cron,
      deps.scheduledAt,
      deps.claimWindowMs
    );
    const workflowRunId = receipt.workflowRunId;
    console.info(
      `[stock-scheduler] dispatch duplicate のため POST なし:` +
        ` date=${deps.scheduledDate} run_id=${workflowRunId}`
    );
    return { status: "duplicate", workflowRunId };
  }
  const details = await postWorkflowDispatch(deps.fetchFn, deps.token, deps.workflow, deps.inputs);
  await saveDispatchResult(deps.bucket, key, etag, {
    version: RECEIPT_VERSION,
    scheduledDate: deps.scheduledDate,
    ...slot,
    cron: deps.cron,
    status: "dispatched",
    claimedAt: new Date(deps.nowMs).toISOString(),
    // POST 完了の実時刻は actual clock を保持する (証拠の正確性のため
    // claim/start 時刻で置換しない)。
    dispatchedAt: new Date(Date.now()).toISOString(),
    workflowRunId: details.workflowRunId,
    runUrl: details.runUrl,
    htmlUrl: details.htmlUrl,
  });
  console.info(
    `[stock-scheduler] dispatch 完了: date=${deps.scheduledDate}` +
      ` run_id=${details.workflowRunId}`
  );
  return { status: "dispatched", workflowRunId: details.workflowRunId };
}

export interface RunJobStep {
  name: string;
  status: string;
  conclusion: string | null;
  completed_at: string | null;
  started_at?: string | null;
}

export interface RunJob {
  name: string;
  status: string;
  conclusion: string | null;
  run_id: number;
  steps?: RunJobStep[];
}

function requiredJobString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Jobs API の ${field} が空でない文字列ではありません`);
  }
  return value;
}

/** 未完了の null/省略は正当な状態。別の型を結果不明へ置き換えない。 */
function nullableJobString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return requiredJobString(value, field);
}

/**
 * Link ヘッダの rel=next を、固定 https api.github.com・対象 repo・
 * 同 run ID・jobs path に限定して辿る。外部 origin/HTTP へ Bearer を
 * 送らない。不正は throw (無視して成功にしない)。
 */
function nextPageUrl(linkHeader: string | null, runId: number): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim());
    if (m) {
      let url: URL;
      try {
        url = new URL(m[1]);
      } catch {
        throw new Error("Jobs API の next ページ URL が不正です");
      }
      if (
        url.protocol !== "https:" ||
        url.host !== "api.github.com" ||
        url.pathname !==
          `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/runs/${runId}/jobs`
      ) {
        throw new Error("Jobs API の next ページが対象外 origin/path です");
      }
      return url.toString();
    }
  }
  return null;
}

/**
 * workflow run の jobs を全ページ取得する (Link rel=next を追う)。
 * 非 200・形式不正・run 不一致・循環・ページ数超過は throw
 * (一部だけ見て判定しない。成功偽装なし)。
 */
export async function fetchAllJobs(
  fetchFn: typeof fetch,
  token: string,
  runId: number
): Promise<RunJob[]> {
  if (!Number.isSafeInteger(runId) || runId <= 0) {
    throw new Error("Jobs API の run ID が正の整数ではありません");
  }
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    Authorization: `Bearer ${token}`,
    "User-Agent": GITHUB_USER_AGENT,
  };
  let url: string | null =
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}` +
    `/actions/runs/${runId}/jobs?per_page=100`;
  const jobs: RunJob[] = [];
  const seen = new Set<string>();
  let pages = 0;
  while (url !== null) {
    if (seen.has(url)) {
      throw new Error("Jobs API の pagination が循環しています");
    }
    seen.add(url);
    pages += 1;
    if (pages > MAX_JOB_PAGES) {
      throw new Error(
        `Jobs API のページ数が上限 (${MAX_JOB_PAGES}) を超過しました`
      );
    }
    const res = await fetchFn(url, { headers });
    if (res.status !== 200) {
      throw new Error(`Jobs API が失敗しました: HTTP ${res.status}`);
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new Error("Jobs API の応答が JSON ではありません");
    }
    if (typeof json !== "object" || json === null) {
      throw new Error("Jobs API の応答形式が不正です");
    }
    const page = (json as Record<string, unknown>)["jobs"];
    if (!Array.isArray(page)) {
      throw new Error("Jobs API の応答に jobs 配列がありません");
    }
    for (const j of page) {
      if (typeof j !== "object" || j === null) {
        throw new Error("Jobs API の job 要素が不正です");
      }
      const job = j as Record<string, unknown>;
      const name = requiredJobString(job["name"], "job name");
      const status = requiredJobString(job["status"], "job status");
      // receipt/run 対応: 別 run の job が混ざったら検証しない。
      if (job["run_id"] !== runId) {
        throw new Error("Jobs API に別 run の job が混ざっています");
      }
      const rawSteps = job["steps"];
      let steps: RunJobStep[] | undefined;
      if (rawSteps !== undefined) {
        if (!Array.isArray(rawSteps)) {
          throw new Error("Jobs API の job steps が配列ではありません");
        }
        steps = rawSteps.map((rawStep: unknown) => {
          if (typeof rawStep !== "object" || rawStep === null || Array.isArray(rawStep)) {
            throw new Error("Jobs API の step 要素が不正です");
          }
          const step = rawStep as Record<string, unknown>;
          return {
            name: requiredJobString(step["name"], "step name"),
            status: requiredJobString(step["status"], "step status"),
            conclusion: nullableJobString(step["conclusion"], "step conclusion"),
            completed_at: nullableJobString(step["completed_at"], "step completed_at"),
            ...(step["started_at"] === undefined ? {} : { started_at: nullableJobString(step["started_at"], "step started_at") }),
          };
        });
      }
      jobs.push({ name, status, conclusion: nullableJobString(job["conclusion"], "job conclusion"), run_id: runId, steps });
    }
    url = nextPageUrl(res.headers.get("Link"), runId);
  }
  return jobs;
}

function stepCompletedAtMs(step: RunJobStep, what: string): number {
  if (step.completed_at === null) {
    throw new Error(`${what} の completed_at がありません (結果不明)`);
  }
  const ms = Date.parse(step.completed_at);
  if (!Number.isFinite(ms)) {
    throw new Error(`${what} の completed_at が時刻として不正です`);
  }
  return ms;
}

function utcClock(spec: string): string {
  const match = /^(\d{2}:\d{2}):\d{2}\.\d{3}Z$/.exec(spec);
  if (match === null) throw new Error(`完了窓の時刻が不正です: ${spec}`);
  return match[1];
}

export interface ReadcheckVerdict {
  stockCompletedAt: string;
}

/**
 * 期限 readcheck の純粋判定。次を全て満たすときのみ成功:
 * - job `sync` がちょうど 1 件・completed・conclusion success
 * - step `stock daily sync` が completed・success・completed_at が
 *   同日 09:00 UTC 以降 14:30 UTC 以前 (古い別日の成功を通さない。
 *   14:30 UTC = D 23:30 JST より後は null 帯に入った run なので成功にしない)
 * - step `許容内失敗があれば Issue にコメント` が SKIPPED
 *   (success = 許容内失敗ありの false-green。欠落も error)
 * それ以外は全て throw (Workers Logs/Cron Events に error として残る)。
 */
export function evaluateReadcheck(
  jobs: RunJob[],
  scheduledDate: string
): ReadcheckVerdict {
  const cutoffMs = Date.parse(`${scheduledDate}T${COMPLETION_CUTOFF_TIME}`);
  const floorMs = Date.parse(`${scheduledDate}T${COMPLETION_FLOOR_TIME}`);
  const syncJobs = jobs.filter((j) => j.name === JOB_NAME_SYNC);
  if (syncJobs.length === 0) {
    throw new Error(`job '${JOB_NAME_SYNC}' が見つかりません`);
  }
  if (syncJobs.length > 1) {
    throw new Error(`job '${JOB_NAME_SYNC}' が複数あります (曖昧)`);
  }
  const job = syncJobs[0];
  if (job.status !== "completed") {
    throw new Error(`job '${JOB_NAME_SYNC}' が未完了です: status=${job.status}`);
  }
  if (job.conclusion !== "success") {
    throw new Error(
      `job '${JOB_NAME_SYNC}' が成功ではありません: conclusion=${job.conclusion}`
    );
  }
  const steps = job.steps ?? [];
  const stockSteps = steps.filter((s) => s.name === STEP_STOCK);
  if (stockSteps.length === 0) {
    throw new Error(`step '${STEP_STOCK}' が見つかりません`);
  }
  if (stockSteps.length !== 1) {
    throw new Error(`step '${STEP_STOCK}' が複数あります (曖昧)`);
  }
  const stock = stockSteps[0];
  if (stock.status !== "completed" || stock.conclusion !== "success") {
    throw new Error(
      `step '${STEP_STOCK}' が成功完了ではありません:` +
        ` status=${stock.status} conclusion=${stock.conclusion}`
    );
  }
  const stockMs = stepCompletedAtMs(stock, `step '${STEP_STOCK}'`);
  if (stockMs < floorMs) {
    throw new Error(
      `step '${STEP_STOCK}' の完了が同日 ${utcClock(COMPLETION_FLOOR_TIME)} UTC より前です (別日の成功):` +
        ` completed_at=${stock.completed_at}`
    );
  }
  if (stockMs > cutoffMs) {
    throw new Error(
      `step '${STEP_STOCK}' の完了が ${utcClock(COMPLETION_CUTOFF_TIME)} UTC を超過しました:` +
        ` completed_at=${stock.completed_at}`
    );
  }
  const comments = steps.filter((s) => s.name === STEP_TOLERATED_COMMENT);
  if (comments.length === 0) {
    throw new Error(`step '${STEP_TOLERATED_COMMENT}' が見つかりません`);
  }
  if (comments.length !== 1) {
    throw new Error(`step '${STEP_TOLERATED_COMMENT}' が複数あります (曖昧)`);
  }
  const comment = comments[0];
  if (comment.conclusion !== "skipped") {
    throw new Error(
      `許容内失敗の疑い (false-green): step '${STEP_TOLERATED_COMMENT}'` +
        ` が SKIPPED ではありません: conclusion=${comment.conclusion}`
    );
  }
  return { stockCompletedAt: stock.completed_at as string };
}

/** 検証済みの dispatched receipt (全必須 field あり)。 */
export interface ValidDispatchedReceipt {
  version: typeof RECEIPT_VERSION;
  scheduledDate: string;
  cron: string;
  status: "dispatched";
  claimedAt: string;
  dispatchedAt: string;
  workflowRunId: number;
  runUrl: string;
  htmlUrl: string;
}

/**
 * 保存済み receipt の厳密 parse (duplicate 読戻しと readcheck で共用)。
 * 実 caller は全必須 field を保存するため互換 fallback なし。
 * claimed は未完了として error 継続 (正常 duplicate にしない)。
 */
function parseStoredReceipt(
  text: string,
  key: string,
  expectedDate: string,
  expectedCron: string,
  expectedAt?: string,
  claimWindowMs = 300_000
): ValidDispatchedReceipt {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`receipt の JSON が不正です: ${key}`);
  }
  if (typeof json !== "object" || json === null) {
    throw new Error(`receipt の形式が不正です: ${key}`);
  }
  const r = json as Record<string, unknown>;
  if (r["version"] !== RECEIPT_VERSION) {
    throw new Error(`receipt の version が未知です: ${key}`);
  }
  if (r["status"] === "claimed") {
    throw new Error(`dispatch 未完了の receipt です: ${key}`);
  }
  if (r["status"] !== "dispatched") {
    throw new Error(`receipt の status が未知です: ${key}`);
  }
  if (typeof r["scheduledDate"] !== "string") {
    throw new Error(`receipt に scheduledDate がありません: ${key}`);
  }
  if (r["scheduledDate"] !== expectedDate) {
    throw new Error(`receipt の日付不一致: ${key}`);
  }
  if (r["cron"] !== expectedCron) {
    throw new Error(`receipt の cron が dispatch ではありません: ${key}`);
  }
  if (expectedAt !== undefined && r["scheduledAt"] !== expectedAt) {
    throw new Error(`receipt の予定slotが一致しません: ${key}`);
  }
  const claimedMs =
    typeof r["claimedAt"] === "string" ? Date.parse(r["claimedAt"]) : NaN;
  if (!Number.isFinite(claimedMs)) {
    throw new Error(`receipt の claimedAt が時刻として不正です: ${key}`);
  }
  const dispatchedMs =
    typeof r["dispatchedAt"] === "string" ? Date.parse(r["dispatchedAt"]) : NaN;
  if (!Number.isFinite(dispatchedMs)) {
    throw new Error(`receipt の dispatchedAt が時刻として不正です: ${key}`);
  }
  if (
    utcDate(claimedMs) !== expectedDate ||
    utcDate(dispatchedMs) !== expectedDate
  ) {
    throw new Error(`receipt の時刻が予定日と一致しません: ${key}`);
  }
  if (expectedAt !== undefined && (claimedMs < Date.parse(expectedAt) || claimedMs > Date.parse(expectedAt) + claimWindowMs)) {
    throw new Error(`receipt のclaimが予定slotの受付外です: ${key}`);
  }
  if (claimedMs > dispatchedMs) {
    throw new Error(`receipt の時刻順序が不正です: ${key}`);
  }
  if (
    !Number.isSafeInteger(r["workflowRunId"]) ||
    (r["workflowRunId"] as number) <= 0
  ) {
    throw new Error(`receipt の workflow_run_id が不正です: ${key}`);
  }
  const workflowRunId = r["workflowRunId"] as number;
  const runUrl = assertRunUrl(
    r["runUrl"],
    "run_url",
    "api.github.com",
    workflowRunId,
    "receipt"
  );
  const htmlUrl = assertRunUrl(
    r["htmlUrl"],
    "html_url",
    "github.com",
    workflowRunId,
    "receipt"
  );
  return {
    version: RECEIPT_VERSION,
    scheduledDate: expectedDate,
    cron: expectedCron,
    status: "dispatched",
    claimedAt: r["claimedAt"] as string,
    dispatchedAt: r["dispatchedAt"] as string,
    workflowRunId,
    runUrl,
    htmlUrl,
  };
}

export async function runDeadlineReadcheck(deps: {
  bucket: SchedulerBucket;
  token: string;
  scheduledDate: string;
  fetchFn: typeof fetch;
}): Promise<ReadcheckVerdict> {
  const key = receiptKey(deps.scheduledDate);
  const obj = await deps.bucket.get(key);
  if (obj === null) {
    throw new Error(`receipt がありません (dispatch 未実行の疑い): ${key}`);
  }
  const receipt = parseStoredReceipt(await obj.text(), key, deps.scheduledDate, DISPATCH_CRON);
  const jobs = await fetchAllJobs(deps.fetchFn, deps.token, receipt.workflowRunId);
  const verdict = evaluateReadcheck(jobs, deps.scheduledDate);
  console.info(
    `[stock-scheduler] readcheck OK: date=${deps.scheduledDate}` +
      ` run_id=${receipt.workflowRunId} stock_completed_at=${verdict.stockCompletedAt}`
  );
  return verdict;
}

export interface ContextReadcheckVerdict {
  contextCompletedAt: string;
}

/** マクロ成功だけを確認し、株式や資金フローの成功へ読み替えない。 */
export function evaluateContextReadcheck(jobs: RunJob[], scheduledDate: string): ContextReadcheckVerdict {
  const sync = jobs.filter((job) => job.name === JOB_NAME_SYNC);
  if (sync.length !== 1 || sync[0].status !== "completed" || sync[0].conclusion !== "success") {
    throw new Error("context sync job が一意の成功完了ではありません");
  }
  const steps = sync[0].steps;
  if (!steps) throw new Error("context sync job の steps がありません");
  const context = steps.filter((step) => step.name === "market context sync");
  if (context.length !== 1 || context[0].status !== "completed" || context[0].conclusion !== "success") {
    throw new Error("market context sync が一意の成功完了ではありません");
  }
  const done = stepCompletedAtMs(context[0], "market context sync");
  const floor = Date.parse(`${scheduledDate}T21:00:00.000Z`);
  const cutoff = Date.parse(`${scheduledDate}T22:00:00.000Z`);
  if (!Number.isFinite(floor) || done < floor || done > cutoff) {
    throw new Error("market context sync の完了が同日21:00〜22:00 UTCの範囲外です");
  }
  const stocks = steps.filter((step) => step.name === STEP_STOCK);
  const moneyflow = jobs.filter((job) => job.name === "moneyflow");
  if (stocks.length !== 1 || stocks[0].conclusion !== "skipped" ||
      moneyflow.length !== 1 || moneyflow[0].conclusion !== "skipped") {
    throw new Error("context-only の株式・moneyflow skip を証明できません");
  }
  return { contextCompletedAt: context[0].completed_at as string };
}

export async function runContextDeadlineReadcheck(deps: {
  bucket: SchedulerBucket; token: string; scheduledDate: string; fetchFn: typeof fetch;
}): Promise<ContextReadcheckVerdict> {
  const key = contextReceiptKey(deps.scheduledDate);
  const obj = await deps.bucket.get(key);
  if (obj === null) throw new Error(`context receipt がありません: ${key}`);
  const receipt = parseStoredReceipt(await obj.text(), key, deps.scheduledDate, CONTEXT_DISPATCH_CRON);
  const jobs = await fetchAllJobs(deps.fetchFn, deps.token, receipt.workflowRunId);
  const verdict = evaluateContextReadcheck(jobs, deps.scheduledDate);
  console.info(`[stock-scheduler] context readcheck OK: date=${deps.scheduledDate} run_id=${receipt.workflowRunId} context_completed_at=${verdict.contextCompletedAt}`);
  return verdict;
}

export interface MoneyflowReadcheckVerdict { moneyflowCompletedAt: string }

export interface CatchupReadcheckVerdict { tdnetCompletedAt: string; edinetCompletedAt: string }

/** 受付や部分成功を完了と呼ばず、同日の両source成功とLinux writer停止を確認する。 */
export function evaluateCatchupReadcheck(jobs: RunJob[], scheduledDate: string): CatchupReadcheckVerdict {
  const catchup = jobs.filter((job) => job.name === "catchup");
  const biztag = jobs.filter((job) => job.name === "biztag");
  if (jobs.length !== 2 || catchup.length !== 1 || catchup[0].status !== "completed" || catchup[0].conclusion !== "success" ||
      biztag.length !== 1 || biztag[0].status !== "completed" || biztag[0].conclusion !== "skipped") {
    throw new Error("catchup成功完了とbiztag skipを一意に証明できません");
  }
  const floor = Date.parse(`${scheduledDate}T${CATCHUP_START_TIME}`);
  const cutoff = Date.parse(`${scheduledDate}T${CATCHUP_COMPLETION_CUTOFF_TIME}`);
  const completions = ["catchup起動資格", "ir-catalog TDnet catchup", "yuho-quant EDINET catchup (受注 + 海外売上)"].map((name) => {
    const steps = catchup[0].steps?.filter((step) => step.name === name);
    if (!steps || steps.length !== 1 || steps[0].status !== "completed" || steps[0].conclusion !== "success") {
      throw new Error(`${name}が一意の成功完了ではありません`);
    }
    const ms = stepCompletedAtMs(steps[0], name);
    if (!Number.isFinite(floor) || ms < floor || ms > cutoff) throw new Error(`${name}の完了が同日19時起動/19:54 JST完了窓の範囲外です`);
    return { ms, at: steps[0].completed_at as string };
  });
  if (completions[0].ms > completions[1].ms || completions[1].ms > completions[2].ms) throw new Error("catchupの起動資格→TDnet→EDINET完了順序が不正です");
  return { tdnetCompletedAt: completions[1].at, edinetCompletedAt: completions[2].at };
}

export async function runCatchupDeadlineReadcheck(deps: {
  bucket: SchedulerBucket; token: string; scheduledDate: string; fetchFn: typeof fetch;
}): Promise<CatchupReadcheckVerdict> {
  const key = catchupReceiptKey(deps.scheduledDate);
  const obj = await deps.bucket.get(key);
  if (obj === null) throw new Error(`catchup receiptがありません（当日dispatch未確認）: ${key}`);
  const receipt = parseStoredReceipt(await obj.text(), key, deps.scheduledDate, CATCHUP_DISPATCH_CRON);
  const jobs = await fetchAllJobs(deps.fetchFn, deps.token, receipt.workflowRunId);
  const verdict = evaluateCatchupReadcheck(jobs, deps.scheduledDate);
  console.info(`[stock-scheduler] catchup readcheck OK: date=${deps.scheduledDate} run_id=${receipt.workflowRunId} edinet_completed_at=${verdict.edinetCompletedAt}`);
  return verdict;
}

export async function runMoneyflowDeadlineReadcheck(deps: {
  bucket: SchedulerBucket; token: string; scheduledDate: string; fetchFn: typeof fetch;
}): Promise<MoneyflowReadcheckVerdict> {
  const key = moneyflowReceiptKey(deps.scheduledDate);
  const obj = await deps.bucket.get(key);
  if (obj === null) throw new Error(`moneyflow receipt がありません: ${key}`);
  const receipt = parseStoredReceipt(await obj.text(), key, deps.scheduledDate, MONEYFLOW_DISPATCH_CRON);
  const jobs = await fetchAllJobs(deps.fetchFn, deps.token, receipt.workflowRunId);
  const { moneyflowCompletedAt } = evaluateMoneyflowReadcheck(jobs, deps.scheduledDate);
  console.info(`[stock-scheduler] moneyflow readcheck OK: date=${deps.scheduledDate} run_id=${receipt.workflowRunId} completed_at=${moneyflowCompletedAt}`);
  return { moneyflowCompletedAt };
}

/** 両laneの実producerと実summary joinだけを受け入れる。片側skip/unknownを成功にしない。 */
export function evaluateMoneyflowReadcheck(jobs: RunJob[], scheduledDate: string): MoneyflowReadcheckVerdict {
  if (jobs.length !== 3) throw new Error("独立moneyflowの両producerとjoin jobがありません");
  const floor = Date.parse(`${scheduledDate}T09:15:00.000Z`), cutoff = Date.parse(`${scheduledDate}T14:40:00.000Z`);
  let producersDone = -Infinity;
  let joinCompletedAt: string | undefined;
  for (const [jobName, name] of [
    ["ingest-non-yahoo", "moneyflow ingest (non-yahoo)"],
    ["ingest-yahoo", "moneyflow ingest (yahoo)"],
    ["join", "moneyflow source join"],
  ]) {
    const matches = jobs.filter(job => job.name === jobName);
    if (matches.length !== 1 || matches[0].status !== "completed" || matches[0].conclusion !== "success") {
      throw new Error("独立moneyflow producer jobが一意の成功完了ではありません");
    }
    const steps = matches[0].steps?.filter(step => step.name === name);
    if (!steps || steps.length !== 1 || steps[0].status !== "completed" || steps[0].conclusion !== "success") {
      throw new Error("独立moneyflow producer/join stepが一意の成功完了ではありません");
    }
    const started = typeof steps[0].started_at === "string" ? Date.parse(steps[0].started_at) : NaN;
    const done = stepCompletedAtMs(steps[0], name);
    if (!Number.isFinite(started) || started < floor || done < started || done > cutoff ||
        (jobName === "join" && started < producersDone)) {
      throw new Error("独立moneyflowの開始/完了/順序が同日18:15〜23:40 JSTの範囲外です");
    }
    if (jobName !== "join") producersDone = Math.max(producersDone, done);
    if (name === "moneyflow source join") joinCompletedAt = steps[0].completed_at as string;
  }
  if (joinCompletedAt === undefined) throw new Error("独立moneyflow全source joinがありません");
  return { moneyflowCompletedAt: joinCompletedAt };
}

export interface VwapReadcheckVerdict { vwapCompletedAt: string }

/** 受付/部分成功は完了にせず、定時の日足+5分足だけの一意成功・開始/終了窓を確認。 */
export function evaluateVwapReadcheck(jobs: RunJob[], scheduledDate: string): VwapReadcheckVerdict {
  if (jobs.length !== 3) throw new Error("VWAP定時3jobが一意ではありません");
  const phases = [
    ["ingest", "VWAP daily + intra → R2"],
    ["ingest-intra", "VWAP scheduled intra → R2"],
    ["scheduled-result", "VWAP scheduled result"],
  ].map(([jobName, stepName]) => {
    const matches = jobs.filter(job => job.name === jobName);
    if (matches.length !== 1 || matches[0].status !== "completed" || matches[0].conclusion !== "success") {
      throw new Error(`VWAP ${jobName} jobが一意の成功完了ではありません`);
    }
    const steps = matches[0].steps?.filter(step => step.name === stepName);
    if (!steps || steps.length !== 1 || steps[0].status !== "completed" || steps[0].conclusion !== "success") {
      throw new Error(`VWAP ${stepName} stepが一意の成功完了ではありません`);
    }
    const started = typeof steps[0].started_at === "string" ? Date.parse(steps[0].started_at) : NaN;
    const done = stepCompletedAtMs(steps[0], stepName);
    return { job: matches[0], step: steps[0], started, done };
  });
  const window = scheduledVwapWindow(scheduledDate);
  // 日足stepの開始は17:10受付窓ではなく、17:00以降かつ23:30の新規IOより前。
  if (!Number.isFinite(phases[0].started) || phases[0].started < window.start || phases[0].started >= window.completionCutoff) {
    throw new Error("VWAP開始期限の範囲外です (予定日17:00 JST以降、23:30 JSTより前)");
  }
  let previous = phases[0].started;
  const cutoff = window.completionCutoff;
  for (const phase of phases) {
    if (!Number.isFinite(phase.started) || phase.started < previous || phase.done < phase.started || phase.done > cutoff) {
      throw new Error("VWAP日足→5分足→結果の順序/同日23:30 JST期限が不正です");
    }
    previous = phase.done;
  }
  const admission = phases[0].job.steps?.filter(step => step.name === "定時日足の同run受付記録を保存");
  if (!admission || admission.length !== 1 || admission[0].status !== "completed" || admission[0].conclusion !== "success") {
    throw new Error("VWAP同run受付artifactの保存成功を証明できません");
  }
  const admitted = stepCompletedAtMs(admission[0], "同run受付artifact");
  if (admitted < phases[0].done || admitted > phases[1].started) throw new Error("VWAP受付artifactと5分足の順序が不正です");
  for (const name of ["VWAP intra backfill → R2", "VWAP margin (daily) → R2"]) {
    const other = phases[0].job.steps?.filter(step => step.name === name);
    if (!other || other.length !== 1 || other[0].conclusion !== "skipped") {
      throw new Error("VWAP定時scope外stepのskipを証明できません");
    }
  }
  return { vwapCompletedAt: phases[2].step.completed_at as string };
}

export async function runVwapDeadlineReadcheck(deps: {
  bucket: SchedulerBucket; token: string; scheduledDate: string; fetchFn: typeof fetch;
}): Promise<VwapReadcheckVerdict> {
  const key = vwapReceiptKey(deps.scheduledDate);
  const obj = await deps.bucket.get(key);
  if (obj === null) throw new Error(`VWAP receiptがありません: ${key}`);
  const receipt = parseStoredReceipt(await obj.text(), key, deps.scheduledDate, VWAP_DISPATCH_CRON);
  const jobs = await fetchAllJobs(deps.fetchFn, deps.token, receipt.workflowRunId);
  const verdict = evaluateVwapReadcheck(jobs, deps.scheduledDate);
  console.info(`[stock-scheduler] VWAP readcheck OK: date=${deps.scheduledDate} run_id=${receipt.workflowRunId} completed_at=${verdict.vwapCompletedAt}`);
  return verdict;
}

/**
 * Worker scheduled handler 本体。cron で分岐し、各 await を await する。
 * 失敗は throw (Cron Events に error として残る)。Dispatch 受付は
 * 同期完了ではない — 完了の判定は readcheck のみが行う。
 */
export async function handleStockScheduled(
  controller: ScheduledControllerLike,
  env: SchedulerEnv,
  deps: { fetchFn?: typeof fetch; nowMs?: number } = {}
): Promise<DispatchOutcome | ReadcheckVerdict | ContextReadcheckVerdict | MoneyflowReadcheckVerdict | CatchupReadcheckVerdict | VwapReadcheckVerdict | { status: "market_closed"; scheduledDate: string; closures: MarketClosure[] }> {
  const route = routeCron(controller.cron);
  const nowMs = deps.nowMs ?? Date.now();
  const scheduledDate = resolveRunDate(route, controller.scheduledTime, nowMs);
  const scheduledAt = scheduledAtIso(controller.scheduledTime);
  if (route === "catchup-dispatch" || route === "catchup-readcheck") {
    const common = { bucket: env.BUCKET, token: schedulerToken(env), scheduledDate, fetchFn: deps.fetchFn ?? fetch };
    return route === "catchup-dispatch"
      ? runCatchupDispatch({ ...common, cron: controller.cron, nowMs, scheduledAt })
      : runCatchupDeadlineReadcheck(common);
  }
  if (route === "moneyflow-dispatch" || route === "moneyflow-readcheck") {
    const common = { bucket: env.BUCKET, token: schedulerToken(env), scheduledDate, fetchFn: deps.fetchFn ?? fetch };
    return route === "moneyflow-dispatch"
      ? runScheduledDispatch({ ...common, cron: controller.cron, nowMs, scheduledAt }, "moneyflow")
      : runMoneyflowDeadlineReadcheck(common);
  }
  // 株式はJPX、同日マクロはJPX+NYSE双方の取引日だけが対象。
  // 公表休場は取得失敗と区別し、原本日付や価格を代用しない。
  const markets = route.startsWith("context-") ? ["JPX", "NYSE"] as const : ["JPX"] as const;
  const closures = markets.flatMap((market) => {
    const closure = marketClosure(market, scheduledDate);
    return closure === null ? [] : [closure];
  });
  if (closures.length > 0) {
    console.info(`[stock-scheduler] market_closed: ${JSON.stringify({ scheduledDate, closures })}`);
    return { status: "market_closed", scheduledDate, closures };
  }
  const token = schedulerToken(env);
  const fetchFn = deps.fetchFn ?? fetch;
  if (route === "vwap-dispatch" || route === "vwap-readcheck") {
    const common = { bucket: env.BUCKET, token, scheduledDate, fetchFn };
    return route === "vwap-dispatch"
      ? runVwapDispatch({ ...common, cron: controller.cron, nowMs, scheduledAt })
      : runVwapDeadlineReadcheck(common);
  }
  if (route === "dispatch" || route === "context-dispatch") {
    console.info(
      `[stock-scheduler] dispatch 開始: date=${scheduledDate} cron=${controller.cron}`
    );
    return runScheduledDispatch({
      bucket: env.BUCKET,
      token,
      cron: controller.cron,
      scheduledDate,
      scheduledAt,
      nowMs,
      fetchFn,
    }, route === "dispatch" ? "stocks" : "context");
  }
  console.info(
    `[stock-scheduler] readcheck 開始: date=${scheduledDate} cron=${controller.cron}`
  );
  const readcheck = route === "readcheck" ? runDeadlineReadcheck : runContextDeadlineReadcheck;
  return readcheck({
    bucket: env.BUCKET,
    token,
    scheduledDate,
    fetchFn,
  });
}
