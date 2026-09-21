/**
 * 有報テキスト既存分の Notion 移行 (D1 → Notion。EDINET は叩かない)。
 *
 * P2 で新規取込は Notion 保管に切り替わった。本スクリプトはそれ以前の
 * 既存通 (text_parse_status='ok' かつ notion_doc_page_id IS NULL) を
 * 銘柄親ページ配下「有報テキスト」DB へ移し、行 ID を D1 へ書き戻す。
 *
 * 冪等・再開可能: 行の有無は Notion 側クエリ (文書完全一致) で判定し、
 * 既存なら作らず行 ID だけ回収する。D1 ポインタ済みは (force 無しなら)
 * スキップ。1 通の失敗で全体を落とさず error 計上して継続する。
 *
 * 非機能: Notion API は ~3 req/s (全用途共有)。1 通 ≈ 2〜3 コール
 * (ensure は銘柄初回のみ) のため、2.4 万通 ≒ 6 時間が下限。--limit /
 * --offset でシャード分割して投入する。並列シャードは 429 を
 * Retry-After で捌く (client.ts) ため、重なっても壊れない (遅くなる)。
 *
 * 必要env(.env): CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID,
 *               D1_DATABASE_ID, NOTION_*(ルール6)。
 *
 * 実行: pnpm yuho:backfill:notion-text -- --limit=3500 --offset=0 [--force]
 */
import "dotenv/config";
import { and, eq, isNull } from "drizzle-orm";
import { createD1HttpDb } from "../../../src/shared/db/d1-http-client.js";
import { loadIngestCodeToId } from "../../../src/shared/db/active-equity.js";
import { backupDocTextToNotion } from "../src/services/text-backup.js";
import * as yuhoSchema from "../src/db/schema.js";

const arg = (n: string) =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const force = process.argv.includes("--force");
const limit = arg("limit") ? Number(arg("limit")) : 3500;
const offset = arg("offset") ? Number(arg("offset")) : 0;
if (!Number.isFinite(limit) || !Number.isFinite(offset) || limit < 0 || offset < 0) {
  console.error("usage: --limit=N --offset=N [--force]");
  process.exit(2);
}

const db = createD1HttpDb(yuhoSchema);
const { yuhoDocuments, textSections } = yuhoSchema;
// stock_id → 証券コード (Notion 銘柄親ページのキー。無ければ当該通を飛ばす)
const idToCode = new Map(
  [...(await loadIngestCodeToId(db))].map(([code, id]) => [id, code] as const)
);

const where = force
  ? eq(yuhoDocuments.textParseStatus, "ok")
  : and(
      eq(yuhoDocuments.textParseStatus, "ok"),
      isNull(yuhoDocuments.notionDocPageId)
    );
const all = await db
  .select({
    id: yuhoDocuments.id,
    docId: yuhoDocuments.docId,
    stockId: yuhoDocuments.stockId,
    periodEnd: yuhoDocuments.periodEnd,
    textParseStatus: yuhoDocuments.textParseStatus,
  })
  .from(yuhoDocuments)
  .where(where)
  .orderBy(yuhoDocuments.id);
console.info(
  `[notion-text] 対象 ${all.length} 通 limit=${limit} offset=${offset} force=${force}`
);
const targets = all.slice(offset, offset + limit);

const tally: Record<string, number> = {
  recorded: 0,
  skipped_existing: 0,
  skipped_no_code: 0,
  skipped_empty: 0,
  error: 0,
};
let done = 0;
for (const r of targets) {
  done++;
  if (done % 50 === 0) {
    console.info(
      `[notion-text] ${done}/${targets.length} recorded=${tally.recorded} existing=${tally.skipped_existing} error=${tally.error}`
    );
  }
  try {
    const stockCode = idToCode.get(r.stockId) ?? null;
    if (stockCode === null) {
      console.warn(`[notion-text] skip(コード不明) ${r.docId}`);
      tally.skipped_no_code!++;
      continue;
    }
    const rows = await db
      .select({
        sectionKey: textSections.sectionKey,
        itemName: textSections.itemName,
        text: textSections.text,
      })
      .from(textSections)
      .where(eq(textSections.documentId, r.id))
      .orderBy(textSections.id);
    if (rows.length === 0) {
      console.warn(
        `[notion-text] skip(本文0件・要調査) ${r.docId} (status=${r.textParseStatus})`
      );
      tally.skipped_empty!++;
      continue;
    }
    const nb = await backupDocTextToNotion({
      stockCode,
      docId: r.docId,
      d1DocumentId: r.id,
      fiscalYearEnd: r.periodEnd,
      textParseStatus: r.textParseStatus ?? "ok",
      sections: rows,
      force,
    });
    if (nb.rowPageId) {
      await db
        .update(yuhoDocuments)
        .set({ notionDocPageId: nb.rowPageId })
        .where(eq(yuhoDocuments.id, r.id));
    }
    if (nb.outcome === "recorded") tally.recorded!++;
    else if (nb.outcome === "skipped_existing") tally.skipped_existing!++;
    else tally.skipped_empty!++;
  } catch (e) {
    console.warn(
      `[notion-text] 失敗 ${r.docId}: ${(e as Error).message}`
    );
    tally.error!++;
  }
}
console.info(
  `[notion-text] 完了: ${targets.length} 通中 ` +
    Object.entries(tally)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ")
);
// error があっても exit 0 (text-backfill と同じ)。完成判定は P3 検証
// (ポインタ NULL 件数 + サンプル照合) で行い、残は再投入で回収する。
