/** 保存有報が明示する期末株数の分割前単位。市場権利落日を法的効力日へ読み替えない。 */
import { createHash } from "node:crypto";
import { readFilingDurationContexts } from "./duration-context.js";
import { observeIssuedShares } from "./issued-shares.js";
import type { ShareholdingsSource } from "./shareholdings.js";
import { stripHtml } from "./text-sections.js";
import type { ZipEntries } from "./zip.js";

export interface PreSplitFiscalYearBasis {
  source: ShareholdingsSource; filename: string; memberSha256: string; factSha256: string;
  element: "jpcrp_cor:NotesRegardingIssuedSharesAndTreasurySharesTextBlock";
  context: { contextRef: string; entity: string; startDate: string; endDate: string };
  statement: string; legalEffectiveDate: string; numerator: number; denominator: number;
  fiscalYearShares: string; issuedSharesFactSha256: string;
}

/** ponytail: 実1798原本の明示文型だけ。非対応注記を「分割無し」や倍率へ補完しない。 */
export function observePreSplitFiscalYearBasis(zip: Buffer, source: ShareholdingsSource,
  filename: string, entries: ZipEntries): PreSplitFiscalYearBasis | undefined {
  const bytes = entries.get(filename);
  if (bytes === undefined || source.edinetCode === null) return;
  const xml = bytes.toString("utf8").replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, "");
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) return;
  const root = /^\uFEFF?\s*(?:<\?xml[^>]*>\s*)?<xbrli:xbrl\b[^>]*>/.exec(xml);
  const bindings = [...xml.matchAll(/\bxmlns:jpcrp_cor\s*=\s*(["'])([^"']+)\1/g)];
  if (root === null || bindings.length !== 1 || !root[0].includes(bindings[0][0]) ||
    !/^http:\/\/disclosure\.edinet-fsa\.go\.jp\/taxonomy\/jpcrp\/(?:2024-11-01|2025-11-01)\/jpcrp_cor$/.test(bindings[0][2])) return;
  const facts = [...xml.matchAll(/<jpcrp_cor:NotesRegardingIssuedSharesAndTreasurySharesTextBlock\b([^>]*?)>([\s\S]*?)<\/jpcrp_cor:NotesRegardingIssuedSharesAndTreasurySharesTextBlock\s*>/g)]
    .filter(fact => /\bcontextRef\s*=\s*(["'])CurrentYearDuration\1/.test(fact[1]));
  if (facts.length !== 1 || !/^\s+contextRef="CurrentYearDuration"\s*$/.test(facts[0][1])) return;
  const bodies = [...entries.keys()].filter(name => /^XBRL\/PublicDoc\/\d+_honbun_/.test(name) &&
    name.endsWith(`_${filename.slice("XBRL/PublicDoc/".length, -".xbrl".length)}_ixbrl.htm`));
  if (bodies.length === 0) return;
  const context = readFilingDurationContexts(entries, bodies[0], source.fiscalYearEnd).get("CurrentYearDuration");
  if (!context || context.entity !== `${source.edinetCode}-000` || context.endDate !== source.fiscalYearEnd) return;
  // XBRL textBlock is entity-encoded HTML; two existing decoder passes remove only that representation.
  const text = stripHtml(stripHtml(facts[0][2])).normalize("NFKC");
  const statements = [...text.matchAll(/当社は(\d{4})年(\d{1,2})月(\d{1,2})日付で普通株式(\d+)株につき(\d+)株の割合で株式分割を行っていますが、上記事項は当該株式分割前の株式数を基準としています。/g)];
  if (statements.length !== 1) return;
  const statement = statements[0], legalEffectiveDate = `${statement[1]}-${statement[2].padStart(2, "0")}-${statement[3].padStart(2, "0")}`;
  if (!Number.isFinite(Date.parse(`${legalEffectiveDate}T00:00:00Z`)) || new Date(`${legalEffectiveDate}T00:00:00Z`).toISOString().slice(0, 10) !== legalEffectiveDate) return;
  const denominator = Number(statement[4]), numerator = Number(statement[5]);
  if (![numerator, denominator].every(v => Number.isSafeInteger(v) && v > 0) || numerator <= denominator) return;
  const observed = observeIssuedShares(zip, source, null, entries);
  const shares = observed.observations?.filter(fact => fact.qualification.kind === "fiscal-year-end" &&
    fact.qualification.shareClass === "ordinary" && fact.qualification.economicDate === source.fiscalYearEnd);
  if (observed.sourceQualification.status !== "verified" || shares?.length !== 1) return;
  const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
  return { source, filename, memberSha256: sha(bytes), factSha256: sha(facts[0][0]),
    element: "jpcrp_cor:NotesRegardingIssuedSharesAndTreasurySharesTextBlock", context, statement: statement[0],
    legalEffectiveDate, numerator, denominator, fiscalYearShares: shares[0].rawValue.trim(), issuedSharesFactSha256: shares[0].factSha256 };
}
