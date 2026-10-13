/** 保存原本の保有明細。diagnose/schema-plan/parse-savedはローカルのみ。 */
import "dotenv/config";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseShareholdingsData } from "../../services/yuho-quant/src/services/edinet/shareholdings.js";
import { applyHoldingsSchema, buildHoldingsSchemaPatch, publishSavedShareholdings } from "../../src/shared/notion-archive/shareholdings.js";
import { NotionConfigError } from "../../src/shared/notion-archive/env.js";

const [mode, ...args] = process.argv.slice(2);
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const save = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
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
  assert.equal(existsSync(out) || existsSync(pending), false, "既存結果・送信中記録があるため読取照合が必要です");
  const native = globalThis.fetch;
  const writes: unknown[] = [];
  let stopped = false;
  globalThis.fetch = async (input, init) => {
    try {
      assert.equal(stopped, false);
      const request = new Request(input, init), url = new URL(request.url);
      assert.equal(url.protocol, "https:");
      if (request.method !== "GET" && !url.pathname.endsWith("/query")) {
        assert.equal(url.origin, "https://api.notion.com");
        writes.push({ time: new Date().toISOString(), method: request.method, urlSha256: sha(request.url), bodySha256: sha(Buffer.from(await request.clone().arrayBuffer())) });
        writeFileSync(pending, JSON.stringify({ writes, noAutomaticReplay: true }), { mode: 0o600 });
      }
      const response = await native(request, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
      assert.equal(response.status, 200);
      return response;
    } catch {
      stopped = true;
      throw new NotionConfigError("保有明細の通信未完了。再送せず読取照合してください");
    }
  };
  try {
    const result = await action();
    save(out, { observedAt: new Date().toISOString(), mode: label, result, writes: writes.length, sourceRequests: 0 });
    if (existsSync(pending)) unlinkSync(pending);
    console.info(JSON.stringify({ outcome: "READBACK_VERIFIED", writes: writes.length }));
    return result;
  } finally { globalThis.fetch = native; }
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
  } else if (mode === "apply-schema" || mode === "publish-saved") {
    assert.equal(args.length, mode === "apply-schema" ? 2 : 3);
    await guardedHoldingsMutation<unknown>(args[args.length - 1], mode, () => mode === "apply-schema" ? applyHoldingsSchema(read(args[0]))
      : publishSavedShareholdings(publishInput(args[0], args[1])));
  } else throw new Error("diagnose / schema-plan / parse-saved / apply-schema / publish-saved を指定してください");
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error("SHAREHOLDINGS_STOPPED_NO_AUTOMATIC_REPLAY"); process.exitCode = 1; });
}
