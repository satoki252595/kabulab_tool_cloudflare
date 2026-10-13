/** Same-disclosure mirrors only. Catalog IDs never become official PDF IDs. */
export const IR_PDF_LIMIT = 20_000_000;
export type PdfAttempt = { source: string; code: string; httpStatus?: number };
export type PdfDownload =
  | { status: "available"; bytes: Uint8Array<ArrayBuffer>; sha256: string; retrievedAt: string; resolvedUrl: string }
  | { status: "unavailable" | "transient"; code: string; httpStatus?: number; resolvedUrl?: string };

export function officialPdfId(value: string): string | null {
  if (/\s/.test(value)) return null;
  // D1 retains this exact public redirect URL even when yanoshin itself returns
  // 404. Its raw query is an observed official URL, not a catalog-ID conversion.
  const wrapper = /^https:\/\/webapi\.yanoshin\.jp\/rd\.php\?(https:\/\/(?:www\.)?release\.tdnet\.info\/inbs\/\d{18}\.pdf)$/.exec(value);
  const observed = wrapper === null ? value : wrapper[1];
  // Match raw URLs: no decoding, recursive unwrapping or URL normalization that
  // could conceal credentials, explicit :443, fragments or additional queries.
  return /^https:\/\/(?:www\.)?release\.tdnet\.info\/inbs\/(\d{18})\.pdf$/.exec(observed)?.[1]
    ?? /^https:\/\/www2\.jpx\.co\.jp\/disc\/[0-9A-Z]{5}\/(\d{18})\.pdf$/.exec(observed)?.[1] ?? null;
}

export function jpxPdfUrl(companyCode: string, observedUrl: string): string | null {
  if (companyCode.length !== 5 || !/^[0-9A-Z]{4}0$/.test(companyCode)) return null;
  const id = officialPdfId(observedUrl);
  if (id === null) return null;
  const url = new URL(observedUrl);
  if (url.hostname === "www2.jpx.co.jp" && url.pathname.split("/")[2] !== companyCode) return null;
  return `https://www2.jpx.co.jp/disc/${companyCode}/${id}.pdf`;
}

export interface ArchivedPdfProvenance {
  schema: "ir-pdf-archive-provenance-v1";
  catalogId: string;
  companyCode: string;
  publishedAt: string;
  source: "jpx";
  sourceUrl: string;
  officialDocumentId: string;
  retrievedAt: string;
  pdfSha256: string;
  pdfBytes: number;
}

/** A saved origin is untrusted until it agrees with the fresh hosted bytes and catalog. */
export function validateArchivedPdfProvenance(
  text: string,
  identity: { tdnetId: string; companyCode: string; publishedAt: string },
  pdf: { sha256: string; bytes: Uint8Array; retrievedAt: string }
): ArchivedPdfProvenance {
  if (text.length === 0 || text.length > 1900) throw new Error("archive_provenance_invalid");
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("archive_provenance_invalid");
  const origin = value as Record<string, unknown>;
  if (Object.keys(origin).sort().join(",") !== ["schema", "catalogId", "companyCode", "publishedAt", "source",
      "sourceUrl", "officialDocumentId", "retrievedAt", "pdfSha256", "pdfBytes"].sort().join(",")
      || origin.schema !== "ir-pdf-archive-provenance-v1" || origin.catalogId !== identity.tdnetId
      || origin.companyCode !== identity.companyCode || origin.source !== "jpx"
      || typeof origin.officialDocumentId !== "string" || !/^\d{18}$/.test(origin.officialDocumentId)
      || origin.sourceUrl !== `https://www2.jpx.co.jp/disc/${identity.companyCode}/${origin.officialDocumentId}.pdf`
      || typeof origin.publishedAt !== "string" || typeof origin.retrievedAt !== "string"
      || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(origin.publishedAt) || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(origin.retrievedAt)
      || !Number.isFinite(Date.parse(origin.publishedAt)) || !Number.isFinite(Date.parse(origin.retrievedAt))
      || Date.parse(origin.publishedAt) !== Date.parse(identity.publishedAt)
      || Date.parse(origin.retrievedAt) < Date.parse(origin.publishedAt)
      || Date.parse(origin.retrievedAt) > Date.parse(pdf.retrievedAt)
      || origin.pdfSha256 !== pdf.sha256 || origin.pdfBytes !== pdf.bytes.byteLength) {
    throw new Error("archive_provenance_invalid");
  }
  return { schema: "ir-pdf-archive-provenance-v1", catalogId: identity.tdnetId, companyCode: identity.companyCode,
    publishedAt: origin.publishedAt, source: "jpx",
    sourceUrl: `https://www2.jpx.co.jp/disc/${identity.companyCode}/${origin.officialDocumentId}.pdf`,
    officialDocumentId: origin.officialDocumentId, retrievedAt: origin.retrievedAt,
    pdfSha256: pdf.sha256, pdfBytes: pdf.bytes.byteLength };
}

/** Bound before buffering/hash; no response/error text or signed URL is logged. */
export async function downloadPdf(url: string, timeoutMs: number, noRedirect = false): Promise<PdfDownload> {
  let response: Response;
  try {
    response = await fetch(url, { redirect: noRedirect ? "manual" : "follow", signal: AbortSignal.timeout(timeoutMs),
      headers: { "User-Agent": "kabulab-ir-catalog/1.0" } });
  } catch {
    return { status: "transient", code: "network_or_timeout" };
  }
  const resolvedUrl = response.url || url;
  if (!response.ok || response.body === null) {
    await response.body?.cancel();
    return { status: response.status >= 500 || response.status === 429 ? "transient" : "unavailable",
      code: "http_error", httpStatus: response.status, resolvedUrl };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > IR_PDF_LIMIT) {
        await reader.cancel();
        return { status: "unavailable", code: "pdf_too_large", resolvedUrl };
      }
      chunks.push(item.value);
    }
  } catch {
    return { status: "transient", code: "body_read_failed", resolvedUrl };
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  if (length <= 5 || new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") {
    return { status: "unavailable", code: "not_pdf", resolvedUrl };
  }
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return { status: "available", bytes, sha256: Array.from(new Uint8Array(hash),
    (value) => value.toString(16).padStart(2, "0")).join(""), retrievedAt: new Date().toISOString(), resolvedUrl };
}

export type OfficialPdfDownload =
  | (Extract<PdfDownload, { status: "available" }> & { source: "catalog" | "jpx"; attempts: PdfAttempt[] })
  | { status: "unavailable" | "transient"; attempts: PdfAttempt[] };

export async function fetchOfficialPdf(documentUrl: string, companyCode: string, timeoutMs: number): Promise<OfficialPdfDownload> {
  const attempts: PdfAttempt[] = [];
  const catalog = await downloadPdf(documentUrl, timeoutMs);
  if (catalog.status === "available") return { ...catalog, source: "catalog", attempts };
  attempts.push({ source: "catalog", code: catalog.code, httpStatus: catalog.httpStatus });
  const jpx = jpxPdfUrl(companyCode, catalog.resolvedUrl === undefined ? documentUrl : catalog.resolvedUrl);
  if (jpx === null || jpx === documentUrl || jpx === catalog.resolvedUrl) {
    return { status: catalog.status, attempts };
  }
  const result = await downloadPdf(jpx, timeoutMs, true);
  if (result.status === "available" && result.resolvedUrl === jpx) return { ...result, source: "jpx", attempts };
  attempts.push(result.status === "available" ? { source: "jpx", code: "unexpected_redirect" }
    : { source: "jpx", code: result.code, httpStatus: result.httpStatus });
  return { status: catalog.status === "transient" || result.status === "transient" ? "transient" : "unavailable", attempts };
}
