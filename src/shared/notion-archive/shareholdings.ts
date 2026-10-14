/** 保有明細の唯一のNotion入口。旧推定値は残し、原表で確定した列だけを公開する。 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { parseShareholdingsData, verifySavedHoldingsSource, type Shareholding, type ShareholdingsSource, type ShareholdingsExtraction } from "../../../services/yuho-quant/src/services/edinet/shareholdings.js";
import { HoldingsPriceIndex, parseHoldingsCodeList, qualifyHoldingValuation, type ArchivedSource, type HoldingValuation } from "../../../services/yuho-quant/src/services/edinet/shareholdings-valuation.js";
import { edinetArchiveFilename } from "../../../services/yuho-quant/src/services/edinet/archive.js";
import { findUniqueBackupChildByTitle, queryUniqueRow } from "./archive.js";
import { notionRequest } from "./client.js";
import { notionEnv } from "./env.js";
import { splitRichText } from "./rich-text.js";
import { verifyArchivedAttachments } from "./readback.js";
import { listPageFiles } from "./page-file.js";

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
  type?: string;
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
  properties: Record<string, HoldingProperty>;
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
  /** publishVerifiedでは物理全文照合済みの原本だけ。保存入口は内部で照合する。 */
  valuationSources?: { codeList: ArchivedSource; prices: readonly ArchivedSource[]; evidenceScope?: string };
}

export interface HoldingPriceBudget { remainingChunks: number; remainingBytes: number }
export type HoldingPriceSourceLoader = (holdings: readonly Shareholding[], budget: HoldingPriceBudget) => Promise<
  { status: "ready"; snapshotId: string; evidenceScope: string; codeList: ArchivedSource; prices: ArchivedSource[] } |
  { status: "held"; reason: string; reasonCode: "snapshot_unavailable" | "budget_exhausted" }
>;

export type PublishHoldingsResult =
  | { status: "published"; parsed: number; created: number; updated: number; unchanged: number; unavailable?: number; pending?: boolean }
  | { status: "held"; parsed: number; reason: string };

/**
 * recordEdinetZip(type1)の物理全文照合を終えた同一bytesだけを渡す。
 * 原本の再取得・再アップロード・再readbackはせず、原表未対応/予算超過は明示HOLD。
 * maxRowsはrunの残枠。0なら通信せずHOLD、途中打切りで一部成功にはしない。
 */
export async function publishVerifiedShareholdings(args: PublishHoldingsArgs): Promise<PublishHoldingsResult> {
  return publishHoldings(args);
}

async function publishHoldings(args: PublishHoldingsArgs, pricePhase?: { snapshotId: string; info: RecoveryInfo }): Promise<PublishHoldingsResult> {
  assert.ok(Number.isSafeInteger(args.maxRows) && args.maxRows >= 0 && args.maxRows <= 1000);
  assert.ok(args.ownerName.trim().length > 0);
  if (args.budget) assert.ok(Number.isSafeInteger(args.budget.remainingRows) && args.budget.remainingRows >= 0 && args.budget.remainingRows <= 100);
  const maxRows = args.budget ? Math.min(args.maxRows, args.budget.remainingRows) : args.maxRows;
  const hold = async (reason: string, parsed: number, retry: boolean): Promise<PublishHoldingsResult> => {
    if (pricePhase) await recordRecoveryInfo(args.archivePageId, pricePhase.info, retry ? "再開待ち" : "要確認", reason, true);
    else await recordRecoveryMarker(args, retry ? "再開待ち" : "要確認", reason, parsed);
    return { status: "held", parsed, reason };
  };
  if (args.zip.length > 5 * 1024 * 1024) return hold("1原本5MiBの解析予算を超えています", 0, false);
  if (maxRows === 0) return hold("保有明細のrun件数予算を使い切りました", 0, true);
  const parsed = parseShareholdingsData(args.zip, args.source);
  if (parsed.status !== "ok" || parsed.holderScope !== "filer_only") {
    return hold(parsed.reason ?? "提出会社の保有主体資格が未確認です", 0, false);
  }
  if (!pricePhase && parsed.holdings.length > maxRows) return hold("明細件数がrunの残予算を超えています", parsed.holdings.length, parsed.holdings.length <= 100);
  if (pricePhase) {
    assert.equal(pricePhase.info.parsed, parsed.holdings.length);
    assert.equal(pricePhase.info.factsSha256, holdingsFactsSha256(parsed.holdings), "価格windowの全facts/orderが変化しています");
  }
  const selected = pricePhase ? parsed.holdings.slice(pricePhase.info.nextHoldingOffset!, pricePhase.info.nextHoldingOffset! + maxRows) : parsed.holdings;
  // 並列backfillでも、最初のawait前にrun枠を予約する。未知結果で返却しない。
  if (args.budget) args.budget.remainingRows -= selected.length;
  const zipSha256 = createHash("sha256").update(args.zip).digest("hex");
  const catalog = args.valuationSources ? parseHoldingsCodeList(args.valuationSources.codeList) : null;
  const prices = args.valuationSources ? new HoldingsPriceIndex(args.valuationSources.prices) : null;
  const ready = [];
  for (const holding of selected) {
    const valuation: HoldingValuation = catalog && prices
      ? await qualifyHoldingValuation({ holding, fiscalYearEnd: args.source.fiscalYearEnd, catalog, prices })
      : { status: "unavailable", identity: null, reason: "銘柄同定・個別価格・分割観測の保存原本が未指定です" };
    ready.push({ holding, valuation, properties: { ...holdingProperties(args.source, args.ownerName, holding),
      ...sourceProperties(parsed, holding, zipSha256), ...valuationProperties(holding, valuation, args.valuationSources?.evidenceScope) } });
  }
  const dbId = notionEnv.NOTION_STOCK_HOLDINGS_DB_ID();
  const schema = await readHoldingsSchema();
  assert.equal(Object.keys(buildHoldingsSchemaPatch(schema).properties).length, 0, "保有明細schemaの受入が未完了です");
  // 未知のmutation結果で止まった通はこの状態を保持し、定時再開の対象にしない。
  if (!pricePhase) await recordRecoveryMarker(args, "実行中（結果未確定）", "原表の資格成立。全明細の読戻しは未完了", parsed.holdings.length);
  const result = { status: "published" as const, parsed: selected.length, created: 0, updated: 0, unchanged: 0 };
  let unavailableInWindow = 0;
  for (const { holding, valuation, properties } of ready) {
    const existing = await queryUniqueRow<HoldingPage>(dbId, { and: [
      { property: "保有会社コード", rich_text: { equals: args.source.stockCode } },
      { property: "銘柄名", rich_text: { equals: holding.name } },
      { property: "期末", date: { equals: args.source.fiscalYearEnd } },
      { property: "保有種別", select: { equals: holding.kind } },
    ] }, "保有明細が複数あるため原本行を特定できません");
    if (existing) {
      assert.equal(existing.object, "page");
      assert.equal(existing.parent.type, "database_id");
      assert.equal(existing.parent.database_id.replaceAll("-", ""), dbId.replaceAll("-", ""));
      assert.equal(existing.archived, false);
      assert.equal(existing.in_trash, false);
      assertProperties(existing.properties, { "保有会社コード": rt(args.source.stockCode), "銘柄名": rt(holding.name), "期末": { date: { start: args.source.fiscalYearEnd } }, "保有種別": { select: { name: holding.kind } } });
      assert.equal(existing.properties["原本照合済"]?.type, "checkbox");
      assert.equal(typeof existing.properties["原本照合済"].checkbox, "boolean");
    }
    if (pricePhase) assert.equal(existing?.properties["原本照合済"]?.checkbox, true, "価格phaseで原本未確定行の作成/更新はしません");
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
    if (pricePhase && existing) for (const [name, value] of Object.entries(existing.properties)) {
      if (!VALUATION_COLUMNS.has(name)) assert.deepEqual(readback.properties[name], value, "価格追記で他propsが変更されています");
    }
    if (existing) result.updated++; else result.created++;
  }
  if (!pricePhase) await recordRecoveryMarker(args, "明細原本照合済", "全明細の保存値・原典キー・旧値保全を読戻し済み", parsed.holdings.length, holdingsFactsSha256(parsed.holdings));
  else {
    const unavailable = pricePhase.info.unavailableRows! + unavailableInWindow;
    const nextHoldingOffset = pricePhase.info.nextHoldingOffset! + selected.length;
    const pending = nextHoldingOffset < parsed.holdings.length;
    await recordRecoveryInfo(args.archivePageId, { ...pricePhase.info, snapshotId: pricePhase.snapshotId, nextHoldingOffset, unavailableRows: unavailable },
      pending ? "再開待ち" : unavailable > 0 ? "要確認" : "価格照合完了",
      pending ? `価格${nextHoldingOffset}/${parsed.holdings.length}明細の読戻し済み。次windowへ再開待ち` :
        unavailable > 0 ? `${unavailable}明細は各windowのsnapshot範囲で価格資格未成立。各行の理由を参照。今回の範囲: ${args.valuationSources!.evidenceScope}` : "全明細の価格資格・他props保持を読戻し済み",
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
export async function readSavedHoldingsZip(source: ShareholdingsSource): Promise<
  { status: "ready"; archivePageId: string; bytes: Buffer; sha256: string; originalManifest: "known" | "unknown"; sourceCustody: "typed" | "legacy"; metadata: Record<string, unknown>; fetchedAt: string; metadataMissing: string[] } |
  { status: "held"; reason: string }
> {
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
  assert.equal(new URL(files[0].url).protocol, "https:");
  const response = await fetch(files[0].url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  assert.equal(response.ok, true);
  const length = response.headers.get("Content-Length");
  if (length !== null && Number(length) > 5 * 1024 * 1024) return { status: "held", reason: "type1原本が1通5MiBの予算を超えています" };
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 5 * 1024 * 1024) return { status: "held", reason: "type1原本が1通5MiBの予算を超えています" };
  const digest = createHash("sha256").update(bytes).digest("hex");
  const parts = page.properties["Metadata"]?.rich_text;
  assert.ok(Array.isArray(parts));
  const metadata = JSON.parse(parts.map(part => {
    assert.equal(part.type, "text"); assert.equal(part.plain_text, part.text?.content); return part.plain_text;
  }).join(""));
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
  const identity = verifySavedHoldingsSource(bytes, source);
  if (identity.status === "held") return identity;
  return { status: "ready", archivePageId: page.id, bytes, sha256: digest,
    originalManifest: metadata._fileManifest === undefined ? "unknown" : "known", sourceCustody, metadata, fetchedAt, metadataMissing: metadataProof.missing };
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
  priceQueueVersion?: 1; nextHoldingOffset?: number; unavailableRows?: number; snapshotId?: string;
}

async function recordRecoveryMarker(args: PublishHoldingsArgs, status: string, reason: string, parsed: number, factsSha256?: string): Promise<void> {
  const info: RecoveryInfo = { source: args.source, ownerName: args.ownerName, zipBytes: args.zip.length,
    zipSha256: createHash("sha256").update(args.zip).digest("hex"), parsed };
  if (factsSha256 !== undefined) info.factsSha256 = factsSha256;
  await recordRecoveryInfo(args.archivePageId, info, status, reason, false);
}

function richValue(property: HoldingProperty): string {
  assert.equal(property.type, "rich_text"); assert.ok(Array.isArray(property.rich_text));
  return property.rich_text.map(part => { assert.equal(part.type, "text"); assert.equal(part.plain_text, part.text?.content); return part.plain_text; }).join("");
}

async function recordRecoveryInfo(archivePageId: string, info: RecoveryInfo, status: string, reason: string, price: boolean, previousOffset?: number): Promise<void> {
  const dbId = await recoveryDatabase();
  const before = await notionRequest<HoldingPage>("GET", `/pages/${archivePageId}`);
  assert.equal(before.object, "page"); assert.equal(before.id.replaceAll("-", ""), archivePageId.replaceAll("-", ""), "保有再開markerのGETが別行です");
  assert.equal(before.parent.type, "database_id");
  assert.equal(before.parent.database_id.replaceAll("-", ""), dbId.replaceAll("-", ""));
  assert.equal(before.archived, false);
  assert.equal(before.in_trash, false);
  const phase = price ? "保有価格" : "保有明細";
  if ((!price && status !== "明細原本照合済" || price && status === "実行中（結果未確定）") && before.properties[`${phase}状態`]?.select?.name === "実行中（結果未確定）") {
    throw new Error("保有明細の前回結果が未確定です。状態を上書きせず読取照合してください");
  }
  const key = before.properties["Key"];
  assert.equal(key.type, "title");
  assert.ok(Array.isArray(key.title));
  assert.equal(key.title.map(part => { assert.equal(part.type, "text"); assert.equal(part.plain_text, part.text?.content); return part.plain_text; }).join(""), `${info.source.docId}:type1`);
  if (price) {
    assert.equal(before.properties["保有明細状態"]?.select?.name, "明細原本照合済", "原本未確定の価格phaseは開始しません");
    assert.equal(before.properties["保有価格状態"]?.select?.name, status === "実行中（結果未確定）" ? "再開待ち" : "実行中（結果未確定）");
    const saved = JSON.parse(richValue(before.properties["保有価格再開情報"])) as RecoveryInfo;
    for (const name of ["source", "ownerName", "zipBytes", "zipSha256", "parsed", "factsSha256"] as const) assert.deepEqual(saved[name], info[name], "価格queueの原本束縛が変更されています");
    assert.equal(saved.priceQueueVersion, 1); assert.equal(info.priceQueueVersion, 1);
    assert.equal(saved.nextHoldingOffset, previousOffset === undefined ? info.nextHoldingOffset : previousOffset, "価格queue cursorが変化しています");
    assert.ok(info.nextHoldingOffset! >= saved.nextHoldingOffset! && info.nextHoldingOffset! <= info.parsed);
    assert.ok(info.unavailableRows! >= saved.unavailableRows! && info.unavailableRows! <= info.nextHoldingOffset!);
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
      "保有価格理由": rt("原本明細は完了。保存価格の資格確認は未実施"), "保有価格再開情報": rt(JSON.stringify({ ...info, priceQueueVersion: 1, nextHoldingOffset: 0, unavailableRows: 0 })) });
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
  if (!price && status === "明細原本照合済" && !Object.hasOwn(properties, "保有価格状態")) for (const name of ["保有価格状態", "保有価格理由", "保有価格再開情報"]) assert.deepEqual(actual.properties[name], before.properties[name], "既存価格queueを変更しません");
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
    assert.ok(Number.isSafeInteger(info.zipBytes) && info.zipBytes > 0 && info.zipBytes <= 5 * 1024 * 1024);
    assert.match(info.zipSha256, /^[a-f0-9]{64}$/);
    assert.ok(typeof info.factsSha256 === "string"); assert.match(info.factsSha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(info.parsed) && info.parsed >= 0);
    assert.equal(info.priceQueueVersion, 1);
    assert.ok(Number.isSafeInteger(info.nextHoldingOffset) && info.nextHoldingOffset! >= 0 && info.nextHoldingOffset! <= info.parsed);
    assert.ok(Number.isSafeInteger(info.unavailableRows) && info.unavailableRows! >= 0 && info.unavailableRows! <= info.nextHoldingOffset!);
    // このphaseだけのunknownを先に保存。後の通信/資格throwでもsource完了は変えない。
    await recordRecoveryInfo(page.id, info, "実行中（結果未確定）", "保存原本・価格根拠の確認を開始。価格列の読戻しは未完了", true);
    const saved = await readSavedHoldingsZip(info.source);
    if (saved.status === "held") {
      await recordRecoveryInfo(page.id, info, "要確認", saved.reason, true); result.held++; continue;
    }
    assert.equal(saved.archivePageId.replaceAll("-", ""), page.id.replaceAll("-", ""));
    assert.equal(saved.sha256, info.zipSha256); assert.equal(saved.bytes.length, info.zipBytes);
    const parsed = parseShareholdingsData(saved.bytes, info.source);
    assert.equal(parsed.status, "ok"); assert.equal(parsed.holderScope, "filer_only");
    assert.equal(parsed.holdings.length, info.parsed, "価格phaseで原表の明細集合が変更されています");
    assert.equal(holdingsFactsSha256(parsed.holdings), info.factsSha256, "価格phaseで全facts/orderが変化しています");
    const selected = parsed.holdings.slice(info.nextHoldingOffset, info.nextHoldingOffset! + args.maxRows - result.usedRows);
    const sources = await args.loadSources(selected, args.budget);
    if (sources.status === "held" || args.shouldStop()) {
      if (sources.status === "held") assert.ok(sources.reasonCode === "budget_exhausted" || sources.reasonCode === "snapshot_unavailable");
      const retry = sources.status !== "held" || sources.reasonCode === "budget_exhausted";
      await recordRecoveryInfo(page.id, info, retry ? "再開待ち" : "要確認", sources.status === "held" ? sources.reason : "価格phaseの実時間予算を使い切りました", true);
      if (retry) result.pending = true; else result.held++;
      continue;
    }
    assert.ok(sources.snapshotId.trim() && sources.evidenceScope.trim());
    const outcome = await publishHoldings({ source: info.source, ownerName: info.ownerName, zip: saved.bytes,
      archivePageId: page.id, maxRows: args.maxRows - result.usedRows, valuationSources: sources }, { snapshotId: sources.snapshotId, info });
    if (outcome.status === "published") { result.usedRows += outcome.parsed; result.resumed++; if (outcome.pending) result.pending = true; else if (outcome.unavailable! > 0) result.held++; }
    else result.held++;
  }
  return result;
}

/** EDINET完了checkpointとは独立した既知HOLDだけを、次定時に保存原本から優先再開。 */
export async function resumePendingShareholdings(args: { maxRows: number; shouldStop: () => boolean }): Promise<{
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
    }).join("")) as { source: ShareholdingsSource; ownerName: string; zipBytes: number; zipSha256: string; parsed: number };
    assert.ok(Number.isSafeInteger(info.zipBytes) && info.zipBytes > 0 && /^[a-f0-9]{64}$/.test(info.zipSha256));
    const { listPageFiles } = await import("./page-file.js");
    const files = await listPageFiles(page.id, "Files");
    assert.equal(files.length, 1);
    const file = files[0];
    assert.equal(file.kind, "file");
    assert.equal(file.name, edinetArchiveFilename(info.source.docId, 1));
    assert.equal(new URL(file.url).protocol, "https:");
    const response = await fetch(file.url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
    assert.equal(response.ok, true, "保有明細の保存原本を再取得できません");
    const zip = Buffer.from(await response.arrayBuffer());
    assert.equal(zip.length, info.zipBytes);
    assert.equal(createHash("sha256").update(zip).digest("hex"), info.zipSha256);
    const outcome = await publishVerifiedShareholdings({ source: info.source, ownerName: info.ownerName, zip,
      archivePageId: page.id, maxRows: args.maxRows - result.usedRows });
    if (outcome.status === "published") { result.usedRows += outcome.parsed; result.resumed++; }
    else { result.held++; if (outcome.parsed <= 100) result.pending = true; }
  }
  return result;
}
