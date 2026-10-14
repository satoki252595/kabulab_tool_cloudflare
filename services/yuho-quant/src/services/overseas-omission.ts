import { z } from "zod";
import type { OverseasOmission } from "./overseas-parser.js";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const recordSchema = z.object({
  version: z.literal(1),
  docId: z.string().regex(/^S[0-9A-Z]+$/),
  periodEnd: date,
  archivePageId: z.string().regex(/^(?:[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i),
  archiveManifest: z.enum(["known", "unknown"]),
  zipSha256: sha256,
  omission: z.object({
    reason: z.literal("domestic_external_sales_over_90_percent"),
    scope: z.literal("regional_external_customer_sales_note"),
    evidence: z.array(z.object({
      honbunFile: z.string().min(1),
      memberSha256: sha256,
      rawBlockSha256: sha256,
      quote: z.string().min(1),
      contextPeriod: z.object({
        contextRef: z.literal("CurrentYearDuration"),
        entity: z.string().regex(/^E\d{5}-\d{3}$/),
        startDate: date,
        endDate: date,
      }).strict(),
    }).strict()).min(1),
  }).strict(),
}).strict().superRefine((record, context) => {
  for (const evidence of record.omission.evidence) {
    const period = evidence.contextPeriod;
    const member = /^XBRL\/PublicDoc\/\d+_honbun_jpcrp030000-asr-\d{3}_(E\d{5}-\d{3})_(\d{4}-\d{2}-\d{2})_\d{2}_\d{4}-\d{2}-\d{2}_ixbrl\.html?$/.exec(evidence.honbunFile);
    const quote = evidence.quote.normalize("NFKC").replace(/[\s、,]/g, "");
    if (!member || member[1] !== period.entity || member[2] !== record.periodEnd ||
        period.endDate !== record.periodEnd || period.startDate >= period.endDate ||
        !/^(?:\(1\))?売上高(?:本邦|国内)の外部顧客への売上高が連結損益計算書の売上高の90%を超えるため記載を省略して(?:います|おります)。?$/.test(quote)) {
      context.addIssue({ code: "custom", message: "省略理由の原文・提出者・会計期末が一致しません" });
    }
  }
});

/** 原文の理由と、検証済み物理ZIPの出典。numeric facts/statusとは独立。 */
export type OverseasOmissionRecord = z.infer<typeof recordSchema>;
type DocumentIdentity = Pick<OverseasOmissionRecord, "docId" | "periodEnd">;

export function validateOverseasOmission(value: unknown, expected: DocumentIdentity): OverseasOmissionRecord {
  const record = recordSchema.parse(value);
  if (record.docId !== expected.docId || record.periodEnd !== expected.periodEnd) {
    throw new Error("省略理由JSONの文書ID・会計期末が保存文書と一致しません");
  }
  return record;
}

/** recordEdinetZipのfullbytes検証後だけ呼ぶ。原文/ハッシュ/時計は補作しない。 */
export function serializeOverseasOmission(input: DocumentIdentity & {
  archivePageId: string;
  archiveManifest: OverseasOmissionRecord["archiveManifest"];
  zipSha256: string;
  omission: OverseasOmission;
}): string {
  return JSON.stringify(validateOverseasOmission({ version: 1, ...input }, input));
}

/** NULLは理由未保存。非開示や省略理由へ推定せず、壊れたJSONも黙殺しない。 */
export function parseOverseasOmission(raw: string | null, expected: DocumentIdentity): OverseasOmissionRecord | null {
  return raw === null ? null : validateOverseasOmission(JSON.parse(raw) as unknown, expected);
}
