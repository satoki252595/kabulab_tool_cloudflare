/** 株式Actionsの明示direct。既存proxyと同じD1停止行を通し、別transportへ再送しない。 */
import { sharedEnv } from "../../src/shared/env.js";
import { assertD1SingleQueryResponse, d1HttpQueryUrl } from "../../src/shared/db/d1-http-client.js";
import { YahooRateLimitError, rateLimitRetryAt, redactYahooDiagnostic, yahooFetchDirect, type YahooTransport } from "../../src/shared/yahoo/client.js";
import { assertYahooCooldown, checkedYahooDeadline, isAllowedYahooTarget, YahooSharedCooldownError, YAHOO_COOLDOWN_SELECT, YAHOO_COOLDOWN_UPSERT } from "../../src/shared/yahoo/shared-cooldown.js";

// diag(INC-20261029-kabulab_tool_cloudflare-yahoo-cooldown-read-fail): 撤去予定
const COOLDOWN_READ_DIAG_TAG = "[INC-20261029-kabulab_tool_cloudflare-yahoo-cooldown-read-fail]";
/** この SELECT は1回だけ。リトライは足さない。 */
const COOLDOWN_READ_ATTEMPT = 1;
const COOLDOWN_READ_TEXT_CHARS = 200;
const COOLDOWN_READ_BODY_BYTES = 4096;
/** 失敗応答の本文待ちの合計。各 read は開始からの残り時間で打ち切る。 */
const COOLDOWN_READ_BODY_WAIT_MS = 250;

type CooldownReadStage = "fetch" | "http-status" | "json" | "shape";
type CooldownReadTrace = {
  stage: CooldownReadStage;
  httpStatus?: number;
  failedResponse?: Response;
};

function safeNow(): number | undefined {
  try {
    const now = performance.now();
    return Number.isFinite(now) ? now : undefined;
  } catch {
    return undefined;
  }
}

function elapsedMs(started: number | undefined): number | undefined {
  if (started === undefined) return undefined;
  try {
    const ms = performance.now() - started;
    if (!Number.isFinite(ms)) return undefined;
    return Math.max(0, Math.round(ms));
  } catch {
    return undefined;
  }
}

function clipDiag(value: string, maxChars: number): string {
  return Array.from(value).slice(0, maxChars).join("");
}

function collapseDiag(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function d1PathSecrets(d1Url: string): string[] {
  try {
    const parts = new URL(d1Url).pathname.split("/");
    const found: string[] = [];
    const accountAt = parts.indexOf("accounts");
    const accountId = accountAt >= 0 ? parts[accountAt + 1] : undefined;
    const databaseAt = parts.indexOf("database");
    const databaseId = databaseAt >= 0 ? parts[databaseAt + 1] : undefined;
    if (typeof accountId === "string" && accountId.length > 0) found.push(accountId);
    if (typeof databaseId === "string" && databaseId.length > 0 && databaseId !== accountId) found.push(databaseId);
    return found;
  } catch {
    return [];
  }
}

function redactDiag(value: string, secrets: readonly string[]): string {
  let out = redactYahooDiagnostic(value)
    .replace(/\bAuthorization\s*:\s*(?:Bearer\s+\S+|\S+)/gi, "Authorization: [redacted]")
    .replace(/\b(token|api[_-]?key|secret|password)\s*=\s*[^\s&]+/gi, "$1=[redacted]")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[url]");
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    out = out.split(secret).join("[redacted]");
    // SyntaxError は本文先頭だけを引用する。既知の秘密の先頭が残っていたら伏せる。
    if (secret.length < 8) continue;
    const head = secret.slice(0, 8);
    if (out.includes(head)) out = out.split(head).join("[redacted]");
  }
  return out;
}

function errorBits(error: unknown, secrets: readonly string[]): { name: string; message: string } {
  const name = error instanceof Error ? error.name : "NonError";
  const raw = error instanceof Error ? error.message : String(error);
  return {
    name: clipDiag(collapseDiag(redactDiag(name, secrets)), 80),
    message: clipDiag(collapseDiag(redactDiag(raw, secrets)), COOLDOWN_READ_TEXT_CHARS),
  };
}

function causeBits(error: unknown, secrets: readonly string[]): { name: string; message: string } | undefined {
  if (!(error instanceof Error) || !(error.cause instanceof Error) || error.cause === error) return undefined;
  return errorBits(error.cause, secrets);
}

function readKind(trace: CooldownReadTrace, error: unknown): string {
  if (error instanceof Error && error.message === "Yahoo cooldown row missing") return "row-missing";
  if (error instanceof Error && error.message === "Yahoo shared cooldown row is missing or invalid") return "row-invalid";
  if (trace.stage === "http-status") return "http-non-ok";
  if (trace.stage === "json") return "body-parse";
  if (trace.stage === "shape") return "response-shape";
  return "exception";
}

function bodyPrefixDeadline(): {
  promise: Promise<never>;
  close: () => void;
  exceeded: () => boolean;
} {
  let exceeded = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      exceeded = true;
      reject(new Error("body prefix wait exceeded"));
    }, COOLDOWN_READ_BODY_WAIT_MS);
  });
  return {
    promise,
    close() {
      if (timer !== undefined) clearTimeout(timer);
    },
    exceeded: () => exceeded,
  };
}

function readWithCap(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  deadline: Promise<never>,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  // 締め切り後の cancel が read を拒否しても、その拒否はここで受ける。
  const pending = reader.read();
  return new Promise((resolve, reject) => {
    pending.then(resolve, reject);
    deadline.then(() => {}, reject);
  });
}

async function readBodyPrefix(response: Response): Promise<string> {
  const deadline = bodyPrefixDeadline();
  try {
    if (response.body === null) return await Promise.race([response.text(), deadline.promise]);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    let timedOut = false;
    try {
      while (received < COOLDOWN_READ_BODY_BYTES && !deadline.exceeded()) {
        let next: ReadableStreamReadResult<Uint8Array>;
        try {
          next = await readWithCap(reader, deadline.promise);
        } catch (error) {
          if (error instanceof Error && error.message === "body prefix wait exceeded") {
            timedOut = true;
            break;
          }
          throw error;
        }
        if (next.done || !next.value) break;
        if (next.value.byteLength === 0) continue;
        const slice = next.value.subarray(0, COOLDOWN_READ_BODY_BYTES - received);
        chunks.push(slice);
        received += slice.byteLength;
      }
    } finally {
      try { await reader.cancel(); } catch { /* 計測の打ち切りに失敗しても、取れた先頭は返す。 */ }
    }
    if (timedOut && received === 0) throw new Error("body prefix wait exceeded");
    const merged = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder("utf-8", { fatal: false }).decode(merged);
  } finally {
    deadline.close();
  }
}

function cooldownReadDiagLine(
  trace: CooldownReadTrace,
  error: unknown,
  secrets: readonly string[],
  elapsed: number | undefined,
  bodyPrefix?: string,
  bodyError?: { name: string; message: string },
): string {
  const kind = readKind(trace, error);
  const detail: Record<string, string | number> = { kind };
  if (typeof trace.httpStatus === "number") detail.http_status = trace.httpStatus;
  if (bodyPrefix !== undefined) {
    detail.body_prefix = clipDiag(collapseDiag(redactDiag(bodyPrefix, secrets)), COOLDOWN_READ_TEXT_CHARS);
  }
  if (bodyError) {
    detail.body_error_name = bodyError.name;
    detail.body_error_message = bodyError.message;
  }
  if (kind !== "http-non-ok") {
    const bits = errorBits(error, secrets);
    detail.error_name = bits.name;
    detail.error_message = bits.message;
    const cause = causeBits(error, secrets);
    if (cause) {
      detail.cause_name = cause.name;
      detail.cause_message = cause.message;
    }
  }
  if (elapsed !== undefined) detail.elapsed_ms = elapsed;
  detail.attempt = COOLDOWN_READ_ATTEMPT;
  return `${COOLDOWN_READ_DIAG_TAG} ${JSON.stringify(detail)}`;
}

function emitCooldownReadDiag(
  trace: CooldownReadTrace,
  error: unknown,
  secrets: readonly string[],
  elapsed: number | undefined,
  bodyPrefix?: string,
  bodyError?: { name: string; message: string },
): void {
  try {
    console.error(cooldownReadDiagLine(trace, error, secrets, elapsed, bodyPrefix, bodyError));
  } catch {
    // 計測行の失敗では停止例外を変えない
  }
}

export function createStockYahooDirectTransport(): YahooTransport {
  const url = d1HttpQueryUrl(), token = sharedEnv.CLOUDFLARE_API_TOKEN();
  const diagSecrets = [token, ...d1PathSecrets(url)].filter((secret) => secret.length > 0);
  async function query(sql: string, params: number[], trace?: CooldownReadTrace) {
    const response = await fetch(url, { method: "POST", signal: AbortSignal.timeout(60_000),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ sql, params }) });
    if (!response.ok) {
      if (trace) {
        trace.stage = "http-status";
        trace.httpStatus = response.status;
        trace.failedResponse = response;
      }
      throw new Error("Yahoo cooldown D1 request failed");
    }
    if (trace) {
      trace.stage = "json";
      trace.httpStatus = response.status;
    }
    const data: unknown = await response.json();
    if (trace) trace.stage = "shape";
    const rows = assertD1SingleQueryResponse(data);
    return { rows, data: data as { result: [{ meta?: { changes?: unknown } }] } };
  }
  const persist = async (status: number, retryAt: number | null) => {
    if (status !== 429 && status !== 503) throw new Error("Yahoo cooldown status invalid");
    const result = await query(YAHOO_COOLDOWN_UPSERT, [checkedYahooDeadline(retryAt), status]);
    if (result.data.result[0].meta?.changes !== 1) throw new Error("Yahoo cooldown write not acknowledged");
  };
  const fault = () => console.error(JSON.stringify({ event: "yahoo_stock_direct_cooldown_failed",
    operation: "persist", globalCooldownGuaranteed: false }));

  return async (target, beforeRequest) => {
    const parsed = new URL(target);
    if (!isAllowedYahooTarget(parsed, decodeURIComponent(parsed.pathname))) throw new Error("Yahoo direct target is not allowed");
    beforeRequest?.();
    let cooldown;
    const trace: CooldownReadTrace = { stage: "fetch" };
    const started = safeNow();
    try {
      const { rows } = await query(YAHOO_COOLDOWN_SELECT, [], trace);
      if (rows.length !== 1) throw new Error("Yahoo cooldown row missing");
      assertYahooCooldown(rows[0]);
      cooldown = rows[0];
    } catch (error) {
      const elapsed = elapsedMs(started);
      // 本文の待ちは source 時計の確認より後。例外・パース失敗は待ちが無いので先に残す。
      if (trace.stage !== "http-status") emitCooldownReadDiag(trace, error, diagSecrets, elapsed);
      beforeRequest?.(); // 実source/停止時計に達した例外をDB不明へ塗り替えない。
      if (trace.stage === "http-status") {
        try {
          let bodyPrefix: string | undefined;
          let bodyError: { name: string; message: string } | undefined;
          if (trace.failedResponse) {
            try {
              bodyPrefix = await readBodyPrefix(trace.failedResponse);
            } catch (readError) {
              bodyError = errorBits(readError, diagSecrets);
            }
          }
          emitCooldownReadDiag(trace, error, diagSecrets, elapsed, bodyPrefix, bodyError);
        } catch {
          // 計測行の失敗では停止例外を変えない
        }
      }
      throw new YahooSharedCooldownError();
    }
    beforeRequest?.(); // D1待機後にsource期限を再確認する。
    if (Date.now() < cooldown.retry_at_ms) {
      if (cooldown.upstream_status === null) throw new YahooSharedCooldownError();
      return new Response(JSON.stringify({ error: "yahoo shared cooldown active; no upstream request" }), {
        status: cooldown.upstream_status, headers: {
          "Retry-After": String(Math.max(0, Math.ceil((cooldown.retry_at_ms - Date.now()) / 1000))),
          "X-Kabulab-Yahoo-Cooldown": "active", "X-Kabulab-Yahoo-Stage": "shared-cooldown",
        } });
    }
    let response: Response;
    try { response = await yahooFetchDirect(target, beforeRequest); }
    catch (error) {
      if (error instanceof YahooRateLimitError) {
        try {
          if (error.retryAtMs === null && error.retryAfterMs !== null && (!Number.isFinite(error.retryAfterMs) || error.retryAfterMs < 0)) throw new Error("invalid retry delay", { cause: error });
          await persist(error.status, error.retryAtMs !== null ? error.retryAtMs : rateLimitRetryAt(new Response(null, {
            status: error.status, headers: error.retryAfterMs === null ? {} : { "Retry-After": String(Math.ceil(error.retryAfterMs / 1000)) },
          })));
        } catch { fault(); }
      }
      throw error;
    }
    let persistenceFailed = false;
    if (response.status === 429 || response.status === 503) {
      try { await persist(response.status, rateLimitRetryAt(response)); }
      catch { persistenceFailed = true; fault(); }
    }
    // 制限原文をcapture前に失わない。Cookie等はconsumerへ渡さず、実URLは元のまま保持。
    const headers = new Headers({ "X-Kabulab-Yahoo-Status": String(response.status),
      "X-Kabulab-Yahoo-Stage": new URL(target).pathname.startsWith("/v8/") ? "chart" : "quote-summary" });
    for (const name of ["Content-Type", "Retry-After", "Age", "CF-Cache-Status", "CF-Ray"]) {
      const value = response.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    if (persistenceFailed) headers.set("X-Kabulab-Yahoo-Cooldown", "persist-failed");
    const relayed = new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    Object.defineProperty(relayed, "url", { value: response.url });
    return relayed;
  };
}
