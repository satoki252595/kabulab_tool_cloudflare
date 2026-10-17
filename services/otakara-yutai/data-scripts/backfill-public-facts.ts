/** 優待条件だけの保守取込。prepareは読取のみ、applyは物理PRE保全後の1送信だけ。 */
import "dotenv/config";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
import { syncParent } from "../../../scripts/biztag-local/clef-journal.js";
import { gzipSync } from "node:zlib";
import { z } from "../../../src/shared/zod-mini.js";
import { activeEquityCondition } from "../../../src/shared/db/active-equity.js";
import { createD1HttpBatchSender, type D1BatchStatement } from "../../../src/shared/db/d1-http-client.js";
import { recordPrimaryData, verifyArchivedAttachments } from "../../../src/shared/notion-archive/index.js";
import { stocks, yutaiBenefits } from "../src/db/schema.js";
import { parsePublicBenefitFacts } from "../src/public-facts.js";
import { assertBenefitSchedule } from "../src/record-date.js";
import { openOtakaraD1 } from "./benefit-rows.js";
import { benefitKey } from "./benefit-key.js";
import { buildPublicBenefitFacts } from "./public-facts.js";
import { assertNotCommittable } from "./private-path.js";
import { recipientContexts, type BenefitRow } from "./summary-tasks.js";
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
export async function loadPublicFactsPreimage(migrated: boolean, codes?: readonly string[]): Promise<PublicFactsPreimage[]> {
  const query = openOtakaraD1().select({
    id: yutaiBenefits.id, stockId: yutaiBenefits.stockId, stockCode: stocks.code, stockName: stocks.name,
    description: yutaiBenefits.description, shortSummary: yutaiBenefits.shortSummary,
    estimatedValue: yutaiBenefits.estimatedValue, estimateValueSource: yutaiBenefits.estimateValueSource,
    minShares: yutaiBenefits.minShares, recordMonth: yutaiBenefits.recordMonth, recordDate: yutaiBenefits.recordDate,
    updatedAt: sql<number>`${yutaiBenefits.updatedAt}`, genreId: yutaiBenefits.genreId,
    createdAt: sql<number>`${yutaiBenefits.createdAt}`,
    publicFacts: migrated ? sql<string | null>`${yutaiBenefits.publicFacts}` : sql<null>`NULL`,
  }).from(yutaiBenefits).innerJoin(stocks, eq(stocks.id, yutaiBenefits.stockId))
    .where(codes === undefined ? activeEquityCondition() : and(activeEquityCondition(), inArray(stocks.code, [...codes]))).orderBy(yutaiBenefits.id);
  const rows = await (codes === undefined ? query : query.limit(101));
  if (codes !== undefined && rows.length > 100) throw new Error("v1更新のscoped PREは100行までです");
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

const UpgradeScope = z.strictObject({
  version: z.literal(1),
  groups: z.array(z.strictObject({
    code: z.string().check(z.regex(/^[0-9]{3}[0-9A-Z]$/)),
    taskId: z.string().check(z.regex(/^[0-9a-f]{16}$/)),
    sourceSha256: z.string().check(z.regex(/^[0-9a-f]{64}$/)),
    rows: positiveInt(),
    recipients: z.array(z.strictObject({ minShares: positiveInt(), recordMonth: z.number().check(z.int()), recordDate: z.nullable(z.string()) })).check(z.minLength(1)),
  })).check(z.minLength(1), z.maxLength(15)),
});
export type PublicFactsUpgradeScope = z.infer<typeof UpgradeScope>;

/** 明示した最大15群/19行/3銘柄だけを扱う。空・部分recipient・重複scopeを認めない。 */
export function parsePublicFactsUpgradeScope(value: unknown): PublicFactsUpgradeScope {
  const scope = UpgradeScope.parse(value);
  const codes = new Set(scope.groups.map(row => row.code));
  if (codes.size > 3 || scope.groups.reduce((n, row) => n + row.rows, 0) > 19 ||
      new Set(scope.groups.map(row => row.taskId)).size !== scope.groups.length) throw new Error("v1条件更新の有限scopeが不正です");
  for (const row of scope.groups) {
    if (row.rows !== row.recipients.length || !isDeepStrictEqual(recipientContexts(row.recipients), row.recipients)) throw new Error("v1条件更新scopeの全受取条件が不正です");
  }
  return scope;
}

/** 既存v1の全値と原文を再資格化し、version/構造以外を変えない純計画。 */
export function planPublicFactsV1Upgrade(source: readonly BenefitRow[], preimage: readonly PublicFactsPreimage[], inputScope: PublicFactsUpgradeScope) {
  const scope = parsePublicFactsUpgradeScope(inputScope), rows = z.array(CompleteRow).parse(preimage);
  const codes = [...new Set(scope.groups.map(row => row.code))].sort();
  if (rows.length === 0 || rows.length > 100 || new Set(rows.map(row => row.id)).size !== rows.length || rows.some(row => !codes.includes(row.stockCode))) throw new Error("v1更新の全列PREが空・重複・範囲外です");
  assertPublicFactsRowsMatch(z.array(SourceRow).parse(source), rows);
  for (const row of rows) assertBenefitSchedule(row);
  const expected = rows.map(row => ({ ...row })), targets: PublicFactsPreimage[] = [];
  for (const group of scope.groups) {
    const members = rows.filter(row => row.stockCode === group.code && benefitKey(row.stockCode, row.description) === group.taskId);
    if (members.length !== group.rows || !isDeepStrictEqual(recipientContexts(members), group.recipients) ||
        members.some(row => digest(row.description) !== group.sourceSha256)) throw new Error("明示した原文群・全文SHA・全受取条件が現在値と一致しません");
    for (const row of members) {
      const old = parsePublicBenefitFacts(row.publicFacts, row.stockCode);
      if (old === null || old.version !== 1) throw new Error("明示更新は既存v1限定です。NULL/既更新/未知は再送しません");
      const next = buildPublicBenefitFacts({ code: row.stockCode, description: row.description,
        context: { minShares: members.map(v => v.minShares), recordMonths: members.map(v => v.recordMonth) },
        fetchedAt: old.source.fetchedAt, batchFetchedAt: old.source.batchFetchedAt,
        ...(old.source.officialStatus === "verified" ? { official: { url: old.source.officialUrl!, verifiedAt: old.source.verifiedAt! } } : {}) });
      if (next.version !== 2 || next.conditionStructure.status !== "literal_parsed") throw new Error("原文の全文選択構造を資格化できません");
      const { conditionStructure, ...fields } = next;
      if (!isDeepStrictEqual({ ...fields, version: 1 }, old) || conditionStructure.sourceSha256 !== group.sourceSha256) throw new Error("既存v1の値・根拠・時計が現在の共通判定と一致しません");
      const updated = expected.find(v => v.id === row.id);
      if (updated === undefined) throw new Error("v1更新の全列PREがありません");
      updated.publicFacts = JSON.stringify({ ...old, version: 2, conditionStructure }); targets.push(updated);
    }
  }
  const columns = { stock_id: "stockId", genre_id: "genreId", description: "description", short_summary: "shortSummary",
    min_shares: "minShares", record_month: "recordMonth", record_date: "recordDate", estimated_value: "estimatedValue",
    estimate_value_source: "estimateValueSource", created_at: "createdAt", updated_at: "updatedAt", public_facts: "publicFacts" };
  const preBytes = JSON.stringify(rows), targetBytes = JSON.stringify(targets.map(row => ({ ...row, priorPublicFacts: rows.find(v => v.id === row.id)!.publicFacts })));
  if (Buffer.byteLength(preBytes) > 64_000 || Buffer.byteLength(targetBytes) > 64_000) throw new Error("v1条件更新の束縛JSONが有限上限を超えています");
  const completeMismatch = Object.entries(columns).map(([column, key]) => `b.${column} IS NOT json_extract(exp.j,'$.${key}')`).join(" OR ");
  const statements: D1BatchStatement[] = [{
    sql: "WITH exp AS (SELECT value AS j FROM json_each(?)) SELECT json(CASE WHEN (SELECT count(*) FROM yutai_benefits b JOIN core_stocks s ON s.id=b.stock_id WHERE s.is_active=1 AND s.instrument_type='equity' AND s.code IN (" + codes.map(() => "?").join(",") + ")) = ? AND NOT EXISTS (SELECT 1 FROM exp LEFT JOIN yutai_benefits b ON b.id=json_extract(exp.j,'$.id') LEFT JOIN core_stocks s ON s.id=b.stock_id WHERE b.id IS NULL OR " + completeMismatch + " OR s.code IS NOT json_extract(exp.j,'$.stockCode') OR s.name IS NOT json_extract(exp.j,'$.stockName') OR s.is_active IS NOT 1 OR s.instrument_type IS NOT 'equity') THEN 'null' ELSE '' END)",
    params: [preBytes, ...codes, rows.length],
  }, {
    sql: "WITH exp AS (SELECT value AS j FROM json_each(?)) UPDATE yutai_benefits AS b SET public_facts=json_extract(exp.j,'$.publicFacts') FROM exp WHERE b.id=json_extract(exp.j,'$.id') AND " +
      Object.entries(columns).filter(([column]) => column !== "public_facts").map(([column, key]) => `b.${column} IS json_extract(exp.j,'$.${key}')`).join(" AND ") +
      " AND b.public_facts IS json_extract(exp.j,'$.priorPublicFacts') AND EXISTS (SELECT 1 FROM core_stocks s WHERE s.id=b.stock_id AND s.code IS json_extract(exp.j,'$.stockCode') AND s.is_active=1 AND s.instrument_type='equity')",
    params: [targetBytes],
  }, { sql: "SELECT json(CASE WHEN changes() = ? THEN 'null' ELSE '' END)", params: [targets.length] }];
  return { expected, statements, groups: scope.groups.length, targetRows: targets.length, codes };
}

/** canonical .env配下の一度だけの移行latch。新output/別PREでも未閉鎖送信を迂回しない。 */
export function assertPublicFactsUpgradeReady(state: string): void {
  if (existsSync(state)) {
    const st = lstatSync(state);
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0) throw new Error("v1更新stateは所有者限定の実体directoryが必要です");
    if (readdirSync(state).length !== 0) throw new Error("v1更新は開始済みです。完了/結果不明の保存物を保持し、自動再送しません");
  }
}
export function claimPublicFactsUpgrade(state: string, value: unknown): void {
  assertPublicFactsUpgradeReady(state);
  if (!existsSync(state)) mkdirSync(state, { mode: 0o700 });
  assertPublicFactsUpgradeReady(state);
  syncParent(state);
  const path = join(state, "upgrade-v1-started.json"); writeFileSync(path, json(value), { mode: 0o600, flag: "wx", flush: true }); syncParent(path);
}

const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
const save = (dir: string, name: string, value: unknown) => writeFileSync(join(dir, name), json(value), { mode: 0o600, flag: "wx" });

/** 1回だけ送信し、成功応答後も全行の全列を照合する。unknownは再送しない。 */
export async function applyPublicFactsBackfillOnce(input: {
  dir: string; expected: PublicFactsPreimage[]; statements: D1BatchStatement[];
  sender: AtomicBatchSender; readback: () => Promise<PublicFactsPreimage[]>;
  verifyPost?: (rows: PublicFactsPreimage[]) => Promise<void>;
}) {
  save(input.dir, "apply-started.json", { at: new Date().toISOString(), statements: input.statements.length });
  await input.sender(input.statements);
  const actual = await input.readback();
  save(input.dir, "readback.json", actual);
  assertPublicFactsRowsMatch(input.expected, actual);
  if (input.verifyPost) await input.verifyPost(actual);
  save(input.dir, "applied.json", { at: new Date().toISOString(), rows: actual.length });
}

/** 有限upgradeの通常prepare/apply。旧NULL移行を装わず、全列PRE/POSTを物理保全する。 */
async function upgradeV1Main(mode: string, sourcePath: string, dir: string, scopePath: string) {
  const state = join(dirname(realpathSync(".env")), "tmp/yutai-public-facts-v1-upgrade");
  assertPublicFactsUpgradeReady(state);
  assertNotCommittable(sourcePath); assertNotCommittable(scopePath); assertNotCommittable(join(dir, "preimage.json"));
  const sourceText = readFileSync(sourcePath, "utf8"), scopeText = readFileSync(scopePath, "utf8");
  const source = SourceSnapshot.parse(JSON.parse(sourceText)), scope = parsePublicFactsUpgradeScope(JSON.parse(scopeText));
  const codes = [...new Set(scope.groups.map(v => v.code))].sort();
  if (mode === "prepare-upgrade-v1") {
    const preimage = await loadPublicFactsPreimage(true, codes), plan = planPublicFactsV1Upgrade(source.rows, preimage, scope);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "source.json"), sourceText, { mode: 0o600, flag: "wx" });
    writeFileSync(join(dir, "scope.json"), scopeText, { mode: 0o600, flag: "wx" });
    save(dir, "preimage.json", preimage); save(dir, "expected.json", plan.expected); save(dir, "sql-plan.json", plan.statements);
    save(dir, "upgrade-manifest.json", { version: 1, preparedAt: new Date().toISOString(), sourceSha256: digest(sourceText), scopeSha256: digest(scopeText),
      preimageSha256: digest(json(preimage)), expectedSha256: digest(json(plan.expected)), planSha256: digest(json(plan.statements)),
      rows: preimage.length, targetRows: plan.targetRows, groups: plan.groups, codes });
    console.info(`v1条件の有限計画を保存: ${plan.targetRows}行/${plan.groups}群（書込0）`); return;
  }
  const manifest = z.strictObject({ version: z.literal(1), preparedAt: z.iso.datetime(), sourceSha256: z.string(), scopeSha256: z.string(),
    preimageSha256: z.string(), expectedSha256: z.string(), planSha256: z.string(), rows: positiveInt(), targetRows: positiveInt(), groups: positiveInt(), codes: z.array(z.string()) }).parse(JSON.parse(readFileSync(join(dir, "upgrade-manifest.json"), "utf8")));
  const preText = readFileSync(join(dir, "preimage.json"), "utf8"), preimage = z.array(CompleteRow).parse(JSON.parse(preText));
  const plan = planPublicFactsV1Upgrade(source.rows, preimage, scope);
  if (digest(sourceText) !== manifest.sourceSha256 || digest(scopeText) !== manifest.scopeSha256 || digest(preText) !== manifest.preimageSha256 ||
      digest(json(plan.expected)) !== manifest.expectedSha256 || digest(json(plan.statements)) !== manifest.planSha256 ||
      readFileSync(join(dir, "source.json"), "utf8") !== sourceText || readFileSync(join(dir, "scope.json"), "utf8") !== scopeText ||
      readFileSync(join(dir, "expected.json"), "utf8") !== json(plan.expected) || readFileSync(join(dir, "sql-plan.json"), "utf8") !== json(plan.statements) ||
      manifest.rows !== preimage.length || manifest.targetRows !== plan.targetRows || manifest.groups !== plan.groups || !isDeepStrictEqual(manifest.codes, codes)) throw new Error("v1更新計画・元JSON・scopeのSHA/内容が不一致です");
  const archive = async (phase: "pre" | "post", rows: PublicFactsPreimage[]) => {
    const fetchedAt = phase === "pre" ? manifest.preparedAt : new Date().toISOString();
    const bytes = Uint8Array.from(gzipSync(json({ source, scope, rows, fetchedAt }))), payloadSha256 = digest(Buffer.from(bytes));
    const files = [{ filename: `yutai-v1-upgrade-${phase}-${payloadSha256}.json.gz`, bytes, contentType: "application/gzip" }];
    const receipt = await recordPrimaryData({ service: "otakara-yutai", key: `yutai-v1-upgrade-${phase}-${payloadSha256}`,
      source: `D1 complete scoped rows ${phase} explicit v1 choice-structure upgrade`, fetchedAt,
      metadata: { rows: rows.length, targetRows: plan.targetRows, groups: plan.groups, scopeSha256: manifest.scopeSha256, payloadSha256 }, files });
    if (receipt.fileTooLarge || receipt.manifestMatch === "unknown") throw new Error("v1更新の物理保管が未確定です");
    await verifyArchivedAttachments(receipt.pageId, files, `優待v1更新${phase}`); save(dir, `archive-${phase}-receipt.json`, receipt);
  };
  claimPublicFactsUpgrade(state, { at: new Date().toISOString(), dir, scopeSha256: manifest.scopeSha256, preimageSha256: manifest.preimageSha256, planSha256: manifest.planSha256 });
  await archive("pre", preimage);
  await applyPublicFactsBackfillOnce({ dir, expected: plan.expected, statements: plan.statements, sender: createD1HttpBatchSender(),
    readback: () => loadPublicFactsPreimage(true, codes), verifyPost: rows => archive("post", rows) });
  const path = join(state, "upgrade-v1-completed.json"); writeFileSync(path, json({ at: new Date().toISOString(), intentSha256: digest(readFileSync(join(state, "upgrade-v1-started.json"))),
    scopeSha256: manifest.scopeSha256, planSha256: manifest.planSha256, readbackSha256: digest(readFileSync(join(dir, "readback.json"))),
    postArchiveReceiptSha256: digest(readFileSync(join(dir, "archive-post-receipt.json"))) }), { mode: 0o600, flag: "wx", flush: true }); syncParent(path);
  console.info(`v1条件${plan.targetRows}行のversion/構造のみ更新し、全列・物理PRE/POST照合一致`);
}

async function main() {
  const [mode, sourceArg, dirArg, ...extra] = process.argv.slice(2);
  if (mode === "prepare-upgrade-v1" || mode === "apply-upgrade-v1") {
    if (!sourceArg || !dirArg || extra.length !== 1) throw new Error("使い方: backfill-public-facts.ts prepare-upgrade-v1|apply-upgrade-v1 <source-snapshot.json> <private-output-dir> <explicit-scope.json>");
    await upgradeV1Main(mode, resolve(sourceArg), resolve(dirArg), resolve(extra[0])); return;
  }
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
