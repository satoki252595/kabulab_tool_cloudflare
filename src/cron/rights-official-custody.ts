/** 原本保持だけの独立診断。JPX欠測で無関係なquoteを落とさず、権利資格を成功化しない。 */
import assert from "node:assert/strict";
import { notionEnv, recordPrimaryData, verifyArchivedAttachments } from "../shared/notion-archive/index.js";
import { NotionUnknownResultError } from "../shared/notion-archive/client.js";
import { sha256HexBytes } from "../shared/sha256.js";
import { sharedEnv } from "../shared/env.js";
import { rootCauseMessage } from "../shared/errors.js";
import { EX_RIGHTS_LIMITS, assertExRightsIndexUrl, fetchExRightsSource, parseExRightsIndex, type ExRightsSource } from "../shared/jpx/ex-rights.js";

export interface OfficialRightsCustody {
  family: "jpx-ex-rights";
  status: "retained" | "incomplete";
  reason: "custody-only" | "configuration" | "source" | "index-shape" | "archive" | "archive-unknown";
  financialQualification: "unqualified";
  sourceCount: number;
  completeSources: number;
  archiveKey: string | null;
  archivePageId: string | null;
  physicalVerified: boolean;
  error: string | null;
}

/** 同じ公表日でもbytes訂正は別key。元版をforceで置換しない。 */
export async function collectOfficialRightsCustody(fetchedDateJST: string): Promise<OfficialRightsCustody> {
  const result: OfficialRightsCustody = { family: "jpx-ex-rights", status: "incomplete", reason: "configuration",
    financialQualification: "unqualified", sourceCount: 0, completeSources: 0, archiveKey: null, archivePageId: null, physicalVerified: false, error: null };
  let indexUrl: string;
  try { notionEnv.NOTION_TOKEN(); notionEnv.NOTION_ARCHIVE_PAGE_ID(); indexUrl = sharedEnv.JPX_EX_RIGHTS_URL(); assertExRightsIndexUrl(indexUrl); }
  catch (error) { result.error = rootCauseMessage(error); return result; }
  const sources: ExRightsSource[] = [], index = await fetchExRightsSource(indexUrl, null); sources.push(index); result.reason = "source";
  let complete = false;
  if (index.failure === null && index.bytes !== null) {
    let versions;
    try { versions = parseExRightsIndex(index.bytes, fetchedDateJST, indexUrl); }
    catch (error) { result.reason = "index-shape"; result.error = rootCauseMessage(error); }
    if (versions !== undefined) {
      complete = true;
      for (const version of versions) {
        const source = await fetchExRightsSource(indexUrl, version); sources.push(source);
        if (source.failure !== null) { complete = false; break; }
      }
    }
  }
  assert(sources.length <= EX_RIGHTS_LIMITS.sources);
  result.sourceCount = sources.length; result.completeSources = sources.filter(s => s.complete && s.failure === null).length;
  const files: Array<{ filename: string; contentType: string; bytes: Uint8Array }> = [];
  const entries = [];
  for (const [i, source] of sources.entries()) {
    let filename: string | null = null, encoding: "identity" | "gzip" | null = null;
    const retainedSha256 = source.bytes === null ? null : await sha256HexBytes(Uint8Array.from(source.bytes));
    if (source.bytes !== null) {
      const stem = i === 0 ? "index" : source.announcedDate; assert(stem !== null);
      const identity = source.complete && source.failure === null && source.bytes.length > 0;
      filename = identity ? (i === 0 ? "index.html" : `${stem}.xls`) : `${stem}-received.gz`;
      encoding = identity ? "identity" : "gzip";
      const bytes = identity ? source.bytes : new Uint8Array(await new Response(new Blob([Uint8Array.from(source.bytes)]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
      files.push({ filename, contentType: identity ? (i === 0 ? "text/html" : "application/vnd.ms-excel") : "application/gzip", bytes });
    }
    entries.push({ url: source.url, announcedDate: source.announcedDate, status: source.status, complete: source.complete,
      failure: source.failure, retainedBytes: source.bytes === null ? null : source.bytes.length, retainedSha256,
      fullSourceSha256: source.complete ? retainedSha256 : null, filename, encoding });
  }
  const manifest = { version: 1, family: result.family, complete, financialQualification: result.financialQualification,
    eventParsing: "not-performed", shareClass: "unqualified", ratio: null, legalEffectiveDate: null, sources: entries };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  if (files.length === 0) return result;
  files.push({ filename: "manifest.json", bytes: manifestBytes, contentType: "application/json" });
  assert(files.length <= EX_RIGHTS_LIMITS.sources + 1);
  result.archiveKey = `jpx-ex-rights-${complete ? "retained" : "incomplete"}-sha256-${await sha256HexBytes(manifestBytes)}`;
  try {
    const receipt = await recordPrimaryData({ service: "universe", key: result.archiveKey, source: indexUrl,
      fetchedAt: index.fetchedAt, metadata: { ...manifest, fetchedSources: sources.map(({ bytes: _bytes, ...source }) => source) },
      files, requireExistingDatabase: true, force: false });
    assert.equal(receipt.fileTooLarge, false);
    assert(receipt.outcome === "recorded" || receipt.outcome === "skipped_existing" && receipt.manifestMatch === "same");
    await verifyArchivedAttachments(receipt.pageId, files, "JPX配当落・権利落の原本保持");
    result.archivePageId = receipt.pageId; result.physicalVerified = true;
    if (complete) { result.status = "retained"; result.reason = "custody-only"; }
  } catch (error) {
    result.reason = error instanceof NotionUnknownResultError ? "archive-unknown" : "archive";
    result.error = rootCauseMessage(error);
    // 同じ取得物の再upload/POSTをこのrunで繰り返さない。株価の原本資格は別経路で維持する。
  }
  return result;
}
