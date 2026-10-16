/**
 * 最新有報の保存type1だけで現行明細を再解析する。EDINET/Yahoo GET=0。
 * prepare <limit1..50> <afterCode|START> <privateDir> [valuation-source-paths.json]
 * apply <privateDir> <maxRows1..1000> — 未確定journalがあれば停止。確定windowだけ再開。
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createD1HttpDb } from "../../../src/shared/db/d1-http-client.js";
import * as schema from "../src/db/schema.js";
import { selectLatestHoldingsDocuments } from "./lib/shareholdings-backfill.js";
import { parseShareholdingsData, type ShareholdingsSource } from "../src/services/edinet/shareholdings.js";
import { HoldingsPriceIndex, parseHoldingsCodeList, qualifyHoldingValuation, type ArchivedSource } from "../src/services/edinet/shareholdings-valuation.js";
import { readSavedHoldingsZip, publishVerifiedShareholdings } from "../../../src/shared/notion-archive/shareholdings.js";
import { verifyArchivedAttachments } from "../../../src/shared/notion-archive/readback.js";
import { edinetArchiveFilename, recordEdinetZip } from "../src/services/edinet/archive.js";
import { guardedHoldingsMutation, saveHoldingsReceipt, writeHoldingsArtifact } from "../../../scripts/notion/shareholdings.js";

// ESM module start: never label a running old parser with a SHA read after long preparation.
const PARSER_SOURCE_PATH = fileURLToPath(new URL("../src/services/edinet/shareholdings.ts", import.meta.url));
const PARSER_SOURCE_SHA256 = createHash("sha256").update(readFileSync(PARSER_SOURCE_PATH)).digest("hex");
function assertParserSourceUnchanged(): void {
  assert.equal(createHash("sha256").update(readFileSync(PARSER_SOURCE_PATH)).digest("hex"), PARSER_SOURCE_SHA256, "parser source changed after process startup; stop before accepting a plan");
}

const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const save = saveHoldingsReceipt;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
interface SourcePath { path: string; archivePageId: string; filename: string; sha256: string }
interface Item { parserSourceSha256?: string; source: ShareholdingsSource; ownerName: string; status: string; reason: string | null; parsedRows: number;
  archivePageId?: string; zipPath?: string; zipSha256?: string; originalManifest?: string; projectionPath?: string; sourceCustody?: "typed" | "legacy"; sourceMetadata?: Record<string, unknown>; sourceFetchedAt?: string; sourceMetadataMissing?: string[] }

function valuationSources(path: string | null): { codeList: ArchivedSource; prices: ArchivedSource[] } | undefined {
  if (path === null) return undefined;
  const config = read(path);
  const load = (source: SourcePath) => ({ archivePageId: source.archivePageId, filename: source.filename,
    sha256: source.sha256, bytes: readFileSync(source.path) });
  assert.ok(Array.isArray(config.prices));
  return { codeList: load(config.codeList), prices: config.prices.map(load) };
}

export async function prepareLatestHoldings(args: { limit: number; afterCode: string | null; dir: string; valuationPath: string | null }): Promise<void> {
  const db = createD1HttpDb(schema);
  const selected = await selectLatestHoldingsDocuments(db, args);
  mkdirSync(args.dir, { recursive: true, mode: 0o700 });
  assert.equal(existsSync(join(args.dir, "plan.json")), false, "準備済みplanを上書きしません");
  const evidence = valuationSources(args.valuationPath), catalog = evidence ? parseHoldingsCodeList(evidence.codeList) : null;
  const prices = evidence ? new HoldingsPriceIndex(evidence.prices) : null;
  const items: Item[] = [];
  for (const row of selected.rows) {
    const source: ShareholdingsSource = { docId: row.docId, stockCode: row.stockCode, edinetCode: row.edinetCode, fiscalYearEnd: row.fiscalYearEnd };
    const path = join(args.dir, `${row.stockCode}-${row.docId}.item.json`);
    if (existsSync(path)) { const item = read(path) as Item; assert.deepEqual(item.source, source); assert.equal(item.parserSourceSha256, PARSER_SOURCE_SHA256, "旧parserのitemは未受入です。保存ZIPから別planへ再解析してください"); items.push(item); continue; }
    const saved = await readSavedHoldingsZip(source);
    let item: Item;
    if (saved.status === "held") item = { source, ownerName: row.ownerName, status: "held", reason: saved.reason, parsedRows: 0 };
    else {
      const parsed = parseShareholdingsData(saved.bytes, source);
      const zipPath = join(args.dir, `${row.stockCode}-${row.docId}.zip`);
      writeHoldingsArtifact(zipPath, saved.bytes);
      const records = [];
      for (const holding of parsed.holdings) records.push({ source, ownerName: row.ownerName, holding,
        valuation: prices && catalog ? await qualifyHoldingValuation({ holding, fiscalYearEnd: source.fiscalYearEnd, catalog, prices })
          : { status: "unavailable", identity: null, reason: "価格/同定の保存原本が未指定です" } });
      const projectionPath = join(args.dir, `${row.stockCode}-${row.docId}.current.jsonl`);
      writeHoldingsArtifact(projectionPath, records.map(record => JSON.stringify(record)).join("\n") + (records.length ? "\n" : ""));
      item = { source, ownerName: row.ownerName, status: parsed.status === "ok" ? "ready" : "held", reason: parsed.reason,
        parsedRows: parsed.holdings.length, archivePageId: saved.archivePageId, zipPath, zipSha256: saved.sha256,
        originalManifest: saved.originalManifest, projectionPath, sourceCustody: saved.sourceCustody, sourceMetadata: saved.metadata, sourceFetchedAt: saved.fetchedAt, sourceMetadataMissing: saved.metadataMissing };
    }
    item.parserSourceSha256 = PARSER_SOURCE_SHA256;
    assertParserSourceUnchanged();
    save(path, item); items.push(item);
    console.info(JSON.stringify({ docId: source.docId, status: item.status, rows: item.parsedRows }));
  }
  assertParserSourceUnchanged();
  save(join(args.dir, "plan.json"), { version: 1, parserSourceSha256: PARSER_SOURCE_SHA256, observedAt: new Date().toISOString(), selection: { afterCode: args.afterCode, limit: args.limit },
    nextAfterCode: selected.rows.length ? selected.rows[selected.rows.length - 1].stockCode : args.afterCode, more: selected.more,
    valuationPath: args.valuationPath, items, upstreamRequests: 0, productionWrites: 0 });
  console.info(JSON.stringify({ ready: items.filter(item => item.status === "ready").length, held: items.filter(item => item.status === "held").length,
    more: selected.more, upstreamRequests: 0, productionWrites: 0 }));
}

export async function applyLatestHoldings(dir: string, maxRows: number): Promise<void> {
  assert.ok(Number.isSafeInteger(maxRows) && maxRows >= 1 && maxRows <= 1000);
  assert.equal(readdirSync(dir).some(name => name.endsWith(".pending-write.json")), false, "前回の結果未確定journalがあります。読取照合が必要です");
  const plan = read(join(dir, "plan.json")) as { version: number; parserSourceSha256: string; selection: { afterCode: string | null; limit: number }; valuationPath: string | null; items: Item[] };
  assert.equal(plan.version, 1);
  assert.equal(plan.parserSourceSha256, PARSER_SOURCE_SHA256, "旧parser planは未受入です。保存ZIPから再準備してください");
  assertParserSourceUnchanged();
  const db = createD1HttpDb(schema);
  const evidence = valuationSources(plan.valuationPath);
  const runId = Date.now();
  const result = await guardedHoldingsMutation(join(dir, `apply-${runId}.json`), "latest-saved-holdings", async () => {
    if (evidence) for (const source of [evidence.codeList, ...evidence.prices]) {
      await verifyArchivedAttachments(source.archivePageId, [{ filename: source.filename, bytes: source.bytes }], "保有明細backfillの価格/同定原本");
    }
    let usedRows = 0, published = 0, held = 0, pending = 0;
    for (const item of plan.items) {
      assert.equal(item.parserSourceSha256, PARSER_SOURCE_SHA256, "item parser SHA不一致");
      assertParserSourceUnchanged();
      const receipt = join(dir, `${item.source.stockCode}-${item.source.docId}.published.json`);
      if (existsSync(receipt)) {
        const previous = read(receipt);
        assert.deepEqual(previous.source, item.source); assert.equal(previous.zipSha256, item.zipSha256);
        assert.equal(previous.result.status, "published"); assert.notEqual(previous.result.pending, true, "旧完了receiptに未完windowがあります。読取照合が必要です");
        continue;
      }
      const heldReceipt = join(dir, `${item.source.stockCode}-${item.source.docId}.held.json`);
      if (existsSync(heldReceipt)) {
        const previous = read(heldReceipt);
        assert.deepEqual(previous.source, item.source); assert.equal(previous.zipSha256, item.zipSha256);
        assert.equal(previous.result.status, "held"); assert.notEqual(previous.result.pending, true);
        held++; continue;
      }
      if (item.status !== "ready") { held++; continue; }
      if (usedRows === maxRows) { pending++; continue; }
      assert.ok(item.zipPath && item.zipSha256 && item.archivePageId);
      const zip = readFileSync(item.zipPath); assert.equal(hash(zip), item.zipSha256);
      const assertLatest = async () => {
        const fresh = await selectLatestHoldingsDocuments(db, plan.selection);
        const latest = fresh.rows.find(row => row.stockCode === item.source.stockCode);
        assert.ok(latest, "対象銘柄が最新有報集合から消えています");
        assert.deepEqual({ docId: latest.docId, stockCode: latest.stockCode, edinetCode: latest.edinetCode, fiscalYearEnd: latest.fiscalYearEnd },
          item.source, "最新有報・発行体・期末が準備時から変化しました。再準備してください");
        assert.equal(latest.ownerName, item.ownerName, "提出会社名が準備時から変化しました。再準備してください");
      };
      await assertLatest();
      let archivePageId = item.archivePageId;
      if (item.sourceCustody === "legacy") {
        // 非0件の適格通だけを現行keyへ移す。HOLD/0件は上で除外し、一次データを二重化しない。
        assert.ok(item.parsedRows > 0 && item.sourceMetadata && item.sourceFetchedAt);
        const custodyReceipt = join(dir, `${item.source.stockCode}-${item.source.docId}.modern-custody.json`);
        if (existsSync(custodyReceipt)) {
          const recorded = read(custodyReceipt); assert.equal(recorded.zipSha256, item.zipSha256);
          archivePageId = recorded.result.pageId;
          await verifyArchivedAttachments(archivePageId, [{ filename: edinetArchiveFilename(item.source.docId, 1), bytes: zip }], "保有明細backfillの確定済type1");
        } else {
          const saved = await readSavedHoldingsZip(item.source);
          assert.equal(saved.status, "ready");
          if (saved.status !== "ready") throw new Error("保存原本の現在値が未確認です");
          assert.equal(saved.sourceCustody, "legacy"); assert.equal(saved.archivePageId, item.archivePageId);
          assert.equal(saved.sha256, item.zipSha256); assert.ok(saved.bytes.equals(zip));
          assert.deepEqual(saved.metadata, item.sourceMetadata); assert.equal(saved.fetchedAt, item.sourceFetchedAt);
          const recorded = await recordEdinetZip({ service: "yuho-quant", docID: item.source.docId, type: 1, zip,
            source: "Saved Notion legacy type1; holdings-qualified nonzero custody migration; upstream GET 0",
            fetchedAt: saved.fetchedAt, metadata: { ...saved.metadata, sourceLegacyPageId: saved.archivePageId, sourceSha256: saved.sha256 }, force: false });
          archivePageId = recorded.pageId;
          save(custodyReceipt, { observedAt: new Date().toISOString(), zipSha256: item.zipSha256, result: recorded });
        }
      } else await verifyArchivedAttachments(archivePageId, [{ filename: edinetArchiveFilename(item.source.docId, 1), bytes: zip }], "保有明細backfillの保存type1");
      // 原本の物理読戻し中に新有報へ切り替わった場合も、公開前に止める。
      await assertLatest();
      const windowRows = Math.min(100, maxRows - usedRows);
      const result = await publishVerifiedShareholdings({ source: item.source, ownerName: item.ownerName, zip,
        archivePageId, maxRows: windowRows, valuationSources: evidence });
      const proof = { observedAt: new Date().toISOString(), source: item.source, zipSha256: item.zipSha256, result };
      if (result.status === "held") {
        if (result.pending === true) {
          assert.ok(Number.isSafeInteger(result.usedRows) && result.usedRows! > 0 && result.usedRows! <= windowRows);
          usedRows += result.usedRows!; pending++;
          save(join(dir, `${item.source.stockCode}-${item.source.docId}.window-${runId}.json`), proof);
        } else { held++; save(heldReceipt, proof); }
        continue;
      }
      assert.ok(Number.isSafeInteger(result.parsed) && result.parsed >= 0 && result.parsed <= windowRows);
      usedRows += result.parsed;
      if (result.pending === true) {
        assert.ok(result.parsed > 0);
        pending++; save(join(dir, `${item.source.stockCode}-${item.source.docId}.window-${runId}.json`), proof); continue;
      }
      published++;
      save(receipt, proof);
    }
    return { usedRows, published, held, pending, upstreamRequests: 0 };
  });
  if (result.held > 0 || result.pending > 0) process.exitCode = 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, ...args] = process.argv.slice(2);
  const running = mode === "prepare" && (args.length === 3 || args.length === 4)
    ? prepareLatestHoldings({ limit: Number(args[0]), afterCode: args[1] === "START" ? null : args[1], dir: resolve(args[2]), valuationPath: args[3] === undefined ? null : resolve(args[3]) })
    : mode === "apply" && args.length === 2 ? applyLatestHoldings(resolve(args[0]), Number(args[1]))
      : Promise.reject(new Error("prepare limit afterCode|START privateDir [valuation.json] / apply privateDir maxRows を明示してください"));
  running.catch(() => { console.error("LATEST_HOLDINGS_STOPPED_NO_AUTOMATIC_REPLAY"); process.exitCode = 2; });
}
