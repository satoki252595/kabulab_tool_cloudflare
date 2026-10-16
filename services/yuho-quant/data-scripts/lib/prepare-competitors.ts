/** 通常competitors CLIの機械準備。判定client・競合writer・schema ensureをimportしない。 */
import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { gzipSync } from "node:zlib";
import { createD1HttpDb } from "../../../../src/shared/db/d1-http-client.js";
import { notionEnv, NotionConfigError } from "../../../../src/shared/notion-archive/env.js";
import { notionRequest, notionStats, setNotionMaxRps, NotionUnknownResultError } from "../../../../src/shared/notion-archive/client.js";
import { recordPrimaryData, verifyArchivedAttachments } from "../../../../src/shared/notion-archive/index.js";
import { loadSupplementRows, SUPPLEMENT_PROPS } from "../../../../src/shared/notion-archive/stock-supplement.js";
import { parseStockCode } from "../../../../src/shared/jpx/stock-code.js";
import { TEXT_SECTIONS } from "../../src/services/edinet/text-sections.js";
import { loadLatestDocs } from "../../src/biztag/source.js";
import { todayJst } from "../../src/biztag/date-jst.js";
import { loadCompetitorCalibration } from "../../src/biztag/competitors/calibration.js";
import { buildPreparedCompetitorManifest, prepareCandidateInputs, preparedJson, preparedSha } from "../../src/biztag/competitors/prepare-input.js";

const SOURCE_FILES = ["services/yuho-quant/data-scripts/lib/prepare-competitors.ts", "services/yuho-quant/src/biztag/competitors/prepare-input.ts",
  "services/yuho-quant/src/biztag/competitors/candidates.ts", "services/yuho-quant/src/biztag/competitors/ngram.ts",
  "services/yuho-quant/src/biztag/competitors/question.ts", "services/yuho-quant/src/biztag/competitors/summary.ts",
  "services/yuho-quant/src/biztag/competitors/calibration.ts", "services/yuho-quant/src/biztag/competitors/calibration.semif.json",
  "services/yuho-quant/src/biztag/plan.ts", "services/yuho-quant/src/biztag/source.ts", "services/yuho-quant/src/services/edinet/text-sections.ts",
  "services/yuho-quant/src/biztag/evidence.ts", "services/yuho-quant/src/biztag/prefilter.ts", "services/yuho-quant/data-scripts/biztag.ts", "src/shared/notion-archive/stock-supplement.ts",
  "src/shared/notion-archive/client.ts", "src/shared/notion-archive/archive.ts", "src/shared/notion-archive/readback.ts"];
const root = new URL("../../../../", import.meta.url);
const sourceHashes = () => Object.fromEntries(SOURCE_FILES.map(path => [path, preparedSha(readFileSync(new URL(path, root)))]));

export interface PrepareCompetitorsOptions { codes: string[]; limit: number; budgetMs: number; outDir: string; judge: "semif"; maxRps?: number }

export async function prepareCompetitors(opts: PrepareCompetitorsOptions) {
  if (opts.judge !== "semif" || opts.codes.length === 0 || opts.codes.length > 100 || new Set(opts.codes).size !== opts.codes.length ||
      opts.codes.some(code => parseStockCode(code) !== code) || !Number.isSafeInteger(opts.limit) || opts.limit <= 0 ||
      opts.limit > opts.codes.length || !Number.isSafeInteger(opts.budgetMs) || opts.budgetMs <= 0 || opts.outDir.trim() === "") {
    throw new NotionConfigError("競合準備には明示semif・重複なし1〜100コード・有限limit/budget・private保存先が必要です");
  }
  if (opts.maxRps !== undefined) setNotionMaxRps(opts.maxRps);
  const startedAt = new Date().toISOString(), deadline = Date.now() + opts.budgetMs, before = notionStats();
  const assertReadActive = () => { if (Date.now() >= deadline) throw new NotionConfigError("競合準備の新規読取期限を超過しました。モデル/競合書込なしでSTOP"); };
  const pins = sourceHashes(), codes = opts.codes.slice(0, opts.limit), dbId = notionEnv.NOTION_STOCK_SUPPLEMENT_DB_ID();
  if (dbId === undefined) throw new NotionConfigError("既存補足DBの明示設定がありません。schemaを作らず停止します");
  const schema = await notionRequest<{ object: string; id: string; properties: Record<string, { id: string; type: string }> }>(
    "GET", `/databases/${dbId}`, undefined, { beforeRequest: assertReadActive });
  if (schema.object !== "database" || schema.id.replaceAll("-", "") !== dbId.replaceAll("-", "")) throw new NotionConfigError("補足DBのnative所属が不正です");
  const propertyIds = Object.fromEntries(Object.entries(schema.properties).map(([name, p]) => [name, p.id]));
  for (const name of [...Object.values(SUPPLEMENT_PROPS), ...TEXT_SECTIONS.map(s => s.title)]) {
    if (typeof propertyIds[name] !== "string" || propertyIds[name].length === 0) throw new NotionConfigError("競合準備の既存schemaが未完です。変更せず停止します");
  }
  const calibration = loadCompetitorCalibration("semif");
  const rows = await loadSupplementRows(dbId, propertyIds, { textColumns: ["事業の内容"], strictNative: true, beforeRequest: assertReadActive });
  assertReadActive();
  const db = createD1HttpDb({}), latestBefore = await loadLatestDocs(db);
  const plan = prepareCandidateInputs(rows, calibration, codes, latestBefore);
  const fullRows: Awaited<ReturnType<typeof loadSupplementRows>> = [];
  // 既存OR filter。1社ごとの39列GETを作らず、対象A/選出Bだけ50コードずつ読む。
  for (let offset = 0; offset < plan.neededCodes.length; offset += 50) {
    const selected = plan.neededCodes.slice(offset, offset + 50);
    const read = await loadSupplementRows(dbId, propertyIds, { codes: selected, textColumns: TEXT_SECTIONS.map(s => s.title),
      strictNative: true, beforeRequest: assertReadActive });
    if (read.some(r => !selected.includes(r.stockCode))) throw new NotionConfigError("競合準備OR queryが未知の銘柄を返しました");
    fullRows.push(...read);
  }
  assertReadActive();
  const latest = await loadLatestDocs(db); // 同じ現active/latestを再照会。世代差は資格HOLDへ渡す。
  const manifest = { dbId, ...buildPreparedCompetitorManifest({ rows, fullRows, latest, plan, calibration, codes, sourceHashes: pins,
    today: todayJst(() => Date.now()) }), latestBefore: latestBefore.filter(r => plan.neededCodes.includes(r.stockCode)) };
  if (preparedJson(pins) !== preparedJson(sourceHashes())) throw new NotionConfigError("競合準備中にsourceが変更しました");
  const json = preparedJson(manifest), inputSha256 = preparedSha(json), bytes = gzipSync(json), gzipSha256 = preparedSha(bytes);
  const dir = join(resolve(opts.outDir), inputSha256); mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "input.json.gz"), marker = join(dir, "archive-started.json"), receiptPath = join(dir, "archive-receipt.json");
  if (existsSync(path)) {
    if (!readFileSync(path).equals(bytes)) throw new NotionConfigError("同入力の保存gzipが不一致です");
  } else writeFileSync(path, bytes, { mode: 0o600, flag: "wx" });
  if (existsSync(marker) && !existsSync(receiptPath)) throw new NotionUnknownResultError("競合準備archiveの未完送信記録があります。照合前に再送しません");
  assertReadActive();
  if (!existsSync(marker)) writeFileSync(marker, JSON.stringify({ startedAt, inputSha256, gzipSha256 }), { mode: 0o600, flag: "wx" });
  const firstAttempt = JSON.parse(readFileSync(marker, "utf8"));
  if (firstAttempt.inputSha256 !== inputSha256 || firstAttempt.gzipSha256 !== gzipSha256 ||
      typeof firstAttempt.startedAt !== "string" || !Number.isFinite(Date.parse(firstAttempt.startedAt))) throw new NotionConfigError("競合準備archive開始証跡が不一致です");
  const key = `competitor-prepared-input-v1/${inputSha256}`, filename = `competitor-prepared-${inputSha256}.json.gz`;
  // 読取期限を越えて新規本文は読まない。取得済み入力の物理保管/照合は最後まで閉じる。
  const files = [{ filename, bytes, contentType: "application/gzip" }];
  const archived = await recordPrimaryData({ service: "yuho-quant", key, source: "通常競合CLIの最新入力機械準備（モデル/競合書込なし）",
    fetchedAt: firstAttempt.startedAt, requireExistingDatabase: true, force: false,
    metadata: { inputSha256, gzipSha256, companies: codes.length, ready: manifest.prepared.filter(p => p.status === "prepared").length,
      held: manifest.holds.length, corpus: plan.corpus.length, modelCalls: 0, competitorWrites: 0, schemaWrites: 0 }, files });
  if (archived.fileTooLarge || archived.manifestMatch === "unknown") throw new NotionConfigError("競合準備archiveの全物理入力が未証明です");
  await verifyArchivedAttachments(archived.pageId, files, "競合のモデル不要prepare入力");
  if (!existsSync(receiptPath)) writeFileSync(receiptPath, JSON.stringify({ inputSha256, gzipSha256, archivePageId: archived.pageId,
    verifiedAt: new Date().toISOString(), bytes: bytes.length, modelCalls: 0, competitorWrites: 0, schemaWrites: 0 }), { mode: 0o600, flag: "wx" });
  const after = notionStats();
  return { mode: "prepare-only", status: manifest.holds.length === 0 ? "prepared-input-only" : "prepared-input-with-holds",
    startedAt, finishedAt: new Date().toISOString(), requested: opts.codes.length, preparedScope: codes.length,
    notStartedCodes: opts.codes.slice(opts.limit), ready: manifest.prepared.filter(p => p.status === "prepared").length,
    holds: manifest.holds, inputSha256, gzipSha256, path, bytes: bytes.length, archivePageId: archived.pageId,
    archiveOutcome: archived.outcome, physicalArchiveVerified: true, notionRequests: after.requests - before.requests,
    modelCalls: 0, competitorWrites: 0, schemaWrites: 0 };
}
