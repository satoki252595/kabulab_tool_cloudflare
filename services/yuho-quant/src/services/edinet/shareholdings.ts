/** 株式保有の当期明細。平文化CSV・株価・会社名から株数や上場区分を推定しない。 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isUnassignedEdinetSecCode } from "./types.js";
import { unzip, type ZipEntries } from "./zip.js";
import { extractTables, tableToGridExpanded, unitToYenFactor } from "./html-table.js";
import { stripHtml } from "./text-sections.js";
import { readFilingDateInstant, readReportedFilingInstant, type FilingDateInstant } from "./duration-context.js";
import { observeHoldingNameChanges, type HoldingNameChange } from "./shareholdings-name-change.js";

export interface ShareholdingsSource {
  docId: string;
  stockCode: string;
  edinetCode: string | null;
  fiscalYearEnd: string;
}

export interface Shareholding {
  name: string;
  kind: "特定投資株式" | "みなし保有株式";
  shares: number | null;
  sharesRaw: number | null;
  sharesUnit: "株" | "千株";
  bookValueYen: number | null;
  bookValueRaw: number | null;
  bookValueUnit: "円" | "千円" | "百万円";
  listingStatus: "unknown";
  price: null;
  priceDate: null;
  priceCurrency: null;
  tableIndex: number;
  rowIndex: number;
}

/** 節の明示不該当。株数0・全株式資産の不在・期末時点や価格完了を意味しない。 */
export interface ShareholdingsNotApplicable {
  version: 1;
  basis: "whole_section_not_applicable" | "filer_both_investment_purposes_absent";
  zipSha256: string; filename: string; memberSha256: string; blockHtmlSha256: string;
  elementNamespace: string; inlineNamespace: string;
  context: FilingDateInstant;
  statement: string;
}

export interface ShareholdingsExtraction {
  status: "ok" | "no_detail_table" | "unsupported" | "explicit_not_applicable";
  reason: string | null;
  source: ShareholdingsSource;
  filename: string | null;
  elementId: "jpcrp_cor:ShareholdingsTextBlock";
  contextRef: string | null;
  holdings: Shareholding[];
  holderScope: "filer_only" | "unqualified";
  notApplicable?: ShareholdingsNotApplicable;
  /** 原表の診断。holding値/原表factsSHAには加えず、価格主体資格へ明示注を渡す。 */
  nameChanges?: HoldingNameChange[];
}

/** 保存type1のDEIを公式namespace・単一PublicDoc・提出者/証券コード/期末で照合する。 */
export function verifySavedHoldingsSource(zip: Buffer, source: ShareholdingsSource,
  opts?: { onVerifiedEntries: (entries: ZipEntries) => void }): { status: "verified"; filename: string } | { status: "held"; reason: string } {
  if (source.edinetCode === null) return { status: "held", reason: "提出者EDINETコードが未確定です" };
  const entries = unzip(zip, { maxEntries: 5000, maxExpandedBytes: 64 * 1024 * 1024 });
  const result = verifyHoldingsSourceEntries(entries, source);
  if (result.status === "verified") opts?.onVerifiedEntries(entries);
  return result;
}

/** 同じbounded ZIP展開を使うproducer用。DEI資格を複製せず、二重展開を避ける。 */
export function verifyHoldingsSourceEntries(zipEntries: ZipEntries, source: ShareholdingsSource): { status: "verified"; filename: string } | { status: "held"; reason: string } {
  if (source.edinetCode === null) return { status: "held", reason: "提出者EDINETコードが未確定です" };
  const entries = [...zipEntries].filter(([filename]) => /\/PublicDoc\/[^/]+\.xbrl$/.test(filename));
  if (entries.length !== 1) return { status: "held", reason: "保存type1のPublicDoc XBRLを一意に特定できません" };
  const [filename, bytes] = entries[0];
  assert.ok(filename.includes(`_${source.edinetCode}-`) && filename.includes(`_${source.fiscalYearEnd}_`), "保存type1のmember名と提出者/期末が不一致です");
  const xml = bytes.toString("utf8").replace(/<!--[\s\S]*?-->/g, "");
  const bindings = [...xml.matchAll(/\bxmlns:([A-Za-z_][\w.-]*)\s*=\s*(["'])([^"']+)\2/g)];
  const official = bindings.filter(match => /^http:\/\/disclosure\.edinet-fsa\.go\.jp\/taxonomy\/jpdei\/\d{4}-\d{2}-\d{2}\/jpdei_cor$/.test(match[3]));
  if (official.length !== 1) return { status: "held", reason: "保存type1の公式DEI namespaceを一意に確認できません" };
  const prefix = official[0][1];
  assert.equal(bindings.filter(match => match[1] === prefix).length, 1, "保存type1のDEI namespaceが再束縛されています");
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let unassigned = false;
  for (const [name, expected] of Object.entries({ EDINETCodeDEI: source.edinetCode, SecurityCodeDEI: `${source.stockCode}0`, CurrentFiscalYearEndDateDEI: source.fiscalYearEnd })) {
    const matches = [...xml.matchAll(new RegExp(`<${escaped}:${name}\\b([^>]*)>([^<]*)<\\/${escaped}:${name}\\s*>`, "g"))];
    if (matches.length !== 1) return { status: "held", reason: `保存type1の${name}を一意に確認できません` };
    assert.match(matches[0][1], /\bcontextRef\s*=\s*(["'])FilingDateInstant\1/, "保存type1のDEI contextが不一致です");
    const actual = matches[0][2].trim();
    if (name === "SecurityCodeDEI" && isUnassignedEdinetSecCode(actual)) { unassigned = true; continue; }
    assert.equal(actual, expected, "保存type1のDEIと文書識別が不一致です");
  }
  if (unassigned) return { status: "held", reason: "原本SecurityCodeDEIが未割当00000です。公式提出者逆引きの追加根拠が未確認です" };
  return { status: "verified", filename };
}

const normalize = (text: string) => text.normalize("NFKC").replace(/\s/g, "");

/** nonNumericは入れ子と自己閉じnilを含む。最初の閉じタグでは切らない。 */
function shareholdingsBlocks(html: string): Array<{ html: string; opening: string; contextRef: string | null; continued: boolean }> {
  const blocks: Array<{ html: string; opening: string; contextRef: string | null; continued: boolean }> = [];
  let start = -1, depth = 0, contextRef: string | null = null, continued = false;
  let opening = "";
  for (const match of html.matchAll(/<\/?ix:nonNumeric\b[^>]*>/gi)) {
    const tag = match[0];
    const closing = tag.startsWith("</"), selfClosing = /\/\s*>$/.test(tag);
    if (start < 0) {
      if (closing || !/\bname=["']jpcrp_cor:ShareholdingsTextBlock["']/.test(tag)) continue;
      if (selfClosing) continue;
      start = match.index + tag.length;
      opening = tag;
      depth = 1;
      const context = /\bcontextRef=["']([^"']+)["']/.exec(tag);
      contextRef = context === null ? null : context[1];
      continued = /\bcontinuedAt=/.test(tag);
      continue;
    }
    if (!selfClosing) depth += closing ? -1 : 1;
    if (depth !== 0) continue;
    blocks.push({ html: html.slice(start, match.index), opening, contextRef, continued });
    start = -1;
  }
  if (start >= 0) throw new Error("株式保有TextBlockの終端が不明です");
  return blocks;
}

/** 保存142A/143Aの完全な段落列だけ。別会社区画や「一部該当なし」は採らない。 */
function explicitNotApplicable(block: ReturnType<typeof shareholdingsBlocks>[number], filename: string,
  entries: ZipEntries, source: ShareholdingsSource, zip: Buffer): ShareholdingsNotApplicable | undefined {
  if (!/^<ix:nonNumeric\s+(?:name="jpcrp_cor:ShareholdingsTextBlock"\s+contextRef="FilingDateInstant"|contextRef="FilingDateInstant"\s+name="jpcrp_cor:ShareholdingsTextBlock")\s+escape="true"\s*>$/.test(block.opening)) return;
  const paragraph = /<p\b[^>]*>([^<]*)<\/p\s*>/gi;
  const matches = [...block.html.matchAll(paragraph)];
  if (block.html.replace(paragraph, "").trim() !== "") return;
  const values = matches.map(m => normalize(stripHtml(m[1]))).filter(value => value.length > 0); // 原本の空白段落だけを正規化。
  if (!/^\([1-9][0-9]?\)【株式の保有状況】$/.test(values[0])) return;
  let basis: ShareholdingsNotApplicable["basis"];
  if (values.length === 2 && values[1] === "該当事項はありません。") basis = "whole_section_not_applicable";
  else if (JSON.stringify(values.slice(1)) === JSON.stringify([
    "①投資株式の区分の基準及び考え方",
    "当社は、保有目的が純投資目的の株式及び純投資目的以外の目的の株式のいずれも所有しておりません。",
    "②保有目的が純投資目的以外の目的である株式投資", "該当事項はありません。",
    "③保有目的が純投資目的である株式投資", "該当事項はありません。",
  ].map(normalize))) basis = "filer_both_investment_purposes_absent";
  else return;
  const member = entries.get(filename); assert.ok(member);
  const html = member.toString("utf8");
  const root = /^\uFEFF?\s*(?:<\?xml[^>]*>\s*)?<html\b[^>]*>/.exec(html);
  if (root === null || !/\bxmlns=(["'])http:\/\/www\.w3\.org\/1999\/xhtml\1/.test(root[0]) ||
    [...html.matchAll(/\bxmlns\s*=/g)].length !== 1) return;
  const namespaces = (prefix: string) => [...html.matchAll(new RegExp(`\\bxmlns:${prefix}\\s*=\\s*(["'])([^"']+)\\1`, "g"))];
  const jpcrp = namespaces("jpcrp_cor"), ix = namespaces("ix");
  if (jpcrp.length !== 1 || ix.length !== 1 || !root[0].includes(jpcrp[0][0]) || !root[0].includes(ix[0][0]) ||
    !/^http:\/\/disclosure\.edinet-fsa\.go\.jp\/taxonomy\/jpcrp\/\d{4}-\d{2}-\d{2}\/jpcrp_cor$/.test(jpcrp[0][2]) ||
    ix[0][2] !== "http://www.xbrl.org/2008/inlineXBRL") return;
  const identity = verifyHoldingsSourceEntries(entries, source);
  if (identity.status !== "verified") return;
  const context = readFilingDateInstant(entries, filename, source.fiscalYearEnd);
  if (context === null) return;
  const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  return { version: 1, basis, zipSha256: sha(zip), filename, memberSha256: sha(member), blockHtmlSha256: sha(block.html),
    elementNamespace: jpcrp[0][2], inlineNamespace: ix[0][2], context, statement: stripHtml(block.html) };
}

/** 明示非開示はNULL。保存原表の限定注1/2 prefix以外の注記・桁区切り不正はHOLD。 */
function numberCell(text: string): number | null | undefined {
  const value = normalize(text).replace(/^\(注[12]\)/, "");
  if (/^(?:-|－|―|—)$/.test(value)) return null;
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(value)) return undefined;
  const number = Number(value.replaceAll(",", ""));
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

export function parseShareholdingsData(zip: Buffer, source: ShareholdingsSource,
  opts?: { qualifySource: (entries: ZipEntries) => { status: "verified" } | { status: "held"; reason: string } }): ShareholdingsExtraction {
  if (!/^S[0-9A-Z]+$/.test(source.docId) || !/^[0-9A-Z]{4}$/.test(source.stockCode) ||
      (source.edinetCode !== null && !/^E\d{5}$/.test(source.edinetCode)) || !/^\d{4}-\d{2}-\d{2}$/.test(source.fiscalYearEnd) ||
      new Date(`${source.fiscalYearEnd}T00:00:00Z`).toISOString().slice(0, 10) !== source.fiscalYearEnd) {
    throw new Error("株式保有の書類識別・会計期末が不正です");
  }
  const result: ShareholdingsExtraction = { status: "no_detail_table", reason: "株数・単位・当期を確認できる明細表がありません", source,
    filename: null, elementId: "jpcrp_cor:ShareholdingsTextBlock", contextRef: null, holdings: [], holderScope: "unqualified" };
  if (source.edinetCode === null) return { ...result, status: "unsupported", reason: "提出者EDINETコードが未確定です" };
  const entries = unzip(zip);
  if (opts !== undefined) {
    const qualified = opts.qualifySource(entries);
    if (qualified.status === "held") return { ...result, status: "unsupported", reason: qualified.reason };
  }
  const candidates = [];
  for (const [filename, bytes] of entries) {
    if (!/\/PublicDoc\//.test(filename) || !/\.html?$/.test(filename)) continue;
    for (const block of shareholdingsBlocks(bytes.toString("utf8"))) candidates.push({ filename, ...block });
  }
  if (candidates.length === 0) return result;
  if (candidates.length !== 1) return { ...result, status: "unsupported", reason: "株式保有TextBlockが複数あり、採用元を確定できません" };
  const block = candidates[0];
  result.filename = block.filename;
  result.contextRef = block.contextRef;
  if (!block.filename.includes(`_${source.edinetCode}-`) || !block.filename.includes(`_${source.fiscalYearEnd}_`) ||
      block.contextRef !== "FilingDateInstant" || block.continued) {
    return { ...result, status: "unsupported", reason: "提出者・会計期末・本文の完全性を確認できません" };
  }
  const tables = extractTables(block.html);
  let lastEnd = 0, scope: "filer" | "other" | "unknown" = "unknown";
  let ambiguousOwnerSection = false;
  let unqualifiedLargestHolder: string | null = null;
  let kind: "特定投資株式" | "みなし保有株式" | null = null;
  let excludedTables = 0;
  for (const [tableIndex, table] of tables.entries()) {
    const start = block.html.indexOf(table, lastEnd);
    const beforeHtml = block.html.slice(lastEnd, start);
    const before = stripHtml(beforeHtml).normalize("NFKC");
    lastEnd = start + table.length;
    // 当社の株式を相手方が保有する、という表の列見出しは主体証拠に使わない。
    // 保存原典で確認した当社自身の保有説明と明示区画だけ。別会社区画へ入った後は
    // その中の「当社」を提出会社へ読み替えず、次の明示提出会社区画まで対象外。
    for (const event of before.matchAll(/(?:^|[\s。])当社は、|(?:当社が保有する|当社の保有する)|(?:^|[\s。])([^\s。]{1,100})\s*における株式の保有状況|(?:^|\s)\((最大保有会社の次に大きい会社)\)|(?:^|[\s。])(?:当社|提出会社)(?:及び|および)連結子会社のうち、[^。]{1,180}?\(最大保有会社\)(?:である\s*([^。]{1,120}?)\s*については以下の(?:とおり|通り)(?:であります|です)。|は([^。]{1,120}?)であるため、同社で保有している銘柄を記載しております。)/g)) {
      if (event[3] !== undefined || event[4] !== undefined) {
        const holder = (event[3] !== undefined ? event[3] : event[4]).trim();
        // Named-largest disclosure is not a filer identity proof. Keep already
        // qualified other sections and explicit self labels unchanged.
        if (!/^(?:当社|提出会社)(?:の株式の保有状況)?$/.test(holder) && scope !== "other") {
          scope = "unknown"; ambiguousOwnerSection = true;
          unqualifiedLargestHolder = holder; kind = null;
        }
      } else if (event[2] !== undefined) {
        // S100YB9P's named next-largest holder is a separate section. An
        // unproved owner section must not inherit the preceding filer scope.
        const after = before.slice(event.index + event[0].length);
        const named = /^\s*当社(?:及び|および)連結子会社のうち、[^。]{1,180}?会社は\s+(?:株式会社[^\s。()]{1,80}|[^\s。()]{1,80}株式会社)(?=\s|。|$)/.test(after);
        scope = named ? "other" : "unknown";
        ambiguousOwnerSection = !named;
        kind = null;
      } else if (event[1] !== undefined) {
        const label = event[1].replace(/^[①-⑳]/, "");
        scope = /^(?:[0-9]+[.)、]?)?(?:当社|提出会社)$/.test(label) ? "filer" : "other";
        ambiguousOwnerSection = false;
        unqualifiedLargestHolder = null;
        kind = null;
      } else if (scope !== "other" && !ambiguousOwnerSection) scope = "filer";
    }
    const parenthesizedKind = /(?:^|\s)\((特定投資株式|みなし保有株式)\)\s*$/.exec(before);
    const kindHeading = /(?:^|\s)(?:\((?:i|ii)\)\s*)?(特定投資株式|みなし保有株式)(\(信託財産として保有し議決権行使権限のあるもの等\))?\s*$/.exec(before);
    // A preceding paragraph's parenthesized note is not a heading prefix.
    let heading = "";
    for (const part of beforeHtml.split(/<\/(?:p|div|h[1-6])\s*>/i)) {
      const text = stripHtml(part).normalize("NFKC");
      if (text) heading = text;
    }
    const enumeration = /(?:^|\s)(\([^()]*\)?)\s*(?:特定投資株式|みなし保有株式)(?:\(信託財産として保有し議決権行使権限のあるもの等\))?\s*$/.exec(heading);
    // Spaced (a)/(b) headings were already accepted by the bare-kind path.
    // This change adds only (i)/(ii), including headings without a space.
    if (!parenthesizedKind && enumeration && !["(i)", "(ii)", "(a)", "(b)"].includes(enumeration[1])) {
      return { ...result, status: "unsupported", reason: "保有種別見出しの列挙記号を確認できません", holdings: [] };
    } else if (parenthesizedKind) {
      kind = parenthesizedKind[1] as Shareholding["kind"];
    } else if (kindHeading && (kindHeading[2] === undefined || kindHeading[1] === "みなし保有株式")) {
      kind = kindHeading[1] as Shareholding["kind"];
    } else if (/(?:^|\s)(?:特定投資株式|みなし保有株式)\s*\(|(?:^|\s)\((?:特定投資株式|みなし保有株式)|(?:特定投資株式|みなし保有株式)\s*$/.test(before)) {
      return { ...result, status: "unsupported", reason: "保有種別見出しの括弧注記を確認できません", holdings: [] };
    }
    const grid = tableToGridExpanded(table);
    if (grid.length < 4 || !grid[0].some(c => normalize(c) === "銘柄") ||
        !grid.slice(0, 3).some(row => row.some(c => c.includes("株式数")))) continue;
    if (scope === "other") { excludedTables++; continue; }
    if (scope !== "filer") return { ...result, status: "unsupported", reason: unqualifiedLargestHolder === null
      ? "明細の保有主体が当社/提出会社と明示されていません"
      : `最大保有会社「${unqualifiedLargestHolder}」を提出会社自身の保有主体として確認できません`, holdings: [] };
    if (grid.some(row => row.length < 3)) return { ...result, status: "unsupported", reason: "明細表の列数が不足しています", holdings: [] };
    // 当期/前期は明示ラベルで選ぶ。連結ラベル・重複・欠落・未知注記は読み替えない。
    const periods = grid[0].slice(1, 3).map(cell => normalize(cell).replace(/^\((当事業年度|前事業年度)\)$/, "$1"));
    let current: 1 | 2, previous: 1 | 2;
    if (periods[0] === "当事業年度" && periods[1] === "前事業年度") { current = 1; previous = 2; }
    else if (periods[0] === "前事業年度" && periods[1] === "当事業年度") { current = 2; previous = 1; }
    else return { ...result, status: "unsupported", reason: "明細表の保有種別・当期列・株数単位・金額単位を確認できません", holdings: [] };
    const shareHeader = normalize(grid[1][current]), bookHeader = normalize(grid[2][current]);
    const sharesUnit = /^株式数\((株|千株)\)$/.exec(shareHeader);
    let bookUnit = /^貸借対照表計上額\((円|千円|百万円)\)$/.exec(bookHeader);
    let dataStart = 3;
    const cellUnits = shareHeader === "株式数(上段)" && bookHeader === "貸借対照表計上額(下段)";
    // 単位だけを第4ヘッダ行へ置く実原表。現在/前期の明示同値を必須にする。
    if (sharesUnit && bookHeader === "貸借対照表計上額" && grid.length >= 6 && normalize(grid[3][0]) === "銘柄" && normalize(grid[3][1]) === normalize(grid[3][2])) {
      bookUnit = /^\((円|千円|百万円)\)$/.exec(normalize(grid[3][current]));
      dataStart = 4;
    }
    if (kind === null || normalize(grid[0][0]) !== "銘柄" || (!cellUnits && (!sharesUnit || !bookUnit)) ||
        normalize(grid[1][previous]) !== shareHeader || normalize(grid[2][previous]) !== bookHeader || (grid.length - dataStart) % 2 !== 0) {
      return { ...result, status: "unsupported", reason: "明細表の保有種別・当期列・株数単位・金額単位を確認できません", holdings: [] };
    }
    for (let rowIndex = dataStart; rowIndex < grid.length; rowIndex += 2) {
      const row = grid[rowIndex], book = grid[rowIndex + 1];
      let shareLabel: "株" | "千株", moneyLabel: "円" | "千円" | "百万円";
      let sharesRaw: number | null | undefined, bookValueRaw: number | null | undefined;
      if (cellUnits) {
        const shareParts = /^(.+?)(千株|株)$/.exec(normalize(row[current]));
        const bookParts = /^(.+?)(百万円|千円|円)$/.exec(normalize(book[current]));
        const previousShare = /^(.+?)(千株|株)$/.exec(normalize(row[previous]));
        const previousBook = /^(.+?)(百万円|千円|円)$/.exec(normalize(book[previous]));
        if (!shareParts || !bookParts || !previousShare || !previousBook || shareParts[2] !== previousShare[2] || bookParts[2] !== previousBook[2]) return { ...result, status: "unsupported", reason: "上下段セルの当期/前期単位を確認できません", holdings: [] };
        shareLabel = shareParts[2] as typeof shareLabel; moneyLabel = bookParts[2] as typeof moneyLabel;
        sharesRaw = numberCell(shareParts[1]); bookValueRaw = numberCell(bookParts[1]);
      } else {
        shareLabel = sharesUnit![1] as typeof shareLabel; moneyLabel = bookUnit![1] as typeof moneyLabel;
        sharesRaw = numberCell(row[current]); bookValueRaw = numberCell(book[current]);
      }
      if (!row[0] || normalize(row[0]) !== normalize(book[0]) || /^\d+$/.test(normalize(row[0])) || sharesRaw === undefined || bookValueRaw === undefined) return { ...result, status: "unsupported", reason: "銘柄名と株数・帳簿価額の行対応を確認できません", holdings: [] };
      const shares = sharesRaw === null ? null : sharesRaw * (shareLabel === "千株" ? 1000 : 1);
      const bookValueYen = bookValueRaw === null ? null : bookValueRaw * unitToYenFactor(moneyLabel);
      if ((shares !== null && (!Number.isFinite(shares) || shares > Number.MAX_SAFE_INTEGER)) || (bookValueYen !== null && !Number.isSafeInteger(bookValueYen))) return { ...result, status: "unsupported", reason: "単位換算後の数値を安全に保存できません", holdings: [] };
      result.holdings.push({ name: row[0], kind, shares, sharesRaw, sharesUnit: shareLabel, bookValueYen, bookValueRaw, bookValueUnit: moneyLabel,
        listingStatus: "unknown", price: null, priceDate: null, priceCurrency: null, tableIndex, rowIndex });
    }
  }
  if (new Set(result.holdings.map(holding => `${holding.kind}:${normalize(holding.name)}`)).size !== result.holdings.length) {
    return { ...result, status: "unsupported", reason: "同名銘柄の複数明細があり、既存行との対応を一意に確定できません", holdings: [] };
  }
  if (result.holdings.length > 0) {
    const nameChanges = result.holdings.some(holding => /\(注\)[1-9]\d{0,2}$/.test(normalize(holding.name)))
      ? observeHoldingNameChanges({ source, filename: block.filename, zip, member: entries.get(block.filename)!, blockHtml: block.html,
        context: readReportedFilingInstant(entries, block.filename, source.fiscalYearEnd), holdings: result.holdings }) : [];
    return { ...result, status: "ok", reason: null, holderScope: "filer_only",
      ...(nameChanges.length > 0 && verifyHoldingsSourceEntries(entries, source).status === "verified" ? { nameChanges } : {}) };
  }
  if (excludedTables > 0) return { ...result, reason: "当社/提出会社と明示された保有区画に適格明細がありません（名義別区画は対象外）" };
  const notApplicable = explicitNotApplicable(block, block.filename, entries, source, zip);
  if (notApplicable !== undefined) return { ...result, status: "explicit_not_applicable", holderScope: "filer_only", notApplicable,
    reason: "提出会社の株式保有節は原本で明示不該当です（期末数値や価格完了は未判定）" };
  return result;
}
