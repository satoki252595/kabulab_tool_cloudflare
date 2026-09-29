/**
 * 株式 sync の CF スケジューラ (Worker scheduled handler 本体)。
 *
 * 背景: GitHub Actions の schedule イベントが 250/318 分の生成遅配を 2 回連続で
 * 起こし (runner 待ちは 3 秒)、06:00 JST 基準 guard が正しく STOP した。
 * 株式の起動時刻だけを Cloudflare Cron Trigger へ移し、実実行は従来どおり
 * GitHub Actions (stock-sync.yml workflow_dispatch) に任せる。cron 前倒しは
 * Yahoo 確定証拠なしで不採用。詳細は docs/stock-scheduler.md。
 *
 * Worker-safe: node 専用 import なし。env/bucket/fetch は引数で受ける。
 * ログに秘密 (token)・リクエスト URL・run URL の値は出さない。
 */

export const DISPATCH_CRON = "13 17 * * MON-FRI";
export const READCHECK_CRON = "5 21 * * MON-FRI";

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
 * 落とす。21:00 UTC 完了期限への波及を待たない。
 */
export const DISPATCH_START_DEADLINE_MINUTES = 60;

/** 株式 step が完了すべき UTC 日内時刻 (06:00 JST 基準 = 21:00 UTC)。 */
export const COMPLETION_CUTOFF_TIME = "21:00:00.000Z";
/** 株式 step 完了の下限 (同日 dispatch 予定時刻)。古い別日の成功を通さない。 */
export const COMPLETION_FLOOR_TIME = "17:13:00.000Z";

/**
 * Jobs API の最大ページ数。全頁が必要だが、50 subrequests 境界に合わせ
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

export type SchedulerRoute = "dispatch" | "readcheck";

export interface StockReceipt {
  version: number;
  scheduledDate: string;
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
  throw new Error(
    `未知の cron です: ${cron} (想定: ${DISPATCH_CRON} / ${READCHECK_CRON})`
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
  if (route === "dispatch") {
    const delayMs = nowMs - scheduledTimeMs;
    if (delayMs > DISPATCH_START_DEADLINE_MINUTES * 60 * 1000) {
      throw new Error(
        `dispatch 開始期限を超過しました: 遅延=${Math.floor(delayMs / 60000)}分` +
          ` (上限 ${DISPATCH_START_DEADLINE_MINUTES}分)`
      );
    }
  }
  return scheduledDate;
}

export function receiptKey(scheduledDate: string): string {
  return `${RECEIPT_PREFIX}${scheduledDate}.json`;
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
  const res = await fetchFn(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}` +
      `/actions/workflows/${WORKFLOW_FILE}/dispatches`,
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
        inputs: { target: DISPATCH_TARGET, scheduled_date: scheduledDate },
        return_run_details: true,
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

export async function runStockDispatch(deps: {
  bucket: SchedulerBucket;
  token: string;
  cron: string;
  scheduledDate: string;
  nowMs: number;
  fetchFn: typeof fetch;
}): Promise<DispatchOutcome> {
  const key = receiptKey(deps.scheduledDate);
  const { claimed, etag } = await claimReceipt(deps.bucket, key, {
    version: RECEIPT_VERSION,
    scheduledDate: deps.scheduledDate,
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
      deps.scheduledDate
    );
    const workflowRunId = receipt.workflowRunId;
    console.info(
      `[stock-scheduler] dispatch duplicate のため POST なし:` +
        ` date=${deps.scheduledDate} run_id=${workflowRunId}`
    );
    return { status: "duplicate", workflowRunId };
  }
  const details = await postStockDispatch(
    deps.fetchFn,
    deps.token,
    deps.scheduledDate
  );
  await saveDispatchResult(deps.bucket, key, etag, {
    version: RECEIPT_VERSION,
    scheduledDate: deps.scheduledDate,
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
}

export interface RunJob {
  name: string;
  status: string;
  conclusion: string | null;
  run_id: number;
  steps?: RunJobStep[];
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
      if (typeof job["name"] !== "string") {
        throw new Error("Jobs API の job に name がありません");
      }
      // receipt/run 対応: 別 run の job が混ざったら検証しない。
      if (job["run_id"] !== runId) {
        throw new Error("Jobs API に別 run の job が混ざっています");
      }
      jobs.push({
        name: job["name"] as string,
        status: typeof job["status"] === "string" ? job["status"] : "",
        conclusion:
          typeof job["conclusion"] === "string" ? job["conclusion"] : null,
        run_id: runId,
        steps: Array.isArray(job["steps"])
          ? (job["steps"] as Array<Record<string, unknown>>).map((s) => ({
              name: typeof s["name"] === "string" ? s["name"] : "",
              status: typeof s["status"] === "string" ? s["status"] : "",
              conclusion:
                typeof s["conclusion"] === "string" ? s["conclusion"] : null,
              completed_at:
                typeof s["completed_at"] === "string" ? s["completed_at"] : null,
            }))
          : undefined,
      });
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

export interface ReadcheckVerdict {
  stockCompletedAt: string;
}

/**
 * 期限 readcheck の純粋判定。次を全て満たすときのみ成功:
 * - job `sync` がちょうど 1 件・completed・conclusion success
 * - step `stock daily sync` が completed・success・completed_at が
 *   同日 17:13 UTC 以降 21:00 UTC 以前 (古い別日の成功を通さない)
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
  const stock = steps.find((s) => s.name === STEP_STOCK);
  if (!stock) {
    throw new Error(`step '${STEP_STOCK}' が見つかりません`);
  }
  if (stock.status !== "completed" || stock.conclusion !== "success") {
    throw new Error(
      `step '${STEP_STOCK}' が成功完了ではありません:` +
        ` status=${stock.status} conclusion=${stock.conclusion}`
    );
  }
  const stockMs = stepCompletedAtMs(stock, `step '${STEP_STOCK}'`);
  if (stockMs < floorMs) {
    throw new Error(
      `step '${STEP_STOCK}' の完了が同日 17:13 UTC より前です (別日の成功):` +
        ` completed_at=${stock.completed_at}`
    );
  }
  if (stockMs > cutoffMs) {
    throw new Error(
      `step '${STEP_STOCK}' の完了が 21:00 UTC を超過しました:` +
        ` completed_at=${stock.completed_at}`
    );
  }
  const comment = steps.find((s) => s.name === STEP_TOLERATED_COMMENT);
  if (!comment) {
    throw new Error(`step '${STEP_TOLERATED_COMMENT}' が見つかりません`);
  }
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
  cron: typeof DISPATCH_CRON;
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
  expectedDate: string
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
  if (r["cron"] !== DISPATCH_CRON) {
    throw new Error(`receipt の cron が dispatch ではありません: ${key}`);
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
    cron: DISPATCH_CRON,
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
  const receipt = parseStoredReceipt(await obj.text(), key, deps.scheduledDate);
  const jobs = await fetchAllJobs(deps.fetchFn, deps.token, receipt.workflowRunId);
  const verdict = evaluateReadcheck(jobs, deps.scheduledDate);
  console.info(
    `[stock-scheduler] readcheck OK: date=${deps.scheduledDate}` +
      ` run_id=${receipt.workflowRunId} stock_completed_at=${verdict.stockCompletedAt}`
  );
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
): Promise<DispatchOutcome | ReadcheckVerdict> {
  const route = routeCron(controller.cron);
  const nowMs = deps.nowMs ?? Date.now();
  const scheduledDate = resolveRunDate(route, controller.scheduledTime, nowMs);
  const token = schedulerToken(env);
  const fetchFn = deps.fetchFn ?? fetch;
  if (route === "dispatch") {
    console.info(
      `[stock-scheduler] dispatch 開始: date=${scheduledDate} cron=${controller.cron}`
    );
    return runStockDispatch({
      bucket: env.BUCKET,
      token,
      cron: controller.cron,
      scheduledDate,
      nowMs,
      fetchFn,
    });
  }
  console.info(
    `[stock-scheduler] readcheck 開始: date=${scheduledDate} cron=${controller.cron}`
  );
  return runDeadlineReadcheck({
    bucket: env.BUCKET,
    token,
    scheduledDate,
    fetchFn,
  });
}
