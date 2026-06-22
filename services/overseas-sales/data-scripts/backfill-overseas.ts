/**
 * 海外売上高 バックフィル (Node → D1 HTTP 書込)。
 *
 * 005 yuho-quant が既に発見・記録した有報 (yuho_documents, 最大5年×全銘柄) を
 * コーパスとして、各有報の type=1(XBRL) を取得 → 海外売上を構造化 →
 * oseas_documents / oseas_sales_facts へ冪等 upsert する。trend 表示には複数年が
 * 要るため latest だけでなく **全有報** を対象にする。
 *
 * D1 は Worker バインディング経由が原則だが、本処理は Node 専用 (大量の EDINET
 * 取得 + ローカルパース) のため createD1HttpDb (sqlite-proxy / D1 REST) で書く。
 * sqlite-proxy は db.batch 非対応なので **冪等 upsert + per-row** で書く。
 *
 * 冪等・再開可能: 既に oseas_documents に在る docId は (force 無しなら) スキップ。
 * XBRL 本文は tmp/oseas-cache に共有キャッシュ (audit と再利用)。
 *
 * 必要env(.env): EDINET_API_KEY, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID,
 *               D1_DATABASE_ID。
 *
 * 実行: D1_DATABASE_ID=<id> pnpm exec tsx services/overseas-sales/data-scripts/backfill-overseas.ts [--limit=N] [--offset=N] [--force]
 */
import "dotenv/config";
import { eq } from "drizzle-orm";
import { sharedEnv } from "../../../src/shared/env.js";
import { createD1HttpDb } from "../../../src/shared/db/d1-http-client.js";
import {
  downloadDocument,
  EdinetNotFoundError,
} from "../../yuho-quant/src/services/edinet/client.js";
import { parseOverseasData } from "../src/services/overseas-parser.js";
import * as oseasSchema from "../src/db/schema.js";

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const force = process.argv.includes("--force");
const limit = arg("limit") ? Number(arg("limit")) : Infinity;
const offset = arg("offset") ? Number(arg("offset")) : 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function d1Query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  const acct = sharedEnv.CLOUDFLARE_ACCOUNT_ID();
  const tok = sharedEnv.CLOUDFLARE_API_TOKEN();
  const db = sharedEnv.D1_DATABASE_ID();
  const url = `https://api.cloudflare.com/client/v4/accounts/${acct}/d1/database/${db}/query`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}` },
    body: JSON.stringify({ sql }),
  });
  if (!res.ok) throw new Error(`D1 HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { success: boolean; result?: Array<{ results?: T[] }>; errors?: unknown };
  if (!j.success) throw new Error(`D1 error: ${JSON.stringify(j.errors)}`);
  return j.result?.[0]?.results ?? [];
}

function toYen(raw: number | null, factor: number): number | null {
  return raw === null ? null : Math.round(raw * factor);
}
function chunk<T>(a: T[], s: number): T[][] {
  const o: T[][] = [];
  for (let i = 0; i < a.length; i += s) o.push(a.slice(i, i + s));
  return o;
}

async function getXbrlZip(docId: string): Promise<Buffer | null> {
  // 本文 HTML キャッシュからは ZIP を復元できないため、ZIP は都度取得する
  // (キャッシュは audit の HTML 用)。type=1 未提供は null。
  try {
    return await downloadDocument(docId, 1);
  } catch (e) {
    if (e instanceof EdinetNotFoundError) return null;
    throw e;
  }
}

const db = createD1HttpDb(oseasSchema);

interface DocRow {
  stock_id: number;
  edinet_code: string;
  doc_id: string;
  doc_type_code: string;
  filer_name: string;
  period_start: string | null;
  period_end: string;
  submitted_at: number;
}

const corpus = await d1Query<DocRow>(`
  select stock_id, edinet_code, doc_id, doc_type_code, filer_name,
         period_start, period_end, submitted_at
  from yuho_documents
  order by stock_id, submitted_at desc`);

// 既取込 docId (force 無しならスキップ)
const existing = new Set<string>(
  force ? [] : (await d1Query<{ doc_id: string }>(`select doc_id from oseas_documents`)).map((r) => r.doc_id)
);

const targets = corpus.filter((r) => force || !existing.has(r.doc_id)).slice(offset, offset + (limit === Infinity ? corpus.length : limit));
console.info(`[oseas-backfill] corpus=${corpus.length} 既取込=${existing.size} 今回=${targets.length} force=${force}`);

const tally: Record<string, number> = {};
let n = 0;
for (const r of targets) {
  let status = "skipped";
  let facts: ReturnType<typeof parseOverseasData>["facts"] = [];
  let honbunFile: string | null = null;
  try {
    const zip = await getXbrlZip(r.doc_id);
    if (!zip) {
      status = "no_xbrl";
    } else {
      const ex = parseOverseasData(zip, r.period_end);
      status = ex.status;
      honbunFile = ex.honbunFile;
      facts = ex.facts;
    }
  } catch (e) {
    status = "parse_error";
    console.warn(`[oseas-backfill] ${r.doc_id} ${r.filer_name}: ${(e as Error).message}`);
  }
  tally[status] = (tally[status] ?? 0) + 1;

  // dedup (会計期末, 地域名)
  const seen = new Set<string>();
  const deduped = facts.filter((f) => {
    const k = `${f.fiscalYearEnd} ${f.regionName}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const [docRow] = await db
    .insert(oseasSchema.overseasDocuments)
    .values({
      stockId: r.stock_id,
      edinetCode: r.edinet_code,
      docId: r.doc_id,
      docTypeCode: r.doc_type_code,
      filerName: r.filer_name,
      periodStart: r.period_start,
      periodEnd: r.period_end,
      submittedAt: new Date(r.submitted_at * 1000),
      parseStatus: status,
      honbunFile,
    })
    .onConflictDoUpdate({
      target: oseasSchema.overseasDocuments.docId,
      set: { parseStatus: status, honbunFile },
    })
    .returning({ id: oseasSchema.overseasDocuments.id });

  await db.delete(oseasSchema.overseasSalesFacts).where(eq(oseasSchema.overseasSalesFacts.documentId, docRow.id));
  const rows = deduped.map((f) => ({
    documentId: docRow.id,
    stockId: r.stock_id,
    fiscalYearEnd: f.fiscalYearEnd,
    regionName: f.regionName,
    regionKind: f.regionKind,
    isConsolidated: f.isConsolidated,
    unitLabel: f.unitLabel,
    salesRaw: f.salesAmount,
    salesYen: toYen(f.salesAmount, f.unitYenFactor),
    ratioPct: f.ratioPct,
    pattern: status.startsWith("ok_") ? status.replace("ok_", "") : "none",
  }));
  for (const part of chunk(rows, 8)) {
    await db.insert(oseasSchema.overseasSalesFacts).values(part);
  }

  n++;
  if (n % 50 === 0) console.info(`[oseas-backfill] ${n}/${targets.length} ` + Object.entries(tally).map(([k, v]) => `${k}=${v}`).join(" "));
  await sleep(150);
}

console.info("\n[oseas-backfill] 完了:");
for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.info(`  ${k}: ${v}`);
