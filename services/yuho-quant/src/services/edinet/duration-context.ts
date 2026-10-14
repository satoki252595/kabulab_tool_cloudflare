import type { ZipEntries } from "./zip.js";

/** 実 iXBRL/XBRL context の期間証拠。連結区分の証拠にはしない。 */
export interface DurationContext {
  contextRef: string;
  entity: string;
  startDate: string;
  endDate: string;
}

/** 同じ filing の実提出日時点。duration や連結区分へ変換しない。 */
export interface FilingDateInstant {
  contextRef: string;
  entity: string;
  instantDate: string;
}

type FilingContext = DurationContext | FilingDateInstant;

/** null は当該 ID の欠損・非対応・矛盾。未使用 ID の失敗は波及させない。 */
export type FilingDurationContexts = ReadonlyMap<
  string,
  DurationContext | null
>;

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000-"))
    return false;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * EDINET 実原文の dimension-free duration/instant 形だけを受理する小さな reader。
 * XML 汎用 parser の代用ではない。segment/scenario、属性追加、namespace
 * 再定義、entity 不一致などは null。contextRef の名前から期を推測しない。
 */
function readContexts(
  source: string,
  entity: string,
  rootTag: "html" | "xbrli:xbrl"
): Map<string, FilingContext | null> {
  const found = new Map<string, FilingContext | null>();
  // Comments/CDATA are not definitions. DTD/entity substitution is unsupported.
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) return found;
  source = source.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, "");
  const root = /^\uFEFF?\s*(?:<\?xml[^>]*>\s*)?<(html|xbrli:xbrl)\b[^>]*>/.exec(
    source
  );
  const close = `</${rootTag}>`;
  const end = source.indexOf(close);
  const enclosed =
    root !== null &&
    end >= root[0].length &&
    source.slice(end + close.length).trim() === "";
  const bound =
    root !== null &&
    enclosed &&
    root[1] === rootTag &&
    /\bxmlns:xbrli\s*=\s*(["'])http:\/\/www\.xbrl\.org\/2003\/instance\1/.test(
      root[0]
    );
  // A re-bound prefix cannot be attributed safely by this deliberately narrow reader.
  const re = /<xbrli:context\b[^>]*>[\s\S]*?<\/xbrli:context\s*>/g;
  // An unsupported definition's local re-binding must not invalidate other IDs.
  const bindings = [...source.replace(re, "").matchAll(/\bxmlns:xbrli\s*=/g)]
    .length;
  const counts = new Map<string, number>();
  for (const opening of source.matchAll(/<xbrli:context\b[^>]*>/g)) {
    const id = /\bid\s*=\s*(["'])([^"']+)\1/.exec(opening[0])?.[2];
    if (id === undefined) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
    found.set(id, null);
  }
  for (const m of source.matchAll(re)) {
    const opening = m[0].slice(0, m[0].indexOf(">") + 1);
    const id = /\bid\s*=\s*(["'])([^"']+)\1/.exec(opening)?.[2];
    if (id === undefined) continue;
    if (counts.get(id) !== 1) continue; // equal/malformed duplicates also fail.
    const duration =
      /^<xbrli:context\s+id=(?:"[^"<>]+"|'[^'<>]+')\s*>\s*<xbrli:entity>\s*<xbrli:identifier\s+scheme=(["'])http:\/\/disclosure\.edinet-fsa\.go\.jp\1\s*>\s*(E\d{5}-\d{3})\s*<\/xbrli:identifier>\s*<\/xbrli:entity>\s*<xbrli:period>\s*<xbrli:startDate>\s*(\d{4}-\d{2}-\d{2})\s*<\/xbrli:startDate>\s*<xbrli:endDate>\s*(\d{4}-\d{2}-\d{2})\s*<\/xbrli:endDate>\s*<\/xbrli:period>\s*<\/xbrli:context\s*>$/.exec(
        m[0]
      );
    const instant =
      /^<xbrli:context\s+id=(?:"[^"<>]+"|'[^'<>]+')\s*>\s*<xbrli:entity>\s*<xbrli:identifier\s+scheme=(["'])http:\/\/disclosure\.edinet-fsa\.go\.jp\1\s*>\s*(E\d{5}-\d{3})\s*<\/xbrli:identifier>\s*<\/xbrli:entity>\s*<xbrli:period>\s*<xbrli:instant>\s*(\d{4}-\d{2}-\d{2})\s*<\/xbrli:instant>\s*<\/xbrli:period>\s*<\/xbrli:context\s*>$/.exec(m[0]);
    if (bound && bindings === 1 && instant?.[2] === entity && isIsoDate(instant[3])) {
      found.set(id, { contextRef: id, entity, instantDate: instant[3] });
      continue;
    }
    if (
      !bound ||
      bindings !== 1 ||
      !duration ||
      duration[2] !== entity ||
      !isIsoDate(duration[3]) ||
      !isIsoDate(duration[4]) ||
      duration[3] >= duration[4]
    ) {
      found.set(id, null);
      continue;
    }
    found.set(id, {
      contextRef: id,
      entity,
      startDate: duration[3],
      endDate: duration[4]
    });
  }
  return found;
}

/**
 * 選ばれた本文と同一 filing stem の PublicDoc instance/header だけを読む。
 * 一方だけなら一意の実定義を受理。両方あれば同じ ID の entity/開始/終了の
 * 一致が必須 (片方にない・重複・非対応も null)。別 issuer の定義は借りない。
 */
function readFilingContexts(
  entries: ZipEntries,
  honbunFile: string,
  reportPeriodEnd: string
): ReadonlyMap<string, FilingContext | null> {
  const name =
    /^(XBRL\/PublicDoc\/)\d+_honbun_(jpcrp030000-asr-\d{3}_(E\d{5}-\d{3})_(\d{4}-\d{2}-\d{2})_\d{2}_\d{4}-\d{2}-\d{2})_ixbrl\.html?$/.exec(
      honbunFile
    );
  if (!name || name[4] !== reportPeriodEnd) return new Map();
  const instanceName = `${name[1]}${name[2]}.xbrl`;
  const headerNames = [...entries.keys()].filter(
    (n) =>
      n.startsWith(name[1]) &&
      /^\d+_header_/.test(n.slice(name[1].length)) &&
      (n.endsWith(`_${name[2]}_ixbrl.htm`) ||
        n.endsWith(`_${name[2]}_ixbrl.html`))
  );
  if (headerNames.length > 1) return new Map();
  const sources: Map<string, FilingContext | null>[] = [];
  const instance = entries.get(instanceName);
  if (instance !== undefined)
    sources.push(
      readContexts(instance.toString("utf8"), name[3], "xbrli:xbrl")
    );
  if (headerNames.length === 1)
    sources.push(
      readContexts(
        entries.get(headerNames[0])!.toString("utf8"),
        name[3],
        "html"
      )
    );
  const out = new Map<string, FilingContext | null>();
  for (const source of sources) {
    for (const id of source.keys()) {
      if (out.has(id)) continue;
      const definitions = sources.map((s) => s.get(id));
      const first = definitions[0];
      if (
        !first ||
        definitions.some(
          (d) =>
            !d ||
            d.entity !== first.entity ||
            ("startDate" in first
              ? !("startDate" in d) || d.startDate !== first.startDate || d.endDate !== first.endDate
              : !("instantDate" in d) || d.instantDate !== first.instantDate)
        )
      ) {
        out.set(id, null);
      } else out.set(id, first);
    }
  }
  return out;
}

/** 既存 duration reader の公開 shape は不変。instant は引き続き null。 */
export function readFilingDurationContexts(
  entries: ZipEntries,
  honbunFile: string,
  reportPeriodEnd: string
): FilingDurationContexts {
  return new Map([...readFilingContexts(entries, honbunFile, reportPeriodEnd)]
    .map(([id, context]) => [id, context && "startDate" in context ? context : null]));
}

/** 実定義・同一 issuer/stem・両 source 一致・原 filename の提出日一致が必須。 */
export function readFilingDateInstant(
  entries: ZipEntries,
  honbunFile: string,
  reportPeriodEnd: string
): FilingDateInstant | null {
  const context = readFilingContexts(entries, honbunFile, reportPeriodEnd).get("FilingDateInstant");
  const filingDate = /_\d{2}_(\d{4}-\d{2}-\d{2})_ixbrl\.html?$/.exec(honbunFile)?.[1];
  return context && "instantDate" in context && context.instantDate === filingDate ? context : null;
}
