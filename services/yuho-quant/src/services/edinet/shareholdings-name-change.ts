/** 原表の注番号に対応する、実施済み商号変更の完全な一文だけを観測する。 */
import { createHash } from "node:crypto";
import { stripHtml } from "./text-sections.js";
import type { ReportedFilingInstant } from "./duration-context.js";
import type { Shareholding, ShareholdingsSource } from "./shareholdings.js";

export interface HoldingNameChange {
  source: ShareholdingsSource; filename: string; zipSha256: string; memberSha256: string; blockHtmlSha256: string;
  context: ReportedFilingInstant; holdingName: string; oldName: string; newName: string; noteNumber: number;
  effectiveDate: string; statement: string; statementSha256: string;
}
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const normalized = (value: string) => value.normalize("NFKC").replace(/\s/g, "");
const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

export function observeHoldingNameChanges(args: { source: ShareholdingsSource; filename: string; zip: Uint8Array; member: Uint8Array;
  blockHtml: string; context: ReportedFilingInstant | null; holdings: readonly Pick<Shareholding, "name">[] }): HoldingNameChange[] {
  const { context } = args;
  if (context === null || context.clockKind !== "reported_context" || context.contextRef !== "FilingDateInstant" || context.entity !== `${args.source.edinetCode}-000` ||
    !validDate(context.instantDate) || !validDate(context.sourceFilenameDate)) return [];
  const paragraphs = [...args.blockHtml.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p\s*>/gi)].map(match => stripHtml(match[1]));
  const result: HoldingNameChange[] = [];
  // ponytail: 一意の注番号＋旧名＋実施済み全文だけ。予定・合併等は新しい原文回帰が揃うまで採らない。
  for (const holding of args.holdings) {
    const label = /^(.+?)\(注\)([1-9]\d{0,2})$/.exec(normalized(holding.name)); if (label === null) continue;
    const matched = paragraphs.filter(statement => normalized(statement).startsWith(`${label[2]}${label[1]}は`));
    if (matched.length !== 1) continue;
    const candidates = matched.flatMap(statement => {
      const match = /^([1-9]\d{0,2})(.+?)は(\d{4})年(\d{1,2})月(\d{1,2})日付で(.+?)(?:に|へ)商号変更しております。$/.exec(normalized(statement));
      if (match === null || Number(match[1]) !== Number(label[2]) || match[2] !== label[1]) return [];
      const effectiveDate = `${match[3]}-${match[4].padStart(2, "0")}-${match[5].padStart(2, "0")}`;
      if (!validDate(effectiveDate) || effectiveDate > context.instantDate || effectiveDate > context.sourceFilenameDate || match[2] === match[6] ||
        [match[2], match[6]].some(name => !/(?:株式会社|\(株\))/.test(name) || /予定|合併|譲渡|承継|又は|または|及び|および|、/.test(name))) return [];
      return [{ source: args.source, filename: args.filename, zipSha256: hash(args.zip), memberSha256: hash(args.member), blockHtmlSha256: hash(args.blockHtml),
        context, holdingName: holding.name, oldName: match[2], newName: match[6], noteNumber: Number(match[1]), effectiveDate, statement, statementSha256: hash(statement) }];
    });
    if (candidates.length === 1) result.push(candidates[0]);
  }
  return result;
}
