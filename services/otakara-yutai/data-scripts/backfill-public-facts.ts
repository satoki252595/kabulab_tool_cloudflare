/** 優待条件だけの保守取込。prepareは読取のみ、applyは物理PRE保全後の1送信だけ。 */
import "dotenv/config";
import { eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { z } from "../../../src/shared/zod-mini.js";
import { activeEquityCondition } from "../../../src/shared/db/active-equity.js";
import { createD1HttpBatchSender, type D1BatchStatement } from "../../../src/shared/db/d1-http-client.js";
import { recordPrimaryData, verifyArchivedAttachments } from "../../../src/shared/notion-archive/index.js";
import { stocks, yutaiBenefits } from "../src/db/schema.js";
import { assertBenefitSchedule } from "../src/record-date.js";
import { openOtakaraD1 } from "./benefit-rows.js";
import { benefitKey } from "./benefit-key.js";
import { buildPublicBenefitFacts } from "./public-facts.js";
import { assertNotCommittable } from "./private-path.js";
import type { BenefitRow } from "./summary-tasks.js";
import type { AtomicBatchSender } from "./atomic-apply.js";

const positiveInt = () => z.number().check(z.int(), z.positive());
const SourceRow = z.strictObject({
  id: positiveInt(), stockId: positiveInt(), stockCode: z.string(), stockName: z.string(),
  description: z.string(), shortSummary: z.nullable(z.string()), estimatedValue: z.nullable(z.number()),
  estimateValueSource: z.nullable(z.string()), minShares: positiveInt(), recordMonth: z.number().check(z.int()),
  recordDate: z.nullable(z.string()), updatedAt: z.number().check(z.int()),
});
const SourceSnapshot = z.strictObject({ fetchedAt: z.iso.datetime(), rows: z.array(SourceRow) });
const CompleteRow = z.strictObject({
  ...SourceRow.shape, genreId: positiveInt(), createdAt: z.number().check(z.int()), publicFacts: z.nullable(z.string()),
});
export type PublicFactsPreimage = z.infer<typeof CompleteRow>;

/** 新列が無いprepare時にも全旧列を読み、日時をDBのunix秒のまま保持する。 */
export async function loadPublicFactsPreimage(migrated: boolean): Promise<PublicFactsPreimage[]> {
  const rows = await openOtakaraD1().select({
    id: yutaiBenefits.id, stockId: yutaiBenefits.stockId, stockCode: stocks.code, stockName: stocks.name,
    description: yutaiBenefits.description, shortSummary: yutaiBenefits.shortSummary,
    estimatedValue: yutaiBenefits.estimatedValue, estimateValueSource: yutaiBenefits.estimateValueSource,
    minShares: yutaiBenefits.minShares, recordMonth: yutaiBenefits.recordMonth, recordDate: yutaiBenefits.recordDate,
    updatedAt: sql<number>`${yutaiBenefits.updatedAt}`, genreId: yutaiBenefits.genreId,
    createdAt: sql<number>`${yutaiBenefits.createdAt}`,
    publicFacts: migrated ? sql<string | null>`${yutaiBenefits.publicFacts}` : sql<null>`NULL`,
  }).from(yutaiBenefits).innerJoin(stocks, eq(stocks.id, yutaiBenefits.stockId))
    .where(activeEquityCondition()).orderBy(yutaiBenefits.id);
  return z.array(CompleteRow).parse(rows);
}

/** 全行・全射影列を照合し、変わった列名とIDだけで停止する。原文はログに出さない。 */
export function assertPublicFactsRowsMatch(expected: readonly Record<string, unknown>[], actual: readonly Record<string, unknown>[]): void {
  if (expected.length !== actual.length) throw new Error("優待PRE/readbackの行数が一致しません");
  const byId = new Map(actual.map(row => [row.id, row]));
  if (byId.size !== actual.length) throw new Error("優待readbackのIDが重複しています");
  for (const row of expected) {
    const found = byId.get(row.id);
    if (found === undefined) throw new Error(`優待行${row.id}がreadbackにありません`);
    for (const key of Object.keys(row)) {
      if (!Object.hasOwn(found, key) || JSON.stringify(found[key]) !== JSON.stringify(row[key])) {
        throw new Error(`優待行${row.id}の${key}がPRE/期待値と一致しません`);
      }
    }
  }
}

/** 既存群の全株数・月で計画する。新列NULLへの一度の保守取込だけを扱う。 */
export function planPublicFactsBackfill(source: readonly BenefitRow[], preimage: readonly PublicFactsPreimage[]) {
  const rows = z.array(CompleteRow).parse(preimage);
  if (rows.length === 0 || new Set(rows.map(row => row.id)).size !== rows.length) throw new Error("優待PREが空かID重複です");
  assertPublicFactsRowsMatch(z.array(SourceRow).parse(source), rows);
  for (const row of rows) {
    assertBenefitSchedule(row);
    if (row.publicFacts !== null) throw new Error(`優待行${row.id}には既に条件DTOがあります（上書きしません）`);
  }
  const groups = new Map<string, PublicFactsPreimage[]>();
  for (const row of rows) {
    const key = benefitKey(row.stockCode, row.description);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [row]); else group.push(row);
  }
  const facts = new Map<string, string>();
  for (const [key, group] of groups) {
    const first = group[0];
    facts.set(key, JSON.stringify(buildPublicBenefitFacts({ code: first.stockCode, description: first.description,
      context: { minShares: group.map(row => row.minShares), recordMonths: group.map(row => row.recordMonth) },
      fetchedAt: null, batchFetchedAt: null })));
  }
  const expected = rows.map(row => {
    const value = facts.get(benefitKey(row.stockCode, row.description));
    if (value === undefined) throw new Error("公開条件群の計画がありません");
    return { ...row, publicFacts: value };
  });
  const chunks: typeof expected[] = [];
  let chunk: typeof expected = [];
  for (const row of expected) {
    if (Buffer.byteLength(JSON.stringify(row)) > 1_000_000) throw new Error(`優待行${row.id}の束縛JSONが大きすぎます`);
    if (chunk.length > 0 && Buffer.byteLength(JSON.stringify([...chunk, row])) > 64_000) {
      chunks.push(chunk); chunk = [];
    }
    chunk.push(row);
  }
  if (chunk.length > 0) chunks.push(chunk);
  const columns = { stock_id: "stockId", genre_id: "genreId", description: "description", short_summary: "shortSummary",
    min_shares: "minShares", record_month: "recordMonth", record_date: "recordDate", estimated_value: "estimatedValue",
    estimate_value_source: "estimateValueSource", created_at: "createdAt", updated_at: "updatedAt" };
  const countGuard: D1BatchStatement = {
    sql: "SELECT json(CASE WHEN (SELECT count(*) FROM yutai_benefits b JOIN core_stocks s ON s.id=b.stock_id WHERE s.is_active=1 AND s.instrument_type='equity') = ? THEN 'null' ELSE '' END)", params: [rows.length],
  };
  const statements: D1BatchStatement[] = [countGuard];
  for (const part of chunks) {
    statements.push({
      sql: "WITH exp AS (SELECT value AS j FROM json_each(?)) UPDATE yutai_benefits AS b SET public_facts=json_extract(exp.j,'$.publicFacts') FROM exp WHERE b.id=json_extract(exp.j,'$.id') AND " +
        Object.entries(columns).map(([column, key]) => `b.${column} IS json_extract(exp.j,'$.${key}')`).join(" AND ") +
        " AND b.public_facts IS NULL AND EXISTS (SELECT 1 FROM core_stocks s WHERE s.id=b.stock_id AND s.code IS json_extract(exp.j,'$.stockCode') AND s.is_active=1 AND s.instrument_type='equity')",
      params: [JSON.stringify(part)],
    }, { sql: "SELECT json(CASE WHEN changes() = ? THEN 'null' ELSE '' END)", params: [part.length] });
  }
  if (statements.length > 900) throw new Error("1送信の安全上限を超えるため、計画だけで停止します");
  return { expected, statements, groups: groups.size };
}

const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
const save = (dir: string, name: string, value: unknown) => writeFileSync(join(dir, name), json(value), { mode: 0o600, flag: "wx" });

/** 1回だけ送信し、成功応答後も全行の全列を照合する。unknownは再送しない。 */
export async function applyPublicFactsBackfillOnce(input: {
  dir: string; expected: PublicFactsPreimage[]; statements: D1BatchStatement[];
  sender: AtomicBatchSender; readback: () => Promise<PublicFactsPreimage[]>;
}) {
  save(input.dir, "apply-started.json", { at: new Date().toISOString(), statements: input.statements.length });
  await input.sender(input.statements);
  const actual = await input.readback();
  save(input.dir, "readback.json", actual);
  assertPublicFactsRowsMatch(input.expected, actual);
  save(input.dir, "applied.json", { at: new Date().toISOString(), rows: actual.length });
}

async function main() {
  const [mode, sourceArg, dirArg, ...extra] = process.argv.slice(2);
  if ((mode !== "prepare" && mode !== "apply") || !sourceArg || !dirArg || extra.length > 0) {
    throw new Error("使い方: backfill-public-facts.ts prepare|apply <source-snapshot.json> <private-output-dir>");
  }
  const sourcePath = resolve(sourceArg), dir = resolve(dirArg);
  assertNotCommittable(sourcePath); assertNotCommittable(join(dir, "preimage.json"));
  const sourceText = readFileSync(sourcePath, "utf8");
  const source = SourceSnapshot.parse(JSON.parse(sourceText));
  if (mode === "prepare") {
    const preimage = await loadPublicFactsPreimage(false);
    const plan = planPublicFactsBackfill(source.rows, preimage);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "source.json"), sourceText, { mode: 0o600, flag: "wx" }); save(dir, "preimage.json", preimage);
    save(dir, "expected.json", plan.expected); save(dir, "sql-plan.json", plan.statements);
    save(dir, "manifest.json", { preparedAt: new Date().toISOString(), sourceSha256: digest(sourceText),
      preimageSha256: digest(json(preimage)), expectedSha256: digest(json(plan.expected)), planSha256: digest(json(plan.statements)),
      rows: preimage.length, groups: plan.groups, statements: plan.statements.length,
      requestBytes: Buffer.byteLength(JSON.stringify({ batch: plan.statements })), publicFactsColumn: "absent-before-migration" });
    console.info(`優待条件PRE/期待/SQL計画を保存: ${preimage.length}行/${plan.groups}群/${plan.statements.length}SQL（D1書込0）`);
    return;
  }
  const manifest = z.strictObject({ preparedAt: z.iso.datetime(), sourceSha256: z.string(), preimageSha256: z.string(),
    expectedSha256: z.string(), planSha256: z.string(), rows: positiveInt(), groups: positiveInt(), statements: positiveInt(),
    requestBytes: positiveInt(), publicFactsColumn: z.literal("absent-before-migration") }).parse(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")));
  if (manifest.sourceSha256 !== digest(sourceText)) throw new Error("計画時sourceのSHAが一致しません");
  const preText = readFileSync(join(dir, "preimage.json"), "utf8");
  const plan = planPublicFactsBackfill(source.rows, z.array(CompleteRow).parse(JSON.parse(preText)));
  if (digest(preText) !== manifest.preimageSha256 || digest(json(plan.expected)) !== manifest.expectedSha256 || digest(json(plan.statements)) !== manifest.planSha256 ||
      readFileSync(join(dir, "expected.json"), "utf8") !== json(plan.expected) || readFileSync(join(dir, "sql-plan.json"), "utf8") !== json(plan.statements)) throw new Error("優待条件計画のSHA/内容が一致しません");
  const bytes = Uint8Array.from(gzipSync(json({ source, preimage: JSON.parse(preText) })));
  const files = [{ filename: `yutai-public-facts-pre-${manifest.preimageSha256}.json.gz`, bytes, contentType: "application/gzip" }];
  const archived = await recordPrimaryData({ service: "otakara-yutai", key: `yutai-public-facts-pre-${manifest.preimageSha256}`,
    source: "D1 yutai_benefits complete preimage before public_facts-only backfill", fetchedAt: manifest.preparedAt,
    metadata: { rows: manifest.rows, preimageSha256: manifest.preimageSha256 }, files });
  if (archived.fileTooLarge || archived.manifestMatch === "unknown") throw new Error("優待PREの物理保管が確定しません");
  await verifyArchivedAttachments(archived.pageId, files, "優待条件PRE");
  save(dir, "archive-receipt.json", archived);
  await applyPublicFactsBackfillOnce({ dir, expected: plan.expected, statements: plan.statements,
    sender: createD1HttpBatchSender(), readback: () => loadPublicFactsPreimage(true) });
  console.info(`優待条件${manifest.rows}行の全列readback一致（送信1回）`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error("優待条件の保全・計画・適用・全列照合のいずれかで停止。原文はprivate証跡を確認し、自動再送しないでください。"); process.exitCode = 1; });
}
