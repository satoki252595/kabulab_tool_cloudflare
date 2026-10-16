/** 公式issuer有報から英字名集合の根拠を作る。略称推測や価格原本の書換えはしない。 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { exactLegalName, type ArchivedSource, type ListedIdentity } from "./shareholdings-valuation.js";
import { verifySavedHoldingsSource, type ShareholdingsSource } from "./shareholdings.js";
import type { ZipEntries } from "./zip.js";
import { stripHtml } from "./text-sections.js";
import { observePreSplitFiscalYearBasis, type PreSplitFiscalYearBasis } from "./shareholdings-split-basis.js";

export interface OfficialIssuerEnglishName {
  code: string; edinetCode: string; corporateNumber: string; legalName: string; englishName: string;
  source: ShareholdingsSource; archivePageId: string; zipSha256: string; filename: string; memberSha256: string;
  submittedAt: string; filingDate: string; fetchedAt: string; priceCapturedAt: string;
  contextRef: "FilingDateInstant";
  /** Same verified issuer ZIP. Absence is unknown, never proof of split absence. */
  preSplitFiscalYearBasis?: PreSplitFiscalYearBasis;
}
export type OfficialIssuerNames = ReadonlyMap<string, OfficialIssuerEnglishName>;

/** 呼出側は通常のscoped最新selector/保存物理readerでsourceとownerを固定する。 */
export function qualifyOfficialIssuerEnglishName(args: {
  identity: ListedIdentity; source: ShareholdingsSource; ownerName: string;
  archived: ArchivedSource; metadata: Record<string, unknown>; fetchedAt: string; priceCapturedAt: string;
}): { status: "verified"; evidence: OfficialIssuerEnglishName } | { status: "held"; reason: string } {
  const { identity, source, archived, metadata } = args;
  assert.equal(source.stockCode, identity.code); assert.equal(source.edinetCode, identity.edinetCode);
  assert.equal(exactLegalName(args.ownerName), exactLegalName(identity.legalName), "issuer最新提出者名と公式法定名が不一致です");
  assert.match(archived.archivePageId.replaceAll("-", ""), /^[a-f0-9]{32}$/i);
  assert.equal(createHash("sha256").update(archived.bytes).digest("hex"), archived.sha256);
  for (const [name, expected] of Object.entries({ docID: source.docId, edinetCode: source.edinetCode, secCode: `${source.stockCode}0`, periodEnd: source.fiscalYearEnd })) {
    assert.equal(metadata[name], expected, "issuer metadataの主体/最新doc/期末が不一致です");
  }
  assert.equal(typeof metadata.filerName, "string");
  assert.equal(exactLegalName(metadata.filerName as string), exactLegalName(identity.legalName));
  assert.ok(typeof metadata.submitDateTime === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/.test(metadata.submitDateTime));
  const submittedAt = metadata.submitDateTime.replace(" ", "T") + "+09:00";
  assert.ok(Number.isFinite(Date.parse(submittedAt)) && Number.isFinite(Date.parse(args.fetchedAt)) && Number.isFinite(Date.parse(args.priceCapturedAt)));
  assert.ok(Date.parse(`${source.fiscalYearEnd}T00:00:00+09:00`) <= Date.parse(submittedAt));
  if (Date.parse(submittedAt) > Date.parse(args.priceCapturedAt)) return { status: "held", reason: "公式英字名の提出時点が価格captureより後です" };
  let entries: ZipEntries | undefined;
  const checked = verifySavedHoldingsSource(archived.bytes, source, { onVerifiedEntries: value => { entries = value; } });
  if (checked.status === "held") return checked;
  assert.ok(entries);
  const bytes = entries.get(checked.filename); assert.ok(bytes);
  const xml = bytes.toString("utf8").replace(/<!--[\s\S]*?-->/g, "");
  const bindings = [...xml.matchAll(/\bxmlns:([A-Za-z_][\w.-]*)\s*=\s*(["'])([^"']+)\2/g)];
  const dei = bindings.filter(match => /^http:\/\/disclosure\.edinet-fsa\.go\.jp\/taxonomy\/jpdei\/\d{4}-\d{2}-\d{2}\/jpdei_cor$/.test(match[3]));
  assert.equal(dei.length, 1);
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const prefix = escape(dei[0][1]), fields: Record<string, string> = {};
  for (const name of ["FilerNameInJapaneseDEI", "FilerNameInEnglishDEI"]) {
    const matches = [...xml.matchAll(new RegExp(`<${prefix}:${name}\\b([^>]*)>([^<]*)<\\/${prefix}:${name}\\s*>`, "g"))];
    if (matches.length !== 1) return { status: "held", reason: `公式${name}が一意ではありません` };
    assert.match(matches[0][1], /\bcontextRef\s*=\s*(["'])FilingDateInstant\1/);
    fields[name] = stripHtml(matches[0][2]).trim();
    if (!fields[name]) return { status: "held", reason: `公式${name}が空です` };
  }
  assert.equal(exactLegalName(fields.FilerNameInJapaneseDEI), exactLegalName(identity.legalName));
  const instance = bindings.filter(match => match[3] === "http://www.xbrl.org/2003/instance");
  assert.equal(instance.length, 1); assert.equal(bindings.filter(match => match[1] === instance[0][1]).length, 1);
  const xbrli = escape(instance[0][1]);
  const contexts = [...xml.matchAll(new RegExp(`<${xbrli}:context\\b[^>]*\\bid=(["'])FilingDateInstant\\1[^>]*>([\\s\\S]*?)<\\/${xbrli}:context\\s*>`, "g"))];
  assert.equal(contexts.length, 1);
  const identifiers = [...contexts[0][2].matchAll(new RegExp(`<${xbrli}:identifier\\b([^>]*)>([^<]*)<\\/${xbrli}:identifier\\s*>`, "g"))];
  assert.equal(identifiers.length, 1); assert.match(identifiers[0][1], /\bscheme=(["'])http:\/\/disclosure\.edinet-fsa\.go\.jp\1/);
  assert.equal(identifiers[0][2].trim(), `${source.edinetCode}-000`);
  const instants = [...contexts[0][2].matchAll(new RegExp(`<${xbrli}:instant\\b[^>]*>([^<]*)<\\/${xbrli}:instant\\s*>`, "g"))];
  assert.equal(instants.length, 1); const filingDate = instants[0][1].trim();
  assert.equal(filingDate, metadata.submitDateTime.slice(0, 10), "公式英字名のFilingDateInstantが提出日と不一致です");
  const preSplitFiscalYearBasis = observePreSplitFiscalYearBasis(archived.bytes, source, checked.filename, entries);
  return { status: "verified", evidence: { code: identity.code, edinetCode: identity.edinetCode, corporateNumber: identity.corporateNumber,
    legalName: identity.legalName, englishName: fields.FilerNameInEnglishDEI, source, archivePageId: archived.archivePageId,
    zipSha256: archived.sha256, filename: checked.filename, memberSha256: createHash("sha256").update(bytes).digest("hex"),
    submittedAt, filingDate, fetchedAt: args.fetchedAt, priceCapturedAt: args.priceCapturedAt, contextRef: "FilingDateInstant",
    ...(preSplitFiscalYearBasis === undefined ? {} : { preSplitFiscalYearBasis }) } };
}
