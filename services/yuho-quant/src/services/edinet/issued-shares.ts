/** 取得済みtype1の限定発行株数観測。権利イベント/価格係数/財務値を生成しない。 */
import { createHash } from "node:crypto";
import { readFilingDateInstant } from "./duration-context.js";
import { verifyHoldingsSourceEntries, type ShareholdingsSource } from "./shareholdings.js";
import { unzip, type ZipEntries } from "./zip.js";

const INSTANCE = "http://www.xbrl.org/2003/instance", DIMENSION = "http://xbrl.org/2006/xbrldi";
const ELEMENTS = {
  NumberOfIssuedSharesAsOfFiscalYearEndIssuedSharesTotalNumberOfSharesEtc: "fiscal-year-end",
  NumberOfIssuedSharesAsOfFilingDateIssuedSharesTotalNumberOfSharesEtc: "filing-date",
} as const;
const VERSIONS = ["2024-11-01", "2025-11-01"];
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
// V8の部分文字列で巨大なinstance全体を小diagnosticへ保持しない。
const copyText = (v: string) => Buffer.from(v, "utf8").toString("utf8");
const esc = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const date = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

function attributes(raw: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  const re = /([A-Za-z_][\w.:-]*)\s*=\s*(["'])([^"'<>]*)\2/g;
  let end = 0;
  for (const m of raw.matchAll(re)) {
    if (raw.slice(end, m.index).trim() !== "" || m[1] in out) return null;
    out[m[1]] = m[3]; end = m.index + m[0].length;
  }
  return raw.slice(end).trim() === "" ? out : null;
}

/** コメント/CDATA内を事実として読まず、原文indexは変えない。DTD/外部entityは非対応。 */
function nativeSource(filename: string, bytes: Buffer) {
  const raw = bytes.toString("utf8"), masked = raw.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, m => " ".repeat(m.length));
  const root = /^\uFEFF?\s*(?:<\?xml[^>]*>\s*)?<([\w.-]+:xbrl|html)\b([^>]*)>/.exec(masked);
  const a = root === null ? null : attributes(root[2]);
  const enclosed = root !== null && masked.trimEnd().endsWith(`</${root[1]}>`) && !/<!DOCTYPE|<!ENTITY/i.test(masked);
  const resolve = (qname: string): { namespace: string; name: string } | null => {
    const parts = /^([A-Za-z_][\w.-]*):([A-Za-z_][\w.-]*)$/.exec(qname);
    if (!enclosed || a === null || parts === null) return null;
    const ns = a[`xmlns:${parts[1]}`];
    if (ns === undefined || [...masked.matchAll(new RegExp(`\\bxmlns:${esc(parts[1])}\\s*=`, "g"))].length !== 1) return null;
    return { namespace: ns, name: parts[2] };
  };
  const namespaces = a === null ? null : Object.fromEntries(Object.entries(a).filter(([key]) => key === "xmlns" || key.startsWith("xmlns:")));
  return { filename, raw, masked, memberSha256: sha(bytes), namespaces, resolve };
}
type Native = ReturnType<typeof nativeSource>;

function definitions(native: Native, kind: "context" | "unit", id: string) {
  const out = [];
  const re = new RegExp(`<([A-Za-z_][\\w.-]*):${kind}\\b([^>]*)>([\\s\\S]*?)<\\/\\1:${kind}\\s*>`, "g");
  for (const m of native.masked.matchAll(re)) {
    const a = attributes(m[2]);
    if (a?.id !== id) continue;
    out.push({ prefix: m[1], attributes: a, body: m[3], rawDefinition: copyText(native.raw.slice(m.index, m.index + m[0].length)),
      filename: native.filename, memberSha256: native.memberSha256 });
  }
  return out;
}
const definitionProof = (d: ReturnType<typeof definitions>[number]) => ({ prefix: d.prefix, attributes: d.attributes,
  rawDefinition: d.rawDefinition, filename: d.filename, memberSha256: d.memberSha256 });

function context(native: Native, id: string, namespace: string | null) {
  const defs = definitions(native, "context", id);
  const base = { definitions: defs.map(definitionProof), entity: null as string | null, instantDate: null as string | null,
    dimensions: [] as { axis: string; member: string; axisNamespace: string | null; memberNamespace: string | null }[], valid: false };
  if (defs.length !== 1) return base;
  const def = defs[0], p = esc(def.prefix);
  if (native.resolve(`${def.prefix}:context`)?.namespace !== INSTANCE || Object.keys(def.attributes).join() !== "id") return base;
  const shape = new RegExp(`^\\s*<${p}:entity>\\s*<${p}:identifier\\s+scheme=(["'])http:\\/\\/disclosure\\.edinet-fsa\\.go\\.jp\\1\\s*>\\s*(E\\d{5}-\\d{3})\\s*<\\/${p}:identifier>\\s*<\\/${p}:entity>\\s*<${p}:period>\\s*<${p}:instant>\\s*(\\d{4}-\\d{2}-\\d{2})\\s*<\\/${p}:instant>\\s*<\\/${p}:period>\\s*(?:<${p}:scenario>([\\s\\S]*?)<\\/${p}:scenario>\\s*)?$`).exec(def.body);
  if (shape === null) return base;
  base.entity = shape[2]; base.instantDate = shape[3];
  if (!date(shape[3])) return base;
  if (shape[4] !== undefined) {
    const d = /^\s*<([\w.-]+):explicitMember\s+dimension=(["'])([\w.:-]+)\2\s*>\s*([\w.:-]+)\s*<\/\1:explicitMember>\s*$/.exec(shape[4]);
    if (d === null) return base;
    const axis = native.resolve(d[3]), member = native.resolve(d[4]);
    base.dimensions.push({ axis: d[3], member: d[4], axisNamespace: axis === null ? null : axis.namespace, memberNamespace: member === null ? null : member.namespace });
    if (native.resolve(`${d[1]}:explicitMember`)?.namespace !== DIMENSION || axis?.namespace !== namespace ||
      axis.name !== "ClassesOfSharesAxis" || member?.namespace !== namespace || member.name !== "OrdinaryShareMember") return base;
  }
  base.valid = true; return base;
}

function unit(native: Native, id: string) {
  const defs = definitions(native, "unit", id);
  if (defs.length !== 1) return { definitions: defs.map(definitionProof), measure: null, valid: false };
  const def = defs[0], p = esc(def.prefix);
  const m = new RegExp(`^\\s*<${p}:measure>\\s*([\\w.:-]+)\\s*<\\/${p}:measure>\\s*$`).exec(def.body);
  const resolved = m === null ? null : native.resolve(m[1]);
  return { definitions: defs.map(definitionProof), measure: m === null ? null : m[1], valid: Object.keys(def.attributes).join() === "id" &&
    native.resolve(`${def.prefix}:unit`)?.namespace === INSTANCE && resolved?.namespace === INSTANCE && resolved.name === "shares" };
}

export interface IssuedShareObservation {
  version: 1; status: "observed" | "observed-with-holds" | "not-observed" | "held" | "unknown";
  reason: string | null; source: ShareholdingsSource | null; zipSha256: string; candidateCount: number | null;
  sourceQualification: { status: "verified" | "held" | "unknown"; reason: string | null };
  filingDateEvidence: { rawSubmitDateTime: string; provenance: "same-edinet-document" | "saved-archive-metadata" } | null;
  instance: { filename: string; memberSha256: string; namespaces: Record<string, string> | null } | null;
  observations: Array<{
    element: string; namespace: string | null; occurrence: number; attributes: Record<string, string> | null; rawAttributes: string; rawValue: string;
    factSha256: string; contextRef: string | null; unitRef: string | null; decimals: string | null;
    contexts: ReturnType<typeof context>[]; units: ReturnType<typeof unit>[];
    qualification: { status: "observed-kind" | "hold"; reason: string | null; kind: "fiscal-year-end" | "filing-date" | null;
      economicDate: string | null; nativeContextDate: string | null; shareClass: "ordinary" | "unknown"; rightsApplication: "unknown" };
  }> | null;
}

/** 未有効caller/解析前停止をイベント不在へ変換しないtyped receipt。 */
export function unobservedIssuedShares(zip: Buffer, source: ShareholdingsSource, reason: string,
  sourceQualification: IssuedShareObservation["sourceQualification"]): IssuedShareObservation {
  return { version: 1, status: sourceQualification.status === "held" ? "held" : "not-observed", reason, source,
    sourceQualification, zipSha256: sha(zip), candidateCount: null, filingDateEvidence: null, instance: null, observations: null };
}

/** 同じ取得/検証済みZIPを通常producerと保存replayで使う。未資格は原本参照つきtyped HOLD。 */
export function observeIssuedShares(zip: Buffer, source: ShareholdingsSource | null,
  filingDateEvidence: IssuedShareObservation["filingDateEvidence"] = null,
  existingEntries?: ZipEntries): IssuedShareObservation {
  const base: IssuedShareObservation = { version: 1, status: "unknown", reason: "期待する提出者/証券コード/期末が未確定です", source,
    zipSha256: sha(zip), candidateCount: null, instance: null, observations: null,
    sourceQualification: { status: "unknown", reason: "期待identity未確定" }, filingDateEvidence };
  if (source === null || source.edinetCode === null) return base;
  try {
    const entries = existingEntries === undefined ? unzip(zip, { maxEntries: 5000, maxExpandedBytes: 64 * 1024 * 1024 }) : existingEntries;
    const verified = verifyHoldingsSourceEntries(entries, source);
    if (verified.status === "held") return { ...base, status: "held", reason: verified.reason, sourceQualification: verified };
    base.sourceQualification = { status: "verified", reason: null };
    const bytes = entries.get(verified.filename);
    if (bytes === undefined) return { ...base, status: "held", reason: "資格化したinstanceが欠測です" };
    const instance = nativeSource(verified.filename, bytes);
    base.instance = { filename: instance.filename, memberSha256: instance.memberSha256, namespaces: instance.namespaces };
    const stem = /^XBRL\/PublicDoc\/(jpcrp030000-asr-\d{3}_(E\d{5}-\d{3})_(\d{4}-\d{2}-\d{2})_\d{2}_(\d{4}-\d{2}-\d{2}))\.xbrl$/.exec(instance.filename);
    if (stem === null || stem[2] !== `${source.edinetCode}-000` || stem[3] !== source.fiscalYearEnd) return { ...base, status: "held", reason: "単一PublicDocのissuer/stem/期末が未資格です" };
    const bodies = [...entries.keys()].filter(n => /^XBRL\/PublicDoc\/\d+_honbun_/.test(n) && (n.endsWith(`_${stem[1]}_ixbrl.htm`) || n.endsWith(`_${stem[1]}_ixbrl.html`))).sort();
    const headers = [...entries.keys()].filter(n => /^XBRL\/PublicDoc\/\d+_header_/.test(n) && (n.endsWith(`_${stem[1]}_ixbrl.htm`) || n.endsWith(`_${stem[1]}_ixbrl.html`)));
    if (bodies.length === 0 || headers.length > 1) return { ...base, status: "held", reason: "同じstemの本文/headerを確定できません" };
    const filing = readFilingDateInstant(entries, bodies[0], source.fiscalYearEnd);
    // EDINET一覧の原JST表記だけ。ISO変換済み保存時計やfilenameは代用しない。
    const submitted = filingDateEvidence === null ? null : /^(\d{4}-\d{2}-\d{2}) ([01]\d|2[0-3]):([0-5]\d)$/.exec(filingDateEvidence.rawSubmitDateTime);
    const declaredFilingDate = submitted !== null && date(submitted[1]) ? submitted[1] : null;
    const natives = [instance, ...headers.map(n => nativeSource(n, entries.get(n)!))];
    const re = new RegExp(`<([A-Za-z_][\\w.-]*):(${Object.keys(ELEMENTS).join("|")})\\b([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/\\1:\\2\\s*>)`, "g");
    const matches = [...instance.masked.matchAll(re)]; base.candidateCount = matches.length;
    const openings = [...instance.masked.matchAll(new RegExp(`<([A-Za-z_][\\w.-]*):(${Object.keys(ELEMENTS).join("|")})\\b`, "g"))];
    if (openings.length !== matches.length) return { ...base, status: "held", reason: "限定項目の開始/終端が未完です。原ZIPを保全します" };
    // ponytail: 小さい診断のみ。同一原ZIPは保管するので、異常な大量観測は切捨て成功にせずHOLD。
    if (matches.length > 64) return { ...base, status: "held", reason: "限定項目の観測数が64件予算を超えました。原ZIPを保全します" };
    const keys = matches.map(m => { const a = attributes(m[3]); return `${m[2]}\0${a?.contextRef}`; });
    const observations = matches.map((m, occurrence): NonNullable<IssuedShareObservation["observations"]>[number] => {
      const a = attributes(m[3]), q = instance.resolve(`${m[1]}:${m[2]}`), namespace = q === null ? null : q.namespace;
      const rawFact = instance.raw.slice(m.index, m.index + m[0].length), start = rawFact.indexOf(">"), end = rawFact.lastIndexOf("</");
      const rawValue = end < 0 ? "" : copyText(rawFact.slice(start + 1, end));
      const contextRef = a?.contextRef === undefined ? null : a.contextRef, unitRef = a?.unitRef === undefined ? null : a.unitRef;
      const contexts = contextRef === null ? [] : natives.map(n => context(n, contextRef, namespace));
      const units = unitRef === null ? [] : natives.map(n => unit(n, unitRef));
      const c = contexts[0], kind = ELEMENTS[m[2] as keyof typeof ELEMENTS];
      const sameContext = contexts.every(v => v.valid && v.entity === c.entity && v.instantDate === c.instantDate &&
        JSON.stringify(v.dimensions.map(d => [d.axisNamespace, d.axis.split(":")[1], d.memberNamespace, d.member.split(":")[1]])) ===
        JSON.stringify(c.dimensions.map(d => [d.axisNamespace, d.axis.split(":")[1], d.memberNamespace, d.member.split(":")[1]])));
      let reason: string | null = null;
      if (namespace === null || !VERSIONS.some(v => namespace === `http://disclosure.edinet-fsa.go.jp/taxonomy/jpcrp/${v}/jpcrp_cor`)) reason = "taxonomy-namespace-unqualified-or-rebound";
      else if (filing === null || filing.instantDate !== stem[4] || c === undefined || !sameContext || c.entity !== stem[2] || c.instantDate !== filing.instantDate) reason = "context-definition-entity-time-or-dimensions-unqualified";
      else if (declaredFilingDate !== null && declaredFilingDate !== filing.instantDate) reason = "declared-filing-date-mismatch";
      else if (c.dimensions.length !== 1) reason = "share-class-unspecified;dimension-free-is-not-ordinary";
      else if (units.length === 0 || units.some(u => !u.valid)) reason = "shares-unit-unqualified";
      else if (a === null || Object.keys(a).some(k => !["contextRef", "unitRef", "decimals", "id"].includes(k)) ||
        !["0", "INF"].includes(a.decimals) || !/^\d+$/.test(rawValue.trim())) reason = "raw-value-nil-or-precision-unqualified";
      else if (keys.filter(k => k === keys[occurrence]).length !== 1) reason = "same-element-context-multiple-facts";
      else if (kind === "filing-date" && declaredFilingDate === null) reason = "filing-economic-date-unqualified;native-context-is-not-submission-proof";
      return { element: `${m[1]}:${m[2]}`, namespace, occurrence, attributes: a, rawAttributes: copyText(m[3]), rawValue,
        factSha256: sha(rawFact), contextRef, unitRef, decimals: a?.decimals === undefined ? null : a.decimals, contexts, units,
        qualification: { status: reason === null ? "observed-kind" : "hold", reason, kind: reason === null ? kind : null,
          economicDate: reason === null ? (kind === "fiscal-year-end" ? source.fiscalYearEnd : declaredFilingDate) : null,
          nativeContextDate: c === undefined ? null : c.instantDate, shareClass: reason === null ? "ordinary" : "unknown", rightsApplication: "unknown" } };
    });
    // 異なるcontextRefでも同じ限定kindの複数値は一意に採らない。
    for (const kind of Object.values(ELEMENTS)) {
      const qualified = observations.filter(o => o.qualification.kind === kind);
      if (qualified.length > 1) for (const o of qualified) o.qualification = { ...o.qualification, status: "hold", reason: "same-kind-multiple-contexts", kind: null, economicDate: null, shareClass: "unknown" };
    }
    const held = observations.filter(o => o.qualification.status === "hold").length;
    const result: IssuedShareObservation = { ...base, status: observations.length === 0 ? "not-observed" : held === observations.length ? "held" : held > 0 ? "observed-with-holds" : "observed", reason: held > 0 ? "未資格の観測はHOLDのまま保持します" : null, observations };
    if (Buffer.byteLength(JSON.stringify(result)) > 64 * 1024) return { ...base, status: "held", reason: "診断64KiB予算超過。原ZIPの全原文を保全し観測完了とは数えません" };
    return result;
  } catch (error) {
    const reason = `原本/DEI資格を確定できません: ${error instanceof Error ? error.message : String(error)}`;
    return { ...base, status: "held", reason, sourceQualification: base.sourceQualification.status === "verified" ? base.sourceQualification : { status: "held", reason } };
  }
}
