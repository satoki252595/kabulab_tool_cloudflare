/** 保存原本の保有明細。diagnose/schema-plan/parse-savedはローカルのみ。 */
import "dotenv/config";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants, existsSync, readFileSync, unlinkSync, writeFileSync, openSync, closeSync, fsyncSync, linkSync, mkdirSync, lstatSync, realpathSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseShareholdingsData } from "../../services/yuho-quant/src/services/edinet/shareholdings.js";
import { applyHoldingsSchema, buildHoldingsSchemaPatch, inspectHoldingPatch, publishSavedShareholdings, replaceUnknownHoldingPatch, qualifyHoldingPatchJournal } from "../../src/shared/notion-archive/shareholdings.js";
import { NotionConfigError } from "../../src/shared/notion-archive/env.js";

const [mode, ...args] = process.argv.slice(2);
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
function syncParent(path: string): void {
  const fd = openSync(dirname(path), "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
}
/** Node CLI/backfillの排他的artifact。既存byteを上書きせずfileと親directoryを確定する。 */
export function writeHoldingsArtifact(path: string, value: string | Uint8Array): void {
  writeFileSync(path, value, { mode: 0o600, flag: "wx", flush: true });
  syncParent(path);
}
export const saveHoldingsReceipt = (path: string, value: unknown): void => writeHoldingsArtifact(path, JSON.stringify(value, null, 2) + "\n");
const save = saveHoldingsReceipt;
let mutationGuardActive = false;
function publishInput(zipPath: string, metadataPath: string) {
  const metadata = read(metadataPath);
  if (metadata.valuationSources !== undefined) {
    const load = (source: { path: string; archivePageId: string; filename: string; sha256: string }) => ({
      archivePageId: source.archivePageId, filename: source.filename, sha256: source.sha256, bytes: readFileSync(source.path),
    });
    assert.ok(Array.isArray(metadata.valuationSources.prices));
    metadata.valuationSources = { codeList: load(metadata.valuationSources.codeList), prices: metadata.valuationSources.prices.map(load) };
  }
  return { ...metadata, zip: readFileSync(zipPath) };
}

/** 単通CLIと保存原本backfillが共有する単発送信journal。unknown後は別通へ進まない。 */
export async function guardedHoldingsMutation<T>(out: string, label: string, action: () => Promise<T>): Promise<T> {
  const pending = `${out}.pending-write.json`;
  const journal = `${out}.write-events.jsonl`, completed = `${out}.completed-write.json`;
  assert.equal(mutationGuardActive, false, "同processで保有明細guardを重ねません");
  assert.equal([out, pending, journal, completed].some(path => existsSync(path)), false, "既存結果・送信中記録があるため読取照合が必要です");
  // action前のwxが同outputの競合/再起動を防ぐ。旧pendingは一切読替え/上書きしない。
  save(pending, { version: 2, observedAt: new Date().toISOString(), mode: label, journal, writes: [], noAutomaticReplay: true });
  writeHoldingsArtifact(journal, "");
  function append(value: unknown): void {
    // O_CREATなし。journal消失を新規作成で隠さず、既存prefixへだけ追記する。
    const fd = openSync(journal, constants.O_WRONLY | constants.O_APPEND);
    try { writeFileSync(fd, JSON.stringify(value) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  }
  const native = globalThis.fetch;
  const writes: unknown[] = [];
  let stopped = false;
  mutationGuardActive = true;
  globalThis.fetch = async (input, init) => {
    let attempt: number | undefined;
    try {
      assert.equal(stopped, false);
      const request = new Request(input, init), url = new URL(request.url);
      assert.equal(url.protocol, "https:");
      if (request.method !== "GET" && !url.pathname.endsWith("/query")) {
        assert.equal(url.origin, "https://api.notion.com");
        attempt = writes.length + 1;
        const intent = { phase: "send-intent", attempt, time: new Date().toISOString(), method: request.method,
          urlSha256: sha(request.url), bodySha256: sha(Buffer.from(await request.clone().arrayBuffer())) };
        append(intent); writes.push(intent);
      }
      const timeout = AbortSignal.timeout(30_000);
      const response = await native(request, { redirect: "manual", signal: AbortSignal.any([request.signal, timeout]) });
      if (attempt !== undefined) append({ phase: "response-headers", attempt, time: new Date().toISOString(), status: response.status });
      assert.equal(response.status, 200);
      return response;
    } catch {
      stopped = true;
      append({ phase: "stopped-no-replay", attempt, time: new Date().toISOString(), fullReadbackVerified: false });
      throw new NotionConfigError("保有明細の通信未完了。再送せず読取照合してください");
    }
  };
  try {
    const result = await action();
    assert.equal(stopped, false, "通信STOP後に成功を返しません");
    append({ phase: "action-returned", time: new Date().toISOString(), writes: writes.length });
    save(out, { observedAt: new Date().toISOString(), mode: label, result, writes: writes.length, sourceRequests: 0,
      journal: { version: 2, path: journal, sha256: sha(readFileSync(journal)), pendingSha256: sha(readFileSync(pending)) } });
    // renameの上書きを避けて旧marker bytesも保持。途中停止ならpendingが残り再送不可。
    linkSync(pending, completed); syncParent(completed);
    unlinkSync(pending); syncParent(pending);
    console.info(JSON.stringify({ outcome: "RESULT_JOURNALED", writes: writes.length }));
    return result;
  } finally { globalThis.fetch = native; mutationGuardActive = false; }
}

/** 通常journalの最後の結果不明PATCHを1 GETだけ観測する。元pending/全journalは解除も編集もしない。 */
function pendingHoldingPatch(paths: { pending: string; intent: string; request: string; before: string; schema: string; out: string }) {
  assert(paths.pending.endsWith(".pending-write.json")); assert(!existsSync(paths.out));
  const pending = read(paths.pending); assert.equal(pending.version, 2); assert.equal(pending.noAutomaticReplay, true);
  assert(["latest-saved-holdings", "publish-saved"].includes(pending.mode));
  assert.equal(resolve(dirname(pending.journal)), resolve(dirname(paths.pending)));
  const inputs = [paths.pending, pending.journal, paths.intent, paths.request, paths.before, paths.schema];
  assert(!inputs.some(path => resolve(path) === resolve(paths.out)));
  const pins = inputs.map(path => ({ path, sha256: sha(readFileSync(path)) }));
  const beforeRaw = readFileSync(paths.before, "utf8"), schemaRaw = readFileSync(paths.schema, "utf8");
  const evidence = { pending: readFileSync(paths.pending, "utf8"), journal: readFileSync(pending.journal, "utf8"), intent: readFileSync(paths.intent, "utf8"), request: readFileSync(paths.request, "utf8"), before: JSON.parse(beforeRaw), schema: JSON.parse(schemaRaw), beforeRaw, schemaRaw };
  const { attempt, changed } = qualifyHoldingPatchJournal(evidence);
  return { pins, last: { attempt }, before: evidence.before, changed, schema: evidence.schema, evidence };
}
export async function inspectPendingHoldingPatch(paths: { pending: string; intent: string; request: string; before: string; schema: string; out: string }): Promise<void> {
  assert.equal(mutationGuardActive, false);
  const { pins, last, before, changed, schema } = pendingHoldingPatch(paths);
  const observation = await inspectHoldingPatch({ before, changed, schema });
  for (const pin of pins) assert.equal(sha(readFileSync(pin.path)), pin.sha256, "読取中に元journal/PRE/inputが変わりました");
  save(paths.out, { status: "READ_ONLY_PENDING_PATCH_OBSERVATION_UNKNOWN_RETAINED", observedAt: new Date().toISOString(),
    observation, attempt: last.attempt, inputs: pins, GET: 1, mutations: 0, sourceRequests: 0,
    pendingCleared: false, sourceComplete: false, replayAuthorized: false });
}

/** canonical state内の一度intent。別outputでも同じ旧IDへの結果不明操作を繰り返さない。 */
export function claimHoldingPatchReplacement(state: string, value: unknown): void {
  if (!existsSync(state)) { mkdirSync(state, { recursive: true, mode: 0o700 }); syncParent(state); }
  const st = lstatSync(state); assert(st.isDirectory() && !st.isSymbolicLink()); assert.equal(st.uid, process.getuid!()); assert.equal(st.mode & 0o777, 0o700);
  writeHoldingsArtifact(join(state, "replacement-started.json"), JSON.stringify(value, null, 2) + "\n");
}

/** 元journalは読み取りだけ。物理PRE/退役/別ID/fullPOSTを共有publisherへ渡す明示正常CLI。 */
export async function resolvePendingHoldingPatch(inputPath: string, out: string): Promise<void> {
  assert.equal(mutationGuardActive, false); assert(!existsSync(out));
  const input = read(inputPath);
  assert.deepEqual(Object.keys(input).sort(), ["source", "ownerName", "archivePageId", "zipPath", "legacyPre", "pending", "intent", "request", "before", "schema"].sort());
  const paths = { pending: input.pending, intent: input.intent, request: input.request, before: input.before, schema: input.schema, out };
  const qualified = pendingHoldingPatch(paths), zipPath = resolve(input.zipPath), legacyPath = resolve(input.legacyPre.path);
  assert(statSync(zipPath).size <= 20 * 1024 * 1024 && statSync(legacyPath).size <= 20 * 1024 * 1024);
  const zip = readFileSync(zipPath), legacyBytes = readFileSync(legacyPath);
  const pins = [...qualified.pins, ...[inputPath, zipPath, legacyPath].map(path => ({ path, sha256: sha(readFileSync(path)) }))];
  assert(!pins.some(pin => resolve(pin.path) === resolve(out)));
  const envPath = realpathSync(".env"), env = lstatSync(envPath); assert(env.isFile()); assert.equal(env.uid, process.getuid!()); assert.equal(env.mode & 0o777, 0o600);
  const oldId = qualified.before.id.replaceAll("-", ""); assert.match(oldId, /^[a-f0-9]{32}$/);
  const source = input.source; assert.match(source.stockCode, /^[0-9]{3}[0-9A-Z]$/); assert.match(source.docId, /^S[0-9A-Z]{7}$/); assert.match(source.fiscalYearEnd, /^\d{4}-\d{2}-\d{2}$/);
  const state = join(dirname(envPath), "tmp/holdings-patch-resolution", `${source.stockCode}-${source.fiscalYearEnd}-${oldId}`);
  claimHoldingPatchReplacement(state, { version: 1, at: new Date().toISOString(), source, oldId: qualified.before.id, inputPins: pins, out, noAutomaticReplay: true });
  const assertInputs = () => { for (const pin of pins) assert.equal(sha(readFileSync(pin.path)), pin.sha256, "元pending/journal/保存原本を置換中に変更しません"); };
  const result = await guardedHoldingsMutation(out, "explicit-unknown-patch-replacement", async () => {
    const { createD1HttpDb } = await import("../../src/shared/db/d1-http-client.js"), schema = await import("../../services/yuho-quant/src/db/schema.js");
    const { selectLatestHoldingsDocuments } = await import("../../services/yuho-quant/data-scripts/lib/shareholdings-backfill.js");
    const db = createD1HttpDb(schema);
    const assertLatestSource = async () => {
      assertInputs(); const selected = await selectLatestHoldingsDocuments(db, { limit: 1, afterCode: null, onlyCode: source.stockCode });
      assert.equal(selected.rows.length, 1); const latest = selected.rows[0];
      assert.deepEqual({ docId: latest.docId, stockCode: latest.stockCode, edinetCode: latest.edinetCode, fiscalYearEnd: latest.fiscalYearEnd }, source);
      assert.equal(latest.ownerName, input.ownerName); assertInputs();
    };
    await assertLatestSource();
    const replacement = await replaceUnknownHoldingPatch({ source, ownerName: input.ownerName, archivePageId: input.archivePageId, zip,
      journal: qualified.evidence, legacyPre: { archivePageId: input.legacyPre.archivePageId, filename: input.legacyPre.filename, sha256: input.legacyPre.sha256, bytes: legacyBytes }, assertLatestSource });
    assertInputs(); return replacement;
  });
  save(join(state, "replacement-completed.json"), { at: new Date().toISOString(), result, out, outSha256: sha(readFileSync(out)), inputPins: pins,
    originalPendingCleared: false, originalACKReconstructed: false, sourceComplete: false, pricesAccepted: 0 });
}

function diagnose(graphPath: string, sourcePath: string) {
  const graphBytes = readFileSync(graphPath), sourceBytes = readFileSync(sourcePath);
  const graph = JSON.parse(graphBytes.toString("utf8"));
  assert.ok(Array.isArray(graph.companies));
  const sources = sourceBytes.toString("utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  const byOwnerPeriod = new Map<string, Array<{ id: string; names: Set<string>; html: boolean; units: boolean }>>();
  for (const source of sources) {
    assert.ok(typeof source.code === "string" && typeof source.period === "string" && typeof source.text === "string" && Array.isArray(source.names));
    const key = JSON.stringify([source.code, source.period]);
    const entries = byOwnerPeriod.get(key);
    const names = source.names as Array<{ name: unknown; shares: unknown }>;
    const entry = { id: source.id, names: new Set<string>(names.map(n => JSON.stringify([n.name, n.shares]))),
      html: /<(?:table|tr|td)\b/i.test(source.text),
      units: /株式数\((?:株|千株)\)/.test(source.text.normalize("NFKC").replace(/\s/g, "")) };
    if (entries) entries.push(entry); else byOwnerPeriod.set(key, [entry]);
  }
  const counts = { rows: 0, owners: 0, targetCodePresent: 0, targetCodeMissing: 0, pricePresent: 0, priceMissing: 0,
    sourceMatchUnique: 0, sourceMatchMissing: 0, sourceMatchAmbiguous: 0, matchedPlainText: 0, matchedHtml: 0,
    unitMentionWithoutCellProof: 0, noUnitMention: 0, sharesVerifiedByLegacyWriter: 0, pricesVerifiedByLegacyWriter: 0 };
  for (const company of graph.companies) {
    if (!company.securities) continue;
    const securities = company.securities;
    assert.ok(Array.isArray(securities.names));
    if (securities.names.length > 0) counts.owners++;
    const entries = byOwnerPeriod.get(JSON.stringify([company.code, securities.period]));
    for (const name of securities.names) {
      counts.rows++;
      if (name.code) counts.targetCodePresent++; else counts.targetCodeMissing++;
      if (name.price !== undefined && name.price !== null) counts.pricePresent++; else counts.priceMissing++;
      const matches = entries === undefined ? [] : entries.filter(s => s.names.has(JSON.stringify([name.name, name.shares])));
      if (matches.length === 0) counts.sourceMatchMissing++;
      else if (matches.length !== 1) counts.sourceMatchAmbiguous++;
      else {
        counts.sourceMatchUnique++;
        if (matches[0].html) counts.matchedHtml++; else counts.matchedPlainText++;
        if (matches[0].units) counts.unitMentionWithoutCellProof++; else counts.noUnitMention++;
      }
    }
  }
  return { observedAt: new Date().toISOString(), inputs: [
    { name: "graph.json", bytes: graphBytes.length, sha256: sha(graphBytes) },
    { name: "securities_full.jsonl", bytes: sourceBytes.length, sha256: sha(sourceBytes) },
  ], graphDate: graph.asof, marketDate: graph.marketAsOf, sourceRecords: sources.length, counts,
  classification: {
    targetCodeMissing: "銘柄コード未確定。非上場の証明ではない",
    sourceMatchUnique: "保存済み平文化抽出結果との一致。原表の列・期間・単位の証明ではない",
    pricePresent: "旧参考株価。個別観測日・通貨の一次証拠未確認",
    legacyShares: "100株未満を切り捨てる正規表現抽出。表の列帰属・単位を未確認",
  }, productionWrites: 0, sourceRequests: 0 };
}

async function main() {
  if (mode === "diagnose") {
    assert.equal(args.length, 3);
    const result = diagnose(args[0], args[1]);
    save(args[2], result);
    console.info(JSON.stringify(result.counts));
  } else if (mode === "schema-plan") {
    assert.equal(args.length, 2);
    save(args[1], buildHoldingsSchemaPatch(read(args[0])));
  } else if (mode === "parse-saved") {
    assert.equal(args.length, 3);
    const result = parseShareholdingsData(readFileSync(args[0]), read(args[1]).source);
    save(args[2], result);
    console.info(JSON.stringify({ status: result.status, reason: result.reason, holdings: result.holdings.length }));
  } else if (mode === "inspect-pending-patch") {
    assert.equal(args.length, 6);
    await inspectPendingHoldingPatch({ pending: args[0], intent: args[1], request: args[2], before: args[3], schema: args[4], out: args[5] });
  } else if (mode === "resolve-pending-patch") {
    assert.equal(args.length, 2);
    await resolvePendingHoldingPatch(resolve(args[0]), resolve(args[1]));
  } else if (mode === "apply-schema" || mode === "publish-saved") {
    assert.equal(args.length, mode === "apply-schema" ? 2 : 3);
    await guardedHoldingsMutation<unknown>(args[args.length - 1], mode, () => mode === "apply-schema" ? applyHoldingsSchema(read(args[0]))
      : publishSavedShareholdings(publishInput(args[0], args[1])));
  } else throw new Error("diagnose / schema-plan / parse-saved / inspect-pending-patch / resolve-pending-patch / apply-schema / publish-saved を指定してください");
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error("SHAREHOLDINGS_STOPPED_NO_AUTOMATIC_REPLAY"); process.exitCode = 1; });
}
