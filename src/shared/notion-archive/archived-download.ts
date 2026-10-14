export interface ArchivedDownloadOptions {
  /** 省略時は既存の未知サイズ読取。0は明示された空ファイルの上限。 */
  maxBytes?: number;
  signal?: AbortSignal;
  /** URL・署名・原文を含まない実GET/読取計数。observerの失敗もSTOPする。 */
  onAttempt?: (event: { attempt: number; phase: "start" | "complete" | "transport-error"; receivedBytes: number; status?: number }) => void;
}

function transportError(error: unknown): boolean {
  if (!(error instanceof TypeError) || error.name !== "TypeError") return false;
  const cause = error.cause as { code?: unknown; name?: unknown } | undefined;
  if (["NotionConfigError", "NotionUnknownResultError", "AssertionError"].includes(String(cause?.name))) return false;
  if (cause !== undefined) return typeof cause?.code === "string" &&
    ["UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"].includes(cause.code);
  return ["fetch failed", "Failed to fetch", "Load failed", "NetworkError when attempting to fetch resource.", "terminated"].includes(error.message);
}

/** 同じ保管済みURLだけを読む。全体90秒・各45秒・最大2GET、mutation/別原典への切替0。 */
export async function downloadArchivedFile(file: { name: string; url: string }, context: string, options?: ArchivedDownloadOptions): Promise<Uint8Array> {
  const maxBytes = options?.maxBytes;
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
  const total = AbortSignal.timeout(90_000);
  const parent = options?.signal;
  const overall = parent === undefined ? total : AbortSignal.any([parent, total]);
  for (let attempt = 1; attempt <= 2; attempt++) {
    overall.throwIfAborted();
    const timeout = AbortSignal.timeout(45_000);
    const signal = AbortSignal.any([overall, timeout]);
    let receivedBytes = 0;
    let response: Response | undefined;
    let inTransport = false;
    options?.onAttempt?.({ attempt, phase: "start", receivedBytes });
    try {
      inTransport = true;
      response = await fetch(file.url, { redirect: "error", signal });
      inTransport = false;
      if (!response.ok) {
        void Promise.allSettled([response.body?.cancel()]);
        throw new Error(`${context}: 保管済みファイル ${file.name} の再取得に失敗 status=${response.status}`);
      }
      const length = response.headers.get("Content-Length");
      // fetchのstreamは復号済み。圧縮時のContent-Lengthはwire長なので一致比較しない。
      const encoding = response.headers.get("Content-Encoding");
      const identity = encoding === null || encoding.toLowerCase() === "identity";
      if (maxBytes !== undefined && length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || identity && Number(length) > maxBytes)) {
        void Promise.allSettled([response.body?.cancel()]);
        throw new Error(`${context}: 原本読取予算超過/不正サイズ`);
      }
      const chunks: Uint8Array[] = [];
      if (response.body === null) {
        if (maxBytes !== undefined && maxBytes !== 0) throw new Error(`${context}: 原本応答body欠測`);
        // 明示0上限/従来の未知サイズ経路だけ実Responseの空bodyをそのまま読む。
        const empty = new Uint8Array(await response.arrayBuffer());
        receivedBytes = empty.length;
        chunks.push(empty);
      } else {
        const reader = response.body.getReader();
        try {
          for (;;) {
            inTransport = true;
            const { done, value } = await reader.read();
            inTransport = false;
            if (done) break;
            receivedBytes += value.byteLength;
            if (maxBytes !== undefined && receivedBytes > maxBytes) { void Promise.allSettled([reader.cancel()]); throw new Error(`${context}: 原本読取予算超過`); }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
      }
      overall.throwIfAborted();
      if (maxBytes !== undefined && identity && length !== null && receivedBytes !== Number(length)) throw new Error(`${context}: 原本応答のContent-Lengthと実バイト長が不一致`);
      const bytes = new Uint8Array(receivedBytes); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      options?.onAttempt?.({ attempt, phase: "complete", receivedBytes, status: response.status });
      return bytes;
    } catch (error) {
      // 親/全体deadlineは常に優先。設定・不明marker・validationはtransport扱いしない。
      const ownTimeout = timeout.aborted && (error === timeout.reason || error instanceof DOMException && ["TimeoutError", "AbortError"].includes(error.name));
      const retryable = inTransport && (ownTimeout || transportError(error));
      if (inTransport && (retryable || overall.aborted)) options?.onAttempt?.({ attempt, phase: "transport-error", receivedBytes, ...(response === undefined ? {} : { status: response.status }) });
      overall.throwIfAborted();
      if (!retryable) throw error;
      if (attempt === 2) throw error;
    }
  }
  throw new Error(`${context}: 原本GETの試行上限`);
}
