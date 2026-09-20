/**
 * 定性セクション (事業の内容・リスク等) バックフィル (Node → D1 HTTP 書込)。
 *
 * 受注・海外売上は既に取込済み (yuho_documents + *_facts) なので、本スクリプトは
 * **定性セクションだけを追加**する: text_parse_status が NULL の有報 (= 未処理) を
 * 対象に type=5(CSV) を取得 → extractTextSections で抽出 → yuho_documents の
 * text_parse_status 列を更新 + yuho_text_sections へ冪等 upsert する。
 * 受注・海外の列・ファクトには一切触れない。日次キャッチアップ (ingestDocument)
 * は 3 系統を同時に書くので、本スクリプトは「統合前に取り込んだ既存有報」の
 * 定性埋め戻し用。CSV のみで XBRL は落とさない (軽量)。
 *
 * D1 は本来バインディング経由だが、本処理は Node 専用 (大量の EDINET 取得 +
 * ローカルパース) のため createD1HttpDb (sqlite-proxy / D1 REST) で書く。
 * sqlite-proxy は db.batch 非対応なので per-statement の冪等 update/insert で書く。
 *
 * 冪等・再開可能: text_parse_status が埋まった有報は (force 無しなら) 対象外。
 *
 * 必要env(.env): EDINET_API_KEY, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID,
 *               D1_DATABASE_ID。
 *
 * 実行: D1_DATABASE_ID=<id> pnpm yuho:backfill:text [--limit=N] [--offset=N] [--force]
 */
import "dotenv/config";
import { eq, isNull } from "drizzle-orm";
import { createD1HttpDb } from "../../../src/shared/db/d1-http-client.js";
import {
  downloadDocument,
  EdinetNotFoundError,
} from "../src/services/edinet/client.js";
import { parseEdinetCsvZip } from "../src/services/edinet/csv.js";
import { extractTextSections } from "../src/services/edinet/text-sections.js";
import * as yuhoSchema from "../src/db/schema.js";

const arg = (n: string) =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const force = process.argv.includes("--force");
const limit = arg("limit") ? Number(arg("limit")) : Infinity;
const offset = arg("offset") ? Number(arg("offset")) : 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const db = createD1HttpDb(yuhoSchema);
const { yuhoDocuments, textSections } = yuhoSchema;

const all = await db
  .select({
    id: yuhoDocuments.id,
    stockId: yuhoDocuments.stockId,
    docId: yuhoDocuments.docId,
    periodEnd: yuhoDocuments.periodEnd,
    filerName: yuhoDocuments.filerName,
    textParseStatus: yuhoDocuments.textParseStatus,
  })
  .from(yuhoDocuments)
  .where(force ? undefined : isNull(yuhoDocuments.textParseStatus));

const targets = all.slice(offset, offset + (limit === Infinity ? all.length : limit));
console.info(
  `[text-backfill] 定性未処理=${all.length} 今回=${targets.length} force=${force}`
);

const tally: Record<string, number> = {};
let n = 0;
for (const r of targets) {
  let status: string;
  let sections: ReturnType<typeof extractTextSections> = [];
  try {
    const zip = await downloadDocument(r.docId, 5);
    const rows = parseEdinetCsvZip(zip);
    sections = extractTextSections(rows);
    status = sections.length > 0 ? "ok" : "no_text_sections";
  } catch (e) {
    if (e instanceof EdinetNotFoundError) {
      status = "parse_error"; // type=5 未提供 → 抽出不能を正直に記録
    } else {
      status = "parse_error";
      console.warn(`[text-backfill] ${r.docId} ${r.filerName}: ${(e as Error).message}`);
    }
  }
  tally[status] = (tally[status] ?? 0) + 1;

  // text 列を更新 (受注・海外の列・ファクトには触れない)
  await db
    .update(yuhoDocuments)
    .set({ textParseStatus: status })
    .where(eq(yuhoDocuments.id, r.id));

  // 定性セクションを置換 (delete → insert)。sqlite-proxy は batch 非対応なので逐次。
  await db.delete(textSections).where(eq(textSections.documentId, r.id));
  if (sections.length > 0) {
    await db.insert(textSections).values(
      sections.map((s) => ({
        documentId: r.id,
        stockId: r.stockId,
        fiscalYearEnd: r.periodEnd,
        sectionKey: s.sectionKey,
        text: s.text,
        elementId: s.elementId,
        itemName: s.itemName,
        contextId: s.contextId,
        charCount: s.charCount,
      }))
    );
  }

  n++;
  if (n % 50 === 0) {
    console.info(
      `[text-backfill] ${n}/${targets.length} ` +
        Object.entries(tally).map(([k, v]) => `${k}=${v}`).join(" ")
    );
  }
  await sleep(150);
}

console.info("\n[text-backfill] 完了:");
for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
  console.info(`  ${k}: ${v}`);
}
