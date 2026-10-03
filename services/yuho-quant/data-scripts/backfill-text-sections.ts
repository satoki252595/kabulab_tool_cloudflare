/**
 * 定性セクション (事業の内容・リスク等) バックフィル (Node → D1 HTTP 書込)。
 *
 * 受注・海外売上は既に取込済み (yuho_documents + *_facts) なので、本スクリプトは
 * **定性セクションだけを追加**する: text_parse_status が NULL の有報 (= 未処理) を
 * 対象に type=5(CSV) を取得 → extractTextSections で抽出 → yuho_documents の
 * text_parse_status 列を更新 + yuho_text_sections 索引へ冪等 upsert する
 * (本文は Notion のみ。P4) + 全文を Notion 保管し notion_doc_page_id を
 * 書き戻す。将来のギャップ修復 (ポインタ NULL) も本スクリプト --force で行う。
 * 受注・海外の列・ファクトには一切触れない。日次キャッチアップ (ingestDocument)
 * は 3 系統を同時に書くので、本スクリプトは「統合前に取り込んだ既存有報」の
 * 定性埋め戻し用。CSV のみで XBRL は落とさない (軽量)。
 *
 * D1 は本来バインディング経由だが、本処理は Node 専用 (大量の EDINET 取得 +
 * ローカルパース) のため createD1HttpDb (sqlite-proxy / D1 REST) で読む。
 * 書込は 1 文書ぶん (text status UPDATE + 索引 DELETE + INSERT 群) を
 * createD1HttpBatchSender の単一 batch で原子適用する。逐次だと UPDATE 後に
 * 落ちた場合「status だけ埋まって索引 0 件」の部分行が残り、次回選定から
 * 外れて永久欠損になる。per-statement フォールバックはしない。
 *
 * 冪等・再開可能: text_parse_status 未処理 (NULL) の有報に加え、parse 済み
 * (ok) なのに Notion 行ポインタが無い通も (force 無しで) 回収対象。
 *
 * 必要env(.env): EDINET_API_KEY, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID,
 *               D1_DATABASE_ID。
 *
 * 実行: D1_DATABASE_ID=<id> pnpm yuho:backfill:text [--limit=N] [--offset=N] [--force]
 *       P6 ギャップ修復: pnpm yuho:backfill:text -- --doc=S100XXXX,S100YYYY --force
 *       (--doc 指定時はその通だけを EDINET 再抽出+索引置換+Notion 再保管する。
 *       --force 無しの --doc は未処理 (NULL) の通だけに効く)
 */
import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import {
  createD1HttpBatchSender,
  createD1HttpDb,
  toD1BatchStatements,
} from "../../../src/shared/db/d1-http-client.js";
import {
  buildTextBackfillStatements,
  textBackfillWhere,
} from "./lib/text-backfill.js";
import { loadIngestCodeToId } from "../../../src/shared/db/active-equity.js";
import { archiveTallyFailed } from "../src/services/edinet/archive.js";
import {
  downloadDocument,
  EdinetNotFoundError,
  EdinetDocumentFetchError,
  EdinetDocumentArchiveError,
} from "../src/services/edinet/client.js";
import { parseEdinetCsvZip } from "../src/services/edinet/csv.js";
import { extractTextSections } from "../src/services/edinet/text-sections.js";
import { backupDocTextToNotion } from "../src/services/text-backup.js";
import type { Database } from "../src/db/client.js";
import * as yuhoSchema from "../src/db/schema.js";

const arg = (n: string) =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const force = process.argv.includes("--force");
const limit = arg("limit") ? Number(arg("limit")) : Infinity;
const offset = arg("offset") ? Number(arg("offset")) : 0;
/** P6 ギャップ修復用の通指定 (--doc=S100XXXX,S100YYYY)。未指定なら全件走査 */
const docFilter = arg("doc")
  ? arg("doc")!
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  : null;
if (arg("doc") !== undefined && (docFilter === null || docFilter.length === 0)) {
  console.error("usage: --doc=DOCID[,DOCID...] (空は不可)");
  process.exit(2);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const db = createD1HttpDb(yuhoSchema);
// D1 書込口の明示指定 (Node では必須)。sender は無状態なので run 全体で
// 1 個を使い回す。backfill.ts / backfill-overseas.ts と同一の窓口。
const d1HttpBatch = createD1HttpBatchSender();
const { yuhoDocuments } = yuhoSchema;
// stock_id → 証券コード (Notion 銘柄親ページのキー。無ければ当該通を飛ばす)
const idToCode = new Map(
  [...(await loadIngestCodeToId(db))].map(([code, id]) => [id, code] as const)
);

if (docFilter !== null) {
  const existRows = await db
    .select({ docId: yuhoDocuments.docId })
    .from(yuhoDocuments)
    .where(inArray(yuhoDocuments.docId, docFilter));
  const found = new Set(existRows.map((r) => r.docId));
  const unknown = docFilter.filter((d) => !found.has(d));
  if (unknown.length > 0) {
    console.error(`[text-backfill] D1に無い文書ID: ${unknown.join(",")}`);
    process.exit(2);
  }
}

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
  .where(textBackfillWhere(docFilter, force));

const targets = all.slice(offset, offset + (limit === Infinity ? all.length : limit));
console.info(
  `[text-backfill] 定性未処理=${all.length} 今回=${targets.length} force=${force}` +
    (docFilter !== null ? ` doc=${docFilter.join(",")}` : "")
);

const tally: Record<string, number> = {};
let n = 0;
for (const r of targets) {
  // 1 通の失敗で全体を落とさない (残りは次回実行で回収。再開可能)。
  try {
    let status: string;
    let sections: ReturnType<typeof extractTextSections> = [];
    try {
      const zip = await downloadDocument(r.docId, 5);
      const rows = parseEdinetCsvZip(zip);
      sections = extractTextSections(rows);
      status = sections.length > 0 ? "ok" : "no_text_sections";
    } catch (e) {
      if (e instanceof EdinetDocumentArchiveError ||
          (e instanceof EdinetDocumentFetchError && !(e instanceof EdinetNotFoundError))) throw e;
      if (e instanceof EdinetNotFoundError) {
        status = "parse_error"; // type=5 未提供 → 抽出不能を正直に記録
      } else {
        status = "parse_error";
        console.warn(`[text-backfill] ${r.docId} ${r.filerName}: ${(e as Error).message}`);
      }
    }
    tally[status] = (tally[status] ?? 0) + 1;

    // text 列の更新 (受注・海外の列・ファクトには触れない) + 定性セクション
    // 索引の置換 (delete → insert) を 1 文書ぶんの単一 batch で原子適用する。
    // 本文は Notion のみ (P4)。以下で backupDocTextToNotion が保管する。
    // 失敗は外の catch で tally.error に計上し非 0 終了する (握り潰さない)。
    // statement fallback なし。
    const statements = buildTextBackfillStatements(
      db as unknown as Database,
      r,
      status,
      sections
    );
    await d1HttpBatch(toD1BatchStatements(statements));

    // 定性テキスト本文の Notion 保管 (D1 には索引 + 行 ID のみ)。
    // 失敗は当該通の警告に留める (ポインタ NULL の通は P3 が回収)。
    if (sections.length > 0) {
      try {
        const stockCode = idToCode.get(r.stockId) ?? null;
        if (stockCode === null) {
          console.warn(`[text-backfill] notion text skip(コード不明) ${r.docId}`);
          tally.notion_text_no_code = (tally.notion_text_no_code ?? 0) + 1;
        } else {
          const nb = await backupDocTextToNotion({
            stockCode,
            docId: r.docId,
            d1DocumentId: r.id,
            fiscalYearEnd: r.periodEnd,
            textParseStatus: status,
            sections,
            force,
          });
          if (nb.rowPageId) {
            await db
              .update(yuhoDocuments)
              .set({ notionDocPageId: nb.rowPageId })
              .where(eq(yuhoDocuments.id, r.id));
          } else {
            // 本文ありなのに行 ID 未取得は黙って成功にしない (P6 共有根因)。
            console.warn(`[text-backfill] notion text backup 失敗(行 ID 未取得) ${r.docId}: outcome=${nb.outcome}`);
            tally.notion_text_no_pointer = (tally.notion_text_no_pointer ?? 0) + 1;
          }
        }
      } catch (e) {
        console.warn(`[text-backfill] notion text backup 失敗 ${r.docId}: ${(e as Error).message}`);
        tally.notion_text_error = (tally.notion_text_error ?? 0) + 1;
      }
    }
  } catch (e) {
    if (e instanceof EdinetDocumentFetchError || e instanceof EdinetDocumentArchiveError) throw e;
    tally.error = (tally.error ?? 0) + 1;
    console.warn(`[text-backfill] 失敗 ${r.docId}: ${(e as Error).message}`);
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
// 本文保管の失敗 (通エラー・保管 throw・コード不明・行 ID 未取得) が
// 1件でもあれば非0終了にする (false-green 防止。backfill-missing-docs と同一方式)。
// 有限 --doc 指定も通常全対象実行も同じ判定。
{
  const failed =
    (tally.error ?? 0) +
    (tally.notion_text_error ?? 0) +
    (tally.notion_text_no_code ?? 0) +
    (tally.notion_text_no_pointer ?? 0);
  if (archiveTallyFailed(failed)) {
    process.exitCode = 1;
  }
}
