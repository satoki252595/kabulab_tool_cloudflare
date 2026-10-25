import { currentScheduledDeadline } from "../scheduled-admission.js";

export interface ArchivedDownloadOptions {
  /** 省略時は既存の未知サイズ読取。0は明示された空ファイルの上限。 */
  maxBytes?: number;
  /** 資格済みmanifest/記録bufferの正確な長さ。上限値だけから時間枠を延ばさない。 */
  expectedBytes?: number;
  signal?: AbortSignal;
  /** URL・署名・原文を含まないGET/読取計数。非通信失敗も通知し、async observerを待つ。 */
  onAttempt?: (event: { attempt: number; phase: "start" | "complete" | "transport-error" | "error"; receivedBytes: number; status?: number }) => unknown;
}

function transportError(error: unknown): boolean {
  if (!(error instanceof TypeError) || error.name !== "TypeError") return false;
  const cause = error.cause as { code?: unknown; name?: unknown } | undefined;
  if (["NotionConfigError", "NotionUnknownResultError", "AssertionError"].includes(String(cause?.name))) return false;
  if (cause !== undefined) return typeof cause?.code === "string" &&
    ["UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"].includes(cause.code);
  return ["fetch failed", "Failed to fetch", "Load failed", "NetworkError when attempting to fetch resource.", "terminated"].includes(error.message);
}

export { transportError as isRetryableTransportError };

function cancelWithoutWaiting(cancel: () => unknown): void {
  try { void Promise.resolve(cancel()).catch(() => {}); } catch { /* STOPは保持し、非協調cancelを待たない。 */ }
}

/** signal非協調のfetch/readも待ち続けない。遅れて完了したoperationにも呼出側で期限を再検査する。 */
async function untilAbort<T>(signal: AbortSignal, operation: () => Promise<T>, cancel?: () => unknown): Promise<T> {
  signal.throwIfAborted();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => { reject(signal.reason); if (cancel !== undefined) cancelWithoutWaiting(cancel); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    signal.throwIfAborted();
    const value = await Promise.race([operation(), aborted]);
    signal.throwIfAborted();
    return value;
  } finally { signal.removeEventListener("abort", onAbort); }
}

/** 同じ保存URLを最大2GET。未知/小サイズは45/90秒、正確な大容量だけ最大300秒。親hardは常に優先。 */
export async function downloadArchivedFile(file: { name: string; url: string }, context: string, options?: ArchivedDownloadOptions): Promise<Uint8Array> {
  const maxBytes = options?.maxBytes;
  const expectedBytes = options?.expectedBytes;
  if (expectedBytes !== undefined && (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 ||
      maxBytes === undefined || expectedBytes > maxBytes)) throw new Error(`${context}: 原本の正確なバイト長が不正/予算と矛盾`);
  if (maxBytes !== undefined) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error(`${context}: 原本読取予算が不正`);
    const url = new URL(file.url);
    const host = url.hostname;
    if (url.protocol !== "https:" || url.username || url.password ||
      !(host === "file.notion.so" || host.endsWith(".notion.so") || host.endsWith(".notionso.com") ||
        host === "prod-files-secure.s3.us-west-2.amazonaws.com" || host === "s3.us-west-2.amazonaws.com")) {
      throw new Error(`${context}: Notion-hosted原本のURL資格が不正`);
    }
  }
  const attemptMs = expectedBytes === undefined ? 45_000 : Math.min(300_000, Math.max(45_000, Math.ceil(expectedBytes / (512 * 1024) * 1000)));
  const overallMs = expectedBytes === undefined ? 90_000 : Math.min(300_000, Math.max(90_000, attemptMs * 2));
  const overallDeadline = Date.now() + overallMs;
  const total = AbortSignal.timeout(overallMs);
  const parent = options?.signal;
  const installed = currentScheduledDeadline();
  const overall = AbortSignal.any([total, ...(parent === undefined ? [] : [parent]), ...(installed === undefined ? [] : [installed.signal])]);
  const assertOverall = () => {
    installed?.assertActive();
    overall.throwIfAborted();
    if (Date.now() >= overallDeadline) throw new DOMException("原本読取の全体期限", "TimeoutError");
  };
  for (let attempt = 1; attempt <= 2; attempt++) {
    assertOverall();
    const attemptDeadline = Date.now() + attemptMs;
    const timeout = AbortSignal.timeout(attemptMs);
    const signal = AbortSignal.any([overall, timeout]);
    const assertAttempt = () => {
      assertOverall();
      signal.throwIfAborted();
      if (Date.now() >= attemptDeadline) throw new DOMException("原本読取の試行期限", "TimeoutError");
    };
    let receivedBytes = 0;
    let response: Response | undefined;
    let inTransport = false, observed = false;
    await options?.onAttempt?.({ attempt, phase: "start", receivedBytes });
    assertAttempt();
    try {
      inTransport = true;
      response = await untilAbort(signal, async () => {
        const got = await fetch(file.url, { redirect: "error", signal });
        try { assertAttempt(); } catch (error) { cancelWithoutWaiting(() => got.body?.cancel()); throw error; }
        return got;
      });
      inTransport = false;
      if (!response.ok) {
        cancelWithoutWaiting(() => response!.body?.cancel());
        throw new Error(`${context}: 保管済みファイル ${file.name} の再取得に失敗 status=${response.status}`);
      }
      const length = response.headers.get("Content-Length");
      // fetchのstreamは復号済み。圧縮時のContent-Lengthはwire長なので一致比較しない。
      const encoding = response.headers.get("Content-Encoding");
      const identity = encoding === null || encoding.toLowerCase() === "identity";
      if (maxBytes !== undefined && length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || identity && Number(length) > maxBytes)) {
        cancelWithoutWaiting(() => response!.body?.cancel());
        throw new Error(`${context}: 原本読取予算超過/不正サイズ`);
      }
      const chunks: Uint8Array[] = [];
      if (response.body === null) {
        if (maxBytes !== undefined && maxBytes !== 0) throw new Error(`${context}: 原本応答body欠測`);
        // 明示0上限/従来の未知サイズ経路だけ実Responseの空bodyをそのまま読む。
        const empty = new Uint8Array(await untilAbort(signal, () => response!.arrayBuffer()));
        assertAttempt();
        receivedBytes = empty.length;
        chunks.push(empty);
      } else {
        const reader = response.body.getReader();
        try {
          await untilAbort(signal, async () => {
            for (;;) {
              assertAttempt();
              inTransport = true;
              const { done, value } = await reader.read();
              assertAttempt();
              inTransport = false;
              if (done) break;
              receivedBytes += value.byteLength;
              if (maxBytes !== undefined && receivedBytes > maxBytes) { cancelWithoutWaiting(() => reader.cancel()); throw new Error(`${context}: 原本読取予算超過`); }
              chunks.push(value);
            }
          }, () => reader.cancel(signal.reason));
        } finally { reader.releaseLock(); }
      }
      assertAttempt();
      if (maxBytes !== undefined && identity && length !== null && receivedBytes !== Number(length)) throw new Error(`${context}: 原本応答のContent-Lengthと実バイト長が不一致`);
      if (expectedBytes !== undefined && receivedBytes !== expectedBytes) throw new Error(`${context}: 原本の正確なバイト長と実バイト長が不一致`);
      const bytes = new Uint8Array(receivedBytes); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      observed = true;
      await options?.onAttempt?.({ attempt, phase: "complete", receivedBytes, status: response.status });
      assertAttempt();
      return bytes;
    } catch (error) {
      // 親/全体deadlineは常に優先。設定・不明marker・validationはtransport扱いしない。
      const ownTimeout = (timeout.aborted || Date.now() >= attemptDeadline) && (error === timeout.reason || error instanceof DOMException && ["TimeoutError", "AbortError"].includes(error.name));
      const retryable = inTransport && (ownTimeout || transportError(error));
      if (!observed) await options?.onAttempt?.({ attempt, phase: inTransport && (retryable || overall.aborted) ? "transport-error" : "error", receivedBytes,
        ...(response === undefined ? {} : { status: response.status }) });
      assertOverall();
      if (!retryable) throw error;
      if (attempt === 2) throw error;
    }
  }
  throw new Error(`${context}: 原本GETの試行上限`);
}
