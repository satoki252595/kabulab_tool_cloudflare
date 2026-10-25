/** Real3776 native document; wrapper envelopes and conflicts are explicit offline protocol controls. */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { edinetArchiveMetadata, edinetArchiveNativeMetadata, EdinetArchiveMetadataError } from "../services/edinet/archive-metadata.js";
import { qualifyAuditSource } from "../../data-scripts/audit-supplement-texts.js";
import type { LatestDoc } from "../biztag/source.js";
import type { yuhoDocuments } from "../db/schema.js";

const primary = JSON.parse(readFileSync(new URL("./fixtures/information-edit-basis-3776/native-entry.json", import.meta.url), "utf8")).doc;
const native = edinetArchiveMetadata(primary, primary.periodEnd);
const wrapper = () => ({ docID: primary.docID, edinetDocType: 5, primary: structuredClone(primary),
  stockCode: primary.secCode.slice(0, 4), rawSecCode: primary.secCode, originalPublisherClockVerified: "UNKNOWN",
  sourceQualification: "offline wrapper protocol control", sourceZIPSHA: "physical-control-only", _fileManifest: { version: 1 } });
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
afterEach(() => vi.unstubAllGlobals());

it("reads flat metadata unchanged and projects full primary without changing raw provenance", () => {
  const flat = { ...native, edinetDocType: 5 };
  expect(edinetArchiveNativeMetadata(flat)).toBe(flat);
  const raw = wrapper(), before = JSON.stringify(raw), view = edinetArchiveNativeMetadata(raw);
  for (const [key, value] of Object.entries(native)) expect(view[key]).toEqual(value);
  expect(view.originalPublisherClockVerified).toBe("UNKNOWN");
  expect(view.sourceQualification).toBe(raw.sourceQualification);
  expect(view._fileManifest).toBe(raw._fileManifest);
  expect(JSON.stringify(raw)).toBe(before); expect(sha(JSON.stringify(raw))).toBe(sha(before));
  expect(Object.hasOwn(raw, "secCode")).toBe(false);
  // A tuple view does not turn the real information-edit flag into an ordinary source state.
  expect(raw.primary.docInfoEditStatus).toBe(primary.docInfoEditStatus);
});

it.each(Object.keys(native))("rejects a conflicting top-level native field: %s", key => {
  const raw: Record<string, unknown> = { ...wrapper(), [key]: native[key as keyof typeof native] === null ? "conflict control" : null };
  expect(() => edinetArchiveNativeMetadata(raw)).toThrow(EdinetArchiveMetadataError);
});

it.each(["incomplete", "non-object", "type", "nested-type", "raw-code", "ticker", "version"])("rejects an unknown or contradictory wrapper: %s", fault => {
  const raw: Record<string, unknown> = wrapper();
  if (fault === "incomplete") { const p = { ...primary }; delete p.JCN; raw.primary = p; }
  if (fault === "non-object") raw.primary = null;
  if (fault === "type") raw.edinetDocType = 2;
  if (fault === "nested-type") raw.primary = { ...primary, edinetDocType: 1 };
  if (fault === "raw-code") raw.rawSecCode = "00000";
  if (fault === "ticker") raw.stockCode = "0000";
  if (fault === "version") raw.version = "unqualified protocol version control";
  expect(() => edinetArchiveNativeMetadata(raw)).toThrow(EdinetArchiveMetadataError);
});

const actual = resolve("tmp/edinet-primary-native-proof-v1");
it.skipIf(!existsSync(resolve(actual, "METADATA.private.json")))("joins actual130A saved wrapper, exact D1/report and existing whole CSV offline", () => {
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network forbidden"); }));
  const metadataBytes = readFileSync(resolve(actual, "METADATA.private.json"));
  expect(sha(metadataBytes)).toBe("dcb0588ed307321bf5f2da2bffa7d4f3c24ee23cca78f672ab5ad4319554d7a4");
  const metadata = JSON.parse(metadataBytes.toString()), bytes = readFileSync(resolve(actual, "130A-S100XSIT.zip"));
  expect(sha(bytes)).toBe("74b206fdf82a56d4d979fe1c50acc5ce03903262d184c1837d9ff6ecd7009e08");
  expect(sha(bytes)).toBe(metadata.sourceZIPSHA); expect(bytes.length).toBe(metadata.sourceZIPBytes);
  const data = JSON.parse(readFileSync(resolve(actual, "HTTP-3-RESPONSE.private.body"), "utf8"));
  const raw = data.result[0].results[0], latestDoc = JSON.parse(readFileSync(resolve(actual, "REPORT-TARGET.private.json"), "utf8")).latestDoc;
  const document = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
    key === "submitted_at" ? new Date(Number(value) * 1000) : value])) as typeof yuhoDocuments.$inferSelect;
  const latest: LatestDoc = { stockCode: "130A", companyName: document.filerName, sector33: null, doc: latestDoc };
  const before = JSON.stringify(metadata), source = { pageId: "offline exact archive protocol control", bytes, sha256: sha(bytes), metadata, originalManifest: "known" as const };
  const parsed = qualifyAuditSource(latest, document, source);
  expect(parsed.sections.length).toBeGreaterThan(0);
  expect(JSON.stringify(metadata)).toBe(before); expect(metadata.originalPublisherClockVerified).toBe("UNKNOWN");
  expect(fetch).not.toHaveBeenCalled();
});
