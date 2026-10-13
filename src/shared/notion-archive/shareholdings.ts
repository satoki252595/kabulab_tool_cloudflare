/** 保有明細の唯一のNotion入口。旧推定値は残し、原表で確定した列だけを公開する。 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { parseShareholdingsData, type Shareholding, type ShareholdingsSource, type ShareholdingsExtraction } from "../../../services/yuho-quant/src/services/edinet/shareholdings.js";
import { parseHoldingsCodeList, qualifyHoldingValuation, type ArchivedSource, type HoldingValuation } from "../../../services/yuho-quant/src/services/edinet/shareholdings-valuation.js";
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
interface PublishHoldingsArgs {
  source: ShareholdingsSource; ownerName: string; zip: Buffer; archivePageId: string; maxRows: number;
  budget?: ShareholdingsBudget;
  /** publishVerifiedでは物理全文照合済みの原本だけ。保存入口は内部で照合する。 */
  valuationSources?: { codeList: ArchivedSource; prices: readonly ArchivedSource[] };
}

export type PublishHoldingsResult =
  | { status: "published"; parsed: number; created: number; updated: number; unchanged: number }
  | { status: "held"; parsed: number; reason: string };

/**
 * recordEdinetZip(type1)の物理全文照合を終えた同一bytesだけを渡す。
 * 原本の再取得・再アップロード・再readbackはせず、原表未対応/予算超過は明示HOLD。
 * maxRowsはrunの残枠。0なら通信せずHOLD、途中打切りで一部成功にはしない。
 */
export async function publishVerifiedShareholdings(args: PublishHoldingsArgs): Promise<PublishHoldingsResult> {
  assert.ok(Number.isSafeInteger(args.maxRows) && args.maxRows >= 0 && args.maxRows <= 1000);
  assert.ok(args.ownerName.trim().length > 0);
  if (args.budget) assert.ok(Number.isSafeInteger(args.budget.remainingRows) && args.budget.remainingRows >= 0 && args.budget.remainingRows <= 100);
  const maxRows = args.budget ? Math.min(args.maxRows, args.budget.remainingRows) : args.maxRows;
  const hold = async (reason: string, parsed: number, retry: boolean): Promise<PublishHoldingsResult> => {
    await recordRecoveryMarker(args, retry ? "再開待ち" : "要確認", reason, parsed);
    return { status: "held", parsed, reason };
  };
  if (args.zip.length > 5 * 1024 * 1024) return hold("1原本5MiBの解析予算を超えています", 0, false);
  if (maxRows === 0) return hold("保有明細のrun件数予算を使い切りました", 0, true);
  const parsed = parseShareholdingsData(args.zip, args.source);
  if (parsed.status !== "ok") {
    assert.ok(parsed.reason);
    return hold(parsed.reason, 0, false);
  }
  if (parsed.holdings.length > maxRows) return hold("明細件数がrunの残予算を超えています", parsed.holdings.length, parsed.holdings.length <= 100);
  // 並列backfillでも、最初のawait前にrun枠を予約する。未知結果で返却しない。
  if (args.budget) args.budget.remainingRows -= parsed.holdings.length;
  const zipSha256 = createHash("sha256").update(args.zip).digest("hex");
  const catalog = args.valuationSources ? parseHoldingsCodeList(args.valuationSources.codeList) : null;
  const ready = [];
  for (const holding of parsed.holdings) {
    const valuation: HoldingValuation = catalog && args.valuationSources
      ? await qualifyHoldingValuation({ holding, fiscalYearEnd: args.source.fiscalYearEnd, catalog, prices: args.valuationSources.prices })
      : { status: "unavailable", identity: null, reason: "銘柄同定・個別価格・分割観測の保存原本が未指定です" };
    ready.push({ holding, valuation, properties: { ...holdingProperties(args.source, args.ownerName, holding),
      ...sourceProperties(parsed, holding, zipSha256), ...valuationProperties(holding, valuation) } });
  }
  const dbId = notionEnv.NOTION_STOCK_HOLDINGS_DB_ID();
  const schema = await readHoldingsSchema();
  assert.equal(Object.keys(buildHoldingsSchemaPatch(schema).properties).length, 0, "保有明細schemaの受入が未完了です");
  // 未知のmutation結果で止まった通はこの状態を保持し、定時再開の対象にしない。
  await recordRecoveryMarker(args, "実行中（結果未確定）", "原表の資格成立。全明細の読戻しは未完了", parsed.holdings.length);
  const result = { status: "published" as const, parsed: parsed.holdings.length, created: 0, updated: 0, unchanged: 0 };
  for (const { holding, valuation, properties } of ready) {
    const existing = await queryUniqueRow<HoldingPage>(dbId, { and: [
      { property: "保有会社コード", rich_text: { equals: args.source.stockCode } },
      { property: "銘柄名", rich_text: { equals: holding.name } },
      { property: "期末", date: { equals: args.source.fiscalYearEnd } },
    ] }, "保有明細が複数あるため原本行を特定できません");
    if (existing) {
      assert.equal(existing.parent.type, "database_id");
      assert.equal(existing.parent.database_id.replaceAll("-", ""), dbId.replaceAll("-", ""));
      assert.equal(existing.archived, false);
      assert.equal(existing.in_trash, false);
      assert.equal(existing.properties["原本照合済"]?.type, "checkbox");
      assert.equal(typeof existing.properties["原本照合済"].checkbox, "boolean");
    }
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
    const saved: { id: string } = existing
      ? await notionRequest("PATCH", `/pages/${existing.id}`, { properties }, { singleAttempt: true })
      : await notionRequest("POST", "/pages", { parent: { database_id: dbId }, properties }, { singleAttempt: true });
    const readback = await notionRequest<HoldingPage>("GET", `/pages/${saved.id}`);
    assert.equal(readback.id.replaceAll("-", ""), saved.id.replaceAll("-", ""));
    assert.equal(readback.parent.type, "database_id");
    assert.equal(readback.parent.database_id.replaceAll("-", ""), dbId.replaceAll("-", ""));
    assert.equal(readback.archived, false);
    assert.equal(readback.in_trash, false);
    assertProperties(readback.properties, properties);
    if (existing) for (const [, legacy] of LEGACY_HOLDINGS_COLUMNS) assert.deepEqual(readback.properties[legacy], existing.properties[legacy]);
    if (existing) result.updated++; else result.created++;
  }
  await recordRecoveryMarker(args, "明細原本照合済", "全明細の保存値・原典キー・旧値保全を読戻し済み", parsed.holdings.length);
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
function valuationProperties(holding: Shareholding, valuation: HoldingValuation): Record<string, HoldingProperty> {
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
  } else missing.push(valuation.reason);
  properties["欠測理由"] = rt(missing.join("。"));
  return properties;
}

/** 保存type1限定のbackfill準備。新規原本取得・schema変更・行更新は0。 */
export async function readSavedHoldingsZip(docId: string): Promise<
  { status: "ready"; archivePageId: string; bytes: Buffer; sha256: string; originalManifest: "known" | "unknown" } |
  { status: "held"; reason: string }
> {
  assert.match(docId, /^S[0-9A-Z]+$/);
  const dbId = await sourceDatabase();
  const page = await queryUniqueRow<HoldingPage>(dbId, { property: "Key", title: { equals: `${docId}:type1` } }, "type1原本が複数あり保全停止します");
  if (page === null) return { status: "held", reason: "最新有報のtype1物理原本が未保管です。新規EDINET取得は実施しません" };
  assert.equal(page.archived, false); assert.equal(page.in_trash, false);
  assert.equal(page.parent.type, "database_id"); assert.equal(page.parent.database_id.replaceAll("-", ""), dbId.replaceAll("-", ""));
  const key = page.properties["Key"];
  assert.equal(key.type, "title"); assert.ok(Array.isArray(key.title));
  assert.equal(key.title.map(part => { assert.equal(part.type, "text"); assert.equal(part.plain_text, part.text?.content); return part.plain_text; }).join(""), `${docId}:type1`);
  if (page.properties["保有明細状態"]?.select?.name === "実行中（結果未確定）") return { status: "held", reason: "保有明細の前回結果が未確定です。再送せず読取照合してください" };
  const files = await listPageFiles(page.id, "Files");
  if (files.length !== 1 || files[0].kind !== "file" || files[0].name !== edinetArchiveFilename(docId, 1)) return { status: "held", reason: "type1の単一Notion-hosted物理添付を確認できません" };
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
  assert.equal(metadata.docID, docId);
  if (metadata._fileManifest !== undefined) {
    assert.ok(Array.isArray(metadata._fileManifest.files));
    assert.equal(metadata._fileManifest.files.length, 1);
    const manifest = metadata._fileManifest.files[0];
    assert.equal(manifest.originalFilename, files[0].name);
    assert.equal(manifest.byteLength, bytes.length); assert.equal(manifest.sha256, digest);
  }
  return { status: "ready", archivePageId: page.id, bytes, sha256: digest,
    originalManifest: metadata._fileManifest === undefined ? "unknown" : "known" };
}

const RECOVERY = {
  "保有明細状態": { select: { options: ["再開待ち", "要確認", "実行中（結果未確定）", "明細原本照合済"].map(name => ({ name })) } },
  "保有明細理由": { rich_text: {} },
  "保有明細再開情報": { rich_text: {} },
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

async function recordRecoveryMarker(args: PublishHoldingsArgs, status: string, reason: string, parsed: number): Promise<void> {
  const dbId = await recoveryDatabase();
  const before = await notionRequest<HoldingPage>("GET", `/pages/${args.archivePageId}`);
  assert.equal(before.parent.type, "database_id");
  assert.equal(before.parent.database_id.replaceAll("-", ""), dbId.replaceAll("-", ""));
  assert.equal(before.archived, false);
  assert.equal(before.in_trash, false);
  if (status !== "明細原本照合済" && before.properties["保有明細状態"]?.select?.name === "実行中（結果未確定）") {
    throw new Error("保有明細の前回結果が未確定です。状態を上書きせず読取照合してください");
  }
  const key = before.properties["Key"];
  assert.equal(key.type, "title");
  assert.ok(Array.isArray(key.title));
  assert.equal(key.title.map(part => { assert.equal(part.type, "text"); assert.equal(part.plain_text, part.text?.content); return part.plain_text; }).join(""), `${args.source.docId}:type1`);
  const info = { source: args.source, ownerName: args.ownerName, zipBytes: args.zip.length,
    zipSha256: createHash("sha256").update(args.zip).digest("hex"), parsed };
  const properties: Record<string, HoldingProperty> = { "保有明細状態": { select: { name: status } },
    "保有明細理由": rt(reason), "保有明細再開情報": rt(JSON.stringify(info)) };
  await notionRequest("PATCH", `/pages/${args.archivePageId}`, { properties }, { singleAttempt: true });
  const actual = await notionRequest<HoldingPage>("GET", `/pages/${args.archivePageId}`);
  assert.equal(actual.parent.type, "database_id");
  assert.equal(actual.parent.database_id.replaceAll("-", ""), dbId.replaceAll("-", ""));
  assert.equal(actual.archived, false);
  assert.equal(actual.in_trash, false);
  assertProperties(actual.properties, properties);
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
