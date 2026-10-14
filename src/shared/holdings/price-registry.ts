/** Private source addresses only. Raw bodies and signed/source URLs never enter the registry. */
import assert from "node:assert/strict";
import { z } from "zod";
import { isStrictIsoUtc, isCalendarDateString } from "../vwap/proof.js";
import type { DailyFetchProof } from "../yahoo/client.js";
import type { ArchivedYahooPart } from "../yahoo/raw-custody.js";

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const page = z.string().regex(/^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i);
const symbol = z.string().regex(/^[0-9A-Z]{4}\.T$/);
const clock = z.string().refine(isStrictIsoUtc);
export const priceFileSchema = z.object({
  archivePageId: page, filename: z.string().regex(/^[A-Za-z0-9_.-]{1,240}$/),
  sha256: sha, byteLength: z.number().int().positive().max(20 * 1024 * 1024),
}).strict();
export const priceReferenceSchema = z.object({
  file: priceFileSchema, symbol, receivedAt: clock, bodySha256: sha,
  bodyBytes: z.number().int().positive().max(8 * 1024 * 1024),
}).strict();
export type PriceFile = z.infer<typeof priceFileSchema>;
export type PriceReference = z.infer<typeof priceReferenceSchema>;
export const priceSnapshotSchema = z.object({
  version: z.literal(1), snapshotId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,40}$/),
  sessionDate: z.string().refine(isCalendarDateString), createdAt: clock,
  codeList: priceFileSchema, members: z.record(symbol, priceReferenceSchema),
}).strict().superRefine((value, context) => {
  const entries = Object.entries(value.members);
  if (entries.length === 0 || entries.length > 8192 || entries.some(([key, ref]) => key !== ref.symbol)) {
    context.addIssue({ code: "custom", message: "price snapshot membership mismatch" });
  }
  const files = new Map<string, number>();
  for (const [, ref] of entries) {
    const key = `${ref.file.archivePageId.replaceAll("-", "")}/${ref.file.filename}/${ref.file.sha256}`;
    if (files.has(key) && files.get(key) !== ref.file.byteLength) context.addIssue({ code: "custom", message: "price file byte length mismatch" });
    files.set(key, ref.file.byteLength);
  }
});
export type PriceSnapshot = z.infer<typeof priceSnapshotSchema>;
export const priceActiveSchema = z.object({
  version: z.literal(1), snapshotId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,40}$/),
  registryKey: z.string().regex(/^ops\/holdings-price\/snapshot-[A-Za-z0-9_.-]+-[a-f0-9]{64}\.json$/),
  registrySha256: sha, activatedAt: clock,
}).strict();
export const PRICE_ACTIVE_KEY = "ops/holdings-price/active.json";
export const PRICE_METADATA_KEY = "holdings-price";

export function referenceFromArchivedParts(parts: readonly ArchivedYahooPart[], proof: DailyFetchProof): PriceReference {
  const matches = parts.flatMap(part => part.members.filter(member => member.api === "daily" && member.status === 200 &&
    member.symbol === proof.symbol && member.sha256 === proof.rawSha && member.receivedAt === proof.observedAt)
    .map(member => ({ file: { archivePageId: part.archivePageId, filename: part.filename, sha256: part.gzipSha256, byteLength: part.gzipBytes },
      symbol: member.symbol, receivedAt: member.receivedAt, bodySha256: member.sha256, bodyBytes: member.byteLength })));
  assert.equal(matches.length, 1, "物理保管済み価格原本と同一応答を一意に束縛できません");
  return priceReferenceSchema.parse(matches[0]);
}

export function readPriceReference(metadata: Record<string, string> | undefined, proof: DailyFetchProof | undefined):
  { status: "ready"; reference: PriceReference } | { status: "held"; reason: string } {
  if (metadata?.[PRICE_METADATA_KEY] === undefined) return { status: "held", reason: "既存日足に物理原本参照がありません" };
  try {
    const reference = priceReferenceSchema.parse(JSON.parse(metadata[PRICE_METADATA_KEY]));
    assert.ok(proof && reference.symbol === proof.symbol && reference.bodySha256 === proof.rawSha && reference.receivedAt === proof.observedAt);
    return { status: "ready", reference };
  } catch { return { status: "held", reason: "既存日足の原本参照・SHA・実時計が一致しません" }; }
}

export function priceMetadata(metadata: Record<string, string> | undefined, reference: PriceReference): Record<string, string> {
  return { ...metadata, [PRICE_METADATA_KEY]: JSON.stringify(priceReferenceSchema.parse(reference)) };
}
