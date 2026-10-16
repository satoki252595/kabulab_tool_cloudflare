/** 保有明細の唯一のNotion入口。旧推定値は残し、原表で確定した列だけを公開する。 */
import assert from "node:assert/strict";
import { AssertionError } from "node:assert";
import { createHash } from "node:crypto";
import { parseShareholdingsData, verifySavedHoldingsSource, verifyHoldingsSourceEntries, type Shareholding, type ShareholdingsSource, type ShareholdingsExtraction, type ShareholdingsNotApplicable } from "../../../services/yuho-quant/src/services/edinet/shareholdings.js";
import { observeIssuedShares, unobservedIssuedShares, type IssuedShareObservation } from "../../../services/yuho-quant/src/services/edinet/issued-shares.js";
import type { OfficialIssuerNames } from "../../../services/yuho-quant/src/services/edinet/shareholdings-issuer-names.js";
import { HoldingPriceIssuerMismatch, HoldingPriceShareBasisMismatch, HoldingsPriceIndex, parseHoldingsCodeList, qualifyHoldingValuation, type ArchivedSource, type HoldingValuation } from "../../../services/yuho-quant/src/services/edinet/shareholdings-valuation.js";
import { edinetArchiveFilename } from "../../../services/yuho-quant/src/services/edinet/archive.js";
import { findUniqueBackupChildByTitle, queryUniqueRow, recordPrimaryData } from "./archive.js";
import { assertCursorProgress, notionRequest } from "./client.js";
import { notionEnv } from "./env.js";
import { splitRichText } from "./rich-text.js";
import { verifyArchivedAttachments } from "./readback.js";
import { listPageFiles } from "./page-file.js";
import { normalizeFilePropForCompare } from "./file-property.js";
import { downloadArchivedFile } from "./archived-download.js";

export const HOLDINGS_ZIP_MAX_BYTES = 20 * 1024 * 1024;

export interface HoldingsSchema {
  id: string;
  description: Array<{ plain_text: string }>;
  properties: Record<string, { id: string; type: string; formula?: { expression: string }; select?: { options: Array<{ id: string; name: string; color: string }> } }>;
}

export const HOLDINGS_DESCRIPTION = "有報の保有株式明細。原本照合済の列だけ確定値として扱い、旧取込の値は未検証列に保持する。期末参考時価は同日期末株数×終値で、価格・通貨・単位・分割を照合できない場合は欠測理由を示す。";

export const LEGACY_HOLDINGS_COLUMNS = [
  ["区分", "旧分類（未検証）", "select"],
  ["保有株数", "旧抽出株数（単位未確認）", "number"],
  ["株価", "旧株価（通貨・観測日未確認）", "number"],
  ["保有時価", "旧試算時価（未検証）", "number"],
  ["基準日", "旧処理基準日（観測日未確認）", "date"],
] as const;

const canonical: Record<string, Record<string, unknown>> = {
  "保有株数": { number: { format: "number" } },
  "株数単位": { rich_text: {} },
  "帳簿価額（円）": { number: { format: "number" } },
  "株価": { number: { format: "number" } },
  "保有時価": { number: { format: "number" } },
  "通貨": { rich_text: {} },
  "基準日": { date: {} },
  "区分": { select: { options: [{ name: "未確認", color: "gray" }, { name: "上場（コードリスト基準日）", color: "blue" }] } },
  "保有種別": { select: { options: [{ name: "特定投資株式", color: "blue" }, { name: "みなし保有株式", color: "purple" }] } },
  "出典文書ID": { rich_text: {} },
  "出典要素ID": { rich_text: {} },
  "出典明細行": { rich_text: {} },
  "出典ファイル": { rich_text: {} },
  "出典Context": { rich_text: {} },
  "出典原本SHA256": { rich_text: {} },
  "欠測理由": { rich_text: {} },
  "確定銘柄コード": { rich_text: {} },
  "銘柄照合根拠": { rich_text: {} },
  "価格照合根拠": { rich_text: {} },
  "価格照合済": { checkbox: {} },
  "原本照合済": { checkbox: {} },
  "検証状態": { formula: { expression: 'if(prop("原本照合済"), "明細原本照合済", "未検証（旧取込）")' } },
  "価格状態": { formula: { expression: 'if(prop("価格照合済"), "期末参考時価（同日期末株数×終値）", "未取得（価格・通貨・株数単位の照合未成立）")' } },
};

/** 既存property/option IDを維持するので、27587行の数値を書き換えない。 */
export function buildHoldingsSchemaPatch(schema: HoldingsSchema): { properties: Record<string, unknown> } {
  const properties: Record<string, unknown> = {};
  const renamed = new Set<string>();
  for (const [name, legacy, type] of LEGACY_HOLDINGS_COLUMNS) {
    if (schema.properties[legacy]) {
      assert.equal(schema.properties[legacy].type, type);
      continue;
    }
    const old = schema.properties[name];
    assert.ok(old?.id);
    assert.equal(old.type, type);
    // Legacy option IDs/names also remain unchanged. Notion API cannot rename options.
    properties[old.id] = { name: legacy };
    renamed.add(name);
  }
  for (const [name, definition] of Object.entries(canonical)) {
    const type = Object.keys(definition)[0];
    if (!renamed.has(name) && schema.properties[name]) {
      assert.equal(schema.properties[name].type, type);
      if (type === "formula" && schema.properties[name].formula?.expression !== (definition.formula as { expression: string }).expression) properties[name] = definition;
      if (type === "select") {
        const actual = schema.properties[name].select; assert.ok(actual);
        const required = (definition.select as { options: Array<{ name: string; color: string }> }).options;
        const missing = required.filter(option => !actual.options.some(existing => existing.name === option.name));
        if (missing.length > 0) properties[schema.properties[name].id] = { select: { options: [...actual.options, ...missing] } };
      }
    }
    else properties[name] = definition;
  }
  return { properties };
}

export async function readHoldingsSchema(): Promise<HoldingsSchema> {
  return notionRequest<HoldingsSchema>("GET", `/databases/${notionEnv.NOTION_STOCK_HOLDINGS_DB_ID()}`);
}

/** rootが物理PRE保管を確認してから呼ぶ。未知のACKは後続読取/行更新へ進めない。 */
export async function applyHoldingsSchema(expected: HoldingsSchema): Promise<HoldingsSchema> {
  const current = await readHoldingsSchema();
  assert.equal(current.id.replaceAll("-", ""), expected.id.replaceAll("-", ""));
  assert.deepEqual(current.properties, expected.properties, "保有明細schemaが準備時から変化しています");
  assert.deepEqual(current.description, expected.description, "保有明細の説明が準備時から変化しています");
  let patch = buildHoldingsSchemaPatch(current);
  const renames = Object.fromEntries(Object.entries(patch.properties).filter(([, value]) =>
    typeof value === "object" && value !== null && "name" in value));
  if (Object.keys(renames).length > 0) {
    // Release the old property names before creating new columns with those names.
    await notionRequest("PATCH", `/databases/${notionEnv.NOTION_STOCK_HOLDINGS_DB_ID()}`, { properties: renames }, { singleAttempt: true });
    const renamed = await readHoldingsSchema();
    for (const [name, legacy] of LEGACY_HOLDINGS_COLUMNS) {
      assert.equal(renamed.properties[legacy].id, current.properties[name].id);
    }
    patch = buildHoldingsSchemaPatch(renamed);
  }
  if (Object.keys(patch.properties).length > 0 || current.description.map(p => p.plain_text).join("") !== HOLDINGS_DESCRIPTION) {
    await notionRequest("PATCH", `/databases/${notionEnv.NOTION_STOCK_HOLDINGS_DB_ID()}`, { ...patch, description: splitRichText(HOLDINGS_DESCRIPTION) }, { singleAttempt: true });
  }
  const actual = await readHoldingsSchema();
  assert.equal(actual.description.map(p => p.plain_text).join(""), HOLDINGS_DESCRIPTION);
  for (const [name, legacy, type] of LEGACY_HOLDINGS_COLUMNS) {
    const old = current.properties[legacy] ? current.properties[legacy] : current.properties[name];
    assert.equal(actual.properties[legacy].id, old.id);
    assert.equal(actual.properties[legacy].type, type);
    if (type === "select") {
      for (const option of old.select!.options) {
        const updated: { id: string; name: string; color: string } | undefined = actual.properties[legacy].select!.options.find(o => o.id === option.id);
        assert.ok(updated);
        assert.equal(updated.name, option.name);
      }
    }
  }
  for (const [name, definition] of Object.entries(canonical)) assert.equal(actual.properties[name].type, Object.keys(definition)[0]);
  assert.equal(Object.keys(buildHoldingsSchemaPatch(actual).properties).length, 0, "保有明細schemaのformula/選択肢の読戻しが未成立です");
  return actual;
}

const rt = (text: string) => ({ rich_text: splitRichText(text) });

interface HoldingProperty {
  id?: string;
  type?: string;
  formula?: { type: string; string?: string | null };
  rich_text?: Array<{ type?: string; plain_text?: string; text?: { content?: string } }>;
  title?: Array<{ type?: string; plain_text?: string; text?: { content?: string } }>;
  number?: number | null;
  select?: { name: string } | null;
  date?: { start: string; end?: null; time_zone?: null } | null;
  checkbox?: boolean;
}

interface HoldingPage {
  object: "page";
  id: string;
  parent: { type: string; database_id: string };
  archived: boolean;
  in_trash: boolean;
  created_time?: string;
  last_edited_time?: string;
  properties: Record<string, HoldingProperty>;
}

/** 同一issuer/期末だけを一度読む。各行で全DB検索せず、既存cursor/未完guardを使う。 */
async function readHoldingPeriodRows(databaseId: string, source: ShareholdingsSource): Promise<HoldingPage[]> {
  const rows: HoldingPage[] = [], ids = new Set<string>(), cursors = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const response = await notionRequest<{ results: HoldingPage[]; has_more: boolean; next_cursor: string | null }>(
      "POST", `/databases/${databaseId}/query`, { filter: { and: [
        { property: "保有会社コード", rich_text: { equals: source.stockCode } },
        { property: "期末", date: { equals: source.fiscalYearEnd } },
      ] }, page_size: 100, ...(cursor === undefined ? {} : { start_cursor: cursor }) });
    for (const page of response.results) {
      assert.equal(page.object, "page"); assert.equal(page.parent.type, "database_id");
      assert.equal(page.parent.database_id.replaceAll("-", ""), databaseId.replaceAll("-", ""));
      assert.equal(page.archived, false); assert.equal(page.in_trash, false);
      assert.ok(!ids.has(page.id), "保有明細のページがcursor間で重複しています"); ids.add(page.id);
      assertProperties(page.properties, { "保有会社コード": rt(source.stockCode), "期末": { date: { start: source.fiscalYearEnd } } });
      rows.push(page);
      assert.ok(rows.length <= 1000, "同一issuer/期末の候補1000行の読取予算を超えました");
    }
    if (!response.has_more) { assert.equal(response.next_cursor, null); return rows; }
    assert.equal(typeof response.next_cursor, "string"); assertCursorProgress(cursors, response.next_cursor!); cursor = response.next_cursor!;
  }
}

/** 種別欠測を特定投資とみなさない。whole documentと旧行の一対一対応だけを明示移行する。 */
export function resolveHoldingRows(source: ShareholdingsSource, ownerName: string, allHoldings: readonly Shareholding[],
  selected: readonly Shareholding[], rows: readonly HoldingPage[]):
  { status: "ready"; selected: Array<{ existing: HoldingPage | null; migrateLegacy: boolean }> } | { status: "held"; reason: string } {
  const byName = new Map<string, HoldingPage[]>(), sourceNames = new Map<string, number>();
  for (const holding of allHoldings) { const count = sourceNames.get(holding.name); sourceNames.set(holding.name, count === undefined ? 1 : count + 1); }
  for (const page of rows) {
    const name = richValue(page.properties["銘柄名"]);
    assertProperties(page.properties, { "保有会社コード": rt(source.stockCode), "期末": { date: { start: source.fiscalYearEnd } } });
    const group = byName.get(name); if (group) group.push(page); else byName.set(name, [page]);
  }
  const resolved: Array<{ existing: HoldingPage | null; migrateLegacy: boolean }> = [];
  for (const holding of selected) {
    const named = byName.get(holding.name); if (named === undefined) { resolved.push({ existing: null, migrateLegacy: false }); continue; }
    const exact = named.filter(page => { assert.equal(page.properties["保有種別"].type, "select"); return page.properties["保有種別"].select?.name === holding.kind; });
    if (exact.length > 1) return { status: "held", reason: "同一issuer・銘柄名・期末・保有種別の既存行が複数あります" };
    if (exact.length === 1) { resolved.push({ existing: exact[0], migrateLegacy: false }); continue; }
    const legacy = named.filter(page => page.properties["保有種別"].select === null);
    if (legacy.length === 0) { resolved.push({ existing: null, migrateLegacy: false }); continue; }
    if (legacy.length !== 1 || named.length !== 1 || sourceNames.get(holding.name) !== 1) return { status: "held", reason: "種別未記録の旧行と原表全体の明細を一対一に対応できません" };
    const page = legacy[0];
    if (richValue(page.properties["保有会社"]) !== ownerName) return { status: "held", reason: "旧行の保有主体名が提出会社の明示名と完全一致しません" };
    for (const name of ["原本照合済", "価格照合済"]) { assert.equal(page.properties[name].type, "checkbox"); if (page.properties[name].checkbox !== false) return { status: "held", reason: "旧行に既照合フラグがあり種別欠測の移行を許可できません" }; }
    for (const name of ["出典文書ID", "出典原本SHA256", "出典明細行", "出典要素ID", "出典ファイル", "出典Context"]) {
      if (richValue(page.properties[name]) !== "") return { status: "held", reason: "種別未記録の旧行に出典情報があり黙って置換できません" };
    }
    assert.ok(typeof page.created_time === "string" && Number.isFinite(Date.parse(page.created_time)));
    assert.ok(typeof page.last_edited_time === "string" && Number.isFinite(Date.parse(page.last_edited_time)));
    resolved.push({ existing: page, migrateLegacy: true });
  }
  return { status: "ready", selected: resolved };
}

/** 完了markerだけで同値としない。全原表のfile/contextを含む通常出典列を再照合する。 */
export function verifyCompletedHoldingsSource(source: ShareholdingsSource, ownerName: string, parsed: ShareholdingsExtraction,
  zipSha256: string, rows: readonly HoldingPage[]): { status: "verified" } | { status: "held"; reason: string } {
  const found = resolveHoldingRows(source, ownerName, parsed.holdings, parsed.holdings, rows);
  if (found.status === "held") return found;
  for (const [index, choice] of found.selected.entries()) {
    if (choice.migrateLegacy || choice.existing?.properties["原本照合済"]?.checkbox !== true) return { status: "held", reason: "完了sourceの原本確定行を全明細で確認できません" };
    const holding = parsed.holdings[index];
    const expected = { ...holdingProperties(source, ownerName, holding), ...sourceProperties(parsed, holding, zipSha256) };
    try { assertProperties(choice.existing.properties, Object.fromEntries(Object.entries(expected).filter(([name]) => !VALUATION_COLUMNS.has(name)))); }
    catch (error) { if (!(error instanceof AssertionError)) throw error; return { status: "held", reason: "完了sourceの全出典・原本確定値が保存原表と不一致です" }; }
  }
  return { status: "verified" };
}

interface MigrationFile { key: string; filename: string; sha256: string; bytes: number; pageId?: string }
function migrationFile(source: ShareholdingsSource, offset: number, phase: "PRE" | "POST", bytes: Uint8Array): MigrationFile {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { key: `holdings-legacy/${source.docId}/${offset}/${phase}/${sha256}`, filename: `holdings-legacy-${phase}.json`, sha256, bytes: bytes.length };
}
async function archiveMigration(source: ShareholdingsSource, file: MigrationFile, bytes: Uint8Array): Promise<MigrationFile> {
  assert.ok(bytes.length <= 20 * 1024 * 1024, "移行証跡20MiBの予算を超えました");
  assert.equal(bytes.length, file.bytes); assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
  const stored = await recordPrimaryData({ service: "yuho-quant", key: file.key, source: "保有明細の旧未検証行を保存原表で置換する通常移行", metadata: {
    source, legacyValuesPreserved: true, unverifiedCanonicalValuesReplacedFromSavedSource: true, sha256: file.sha256,
  }, files: [{ filename: file.filename, contentType: "application/json", bytes }] });
  assert.equal(stored.fileTooLarge, false); assert.ok(stored.manifestMatch === "written" || stored.manifestMatch === "same");
  await verifyArchivedAttachments(stored.pageId, [{ filename: file.filename, bytes }], "保有明細の旧行移行証跡");
  return { ...file, pageId: stored.pageId };
}
function assertSameHoldingPage(actual: HoldingPage, expected: HoldingPage): void {
  for (const name of ["object", "id", "parent", "archived", "in_trash", "created_time", "last_edited_time"] as const) assert.deepEqual(actual[name], expected[name], "保有明細のfresh PRE/POSTが変更されています");
  assert.deepEqual(stableProperties(actual.properties), stableProperties(expected.properties), "保有明細のfresh全propsが変更されています");
}
function assertMigrationPost(actual: HoldingPage, before: HoldingPage, changed: Record<string, HoldingProperty>, schema: HoldingsSchema): void {
  assert.equal(actual.object, "page"); assert.equal(actual.id, before.id); assert.deepEqual(actual.parent, before.parent);
  assert.equal(actual.archived, false); assert.equal(actual.in_trash, false); assert.equal(actual.created_time, before.created_time);
  assertProperties(actual.properties, changed);
  assert.equal(actual.properties["検証状態"].id, schema.properties["検証状態"].id);
  assert.equal(actual.properties["検証状態"].type, "formula");
  assert.deepEqual(actual.properties["検証状態"].formula, { type: "string", string: "明細原本照合済" });
  assertPriceStatus(actual.properties, schema);
  assert.deepEqual(Object.keys(actual.properties).sort(), Object.keys(before.properties).sort());
  for (const [name, value] of Object.entries(before.properties)) {
    assert.equal(actual.properties[name].id, value.id, "移行でproperty IDが変更されています");
    const expected = name === "検証状態" || name === "価格状態" ? { ...value, formula: actual.properties[name].formula } : value;
    if (!Object.hasOwn(changed, name)) assert.deepEqual(stableProperty(actual.properties[name]), stableProperty(expected), "移行でlegacy/他propsが変更されています");
  }
}

export function holdingProperties(source: ShareholdingsSource, ownerName: string, holding: Shareholding): Record<string, HoldingProperty> {
  return {
    "Name": { title: splitRichText(`${source.stockCode} ${ownerName} → ${holding.name}`) },
    "保有会社コード": rt(source.stockCode), "保有会社": rt(ownerName), "銘柄名": rt(holding.name),
    "保有株数": { number: holding.shares }, "株数単位": rt("株"),
    "帳簿価額（円）": { number: holding.bookValueYen },
    "株価": { number: null }, "保有時価": { number: null }, "通貨": rt(""), "基準日": { date: null },
    "区分": { select: { name: "未確認" } }, "保有種別": { select: { name: holding.kind } },
    "期末": { date: { start: source.fiscalYearEnd } },
    "出典文書ID": rt(source.docId), "出典要素ID": rt("jpcrp_cor:ShareholdingsTextBlock"),
    "出典明細行": rt(`${holding.tableIndex}:${holding.rowIndex}`), "原本照合済": { checkbox: true },
  };
}

function assertProperties(actual: Record<string, HoldingProperty>, expected: Record<string, HoldingProperty>): void {
  for (const [name, value] of Object.entries(expected)) {
    const type = Object.keys(value)[0] as keyof HoldingProperty;
    assert.equal(actual[name]?.type, type);
    if (type === "rich_text" || type === "title") {
      const parts = actual[name][type];
      assert.ok(Array.isArray(parts));
      for (const part of parts) {
        assert.equal(part.type, "text");
        assert.equal(typeof part.plain_text, "string");
        assert.equal(typeof part.text?.content, "string");
        assert.equal(part.plain_text, part.text?.content);
      }
      const expectedParts = value[type];
      assert.ok(Array.isArray(expectedParts));
      assert.equal(parts.map(p => p.plain_text).join(""), expectedParts.map(p => p.text?.content).join(""));
    } else if (type === "select") {
      assert.ok(value.select);
      assert.equal(actual[name].select?.name, value.select.name);
    }
    else if (type === "date") assert.deepEqual(actual[name].date, value.date === null ? null : { ...value.date, end: null, time_zone: null });
    else assert.equal(actual[name][type], value[type]);
  }
}

function assertPriceStatus(properties: Record<string, HoldingProperty>, schema: HoldingsSchema): void {
  const status = properties["価格状態"], checked = properties["価格照合済"];
  const schemaId = schema.properties["価格状態"].id;
  assert.ok(typeof schemaId === "string" && schemaId.length > 0, "価格状態のschema IDが欠けています");
  assert.equal(status?.id, schemaId, "価格状態のproperty IDが不一致です");
  assert.equal(status?.type, "formula", "価格状態がformulaではありません");
  assert.equal(checked?.type, "checkbox"); assert.equal(typeof checked.checkbox, "boolean");
  assert.deepEqual(status.formula, { type: "string", string: checked.checkbox
    ? "期末参考時価（同日期末株数×終値）" : "未取得（価格・通貨・株数単位の照合未成立）" }, "価格状態の計算結果が照合済フラグと不一致です");
}

export interface ShareholdingsBudget { remainingRows: number }
/** 全raw factsを固定列・原表順で束縛する。価格取得結果は混ぜない。 */
export function holdingsFactsSha256(holdings: readonly Shareholding[]): string {
  return createHash("sha256").update(JSON.stringify(holdings.map(h => [h.name, h.kind, h.shares, h.sharesRaw,
    h.sharesUnit, h.bookValueYen, h.bookValueRaw, h.bookValueUnit, h.listingStatus, h.price, h.priceDate,
    h.priceCurrency, h.tableIndex, h.rowIndex]))).digest("hex");
}
interface PublishHoldingsArgs {
  source: ShareholdingsSource; ownerName: string; zip: Buffer; archivePageId: string; maxRows: number;
  budget?: ShareholdingsBudget;
  /** Actions/Node正常入口だけ明示有効。Worker adminは未測定full診断を起動しない。 */
  observeIssuedShares?: true;
  issuedSharesFilingDateEvidence?: IssuedShareObservation["filingDateEvidence"];
  /** 旧cursor欠測HOLDの明示再資格だけ。全props/clockと全原表factsを物理PREへ固定する。 */
  sourceWindowPre?: ArchivedSource;
  /** publishVerifiedでは物理全文照合済みの原本だけ。保存入口は内部で照合する。 */
  valuationSources?: { codeList: ArchivedSource; prices: readonly ArchivedSource[]; evidenceScope?: string; officialIssuerNames?: OfficialIssuerNames; priceIndex?: HoldingsPriceIndex; checkOfficialIssuerNames?: () => Promise<{ status: "verified" } | { status: "held"; reason: string; reasonCode?: "budget_exhausted" | "issuer_source_unavailable" }> };
}

export interface HoldingPriceBudget { remainingChunks: number; remainingBytes: number }
export type HoldingPriceSourceLoader = (holdings: readonly Shareholding[], budget: HoldingPriceBudget, shouldStop?: () => boolean, fiscalYearEnd?: string) => Promise<
  { status: "ready"; snapshotId: string; evidenceScope: string; codeList: ArchivedSource; prices: ArchivedSource[]; officialIssuerNames?: OfficialIssuerNames; priceIndex?: HoldingsPriceIndex; checkOfficialIssuerNames?: () => Promise<{ status: "verified" } | { status: "held"; reason: string; reasonCode?: "budget_exhausted" | "issuer_source_unavailable" }> } |
  { status: "held"; reason: string; reasonCode: "snapshot_unavailable" | "budget_exhausted" | "issuer_source_unavailable" }
>;

export type PublishHoldingsResult = (
  | { status: "published"; parsed: number; created: number; updated: number; unchanged: number; unavailable?: number; pending?: boolean }
  | { status: "held"; parsed: number; reason: string; usedRows?: number; pending?: boolean;
      reasonCode?: "explicit_not_applicable"; notApplicable?: ShareholdingsNotApplicable }) & { issuedSharesObservation?: IssuedShareObservation };

/**
 * recordEdinetZip(type1)の物理全文照合を終えた同一bytesだけを渡す。
 * 原本の再取得・再アップロードはしない。全原表を固定し、残run枠だけを読戻して再開する。
 * windowの完了は通全体の完了と区別し、最後だけ価格queueへ渡す。
 */
export async function publishVerifiedShareholdings(args: PublishHoldingsArgs): Promise<PublishHoldingsResult> {
  const diagnostic: { observation?: IssuedShareObservation } = {};
  const result = await publishHoldings(args, undefined, diagnostic);
  return diagnostic.observation === undefined ? result : { ...result, issuedSharesObservation: diagnostic.observation };
}

async function publishHoldings(args: PublishHoldingsArgs, pricePhase?: { snapshotId?: string; info: RecoveryInfo }, diagnostic?: { observation?: IssuedShareObservation }): Promise<PublishHoldingsResult> {
  assert.ok(Number.isSafeInteger(args.maxRows) && args.maxRows >= 0 && args.maxRows <= 1000);
  assert.ok(args.ownerName.trim().length > 0);
  if (args.budget) assert.ok(Number.isSafeInteger(args.budget.remainingRows) && args.budget.remainingRows >= 0 && args.budget.remainingRows <= 100);
  const maxRows = Math.min(100, args.budget ? Math.min(args.maxRows, args.budget.remainingRows) : args.maxRows);
  const hold = async (reason: string, parsed: number, retry: boolean, pricePreflight = false,
    notApplicable?: ShareholdingsNotApplicable): Promise<PublishHoldingsResult> => {
    assert.ok(notApplicable === undefined || !pricePhase, "既存価格queueを明示不該当へ付け替えません");
    if (pricePhase) await recordRecoveryInfo(args.archivePageId, pricePhase.info, retry ? "再開待ち" : "要確認", reason, true, undefined, undefined, pricePreflight);
    else await recordRecoveryMarker(args, retry ? "再開待ち" : "要確認", reason, parsed, undefined, diagnostic?.observation, notApplicable);
    return { status: "held", parsed, reason, ...(retry ? { pending: true } : {}),
      ...(notApplicable === undefined ? {} : { reasonCode: "explicit_not_applicable", notApplicable }) };
  };
  if (args.zip.length > HOLDINGS_ZIP_MAX_BYTES) return hold("1原本20MiBの解析予算を超えています", 0, false);
  const parsed = parseShareholdingsData(args.zip, args.source, diagnostic === undefined ? undefined : { qualifySource: entries => {
    if (args.observeIssuedShares === true) diagnostic.observation = observeIssuedShares(args.zip, args.source,
        args.issuedSharesFilingDateEvidence === undefined ? null : args.issuedSharesFilingDateEvidence, entries);
    else {
      let identity: IssuedShareObservation["sourceQualification"];
      try { const proof = verifyHoldingsSourceEntries(entries, args.source); identity = proof.status === "verified" ? { status: "verified", reason: null } : proof; }
      catch (error) { identity = { status: "held", reason: `原本/DEI資格を確定できません: ${error instanceof Error ? error.message : String(error)}` }; }
      diagnostic.observation = unobservedIssuedShares(args.zip, args.source,
        identity.status === "held" && identity.reason !== null ? identity.reason : "このcallerはfull観測を有効化していません。Worker実負荷は未受入です", identity);
    }
    const identity = diagnostic.observation.sourceQualification;
    return identity.status === "verified" ? { status: "verified" } : { status: "held", reason: identity.reason === null ? "提出者原本資格は未確認です" : identity.reason };
  } });
  // 明示不該当は未対応表と区別するが、空配列成功や価格queueへ変換しない。
  if (parsed.status === "explicit_not_applicable") {
    assert.equal(parsed.holderScope, "filer_only"); assert.equal(parsed.holdings.length, 0);
    assert.ok(parsed.notApplicable && parsed.reason);
    assert.equal(parsed.notApplicable.zipSha256, createHash("sha256").update(args.zip).digest("hex"));
    return hold(parsed.reason, 0, false, false, parsed.notApplicable);
  }
  if (parsed.status !== "ok" || parsed.holderScope !== "filer_only") {
    return hold(parsed.reason ?? "提出会社の保有主体資格が未確認です", 0, false);
  }
  if (pricePhase) {
    assert.equal(pricePhase.info.parsed, parsed.holdings.length);
    assert.equal(pricePhase.info.factsSha256, holdingsFactsSha256(parsed.holdings), "価格windowの全facts/orderが変化しています");
  }
  // 並列backfillでも、最初のawait前にrun枠を予約する。未知結果で返却しない。
  const reservedRows = Math.min(maxRows, parsed.holdings.length);
  if (args.budget) args.budget.remainingRows -= reservedRows;
  const zipSha256 = createHash("sha256").update(args.zip).digest("hex");
  let sourceBefore: HoldingPage | undefined;
  let sourceInfo: RecoveryInfo | undefined;
  if (!pricePhase) {
    const dbId = await recoveryDatabase();
    sourceBefore = await notionRequest<HoldingPage>("GET", `/pages/${args.archivePageId}`);
    qualifyRecoveryPage(sourceBefore, args.archivePageId, dbId, args.source);
    const status = sourceBefore.properties["保有明細状態"]?.select?.name;
    assert.notEqual(status, "実行中（結果未確定）", "保有明細の前回結果が未確定です。再送せず読取照合してください");
    sourceInfo = { source: args.source, ownerName: args.ownerName, zipBytes: args.zip.length, zipSha256,
      parsed: parsed.holdings.length, factsSha256: holdingsFactsSha256(parsed.holdings), sourceQueueVersion: 1, sourceNextHoldingOffset: 0,
      ...(diagnostic?.observation === undefined ? {} : { issuedSharesObservation: diagnostic.observation }) };
    const previous = sourceBefore.properties["保有明細再開情報"];
    const previousText = previous?.type === "rich_text" ? richValue(previous) : "";
    if (previousText) {
      const saved = JSON.parse(previousText) as RecoveryInfo;
      if (saved.sourceQueueVersion === undefined) {
        if (!args.sourceWindowPre) {
          if (args.budget) args.budget.remainingRows += reservedRows;
          return { status: "held", parsed: parsed.holdings.length, reason: "旧再開情報にsource cursorがありません。全props/clockの物理PREを固定した明示再資格が必要です" };
        }
        assert.ok(status === "再開待ち" || status === "要確認", "旧cursorの再資格は既知HOLDだけです");
        const pre = args.sourceWindowPre;
        assert.equal(createHash("sha256").update(pre.bytes).digest("hex"), pre.sha256);
        await verifyArchivedAttachments(pre.archivePageId, [{ filename: pre.filename, bytes: pre.bytes }], "保有明細source windowの旧PRE");
        const proof = JSON.parse(Buffer.from(pre.bytes).toString("utf8")) as { page: HoldingPage; info: RecoveryInfo };
        assert.deepEqual(proof.info, sourceInfo, "旧PREの全原表束縛が不一致です");
        for (const name of ["object", "id", "parent", "archived", "in_trash", "properties", "created_time", "last_edited_time"] as const) {
          assert.deepEqual(name === "properties" ? stableProperties(proof.page.properties) : proof.page[name],
            name === "properties" ? stableProperties(sourceBefore.properties) : sourceBefore[name], "旧PREのpage/props/clockが変更されています");
        }
        assert.ok(typeof sourceBefore.created_time === "string" && Number.isFinite(Date.parse(sourceBefore.created_time)));
        assert.ok(typeof sourceBefore.last_edited_time === "string" && Number.isFinite(Date.parse(sourceBefore.last_edited_time)));
        for (const name of ["source", "ownerName", "zipBytes", "zipSha256"] as const) assert.deepEqual(saved[name], sourceInfo[name]);
      } else {
        assert.equal(args.sourceWindowPre, undefined, "既存v1へ旧PREを適用しません");
        assert.equal(saved.sourceQueueVersion, 1);
        for (const name of ["source", "ownerName", "zipBytes", "zipSha256", "parsed", "factsSha256"] as const) assert.deepEqual(saved[name], sourceInfo[name], "source windowの全facts/order/原本束縛が変更されています");
        assert.ok(Number.isSafeInteger(saved.sourceNextHoldingOffset) && saved.sourceNextHoldingOffset! >= 0 && saved.sourceNextHoldingOffset! <= saved.parsed);
        sourceInfo.sourceNextHoldingOffset = saved.sourceNextHoldingOffset;
        if (status === "明細原本照合済") {
          assert.equal(saved.sourceNextHoldingOffset, saved.parsed);
          if (args.budget) args.budget.remainingRows += reservedRows;
          if (args.valuationSources === undefined || sourceBefore.properties["保有価格状態"]?.select?.name === "価格照合完了") {
            const rows = await readHoldingPeriodRows(notionEnv.NOTION_STOCK_HOLDINGS_DB_ID(), args.source);
            const verified = verifyCompletedHoldingsSource(args.source, args.ownerName, parsed, zipSha256, rows);
            if (verified.status === "held") return { status: "held", parsed: parsed.holdings.length, reason: verified.reason };
          }
          if (args.valuationSources) {
            const priceInfo = JSON.parse(richValue(sourceBefore.properties["保有価格再開情報"])) as RecoveryInfo;
            for (const name of ["source", "ownerName", "zipBytes", "zipSha256", "parsed", "factsSha256"] as const) assert.deepEqual(priceInfo[name], sourceInfo[name]);
            assert.equal(priceInfo.priceQueueVersion, 1);
            assert.ok(Number.isSafeInteger(priceInfo.nextHoldingOffset) && priceInfo.nextHoldingOffset! >= 0 && priceInfo.nextHoldingOffset! <= priceInfo.parsed);
            assert.ok(Number.isSafeInteger(priceInfo.unavailableRows) && priceInfo.unavailableRows! >= 0 && priceInfo.unavailableRows! <= priceInfo.nextHoldingOffset!);
            if (sourceBefore.properties["保有価格状態"]?.select?.name === "価格照合完了") {
              assert.equal(priceInfo.nextHoldingOffset, priceInfo.parsed);
              assert.equal(priceInfo.unavailableRows, 0);
              return { status: "published", parsed: 0, created: 0, updated: 0, unchanged: 0 };
            }
            assert.notEqual(sourceBefore.properties["保有価格状態"]?.select?.name, "実行中（結果未確定）", "保有価格の前回結果が未確定です。再送せず読取照合してください");
            return publishHoldings(args, { info: priceInfo, snapshotId: priceInfo.snapshotId });
          }
          return { status: "published", parsed: 0, created: 0, updated: 0, unchanged: 0 };
        }
        assert.equal(status, "再開待ち", "source windowは再開待ちだけを処理します");
        assert.ok(saved.sourceNextHoldingOffset! < saved.parsed, "再開待ちのsource cursorが終端に達しています");
      }
    } else {
      assert.ok(status === undefined, "既存source状態に再開情報が欠けています。黙ってcursorを0へ戻しません");
      assert.equal(args.sourceWindowPre, undefined, "新規sourceへ旧PREは適用しません");
    }
    if (maxRows === 0) {
      await recordRecoveryInfo(args.archivePageId, sourceInfo, "再開待ち", "保有明細のrun件数予算を使い切りました。全原表固定済み", false, undefined, sourceBefore);
      return { status: "held", parsed: parsed.holdings.length, reason: "保有明細のrun件数予算を使い切りました" };
    }
  }
  const offset = pricePhase ? pricePhase.info.nextHoldingOffset! : sourceInfo!.sourceNextHoldingOffset!;
  const selected = parsed.holdings.slice(offset, offset + maxRows);
  if (args.budget) args.budget.remainingRows += reservedRows - selected.length;
  const ready: Array<{ holding: Shareholding; valuation: HoldingValuation; properties: Record<string, HoldingProperty> }> = [];
  try {
    const catalog = args.valuationSources ? parseHoldingsCodeList(args.valuationSources.codeList) : null;
    const prices = args.valuationSources ? (args.valuationSources.priceIndex === undefined ? new HoldingsPriceIndex(args.valuationSources.prices) : args.valuationSources.priceIndex) : null;
    if (args.valuationSources?.priceIndex) args.valuationSources.priceIndex.assertSources(args.valuationSources.prices);
    for (const holding of selected) {
      const valuation: HoldingValuation = catalog && prices
        ? await qualifyHoldingValuation({ holding, fiscalYearEnd: args.source.fiscalYearEnd, catalog, prices, officialIssuerNames: args.valuationSources?.officialIssuerNames })
        : { status: "unavailable", identity: null, reason: "銘柄同定・個別価格・分割観測の保存原本が未指定です" };
      ready.push({ holding, valuation, properties: { ...holdingProperties(args.source, args.ownerName, holding),
        ...sourceProperties(parsed, holding, zipSha256), ...valuationProperties(holding, valuation, args.valuationSources?.evidenceScope) } });
    }
    if (args.valuationSources?.checkOfficialIssuerNames) {
      const current = await args.valuationSources.checkOfficialIssuerNames();
      if (current.status === "held") return hold(current.reason, parsed.holdings.length, current.reasonCode === "budget_exhausted", true);
    }
  } catch (error) {
    if (error instanceof HoldingPriceIssuerMismatch || error instanceof HoldingPriceShareBasisMismatch) return hold(error.message, parsed.holdings.length, false, true);
    if (pricePhase) await recordRecoveryInfo(args.archivePageId, pricePhase.info, "実行中（結果未確定）", "価格原本の資格が不明です。自動再送せず読取照合してください", true);
    throw error;
  }
  if (pricePhase) await recordRecoveryInfo(args.archivePageId, pricePhase.info, "実行中（結果未確定）", "全価格windowの原本資格成立。価格列の読戻しは未完了", true);
  const dbId = notionEnv.NOTION_STOCK_HOLDINGS_DB_ID();
  const schema = await readHoldingsSchema();
  assert.equal(Object.keys(buildHoldingsSchemaPatch(schema).properties).length, 0, "保有明細schemaの受入が未完了です");
  const periodRows = await readHoldingPeriodRows(dbId, args.source);
  if (!pricePhase && offset > 0) {
    const prefix = verifyCompletedHoldingsSource(args.source, args.ownerName,
      { ...parsed, holdings: parsed.holdings.slice(0, offset) }, zipSha256, periodRows);
    if (prefix.status === "held") return hold(`既完windowの原本列が不一致です。${prefix.reason}`, parsed.holdings.length, false);
  }
  const resolved = resolveHoldingRows(args.source, args.ownerName, parsed.holdings, selected, periodRows);
  if (resolved.status === "held") return hold(resolved.reason, parsed.holdings.length, false);
  // 既照合行はfile/contextを含む全原本列を確認してからwrite0とする。
  for (const [index, choice] of resolved.selected.entries()) if (choice.existing?.properties["原本照合済"]?.checkbox === true) {
    try { assertProperties(choice.existing.properties, Object.fromEntries(Object.entries(ready[index].properties).filter(([name]) => !VALUATION_COLUMNS.has(name)))); }
    catch (error) { if (!(error instanceof AssertionError)) throw error; return hold("既に原本照合済みの行と保存原表の全出典・確定値が一致しません", parsed.holdings.length, false); }
  }
  const migrating = resolved.selected.filter(choice => choice.migrateLegacy).map(choice => choice.existing!);
  const preBytes = migrating.length === 0 ? undefined : Buffer.from(JSON.stringify({ source: args.source, ownerName: args.ownerName,
    sourceZipSha256: zipSha256, factsSha256: holdingsFactsSha256(parsed.holdings), offset, rows: migrating }) + "\n");
  if (preBytes !== undefined) {
    assert.equal(pricePhase, undefined, "価格phaseはlegacy原本移行をしません");
    sourceInfo!.legacyMigration = { offset, rowIds: migrating.map(page => page.id), pre: migrationFile(args.source, offset, "PRE", preBytes) };
  }
  // PRE upload未知も同じdurable source latchに残し、定時再開の対象にしない。
  if (!pricePhase) sourceBefore = await recordRecoveryInfo(args.archivePageId, sourceInfo!, "実行中（結果未確定）", "原表の資格成立。今回windowの読戻しは未完了", false, undefined, sourceBefore);
  if (preBytes !== undefined) sourceInfo!.legacyMigration!.pre = await archiveMigration(args.source, sourceInfo!.legacyMigration!.pre, preBytes);
  const migrationPosts: HoldingPage[] = [];
  const result = { status: "published" as const, parsed: selected.length, created: 0, updated: 0, unchanged: 0 };
  let unavailableInWindow = 0;
  for (const [index, { holding, valuation, properties }] of ready.entries()) {
    const choice: { existing: HoldingPage | null; migrateLegacy: boolean } = resolved.selected[index];
    const existing: HoldingPage | null = choice.existing, migrateLegacy = choice.migrateLegacy;
    if (existing) {
      assert.equal(existing.object, "page");
      assert.equal(existing.parent.type, "database_id");
      assert.equal(existing.parent.database_id.replaceAll("-", ""), dbId.replaceAll("-", ""));
      assert.equal(existing.archived, false);
      assert.equal(existing.in_trash, false);
      assertProperties(existing.properties, { "保有会社コード": rt(args.source.stockCode), "銘柄名": rt(holding.name), "期末": { date: { start: args.source.fiscalYearEnd } },
        ...(migrateLegacy ? {} : { "保有種別": { select: { name: holding.kind } } }) });
      assert.equal(existing.properties["原本照合済"]?.type, "checkbox");
      assert.equal(typeof existing.properties["原本照合済"].checkbox, "boolean");
    }
    if (pricePhase) {
      assert.equal(existing?.properties["原本照合済"]?.checkbox, true, "価格phaseで原本未確定行の作成/更新はしません");
      assertPriceStatus(existing!.properties, schema);
    }
    if (pricePhase && valuation.status !== "qualified" && existing?.properties["価格照合済"]?.checkbox !== true) unavailableInWindow++;
    if (existing?.properties["原本照合済"]?.checkbox === true) {
      // 期末株数/原本の照合済み行へ価格根拠だけを加える。既存の確定価格は、
      // 新しい価格原本未指定を理由にNULLへ消さない。原本側の差分はSTOP。
      const rawProperties = Object.fromEntries(Object.entries(properties).filter(([name]) => !VALUATION_COLUMNS.has(name)));
      assertProperties(existing.properties, rawProperties);
      if (valuation.status !== "qualified" && (args.valuationSources === undefined || existing.properties["価格照合済"]?.checkbox === true)) {
        result.unchanged++; continue;
      }
      const expected = Object.fromEntries(Object.entries(properties).filter(([name]) => VALUATION_COLUMNS.has(name)));
      if (existing.properties["価格照合済"]?.checkbox === true) {
        assertProperties(existing.properties, expected);
        result.unchanged++;
        continue;
      }
    }
    // 既存未検証行の旧値は専用legacy列に残り、物理PREもrootが保管している。
    const mutationProperties = !pricePhase ? properties : Object.fromEntries(Object.entries(properties).filter(([name]) => VALUATION_COLUMNS.has(name)));
    if (existing) {
      const fresh = await notionRequest<HoldingPage>("GET", `/pages/${existing.id}`);
      assertSameHoldingPage(fresh, existing);
    }
    const saved: { object: string; id: string } = existing
      ? await notionRequest("PATCH", `/pages/${existing.id}`, { properties: mutationProperties }, { singleAttempt: true })
      : await notionRequest("POST", "/pages", { parent: { database_id: dbId }, properties }, { singleAttempt: true });
    assert.equal(saved.object, "page"); assert.match(saved.id.replaceAll("-", ""), /^[a-f0-9]{32}$/);
    if (existing) assert.equal(saved.id.replaceAll("-", ""), existing.id.replaceAll("-", ""), "保有明細PATCH ACKが別行です");
    const readback = await notionRequest<HoldingPage>("GET", `/pages/${saved.id}`);
    assert.equal(readback.object, "page");
    assert.equal(readback.id.replaceAll("-", ""), saved.id.replaceAll("-", ""));
    assert.equal(readback.parent.type, "database_id");
    assert.equal(readback.parent.database_id.replaceAll("-", ""), dbId.replaceAll("-", ""));
    assert.equal(readback.archived, false);
    assert.equal(readback.in_trash, false);
    assertProperties(readback.properties, properties);
    if (existing) for (const [, legacy] of LEGACY_HOLDINGS_COLUMNS) assert.deepEqual(readback.properties[legacy], existing.properties[legacy]);
    if (pricePhase && existing) {
      assertPriceStatus(readback.properties, schema);
      for (const [name, value] of Object.entries(existing.properties)) {
        // この式だけが価格照合済checkboxから再計算される。他formula・ID・旧値は保持する。
        const expected = name === "価格状態" ? { ...value, formula: readback.properties[name].formula } : value;
        if (!VALUATION_COLUMNS.has(name)) assert.deepEqual(stableProperty(readback.properties[name]), stableProperty(expected), "価格追記で他propsが変更されています");
      }
    }
    if (migrateLegacy) { assertMigrationPost(readback, existing!, properties, schema); migrationPosts.push(readback); }
    if (existing) result.updated++; else result.created++;
  }
  if (migrationPosts.length > 0) {
    const independent: HoldingPage[] = [];
    for (const expected of migrationPosts) {
      const fresh = await notionRequest<HoldingPage>("GET", `/pages/${expected.id}`); assertSameHoldingPage(fresh, expected); independent.push(fresh);
    }
    const bytes = Buffer.from(JSON.stringify({ source: args.source, sourceZipSha256: zipSha256, offset,
      pre: sourceInfo!.legacyMigration!.pre, rows: independent, unverifiedCanonicalValuesReplacedFromSavedSource: true, legacyValuesPreserved: true }) + "\n");
    sourceInfo!.legacyMigration!.post = await archiveMigration(args.source, migrationFile(args.source, offset, "POST", bytes), bytes);
  }
  if (!pricePhase) {
    const nextOffset = offset + selected.length, pending = nextOffset < parsed.holdings.length;
    if (!pending) {
      const final = verifyCompletedHoldingsSource(args.source, args.ownerName, parsed, zipSha256,
        await readHoldingPeriodRows(dbId, args.source));
      if (final.status === "held") throw new Error(`全原表の最終読戻しが未成立です。${final.reason}`);
    }
    await recordRecoveryInfo(args.archivePageId, { ...sourceInfo!, sourceNextHoldingOffset: nextOffset },
      pending ? "再開待ち" : "明細原本照合済", pending ? `原本${nextOffset}/${parsed.holdings.length}明細の読戻し済み。次windowへ再開待ち` : "全明細の保存値・原典キー・旧値保全を読戻し済み",
      false, undefined, sourceBefore);
    if (pending) return { status: "held", parsed: parsed.holdings.length, reason: "原本明細のwindow読戻しは完了。残明細は次runへ再開待ち", usedRows: selected.length, pending: true };
  }
  else {
    const unavailable = pricePhase.info.unavailableRows! + unavailableInWindow;
    const nextHoldingOffset = pricePhase.info.nextHoldingOffset! + selected.length;
    const pending = nextHoldingOffset < parsed.holdings.length;
    await recordRecoveryInfo(args.archivePageId, { ...pricePhase.info, ...(pricePhase.snapshotId === undefined ? {} : { snapshotId: pricePhase.snapshotId }), nextHoldingOffset, unavailableRows: unavailable },
      pending ? "再開待ち" : unavailable > 0 ? "要確認" : "価格照合完了",
      pending ? `価格${nextHoldingOffset}/${parsed.holdings.length}明細の読戻し済み。次windowへ再開待ち` :
        unavailable > 0 ? `${unavailable}明細は指定保存原本で価格資格未成立。各行の欠測理由を参照` : "全明細の価格資格・他props保持を読戻し済み",
      true, pricePhase.info.nextHoldingOffset);
    return { ...result, unavailable, pending };
  }
  return result;
}

function sourceProperties(parsed: ShareholdingsExtraction, holding: Shareholding, zipSha256: string): Record<string, HoldingProperty> {
  assert.ok(parsed.filename && parsed.contextRef);
  const missing = ["上場区分・株価・価格観測日・通貨は原本で未確認"];
  if (holding.shares === null) missing.push("当期株数は原表が横線で非開示");
  if (holding.bookValueYen === null) missing.push("当期帳簿価額は原表が横線で非開示");
  return { "出典ファイル": rt(parsed.filename), "出典Context": rt(parsed.contextRef),
    "出典原本SHA256": rt(zipSha256), "欠測理由": rt(missing.join("。")) };
}

/** 保存原本の手動復旧。先に物理添付の同一bytesを全文照合して同じwriterへ渡す。 */
export async function publishSavedShareholdings(args: PublishHoldingsArgs): Promise<PublishHoldingsResult> {
  await verifyArchivedAttachments(args.archivePageId,
    [{ filename: edinetArchiveFilename(args.source.docId, 1), bytes: args.zip }], "株式保有の保存原本");
  if (args.valuationSources) for (const source of [args.valuationSources.codeList, ...args.valuationSources.prices]) {
    await verifyArchivedAttachments(source.archivePageId, [{ filename: source.filename, bytes: source.bytes }], "保有明細の銘柄・価格原本");
  }
  return publishVerifiedShareholdings(args);
}

const VALUATION_COLUMNS = new Set(["株価", "保有時価", "通貨", "基準日", "区分", "確定銘柄コード", "銘柄照合根拠", "価格照合根拠", "価格照合済", "欠測理由"]);
function valuationProperties(holding: Shareholding, valuation: HoldingValuation, evidenceScope?: string): Record<string, HoldingProperty> {
  const identity = valuation.identity;
  const properties: Record<string, HoldingProperty> = { "確定銘柄コード": rt(identity === null ? "" : identity.code),
    "銘柄照合根拠": rt(identity === null ? "" : JSON.stringify(identity)), "価格照合根拠": rt(""),
    "価格照合済": { checkbox: false } };
  if (identity !== null) properties["区分"] = { select: { name: "上場（コードリスト基準日）" } };
  const missing: string[] = [];
  if (holding.shares === null) missing.push("当期株数は原表が横線で非開示");
  if (holding.bookValueYen === null) missing.push("当期帳簿価額は原表が横線で非開示");
  if (valuation.status === "qualified") {
    Object.assign(properties, { "株価": { number: valuation.price }, "保有時価": { number: valuation.value },
      "通貨": rt(valuation.currency), "基準日": { date: { start: valuation.date } },
      "価格照合根拠": rt(JSON.stringify(valuation.priceSource)), "価格照合済": { checkbox: true } });
    missing.push("期末参考時価。現在の株価・保有量およびraw capture後の状態は未観測");
  } else {
    missing.push(valuation.reason);
    if (evidenceScope !== undefined) { assert.ok(evidenceScope.trim()); missing.push(evidenceScope); }
  }
  properties["欠測理由"] = rt(missing.join("。"));
  return properties;
}

/** 原metadataの欠測は書き換えず、存在するissuer/期末とコード証拠を束縛する。 */
export function verifySavedHoldingsMetadata(metadata: Record<string, unknown>, source: ShareholdingsSource): { status: "verified"; missing: string[] } | { status: "held"; reason: string } {
  if (!("docID" in metadata)) return { status: "held", reason: "保存原本metadataにdocIDがなく同一文書の資格が未確認です（旧metadataは変更しません）" };
  assert.equal(metadata.docID, source.docId);
  const missing: string[] = [];
  for (const [field, expected] of Object.entries({ edinetCode: source.edinetCode, periodEnd: source.fiscalYearEnd })) {
    if (metadata[field] === undefined || metadata[field] === null) missing.push(field);
    else assert.equal(metadata[field], expected, "保存原本metadataの提出者/期末が不一致です");
  }
  let codeBound = false;
  if (metadata.stockCode !== undefined) { assert.equal(metadata.stockCode, source.stockCode); codeBound = true; }
  for (const field of ["secCode", "rawSecCode"] as const) {
    const code = metadata[field];
    if (code === undefined || code === null || code === "00000") continue;
    assert.equal(code, `${source.stockCode}0`, "保存原本metadataの非0証券コードが不一致です");
    codeBound = true;
  }
  if (!codeBound) return { status: "held", reason: "原本metadataの銘柄束縛が未確認です（未割当/NULLは公式提出者逆引きの追加根拠が必要）" };
  return { status: "verified", missing };
}

/** 保存type1限定のbackfill準備。新規原本取得・schema変更・行更新は0。 */
export async function readSavedHoldingsZip(source: ShareholdingsSource, budget?: { remainingBytes: number }, opts?: { observeIssuedShares: true }): Promise<
  { status: "ready"; archivePageId: string; bytes: Buffer; sha256: string; originalManifest: "known" | "unknown"; sourceCustody: "typed" | "legacy"; metadata: Record<string, unknown>; fetchedAt: string; metadataMissing: string[]; issuedSharesObservation?: IssuedShareObservation } |
  { status: "held"; reason: string; reasonCode?: "budget_exhausted" }
> {
  if (budget) assert.ok(Number.isSafeInteger(budget.remainingBytes) && budget.remainingBytes >= 0);
  const { docId } = source;
  assert.match(docId, /^S[0-9A-Z]+$/);
  if (source.edinetCode === null) return { status: "held", reason: "提出者EDINETコードが未確定です" };
  const dbId = await sourceDatabase();
  let page = await queryUniqueRow<HoldingPage>(dbId, { property: "Key", title: { equals: `${docId}:type1` } }, "type1原本が複数あり保全停止します");
  const sourceCustody = page === null ? "legacy" : "typed";
  if (page === null) page = await queryUniqueRow<HoldingPage>(dbId, { property: "Key", title: { equals: docId } }, "legacy原本が複数あり保全停止します");
  if (page === null) return { status: "held", reason: "現行type1/legacyの物理保管行がありません。公式の原本未提供とは未判定です（上流GETなし）" };
  assert.equal(page.archived, false); assert.equal(page.in_trash, false);
  assert.equal(page.parent.type, "database_id"); assert.equal(page.parent.database_id.replaceAll("-", ""), dbId.replaceAll("-", ""));
  const key = page.properties["Key"];
  assert.equal(key.type, "title"); assert.ok(Array.isArray(key.title));
  assert.equal(key.title.map(part => { assert.equal(part.type, "text"); assert.equal(part.plain_text, part.text?.content); return part.plain_text; }).join(""), sourceCustody === "typed" ? `${docId}:type1` : docId);
  if (page.properties["保有明細状態"]?.select?.name === "実行中（結果未確定）") return { status: "held", reason: "保有明細の前回結果が未確定です。再送せず読取照合してください" };
  const allFiles = await listPageFiles(page.id, "Files");
  const files = sourceCustody === "typed" ? allFiles : allFiles.filter(file => file.name === edinetArchiveFilename(docId, 1));
  if (files.length !== 1 || files[0].kind !== "file" || files[0].name !== edinetArchiveFilename(docId, 1)) return { status: "held", reason: `${sourceCustody}原本のtype1単一Notion-hosted物理添付を確認できません（CSVは代用しません）` };
  const parts = page.properties["Metadata"]?.rich_text;
  assert.ok(Array.isArray(parts));
  const metadata = JSON.parse(parts.map(part => {
    assert.equal(part.type, "text"); assert.equal(part.plain_text, part.text?.content); return part.plain_text;
  }).join(""));
  let reservedBytes = 0;
  if (budget) {
    reservedBytes = HOLDINGS_ZIP_MAX_BYTES;
    if (metadata.sourceZIPBytes !== undefined) {
      assert.ok(Number.isSafeInteger(metadata.sourceZIPBytes) && metadata.sourceZIPBytes > 0 && metadata.sourceZIPBytes <= HOLDINGS_ZIP_MAX_BYTES);
      reservedBytes = metadata.sourceZIPBytes;
    }
    if (metadata._fileManifest !== undefined) {
      assert.ok(Array.isArray(metadata._fileManifest.files));
      const entries = metadata._fileManifest.files.filter((entry: { originalFilename?: unknown }) => entry.originalFilename === files[0].name);
      assert.equal(entries.length, 1); const expected = entries[0].byteLength;
      assert.ok(Number.isSafeInteger(expected) && expected > 0 && expected <= HOLDINGS_ZIP_MAX_BYTES);
      if (metadata.sourceZIPBytes !== undefined) assert.equal(expected, reservedBytes);
      reservedBytes = expected;
    }
    if (reservedBytes > budget.remainingBytes) return { status: "held", reasonCode: "budget_exhausted", reason: "issuer保存原本の全文読取予算が不足しています（未知サイズは20MiBを予約）" };
    budget.remainingBytes -= reservedBytes;
  }
  const bytes = Buffer.from(await downloadArchivedFile(files[0], "保有明細type1原本", { maxBytes: budget ? reservedBytes : HOLDINGS_ZIP_MAX_BYTES }));
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (metadata.sourceZIPSHA !== undefined) assert.equal(metadata.sourceZIPSHA, digest);
  if (metadata.sourceZIPBytes !== undefined) assert.equal(metadata.sourceZIPBytes, bytes.length);
  const metadataProof = verifySavedHoldingsMetadata(metadata, source);
  if (metadataProof.status === "held") return metadataProof;
  if (sourceCustody === "typed") assert.equal(metadata.edinetDocType, 1);
  const fetchedAt = page.properties["Fetched At"]?.date?.start;
  assert.ok(typeof fetchedAt === "string" && Number.isFinite(Date.parse(fetchedAt)), "保存原本の取得時計が未確認です");
  if (metadata._fileManifest !== undefined) {
    assert.ok(Array.isArray(metadata._fileManifest.files));
    const manifests = metadata._fileManifest.files.filter((file: { originalFilename?: unknown }) => file.originalFilename === files[0].name);
    assert.equal(manifests.length, 1);
    if (sourceCustody === "typed") assert.equal(metadata._fileManifest.files.length, 1);
    const manifest = manifests[0];
    assert.equal(manifest.originalFilename, files[0].name);
    assert.equal(manifest.byteLength, bytes.length); assert.equal(manifest.sha256, digest);
  }
  let issuedSharesObservation: IssuedShareObservation | undefined;
  const identity = opts === undefined ? verifySavedHoldingsSource(bytes, source) : verifySavedHoldingsSource(bytes, source, {
    onVerifiedEntries: entries => { issuedSharesObservation = observeIssuedShares(bytes, source,
      typeof metadata.submitDateTime === "string" ? { rawSubmitDateTime: metadata.submitDateTime, provenance: "saved-archive-metadata" } : null, entries); },
  });
  if (identity.status === "held") return identity;
  if (budget) { assert.ok(bytes.length <= reservedBytes); budget.remainingBytes += reservedBytes - bytes.length; }
  return { status: "ready", archivePageId: page.id, bytes, sha256: digest,
    originalManifest: metadata._fileManifest === undefined ? "unknown" : "known", sourceCustody, metadata, fetchedAt, metadataMissing: metadataProof.missing,
    ...(issuedSharesObservation === undefined ? {} : { issuedSharesObservation }) };
}

const RECOVERY = {
  "保有明細状態": { select: { options: ["再開待ち", "要確認", "実行中（結果未確定）", "明細原本照合済"].map(name => ({ name })) } },
  "保有明細理由": { rich_text: {} },
  "保有明細再開情報": { rich_text: {} },
  "保有価格状態": { select: { options: ["再開待ち", "要確認", "実行中（結果未確定）", "価格照合完了"].map(name => ({ name })) } },
  "保有価格理由": { rich_text: {} },
  "保有価格再開情報": { rich_text: {} },
} as const;
let recoveryDb: Promise<string> | undefined;
let sourceDb: Promise<string> | undefined;
function sourceDatabase(): Promise<string> {
  if (!sourceDb) sourceDb = findUniqueBackupChildByTitle({ parentPageId: notionEnv.NOTION_ARCHIVE_PAGE_ID(),
    title: "一次データ｜yuho-quant", kind: "database" }).then(dbId => { assert.ok(dbId); return dbId; });
  return sourceDb;
}

/** 新規DBは作らず、既存yuho一次データDBのtype1行にだけ再開情報を残す。 */
async function recoveryDatabase(): Promise<string> {
  if (recoveryDb) return recoveryDb;
  recoveryDb = (async () => {
    const dbId = await sourceDatabase();
    const schema = await notionRequest<HoldingsSchema>("GET", `/databases/${dbId}`);
    const properties: Record<string, unknown> = {};
    for (const [name, definition] of Object.entries(RECOVERY)) {
      if (schema.properties[name]) assert.equal(schema.properties[name].type, Object.keys(definition)[0]);
      else properties[name] = definition;
    }
    if (Object.keys(properties).length > 0) {
      await notionRequest("PATCH", `/databases/${dbId}`, { properties }, { singleAttempt: true });
      const actual = await notionRequest<HoldingsSchema>("GET", `/databases/${dbId}`);
      for (const [name, definition] of Object.entries(RECOVERY)) assert.equal(actual.properties[name].type, Object.keys(definition)[0]);
    }
    return dbId;
  })();
  return recoveryDb;
}

interface RecoveryInfo {
  source: ShareholdingsSource; ownerName: string; zipBytes: number; zipSha256: string; parsed: number;
  factsSha256?: string;
  issuedSharesObservation?: IssuedShareObservation;
  notApplicable?: ShareholdingsNotApplicable;
  sourceQueueVersion?: 1; sourceNextHoldingOffset?: number;
  /** 未確定時もPREのexact key/SHAを保持し、同じ旧行PATCHを自動再送しない。 */
  legacyMigration?: { offset: number; rowIds: string[]; pre: MigrationFile; post?: MigrationFile };
  priceQueueVersion?: 1; nextHoldingOffset?: number; unavailableRows?: number; snapshotId?: string;
}

async function recordRecoveryMarker(args: PublishHoldingsArgs, status: string, reason: string, parsed: number, factsSha256?: string, issuedSharesObservation?: IssuedShareObservation,
  notApplicable?: ShareholdingsNotApplicable): Promise<void> {
  const info: RecoveryInfo = { source: args.source, ownerName: args.ownerName, zipBytes: args.zip.length,
    zipSha256: createHash("sha256").update(args.zip).digest("hex"), parsed };
  if (factsSha256 !== undefined) info.factsSha256 = factsSha256;
  if (issuedSharesObservation !== undefined) info.issuedSharesObservation = issuedSharesObservation;
  if (notApplicable !== undefined) info.notApplicable = notApplicable;
  await recordRecoveryInfo(args.archivePageId, info, status, reason, false);
}

function richValue(property: HoldingProperty): string {
  assert.equal(property.type, "rich_text"); assert.ok(Array.isArray(property.rich_text));
  return property.rich_text.map(part => { assert.equal(part.type, "text"); assert.equal(part.plain_text, part.text?.content); return part.plain_text; }).join("");
}

/** Notion再署名だけを除く。原本全bytes/SHA照合と物理PREは別途保持する。 */
function stableProperty(property: HoldingProperty): unknown {
  if (property?.type !== "files") return property;
  const normalized = normalizeFilePropForCompare(property);
  assert.ok(normalized.ok, "Notion Filesの安定同一性を比較できません");
  return normalized.norm;
}
function stableProperties(properties: Record<string, HoldingProperty>): unknown {
  return Object.fromEntries(Object.entries(properties).map(([name, value]) => [name, stableProperty(value)]));
}

function qualifyRecoveryPage(page: HoldingPage, archivePageId: string, dbId: string, source: ShareholdingsSource): void {
  assert.equal(page.object, "page"); assert.equal(page.id.replaceAll("-", ""), archivePageId.replaceAll("-", ""), "保有再開markerのGETが別行です");
  assert.equal(page.parent.type, "database_id"); assert.equal(page.parent.database_id.replaceAll("-", ""), dbId.replaceAll("-", ""));
  assert.equal(page.archived, false); assert.equal(page.in_trash, false);
  const key = page.properties["Key"];
  assert.equal(key.type, "title"); assert.ok(Array.isArray(key.title));
  assert.equal(key.title.map(part => { assert.equal(part.type, "text"); assert.equal(part.plain_text, part.text?.content); return part.plain_text; }).join(""), `${source.docId}:type1`);
}

async function recordRecoveryInfo(archivePageId: string, info: RecoveryInfo, status: string, reason: string, price: boolean, previousOffset?: number, sourceExpected?: HoldingPage, pricePreflight = false): Promise<HoldingPage> {
  if (pricePreflight) assert.ok(price && (status === "再開待ち" || status === "要確認") && previousOffset === undefined);
  const dbId = await recoveryDatabase();
  const before = await notionRequest<HoldingPage>("GET", `/pages/${archivePageId}`);
  qualifyRecoveryPage(before, archivePageId, dbId, info.source);
  const phase = price ? "保有価格" : "保有明細";
  if ((!price && (status === "実行中（結果未確定）" || sourceExpected === undefined) || price && status === "実行中（結果未確定）") && before.properties[`${phase}状態`]?.select?.name === "実行中（結果未確定）") {
    throw new Error("保有明細の前回結果が未確定です。状態を上書きせず読取照合してください");
  }
  if (!price && sourceExpected === undefined && before.properties["保有明細再開情報"]?.type === "rich_text" && richValue(before.properties["保有明細再開情報"])) {
    const saved = JSON.parse(richValue(before.properties["保有明細再開情報"])) as RecoveryInfo;
    assert.notEqual(before.properties["保有明細状態"]?.select?.name, "明細原本照合済", "確定sourceを解析保留で戻しません");
    for (const name of ["source", "ownerName", "zipBytes", "zipSha256"] as const) assert.deepEqual(saved[name], info[name]);
    if (info.notApplicable !== undefined) {
      assert.equal(saved.parsed, 0, "旧非0明細を明示不該当へ付け替えません");
      assert.equal(saved.sourceQueueVersion, undefined, "旧source cursorを明示不該当へ付け替えません");
      assert.equal(saved.factsSha256, undefined, "旧factsを明示不該当へ付け替えません");
      if (saved.notApplicable !== undefined) assert.deepEqual(saved.notApplicable, info.notApplicable);
    }
    // cursor/factsと未知の旧項目を消さず、同ZIPの今回診断だけ追記する。
    info = { ...saved, ...(info.issuedSharesObservation === undefined ? {} : { issuedSharesObservation: info.issuedSharesObservation }),
      ...(info.notApplicable === undefined ? {} : { notApplicable: info.notApplicable }) };
  }
  if (sourceExpected) {
    assert.equal(price, false);
    assert.deepEqual(stableProperties(before.properties), stableProperties(sourceExpected.properties), "source windowの全propsが開始時から変更されています");
    assert.deepEqual(before.created_time, sourceExpected.created_time, "source windowの作成時計が変更されています");
    assert.deepEqual(before.last_edited_time, sourceExpected.last_edited_time, "source windowの編集時計が変更されています");
    assert.equal(info.sourceQueueVersion, 1);
    assert.ok(Number.isSafeInteger(info.sourceNextHoldingOffset) && info.sourceNextHoldingOffset! >= 0 && info.sourceNextHoldingOffset! <= info.parsed);
    if (status === "明細原本照合済") assert.equal(info.sourceNextHoldingOffset, info.parsed);
    if (sourceExpected.properties["保有明細状態"]?.select?.name === "実行中（結果未確定）") {
      const prior = JSON.parse(richValue(sourceExpected.properties["保有明細再開情報"])) as RecoveryInfo;
      for (const name of ["source", "ownerName", "zipBytes", "zipSha256", "parsed", "factsSha256", "sourceQueueVersion"] as const) assert.deepEqual(prior[name], info[name]);
      assert.ok(info.sourceNextHoldingOffset! >= prior.sourceNextHoldingOffset!);
    }
  }
  if (price) {
    assert.equal(before.properties["保有明細状態"]?.select?.name, "明細原本照合済", "原本未確定の価格phaseは開始しません");
    assert.equal(before.properties["保有価格状態"]?.select?.name, pricePreflight || status === "実行中（結果未確定）" ? "再開待ち" : "実行中（結果未確定）");
    const saved = JSON.parse(richValue(before.properties["保有価格再開情報"])) as RecoveryInfo;
    for (const name of ["source", "ownerName", "zipBytes", "zipSha256", "parsed", "factsSha256"] as const) assert.deepEqual(saved[name], info[name], "価格queueの原本束縛が変更されています");
    assert.equal(saved.priceQueueVersion, 1); assert.equal(info.priceQueueVersion, 1);
    assert.equal(saved.nextHoldingOffset, previousOffset === undefined ? info.nextHoldingOffset : previousOffset, "価格queue cursorが変化しています");
    assert.ok(info.nextHoldingOffset! >= saved.nextHoldingOffset! && info.nextHoldingOffset! <= info.parsed);
    assert.ok(info.unavailableRows! >= saved.unavailableRows! && info.unavailableRows! <= info.nextHoldingOffset!);
    if (pricePreflight) assert.equal(info.unavailableRows, saved.unavailableRows, "価格preflight HOLDは既知cursor/欠測数を変えません");
  }
  const properties: Record<string, HoldingProperty> = { [`${phase}状態`]: { select: { name: status } },
    [`${phase}理由`]: rt(reason), [`${phase}再開情報`]: rt(JSON.stringify(info)) };
  if (!price && status === "明細原本照合済") {
    assert.ok(typeof info.factsSha256 === "string"); assert.match(info.factsSha256, /^[a-f0-9]{64}$/);
    const previous = before.properties["保有価格再開情報"];
    if (previous?.type === "rich_text" && richValue(previous)) {
      const saved = JSON.parse(richValue(previous)) as RecoveryInfo;
      for (const name of ["source", "ownerName", "zipBytes", "zipSha256", "parsed", "factsSha256"] as const) assert.deepEqual(saved[name], info[name], "既存価格queueの原本束縛が変更されています");
    } else {
      assert.notEqual(before.properties["保有価格状態"]?.select?.name, "実行中（結果未確定）", "価格unknownの再開情報が欠けています");
      Object.assign(properties, { "保有価格状態": { select: { name: "再開待ち" } },
      "保有価格理由": rt("原本明細は完了。保存価格の資格確認は未実施"), "保有価格再開情報": rt(JSON.stringify({ source: info.source, ownerName: info.ownerName, zipBytes: info.zipBytes, zipSha256: info.zipSha256,
        parsed: info.parsed, factsSha256: info.factsSha256, priceQueueVersion: 1, nextHoldingOffset: 0, unavailableRows: 0 })) });
    }
  }
  const ack = await notionRequest<{ object: string; id: string }>("PATCH", `/pages/${archivePageId}`, { properties }, { singleAttempt: true });
  assert.equal(ack.object, "page"); assert.equal(ack.id.replaceAll("-", ""), archivePageId.replaceAll("-", ""), "保有再開markerのPATCH ACKが別行です");
  const actual = await notionRequest<HoldingPage>("GET", `/pages/${archivePageId}`);
  assert.equal(actual.object, "page"); assert.equal(actual.id.replaceAll("-", ""), archivePageId.replaceAll("-", ""), "保有再開markerのreadbackが別行です");
  assert.equal(actual.parent.type, "database_id");
  assert.equal(actual.parent.database_id.replaceAll("-", ""), dbId.replaceAll("-", ""));
  assert.equal(actual.archived, false);
  assert.equal(actual.in_trash, false);
  assertProperties(actual.properties, properties);
  if (price) for (const name of ["保有明細状態", "保有明細理由", "保有明細再開情報"]) assert.deepEqual(actual.properties[name], before.properties[name], "価格phaseで原本完了を変更しません");
  if (!price && !Object.hasOwn(properties, "保有価格状態")) for (const name of ["保有価格状態", "保有価格理由", "保有価格再開情報"]) assert.deepEqual(actual.properties[name], before.properties[name], "既存価格queueを変更しません");
  return actual;
}

/** 原本完了とは独立。保存ZIP・限定snapshotだけで価格列を追記し、未知は再送しない。 */
export async function resumePendingShareholdingsPrices(args: {
  maxRows: number; shouldStop: () => boolean; loadSources: HoldingPriceSourceLoader;
  budget: HoldingPriceBudget;
}): Promise<{ usedRows: number; resumed: number; held: number; pending: boolean }> {
  assert.ok(Number.isSafeInteger(args.maxRows) && args.maxRows >= 0 && args.maxRows <= 100);
  assert.ok(Number.isSafeInteger(args.budget.remainingChunks) && args.budget.remainingChunks >= 0 && args.budget.remainingChunks <= 116);
  assert.ok(Number.isSafeInteger(args.budget.remainingBytes) && args.budget.remainingBytes >= 0 && args.budget.remainingBytes <= 256 * 1024 * 1024);
  const dbId = await recoveryDatabase();
  const query = (status: string, size: number) => notionRequest<{ results: HoldingPage[]; has_more: boolean; next_cursor: string | null }>(
    "POST", `/databases/${dbId}/query`, { filter: { property: "保有価格状態", select: { equals: status } },
      sorts: [{ timestamp: "created_time", direction: "ascending" }], page_size: size });
  const unknown = await query("実行中（結果未確定）", 1);
  assert.equal(unknown.results.length, 0, "保有価格に結果未確定があります。原本完了は保持し、自動再送せず読取照合してください");
  const queue = await query("再開待ち", 6), attention = await query("要確認", 1);
  const result = { usedRows: 0, resumed: 0, held: attention.results.length, pending: queue.has_more || queue.results.length > 5 };
  for (const page of queue.results.slice(0, 5)) {
    if (args.shouldStop() || result.usedRows === args.maxRows) { result.pending = true; break; }
    assert.equal(page.archived, false); assert.equal(page.in_trash, false);
    assert.equal(page.parent.type, "database_id"); assert.equal(page.parent.database_id.replaceAll("-", ""), dbId.replaceAll("-", ""));
    assert.equal(page.properties["保有明細状態"]?.select?.name, "明細原本照合済");
    assert.equal(page.properties["保有価格状態"]?.select?.name, "再開待ち");
    const info = JSON.parse(richValue(page.properties["保有価格再開情報"])) as RecoveryInfo;
    assert.match(info.source.docId, /^S[0-9A-Z]{7}$/); assert.match(info.source.stockCode, /^[0-9]{3}[0-9A-Z]$/);
    assert.ok(typeof info.source.edinetCode === "string"); assert.match(info.source.edinetCode, /^E[0-9]{5}$/);
    assert.equal(new Date(`${info.source.fiscalYearEnd}T00:00:00Z`).toISOString().slice(0, 10), info.source.fiscalYearEnd);
    assert.ok(typeof info.ownerName === "string" && info.ownerName.trim());
    assert.ok(Number.isSafeInteger(info.zipBytes) && info.zipBytes > 0 && info.zipBytes <= HOLDINGS_ZIP_MAX_BYTES);
    assert.match(info.zipSha256, /^[a-f0-9]{64}$/);
    assert.ok(typeof info.factsSha256 === "string"); assert.match(info.factsSha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(info.parsed) && info.parsed >= 0);
    assert.equal(info.priceQueueVersion, 1);
    assert.ok(Number.isSafeInteger(info.nextHoldingOffset) && info.nextHoldingOffset! >= 0 && info.nextHoldingOffset! <= info.parsed);
    assert.ok(Number.isSafeInteger(info.unavailableRows) && info.unavailableRows! >= 0 && info.unavailableRows! <= info.nextHoldingOffset!);
    let saved: Awaited<ReturnType<typeof readSavedHoldingsZip>>;
    let sources: Awaited<ReturnType<HoldingPriceSourceLoader>>;
    try {
      saved = await readSavedHoldingsZip(info.source);
      if (saved.status === "held") {
        await recordRecoveryInfo(page.id, info, "要確認", saved.reason, true, undefined, undefined, true); result.held++; continue;
      }
      assert.equal(saved.archivePageId.replaceAll("-", ""), page.id.replaceAll("-", ""));
      assert.equal(saved.sha256, info.zipSha256); assert.equal(saved.bytes.length, info.zipBytes);
      const parsed = parseShareholdingsData(saved.bytes, info.source);
      assert.equal(parsed.status, "ok"); assert.equal(parsed.holderScope, "filer_only");
      assert.equal(parsed.holdings.length, info.parsed, "価格phaseで原表の明細集合が変更されています");
      assert.equal(holdingsFactsSha256(parsed.holdings), info.factsSha256, "価格phaseで全facts/orderが変化しています");
      const selected = parsed.holdings.slice(info.nextHoldingOffset, info.nextHoldingOffset! + args.maxRows - result.usedRows);
      sources = await args.loadSources(selected, args.budget, args.shouldStop, info.source.fiscalYearEnd);
      if (sources.status === "held" || args.shouldStop()) {
        if (sources.status === "held") assert.ok(sources.reasonCode === "budget_exhausted" || sources.reasonCode === "snapshot_unavailable" || sources.reasonCode === "issuer_source_unavailable");
        const retry = sources.status !== "held" || sources.reasonCode === "budget_exhausted";
        await recordRecoveryInfo(page.id, info, retry ? "再開待ち" : "要確認", sources.status === "held" ? sources.reason : "価格phaseの実時間予算を使い切りました", true, undefined, undefined, true);
        if (retry) result.pending = true; else result.held++;
        continue;
      }
      assert.ok(sources.snapshotId.trim() && sources.evidenceScope.trim());
    } catch (error) {
      await recordRecoveryInfo(page.id, info, "実行中（結果未確定）", "保存原本・価格根拠が不明です。自動再送せず読取照合してください", true);
      throw error;
    }
    assert.equal(saved.status, "ready"); assert.equal(sources.status, "ready");
    const outcome = await publishHoldings({ source: info.source, ownerName: info.ownerName, zip: saved.bytes,
      archivePageId: page.id, maxRows: args.maxRows - result.usedRows, valuationSources: sources }, { snapshotId: sources.snapshotId, info });
    if (outcome.status === "published") { result.usedRows += outcome.parsed; result.resumed++; if (outcome.pending) result.pending = true; else if (outcome.unavailable! > 0) result.held++; }
    else if (outcome.pending) result.pending = true;
    else result.held++;
  }
  return result;
}

/** EDINET完了checkpointとは独立した既知HOLDだけを、次定時に保存原本から優先再開。 */
export async function resumePendingShareholdings(args: { maxRows: number; shouldStop: () => boolean; observeIssuedShares?: true }): Promise<{
  usedRows: number; resumed: number; held: number; pending: boolean;
}> {
  assert.ok(Number.isSafeInteger(args.maxRows) && args.maxRows >= 0 && args.maxRows <= 100);
  notionEnv.NOTION_STOCK_HOLDINGS_DB_ID(); // EDINET源取得より前に必須設定を検証する。
  const dbId = await recoveryDatabase();
  const query = (status: string, size: number) => notionRequest<{ results: HoldingPage[]; has_more: boolean; next_cursor: string | null }>(
    "POST", `/databases/${dbId}/query`, { filter: { property: "保有明細状態", select: { equals: status } },
      sorts: [{ timestamp: "created_time", direction: "ascending" }], page_size: size });
  const unknown = await query("実行中（結果未確定）", 1);
  assert.equal(unknown.results.length, 0, "保有明細に結果未確定の通があります。自動再送せず読取照合してください");
  const queue = await query("再開待ち", 6);
  const attention = await query("要確認", 1);
  const result = { usedRows: 0, resumed: 0, held: attention.results.length, pending: queue.has_more || queue.results.length > 5 };
  for (const page of queue.results.slice(0, 5)) {
    if (args.shouldStop() || result.usedRows === args.maxRows) { result.pending = true; break; }
    assert.equal(page.archived, false);
    assert.equal(page.in_trash, false);
    const parts = page.properties["保有明細再開情報"];
    assert.equal(parts.type, "rich_text");
    assert.ok(Array.isArray(parts.rich_text));
    const info = JSON.parse(parts.rich_text.map(part => {
      assert.equal(part.type, "text"); assert.equal(part.plain_text, part.text?.content);
      return part.plain_text;
    }).join("")) as RecoveryInfo;
    assert.ok(Number.isSafeInteger(info.zipBytes) && info.zipBytes > 0 && info.zipBytes <= HOLDINGS_ZIP_MAX_BYTES && /^[a-f0-9]{64}$/.test(info.zipSha256));
    if (info.sourceQueueVersion === undefined) { result.held++; result.pending = true; continue; }
    assert.equal(info.sourceQueueVersion, 1);
    const saved = await readSavedHoldingsZip(info.source);
    if (saved.status === "held") { result.held++; continue; }
    assert.equal(saved.archivePageId.replaceAll("-", ""), page.id.replaceAll("-", ""));
    assert.equal(saved.bytes.length, info.zipBytes); assert.equal(saved.sha256, info.zipSha256);
    const outcome = await publishVerifiedShareholdings({ source: info.source, ownerName: info.ownerName, zip: saved.bytes,
      archivePageId: page.id, maxRows: args.maxRows - result.usedRows, observeIssuedShares: args.observeIssuedShares,
      issuedSharesFilingDateEvidence: typeof saved.metadata.submitDateTime === "string"
        ? { rawSubmitDateTime: saved.metadata.submitDateTime, provenance: "saved-archive-metadata" } : null });
    if (outcome.status === "published") { result.usedRows += outcome.parsed; result.resumed++; }
    else if (outcome.pending) { result.usedRows += outcome.usedRows!; result.resumed++; result.pending = true; }
    else { result.held++; result.pending = true; }
  }
  return result;
}
