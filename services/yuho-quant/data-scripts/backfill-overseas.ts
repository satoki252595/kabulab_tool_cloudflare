/**
 * 海外売上高 バックフィル (Node → D1 HTTP 書込)。
 *
 * 受注は既に取込済み (yuho_documents + yuho_order_facts) なので、本スクリプトは
 * **海外売上だけを追加**する: overseas_parse_status が NULL の有報 (= 海外未処理) を
 * 対象に type=1(XBRL) を取得 → parseOverseasData で構造化 → yuho_documents の
 * overseas_* 列を更新 + yuho_overseas_facts へ冪等 upsert する。受注ファクトには
 * 一切触れない。日次キャッチアップ (ingestDocument) は受注と海外を同時に書くので、
 * 本スクリプトは「統合前に受注のみ取り込んだ既存有報」の海外埋め戻し用。
 *
 * D1 は本来バインディング経由だが、本処理は Node 専用 (大量の EDINET 取得 +
 * ローカルパース) のため createD1HttpDb (sqlite-proxy / D1 REST) で書く。
 * sqlite-proxy は db.batch 非対応なので per-statement の冪等 update/insert で書く。
 *
 * 冪等・再開可能: overseas_parse_status が埋まった有報は (force 無しなら) 対象外。
 *
 * 必要env(.env): EDINET_API_KEY, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID,
 *               D1_DATABASE_ID。
 *
 * 実行: D1_DATABASE_ID=<id> pnpm backfill:overseas [--limit=N] [--offset=N] [--force]
 */
import "dotenv/config";
import { eq, isNull } from "drizzle-orm";
import { createD1HttpDb } from "../../../src/shared/db/d1-http-client.js";
import {
  downloadDocument,
  EdinetNotFoundError,
} from "../src/services/edinet/client.js";
import { parseOverseasData } from "../src/services/overseas-parser.js";
import * as yuhoSchema from "../src/db/schema.js";

const arg = (n: string) =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const force = process.argv.includes("--force");
const limit = arg("limit") ? Number(arg("limit")) : Infinity;
const offset = arg("offset") ? Number(arg("offset")) : 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function toYen(raw: number | null, factor: number): number | null {
  return raw === null ? null : Math.round(raw * factor);
}
function chunk<T>(a: T[], s: number): T[][] {
  const o: T[][] = [];
  for (let i = 0; i < a.length; i += s) o.push(a.slice(i, i + s));
  return o;
}

const db = createD1HttpDb(yuhoSchema);
const { yuhoDocuments, overseasSalesFacts } = yuhoSchema;

const all = await db
  .select({
    id: yuhoDocuments.id,
    stockId: yuhoDocuments.stockId,
    docId: yuhoDocuments.docId,
    periodEnd: yuhoDocuments.periodEnd,
    filerName: yuhoDocuments.filerName,
    overseasParseStatus: yuhoDocuments.overseasParseStatus,
  })
  .from(yuhoDocuments)
  .where(force ? undefined : isNull(yuhoDocuments.overseasParseStatus));

const targets = all.slice(offset, offset + (limit === Infinity ? all.length : limit));
console.info(
  `[oseas-backfill] 海外未処理=${all.length} 今回=${targets.length} force=${force}`
);

const tally: Record<string, number> = {};
let n = 0;
for (const r of targets) {
  let status = "no_xbrl";
  let honbunFile: string | null = null;
  let facts: ReturnType<typeof parseOverseasData>["facts"] = [];
  try {
    const zip = await downloadDocument(r.docId, 1);
    const ex = parseOverseasData(zip, r.periodEnd);
    status = ex.status;
    honbunFile = ex.honbunFile;
    facts = ex.facts;
  } catch (e) {
    if (e instanceof EdinetNotFoundError) {
      status = "parse_error"; // type=1 未提供 → 構造化不能を正直に記録
    } else {
      status = "parse_error";
      console.warn(`[oseas-backfill] ${r.docId} ${r.filerName}: ${(e as Error).message}`);
    }
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

  // overseas 列を更新 (受注列・受注ファクトには触れない)
  await db
    .update(yuhoDocuments)
    .set({ overseasParseStatus: status, overseasHonbunFile: honbunFile })
    .where(eq(yuhoDocuments.id, r.id));

  // 海外ファクトを置換 (delete → insert)。sqlite-proxy は batch 非対応なので逐次。
  await db
    .delete(overseasSalesFacts)
    .where(eq(overseasSalesFacts.documentId, r.id));
  const rows = deduped.map((f) => ({
    documentId: r.id,
    stockId: r.stockId,
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
    await db.insert(overseasSalesFacts).values(part);
  }

  n++;
  if (n % 50 === 0) {
    console.info(
      `[oseas-backfill] ${n}/${targets.length} ` +
        Object.entries(tally).map(([k, v]) => `${k}=${v}`).join(" ")
    );
  }
  await sleep(150);
}

console.info("\n[oseas-backfill] 完了:");
for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
  console.info(`  ${k}: ${v}`);
}
