/**
 * AWS SigV4 の query params (Notion hosted 署名 URL の rotation 部分)。
 * これだけを除去し、非署名 query (versionId 等) は残して厳密比較する。
 */
const NOTION_SIGNED_URL_PARAMS: ReadonlySet<string> = new Set([
  "X-Amz-Algorithm",
  "X-Amz-Content-Sha256",
  "X-Amz-Credential",
  "X-Amz-Date",
  "X-Amz-Expires",
  "X-Amz-Security-Token",
  "X-Amz-Signature",
  "X-Amz-SignedHeaders",
]);

/**
 * Notion Files プロパティの rotation 正規化 (純粋)。
 * 元構造の clone を保ち、hosted file.url の既知署名 query と
 * file.expiry_time だけを除去する。非署名 query (versionId 等)・
 * name/type・未知 field は厳密比較 (差があれば不一致)。
 * external の URL は全体比較 (無差別 strip 禁止)。
 * URL 解析不能・未知形状は fail closed (ok:false → 不一致)。
 * 実 bytes の同一性は capture proof (files inventory の bytes SHA) が
 * 全呼出側で併せて検証する (props 比較と proof の二重関門)。
 */
export function normalizeFilePropForCompare(prop: unknown): { ok: true; norm: unknown } | { ok: false } {
  const p = prop as { type?: unknown; files?: unknown };
  if (!p || typeof p !== "object" || p.type !== "files" || !Array.isArray(p.files)) {
    return { ok: false };
  }
  const normFiles: unknown[] = [];
  for (const f of p.files) {
    const e = f as {
      type?: unknown;
      file?: unknown;
      external?: unknown;
    };
    if (!e || typeof e !== "object") return { ok: false };
    if (e.type === "file") {
      const file = e.file as { url?: unknown; expiry_time?: unknown } | undefined;
      if (!file || typeof file !== "object" || typeof file.url !== "string") {
        return { ok: false };
      }
      let resource: string;
      try {
        const u = new URL(file.url);
        for (const k of NOTION_SIGNED_URL_PARAMS) u.searchParams.delete(k);
        resource = u.toString();
      } catch {
        return { ok: false };
      }
      const { expiry_time: _drop, ...restFile } = file as Record<string, unknown>;
      void _drop;
      normFiles.push({ ...(e as Record<string, unknown>), file: { ...restFile, url: resource } });
    } else if (e.type === "external") {
      normFiles.push(e);
    } else {
      return { ok: false };
    }
  }
  return { ok: true, norm: { ...(p as Record<string, unknown>), files: normFiles } };
}

