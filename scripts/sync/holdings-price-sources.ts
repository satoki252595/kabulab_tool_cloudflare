/** Node-only saved-price loader. The normal Worker receives it by injection, never imports S3/fs. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readActivatedPriceSnapshot } from "../vwap/lib/holdings-price-registry.js";
import { downloadArchivedFile } from "../moneyflow/lib/archived-files.js";
import { notionRequest } from "../../src/shared/notion-archive/client.js";
import { priceFileSchema, type PriceFile, type PriceSnapshot } from "../../src/shared/holdings/price-registry.js";
import { exactLegalName, parseHoldingsCodeList, type ArchivedSource } from "../../services/yuho-quant/src/services/edinet/shareholdings-valuation.js";
import type { Shareholding } from "../../services/yuho-quant/src/services/edinet/shareholdings.js";
import { HoldingsCodeListBudgetError, readVerifiedHoldingsCodeList } from "./holdings-code-list.js";

export interface HoldingPriceBudget { remainingChunks: number; remainingBytes: number }
type RichText = { type: string; plain_text: string; text: { content: string } };
type NativePage = { object: string; id: string; archived: boolean; in_trash: boolean;
  parent: { type: string; database_id: string }; properties: Record<string, {
    type: string; has_more?: boolean; rich_text?: RichText[]; select?: { name: string };
    files?: Array<{ name: string; type: string; file?: { url: string } }>;
  }> };
const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const fileKey = (file: PriceFile) => `${file.archivePageId.replaceAll("-", "")}/${file.filename}/${file.sha256}`;

export async function readHoldingPriceFile(expected: PriceFile): Promise<ArchivedSource> {
  priceFileSchema.parse(expected);
  const page = await notionRequest<NativePage>("GET", `/pages/${expected.archivePageId}`, undefined, { singleAttempt: true });
  assert.equal(page.object, "page"); assert.equal(page.id.replaceAll("-", ""), expected.archivePageId.replaceAll("-", ""));
  assert.equal(page.archived, false); assert.equal(page.in_trash, false);
  assert.equal(page.parent.type, "database_id"); assert.match(page.parent.database_id.replaceAll("-", ""), /^[a-f0-9]{32}$/i);
  assert.ok(Object.values(page.properties).every(prop => prop.has_more !== true), "保存価格のpage応答が打ち切られています");
  assert.equal(page.properties.Status.type, "select"); assert.equal(page.properties.Status.select?.name, "recorded");
  assert.equal(page.properties.Metadata.type, "rich_text");
  const parts = page.properties.Metadata.rich_text; assert.ok(Array.isArray(parts));
  const metadata = JSON.parse(parts.map(part => { assert.equal(part.type, "text"); assert.equal(part.plain_text, part.text.content); return part.plain_text; }).join(""));
  const manifest = metadata._fileManifest;
  assert.equal(manifest.version, 1); assert.match(manifest.inputFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(manifest.files.length, 1);
  const entry = manifest.files[0];
  assert.equal(entry.originalFilename, expected.filename); assert.equal(entry.uploadFilename, expected.filename);
  assert.equal(entry.sha256, expected.sha256); assert.equal(entry.byteLength, expected.byteLength); assert.equal(entry.upload, "uploaded");
  const prop = page.properties.Files; assert.equal(prop.type, "files"); assert.equal(prop.files?.length, 1);
  const file = prop.files[0]; assert.equal(file.name, expected.filename); assert.equal(file.type, "file");
  assert.ok(typeof file.file?.url === "string");
  const bytes = Buffer.from(await downloadArchivedFile({ name: expected.filename, url: file.file.url }, "保有価格保存原本", { maxBytes: expected.byteLength }));
  assert.equal(bytes.length, expected.byteLength); assert.equal(hash(bytes), expected.sha256, "価格原本の全SHA不一致です");
  return { archivePageId: expected.archivePageId, filename: expected.filename, sha256: expected.sha256, bytes };
}

export type HoldingPriceSources = { status: "ready"; snapshotId: string; evidenceScope: string; codeList: ArchivedSource; prices: ArchivedSource[] } |
  { status: "held"; reasonCode: "snapshot_unavailable" | "budget_exhausted"; reason: string };

/** A single scheduled run owns this cache and its mutable download budget. Failed reads are not resent. */
export function createHoldingPriceSourceLoader(): (holdings: readonly Shareholding[], budget: HoldingPriceBudget) => Promise<HoldingPriceSources> {
  let snapshot: Promise<PriceSnapshot | null> | undefined;
  let codeList: Promise<ArchivedSource> | undefined;
  let catalog: ReturnType<typeof parseHoldingsCodeList> | undefined;
  const chunks = new Map<string, Promise<ArchivedSource>>();
  return async (holdings, budget) => {
    assert.ok(Number.isSafeInteger(budget.remainingChunks) && budget.remainingChunks >= 0 && Number.isSafeInteger(budget.remainingBytes) && budget.remainingBytes >= 0, "価格取得予算が不正です");
    snapshot ??= readActivatedPriceSnapshot();
    const active = await snapshot;
    if (active === null) return { status: "held", reasonCode: "snapshot_unavailable", reason: "保存価格snapshotのfresh物理受入・有効化が未実施です" };
    if (codeList === undefined) {
      if (active.codeList.byteLength > budget.remainingBytes) return { status: "held", reasonCode: "budget_exhausted", reason: "公式銘柄表の保存原本読取予算が不足しています" };
      codeList = readVerifiedHoldingsCodeList(active.codeList, budget.remainingBytes).then(result => {
        budget.remainingBytes -= result.readBytes; return result.source;
      });
    }
    let codes: ArchivedSource;
    try { codes = await codeList; }
    catch (error) {
      if (!(error instanceof HoldingsCodeListBudgetError)) throw error;
      // Native metadata only; no hosted GET was sent. This known budget stop may resume.
      codeList = undefined;
      return { status: "held", reasonCode: "budget_exhausted", reason: error.message };
    }
    catalog ??= parseHoldingsCodeList(codes);
    const required = new Map<string, PriceFile>();
    for (const holding of holdings) {
      const names = catalog.byLegalName.get(exactLegalName(holding.name));
      if (names === undefined || names.length !== 1 || holding.shares === null) continue;
      const member = active.members[`${names[0].code}.T`];
      if (member !== undefined) required.set(fileKey(member.file), member.file);
    }
    const missing = [...required].filter(([key]) => !chunks.has(key));
    const bytes = missing.reduce((sum, [, file]) => sum + file.byteLength, 0);
    if (missing.length > budget.remainingChunks || bytes > budget.remainingBytes) {
      return { status: "held", reasonCode: "budget_exhausted", reason: "この文書の全必要価格chunkを保存原本読取予算内で照合できません" };
    }
    // Reserve the whole required set before any new GET; never claim a partial set is absent.
    budget.remainingChunks -= missing.length; budget.remainingBytes -= bytes;
    for (const [key, file] of missing) {
      const selected = Object.fromEntries(Object.values(active.members).filter(ref => fileKey(ref.file) === key)
        .map(ref => [ref.symbol, { bodySha256: ref.bodySha256, bodyBytes: ref.bodyBytes, receivedAt: ref.receivedAt }]));
      const read = readHoldingPriceFile(file).then(saved => ({ ...saved, priceMembers: selected }));
      chunks.set(key, read);
      await read;
    }
    const prices: ArchivedSource[] = [];
    // Sequential await also retains rejected promises; the same run never retries transport/SHA errors.
    for (const key of required.keys()) prices.push(await chunks.get(key)!);
    return { status: "ready", snapshotId: active.snapshotId,
      evidenceScope: `snapshot ${active.snapshotId} 内。その他保存観測の存在は未判定`, codeList: codes, prices };
  };
}
