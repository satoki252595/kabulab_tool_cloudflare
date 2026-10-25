import { edinetDocSchema, secCodeToTicker, type EdinetDoc } from "./types.js";

const fields = ["docID", "edinetCode", "secCode", "filerName", "docTypeCode", "periodStart", "submitDateTime"] as const;
export type EdinetArchiveSourceMetadata = Pick<EdinetDoc, typeof fields[number]>;

export class EdinetArchiveMetadataError extends Error {
  constructor(readonly missingKeys: readonly string[]) { super("edinet_archive_metadata_incomplete"); this.name = "EdinetArchiveMetadataError"; }
}

/** Copy acquired native values; null remains null and absent keys never come from D1 or another source. */
export function edinetArchiveMetadata(doc: EdinetArchiveSourceMetadata, periodEnd: string) {
  const missing: string[] = fields.filter(key => doc[key] !== null && typeof doc[key] !== "string");
  if (typeof doc.docID !== "string" || doc.docID.length === 0) missing.push("docID");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(periodEnd)) missing.push("periodEnd");
  if (missing.length > 0) throw new EdinetArchiveMetadataError([...new Set(missing)]);
  return { docID: doc.docID, edinetCode: doc.edinetCode, secCode: doc.secCode, filerName: doc.filerName,
    docTypeCode: doc.docTypeCode, periodStart: doc.periodStart, periodEnd, submitDateTime: doc.submitDateTime };
}

/** Native identity view only. The original metadata, manifest and unknown publisher clocks stay unchanged. */
export function edinetArchiveNativeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  if (!Object.hasOwn(metadata, "primary")) return metadata;
  const parsed = edinetDocSchema.safeParse(metadata.primary);
  if (!parsed.success) throw new EdinetArchiveMetadataError(["primary"]);
  const primary = parsed.data, nativeFields = [...fields, "periodEnd"] as const;
  const conflicts: string[] = nativeFields.filter(key => Object.hasOwn(metadata, key) && metadata[key] !== primary[key]);
  if (metadata.docID !== primary.docID) conflicts.push("docID");
  if (metadata.edinetDocType !== 1 && metadata.edinetDocType !== 5) conflicts.push("edinetDocType");
  const rawPrimary = metadata.primary as Record<string, unknown>;
  if (Object.hasOwn(rawPrimary, "edinetDocType") && rawPrimary.edinetDocType !== metadata.edinetDocType) conflicts.push("primary.edinetDocType");
  if (Object.hasOwn(metadata, "version")) conflicts.push("version"); // No versioned wrapper contract has been qualified.
  if (Object.hasOwn(metadata, "rawSecCode") && metadata.rawSecCode !== primary.secCode) conflicts.push("rawSecCode");
  if (Object.hasOwn(metadata, "stockCode") && metadata.stockCode !== secCodeToTicker(primary.secCode)) conflicts.push("stockCode");
  if (conflicts.length > 0) throw new EdinetArchiveMetadataError([...new Set(conflicts)]);
  return { ...metadata, ...Object.fromEntries(nativeFields.map(key => [key, primary[key]])) };
}
