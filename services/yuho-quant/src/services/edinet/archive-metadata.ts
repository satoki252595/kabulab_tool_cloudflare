import type { EdinetDoc } from "./types.js";

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
