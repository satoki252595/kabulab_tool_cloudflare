import { describe, expect, it } from "vitest";
import { priceMetadata, readPriceReference, referenceFromArchivedParts, priceSnapshotSchema } from "./price-registry.js";
import type { ArchivedYahooPart } from "../yahoo/raw-custody.js";
import type { DailyFetchProof } from "../yahoo/client.js";

const proof: DailyFetchProof = { symbol: "7203.T", rawSha: "a".repeat(64), observedAt: "2026-10-14T09:00:00.123Z",
  requestedRange: "10y", firstTs: 1, lastTs: 2, splits: [] };
const part: ArchivedYahooPart = { archivePageId: "b".repeat(32), filename: "raw.json.gz", gzipSha256: "c".repeat(64), gzipBytes: 100,
  members: [{ api: "daily", symbol: proof.symbol, status: 200, attempt: 1, receivedAt: proof.observedAt, byteLength: 200, sha256: proof.rawSha }] };

describe("private価格参照の原本束縛", () => {
  it("同一symbol/SHA/実clockの一意memberだけを束縛し、URL/bodyは保存しない", () => {
    const ref = referenceFromArchivedParts([part], proof), metadata = priceMetadata({ unrelated: "unchanged" }, ref);
    expect(readPriceReference(metadata, proof)).toEqual({ status: "ready", reference: ref });
    expect(metadata.unrelated).toBe("unchanged");
    expect(JSON.stringify(ref)).not.toMatch(/url|bodyBase64|headers/i);
    expect(() => referenceFromArchivedParts([part, part], proof)).toThrow();
    expect(() => referenceFromArchivedParts([part], { ...proof, rawSha: "d".repeat(64) })).toThrow();
    expect(() => referenceFromArchivedParts([part], { ...proof, observedAt: "2026-10-14T09:00:00.124Z" })).toThrow();
  });
  it.each([undefined, { "holdings-price": "{}" }, { "holdings-price": "null" }, { "holdings-price": "not json" }])("欠測/不正metadataは候補へせず理由付きHOLD", metadata => {
    expect(readPriceReference(metadata, proof).status).toBe("held");
  });
  it("追加URL・keyと異なるsymbolはregistryへ入れない", () => {
    const ref = referenceFromArchivedParts([part], proof);
    const base = { version: 1, snapshotId: "123.1", sessionDate: "2026-10-14", createdAt: proof.observedAt, codeList: ref.file, members: { "7203.T": ref } };
    expect(priceSnapshotSchema.parse(base)).toEqual(base);
    expect(priceSnapshotSchema.safeParse({ ...base, members: { "7203.T": { ...ref, url: "https://private.invalid/" } } }).success).toBe(false);
    expect(priceSnapshotSchema.safeParse({ ...base, members: { "1301.T": ref } }).success).toBe(false);
  });
});
