/** 保管済みファイル 1 件をダウンロードする (取得元ではなく Notion から)。 */
export async function downloadArchivedFile(file: { name: string; url: string }, context: string, options?: { maxBytes: number }): Promise<Uint8Array> {
  if (options !== undefined) {
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) throw new Error(`${context}: 原本読取予算が不正`);
    const url = new URL(file.url);
    const host = url.hostname;
    if (url.protocol !== "https:" || url.username || url.password ||
      !(host === "file.notion.so" || host.endsWith(".notion.so") || host.endsWith(".notionso.com") ||
        host === "prod-files-secure.s3.us-west-2.amazonaws.com" || host === "s3.us-west-2.amazonaws.com")) {
      throw new Error(`${context}: Notion-hosted原本のURL資格が不正`);
    }
  }
  const res = await fetch(file.url, options === undefined ? undefined : { redirect: "error", signal: AbortSignal.timeout(45_000) });
  if (!res.ok) {
    throw new Error(`${context}: 保管済みファイル ${file.name} の再取得に失敗 status=${res.status}`);
  }
  if (options === undefined) return new Uint8Array(await res.arrayBuffer());
  const length = res.headers.get("Content-Length");
  // fetch decodes HTTP content-encoding. Content-Length then describes wire
  // bytes, while the stream/limit describe the restored attachment bytes.
  const encoding = res.headers.get("Content-Encoding");
  const identity = encoding === null || encoding.toLowerCase() === "identity";
  if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || identity && Number(length) > options.maxBytes)) {
    await res.body?.cancel();
    throw new Error(`${context}: 原本読取予算超過/不正サイズ`);
  }
  if (!res.body) throw new Error(`${context}: 原本応答body欠測`);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > options.maxBytes) { await reader.cancel(); throw new Error(`${context}: 原本読取予算超過`); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  if (identity && length !== null && total !== Number(length)) throw new Error(`${context}: 原本応答のContent-Lengthと実バイト長が不一致`);
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
