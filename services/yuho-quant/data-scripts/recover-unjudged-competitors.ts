/** 単発83社: prepare→generate(5/83)→apply。原文と出力はprivate dir、applyは運用者だけが実行。 */
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { notionEnv } from "../../../src/shared/notion-archive/env.js";
import { notionRequest } from "../../../src/shared/notion-archive/client.js";
import { loadSupplementRows, SUPPLEMENT_PROPS } from "../../../src/shared/notion-archive/stock-supplement.js";
import { loadCompetitorMeta, writeCompetitorRelation, type CompetitorMeta } from "../../../src/shared/notion-archive/stock-competitors.js";
import { recordPrimaryData, verifyArchivedAttachments } from "../../../src/shared/notion-archive/index.js";
import { createD1HttpDb } from "../../../src/shared/db/d1-http-client.js";
import { loadIngestCodeToId } from "../../../src/shared/db/active-equity.js";
import { createSemifClient } from "../../../src/shared/semif/client.js";
import { buildCandidates, GENERIC_TAG_LABELS } from "../src/biztag/competitors/candidates.js";
import { loadCompetitorCalibration } from "../src/biztag/competitors/calibration.js";
import { processCompanyCompetitors } from "../src/biztag/competitors/process.js";
import { bandOf } from "../src/biztag/judge.js";
import { todayJst } from "../src/biztag/date-jst.js";
import { assertFreshPre, assertRecoveryOutput, assertRecoveryPage, assertRecoveryReadback, assertRecoverySnapshot,
  assertUnjudged, assertNonTargets, assertOneWaySchema, canonicalJson, propertyText, sha256, type RecoveryPage, type RecoverySnapshot, type RecoveryOutput } from "./lib/unjudged-competitors-recovery.js";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SOURCE_FILES = ["services/yuho-quant/src/biztag/competitors/candidates.ts", "services/yuho-quant/src/biztag/competitors/ngram.ts",
  "services/yuho-quant/src/biztag/competitors/process.ts", "services/yuho-quant/src/biztag/competitors/question.ts",
  "services/yuho-quant/src/biztag/competitors/summary.ts", "services/yuho-quant/src/biztag/competitors/calibration.semif.json",
  "services/yuho-quant/src/biztag/judge.ts", "services/yuho-quant/src/biztag/text.ts",
  "src/shared/semif/client.ts", "services/yuho-quant/scripts/semif_server.py",
  "src/shared/notion-archive/stock-competitors.ts",
  "services/yuho-quant/data-scripts/recover-unjudged-competitors.ts", "services/yuho-quant/data-scripts/lib/unjudged-competitors-recovery.ts"];
const sourceHashes = () => Object.fromEntries(SOURCE_FILES.map((p) => [p, sha256(readFileSync(join(ROOT, p)))]));
const save = (path: string, value: unknown) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
const load = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

async function preserve(filename: string, bytes: Uint8Array, metadata: Record<string, unknown>, key: string): Promise<void> {
  const file = { filename, bytes, contentType: "application/gzip" };
  const saved = await recordPrimaryData({ service: "yuho-quant", key, source: "Notion補足の実入力/PREと既存ローカルSemIf派生結果", metadata,
    fetchedAt: new Date().toISOString(), files: [file], force: false });
  if (saved.fileTooLarge || saved.manifestMatch === "unknown") throw new Error("競合回復の物理保管が未証明");
  await verifyArchivedAttachments(saved.pageId, [file], "競合回復PRE/output");
}

async function readPage(pageId: string, dbId: string): Promise<RecoveryPage> {
  const page = await notionRequest<RecoveryPage>("GET", `/pages/${pageId}`);
  assertRecoveryPage(page, dbId);
  const relation = page.properties["競合他社"];
  if (relation?.has_more === true) {
    const full = await notionRequest<{ results: Array<{ type: string; relation: { id: string } }>; has_more: boolean }>(
      "GET", `/pages/${pageId}/properties/${encodeURIComponent(relation.id)}?page_size=100`);
    if (full.has_more !== false || full.results.some((r) => r.type !== "relation" || typeof r.relation?.id !== "string"))
      throw new Error("競合relationの全件読戻し未成立");
    relation.relation = full.results.map((r) => ({ id: r.relation.id })); relation.has_more = false;
  }
  return page;
}

// 自己relationは片方向。対象外の旧relationは候補入力にも更新にも使わない。
const metaFingerprint = (row: CompetitorMeta) => sha256(canonicalJson({ pageId: row.pageId, stockCode: row.stockCode,
  judgedAt: row.judgedAt, version: row.version, judgedDocId: row.judgedDocId }));
const inputFingerprints = (rows: Awaited<ReturnType<typeof loadSupplementRows>>) => Object.fromEntries(rows.map((r) => [r.stockCode, sha256(canonicalJson(r))]));

async function prepare(targetPath: string, dir: string, baselinePath?: string): Promise<void> {
  const dbId = notionEnv.NOTION_STOCK_SUPPLEMENT_DB_ID();
  if (dbId === undefined) throw new Error("既存補足DBの明示設定が必要。schema作成/自動修復しない");
  const targets = load<{ results: Array<Record<string, unknown>>; has_more: boolean }>(targetPath);
  if (targets.has_more !== false || targets.results.length !== 83) throw new Error("保存対象が完全な83社ではない");
  const codes = targets.results.map((r) => r["銘柄コード"]);
  if (codes.some((c) => typeof c !== "string") || new Set(codes).size !== 83) throw new Error("対象コードが不正/重複");
  const targetCodes = codes as string[];
  const schema = await notionRequest<{ properties: Record<string, { id: string; relation?: { database_id: string; type: string } }> }>("GET", `/databases/${dbId}`);
  const propertyIds = Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, v.id]));
  for (const name of ["競合他社", "競合判定日", "競合判定の版", "競合判定書類ID"]) if (!(name in propertyIds)) throw new Error("既存競合列が欠ける");
  assertOneWaySchema(schema.properties, dbId);
  const active = await loadIngestCodeToId(createD1HttpDb({}));
  const rows = await loadSupplementRows(dbId, propertyIds, { textColumns: ["事業の内容"] });
  const excludedCorpus: RecoverySnapshot["excludedCorpus"] = [];
  const corpus = rows.filter((r) => {
    let reason: string | undefined;
    if (r.tagStatus !== "判定済") reason = "事業タグ判定未完";
    else if (!active.has(r.stockCode)) reason = "現在のactive equity母集団外";
    else if (r.textStatus !== "取得済" || r.docId === null || r.texts["事業の内容"].trim().length === 0) reason = "本文/元有報IDの資格不成立";
    if (reason === undefined) return true;
    excludedCorpus.push({ code: r.stockCode, reason }); return false;
  }).map((r) => {
    return { stockCode: r.stockCode, companyName: r.companyName, pageId: r.pageId, sector33: r.sector33,
      tags: [...r.upstream, ...r.downstream, ...r.distribution], businessText: r.texts["事業の内容"], docId: r.docId };
  });
  const baseline = baselinePath === undefined ? await loadCompetitorMeta(dbId, propertyIds, SUPPLEMENT_PROPS.code) : (() => {
    const cached = load<{ dbId: string; rows: CompetitorMeta[] }>(baselinePath);
    if (cached.dbId !== dbId || !Array.isArray(cached.rows) || new Set(cached.rows.map((r) => r.stockCode)).size !== cached.rows.length) throw new Error("保全済み旧metaが不正");
    return cached.rows;
  })();
  const pre: RecoveryPage[] = [];
  for (const target of targets.results) {
    const company = corpus.find((p) => p.stockCode === target["銘柄コード"]);
    if (company === undefined || company.docId !== target["有報書類ID"]) throw new Error("固定83社の元有報/資格が変化");
    const page = await readPage(company.pageId, dbId); assertUnjudged(page);
    if (propertyText(page, "有報書類ID") !== company.docId || propertyText(page, "事業の内容") !== company.businessText) throw new Error("corpus/PRE入力が不一致");
    pre.push(page);
  }
  const calibration = loadCompetitorCalibration("semif"), start = performance.now();
  const built = buildCandidates(corpus, { topK: calibration.candidateTopK, weights: calibration.candidateWeights,
    genericTagLabels: GENERIC_TAG_LABELS, postingCaps: calibration.candidatePostingCaps });
  const candidates = Object.fromEntries(targetCodes.map((code) => { const found = built.get(code); if (found === undefined) throw new Error("候補計算結果欠け"); return [code, found]; }));
  const snapshot: RecoverySnapshot = { version: 1, capturedAt: new Date().toISOString(), revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(),
    dbId, propertyIds, sourceHashes: sourceHashes(), calibration, targetCodes, corpus, candidates, pre, baseline, inputFingerprints: inputFingerprints(rows), excludedCorpus };
  assertRecoverySnapshot(snapshot);
  const bytes = gzipSync(Buffer.from(canonicalJson(snapshot))), inputSha256 = sha256(canonicalJson(snapshot));
  writeFileSync(join(dir, "input.json.gz"), bytes, { flag: "wx", mode: 0o600 }); save(join(dir, "input.json"), snapshot);
  await preserve("competitor83-input.json.gz", bytes, { inputSha256, targets: 83, corpus: corpus.length }, `competitor83-input-${inputSha256}`);
  save(join(dir, "input-receipt.json"), { inputSha256, gzipSha256: sha256(bytes), fullBytesReadback: true, candidateBuildMs: performance.now() - start,
    corpusSize: corpus.length, excludedCorpus });
  console.info(JSON.stringify({ prepared: 83, corpus: corpus.length, candidateBuildMs: performance.now() - start, inputBytes: bytes.length, sourceGets: 0, modelCalls: 0 }));
}

function snapshotInput(dir: string): { snapshot: RecoverySnapshot; inputSha256: string } {
  const snapshot = load<RecoverySnapshot>(join(dir, "input.json")), receipt = load<{ inputSha256: string; fullBytesReadback: boolean }>(join(dir, "input-receipt.json"));
  assertRecoverySnapshot(snapshot);
  if (receipt.fullBytesReadback !== true || sha256(canonicalJson(snapshot)) !== receipt.inputSha256 || canonicalJson(snapshot.sourceHashes) !== canonicalJson(sourceHashes()))
    throw new Error("入力/SHA/物理保全/実行ソース版が変化");
  return { snapshot, inputSha256: receipt.inputSha256 };
}
function processTreeRssKiB(): number {
  const rows = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,rss="], { encoding: "utf8" }).trim().split("\n").map((l) => l.trim().split(/\s+/).map(Number));
  const descendants = new Set([process.pid]);
  for (let changed = true; changed;) { changed = false; for (const [pid, parent] of rows) if (descendants.has(parent) && !descendants.has(pid)) { descendants.add(pid); changed = true; } }
  return rows.filter(([pid]) => descendants.has(pid)).reduce((sum, [, , rss]) => sum + rss, 0);
}
async function generate(dir: string, limit: number): Promise<void> {
  if (limit !== 5 && limit !== 83) throw new Error("先行5社か固定83社だけ");
  const { snapshot, inputSha256 } = snapshotInput(dir), byCode = new Map(snapshot.corpus.map((p) => [p.stockCode, p]));
  const results: RecoveryOutput[] = [], client = createSemifClient({});
  let requests = 0, questions = 0, peakTreeRssKiB = processTreeRssKiB();
  const meter = setInterval(() => { peakTreeRssKiB = Math.max(peakTreeRssKiB, processTreeRssKiB()); }, 1000);
  try {
    for (const code of snapshot.targetCodes.slice(0, limit)) {
      const path = join(dir, `${code}.output.json`);
      if (existsSync(path)) { const old = load<RecoveryOutput>(path); assertRecoveryOutput(snapshot, old, inputSha256); results.push(old); continue; }
      const startedAt = new Date().toISOString(); save(join(dir, `${code}.started.json`), { code, inputSha256, startedAt, retry: false });
      const probabilities: Record<string, number> = {}, start = performance.now(); let expected: RecoveryOutput["expected"] | undefined;
      const candidates = snapshot.candidates[code];
      const measured = { askNoul: async (state: string, asked: Parameters<typeof client.askNoul>[1]) => {
        requests++; questions += Object.keys(asked).length;
        if (requests > 83 || questions > 4150 || Object.keys(asked).length > 50) throw new Error("固定推論予算を超過");
        const result = await client.askNoul(state, asked);
        if (result.model !== snapshot.calibration.model || canonicalJson(Object.keys(result.answers).sort()) !== canonicalJson(Object.keys(asked).sort())) throw new Error("モデル版/回答集合不一致");
        Object.assign(probabilities, result.answers); return result;
      } };
      const outcome = await processCompanyCompetitors(byCode.get(code)!, candidates, byCode, { jevClient: measured, thresholds: snapshot.calibration.thresholds,
        versionTag: `${snapshot.calibration.candidateVersion}|${snapshot.calibration.model}`, today: todayJst(() => Date.now()), batchSize: 50,
        writeCompetitorRelation: async (pageId, value) => { if (pageId !== byCode.get(code)!.pageId || expected !== undefined) throw new Error("出力write plan不正"); expected = value; } });
      if (expected === undefined) throw new Error("判定の終端出力なし");
      const bands = { yes: 0, no: 0, uncertain: 0 }; for (const p of Object.values(probabilities)) bands[bandOf(p, snapshot.calibration.thresholds)]++;
      peakTreeRssKiB = Math.max(peakTreeRssKiB, processTreeRssKiB());
      const output: RecoveryOutput = { stockCode: code, pageId: byCode.get(code)!.pageId, inputSha256, startedAt, finishedAt: new Date().toISOString(), elapsedMs: performance.now() - start,
        expected, probabilities, candidateCodes: candidates.map((c) => c.stockCode), bands, modelCalls: outcome.jevCalls, peakTreeRssKiB };
      assertRecoveryOutput(snapshot, output, inputSha256); save(path, output); results.push(output);
      console.info(JSON.stringify({ code, elapsedMs: output.elapsedMs, candidates: candidates.length, bands, peakTreeRssKiB }));
    }
  } finally { clearInterval(meter); client.close(); }
  const bytes = gzipSync(Buffer.from(canonicalJson(results))), outputSha256 = sha256(canonicalJson(results));
  writeFileSync(join(dir, `output-${limit}.json.gz`), bytes, { flag: "wx", mode: 0o600 });
  await preserve(`competitor83-output-${limit}.json.gz`, bytes, { inputSha256, outputSha256, companies: results.length, modelCalls: results.reduce((n, r) => n + r.modelCalls, 0) }, `competitor83-output-${outputSha256}`);
  save(join(dir, `output-${limit}-receipt.json`), { inputSha256, outputSha256, fullBytesReadback: true, companies: results.length,
    modelCalls: results.reduce((n, r) => n + r.modelCalls, 0), elapsedMs: results.reduce((n, r) => n + r.elapsedMs, 0), peakTreeRssKiB });
}

async function apply(dir: string): Promise<void> {
  const { snapshot, inputSha256 } = snapshotInput(dir), receipt = load<{ outputSha256: string; fullBytesReadback: boolean }>(join(dir, "output-83-receipt.json"));
  const outputs = snapshot.targetCodes.map((code) => load<RecoveryOutput>(join(dir, `${code}.output.json`)));
  if (receipt.fullBytesReadback !== true || sha256(canonicalJson(outputs)) !== receipt.outputSha256) throw new Error("全出力の物理保全/SHA未成立");
  for (const output of outputs) assertRecoveryOutput(snapshot, output, inputSha256);
  const readSchema = await notionRequest<{ properties: Record<string, { id: string; relation?: { database_id: string; type: string } }> }>("GET", `/databases/${snapshot.dbId}`);
  const propertyIds = Object.fromEntries(Object.entries(readSchema.properties).map(([k, v]) => [k, v.id]));
  if (canonicalJson(propertyIds) !== canonicalJson(snapshot.propertyIds)) throw new Error("補足schemaがPREから変化");
  assertOneWaySchema(readSchema.properties, snapshot.dbId);
  const target = new Set(snapshot.targetCodes);
  const readFingerprints = async () => ({
    meta: Object.fromEntries((await loadCompetitorMeta(snapshot.dbId, propertyIds, SUPPLEMENT_PROPS.code)).map((r) => [r.stockCode, metaFingerprint(r)])),
    input: inputFingerprints(await loadSupplementRows(snapshot.dbId, propertyIds, { textColumns: ["事業の内容"] })),
  });
  const oldMeta = Object.fromEntries(snapshot.baseline.map((r) => [r.stockCode, metaFingerprint(r)])), before = await readFingerprints();
  assertNonTargets(oldMeta, before.meta, target); assertNonTargets(snapshot.inputFingerprints, before.input, target);
  for (const output of outputs) {
    const pre = snapshot.pre.find((p) => p.id === output.pageId); if (pre === undefined) throw new Error("PREなし");
    const marker = join(dir, `${output.stockCode}.patch-started.json`);
    if (existsSync(marker)) throw new Error("送信記録あり。未知結果の再送はしない");
    const fresh = await readPage(output.pageId, snapshot.dbId); assertFreshPre(pre, fresh, snapshot.dbId);
    save(marker, { inputSha256, outputSha256: sha256(canonicalJson(output)), startedAt: new Date().toISOString(), sends: 1 });
    // Notion write窓口は共有writerだけ。失敗/未知時の再PATCHはしない。
    await writeCompetitorRelation(output.pageId, output.expected, { singleAttempt: true });
    const after = await readPage(output.pageId, snapshot.dbId); assertRecoveryReadback(pre, after, output.expected, snapshot.dbId);
    save(join(dir, `${output.stockCode}.readback.json`), after);
  }
  const after = await readFingerprints();
  assertNonTargets(oldMeta, after.meta, target); assertNonTargets(snapshot.inputFingerprints, after.input, target);
  save(join(dir, "apply-complete.json"), { inputSha256, outputSha256: receipt.outputSha256, verified: 83, oldChanged: 0, completedAt: new Date().toISOString() });
  console.info(JSON.stringify({ verified: 83, oldChanged: 0 }));
}

async function main(): Promise<void> {
  const [mode, dirArg, extra, baselinePath] = process.argv.slice(2); if (dirArg === undefined) throw new Error("prepare <private-dir> <targets.json> | generate <private-dir> 5|83 | apply <private-dir>");
  const dir = resolve(dirArg); mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (mode === "prepare" && extra !== undefined) await prepare(resolve(extra), dir, baselinePath === undefined ? undefined : resolve(baselinePath));
  else if (mode === "generate") await generate(dir, Number(extra));
  else if (mode === "apply" && extra === undefined) await apply(dir);
  else throw new Error("不正なmode/args。無処理で停止");
}
if (process.argv[1] === fileURLToPath(import.meta.url)) void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "競合回復失敗"); process.exitCode = 1; });
