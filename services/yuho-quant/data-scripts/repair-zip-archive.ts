/**
 * Notion 一次データ (EDINET 物理 ZIP) のギャップ修復 (Node → D1 HTTP 読取 + Notion 書込)。
 *
 * P6 完成監査で見つけた「D1 にある通の `一次データ｜yuho-quant` 行が無い」
 * ギャップを埋める。D1 行は既存のため再取込はせず、EDINET から ZIP を
 * 取り直して `recordPrimaryData()` (唯一の窓口。ルール6) で記録する。
 * 既記録の通はスキップ (冪等・再開可能)。
 *
 * 冪等・再開可能: recordPrimaryData が Key 完全一致で既存判定する。
 *
 * 必要env(.env): EDINET_API_KEY, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID,
 *               D1_DATABASE_ID, NOTION_*(ルール6)。
 *
 * 実行: pnpm yuho:repair:zip -- --doc=S100XXXX,S100YYYY [--force]
 */
import "dotenv/config";
import { eq } from "drizzle-orm";
import { createD1HttpDb } from "../../../src/shared/db/d1-http-client.js";
import { recordPrimaryData } from "../../../src/shared/notion-archive/index.js";
import {
  downloadDocument,
  EdinetNotFoundError,
} from "../src/services/edinet/client.js";
import * as yuhoSchema from "../src/db/schema.js";

const arg = (n: string) =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const force = process.argv.includes("--force");
const docIds = arg("doc")
  ? arg("doc")!
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  : [];
if (docIds.length === 0) {
  console.error("usage: --doc=DOCID[,DOCID...] [--force]");
  process.exit(2);
}

const db = createD1HttpDb(yuhoSchema);
const { yuhoDocuments } = yuhoSchema;

const tally: Record<string, number> = {
  recorded: 0,
  skipped_existing: 0,
  unknown_doc: 0,
  edinet_not_found: 0,
  error: 0,
};
for (const docId of docIds) {
  const rows = await db
    .select({
      edinetCode: yuhoDocuments.edinetCode,
      filerName: yuhoDocuments.filerName,
      docTypeCode: yuhoDocuments.docTypeCode,
      periodEnd: yuhoDocuments.periodEnd,
      submittedAt: yuhoDocuments.submittedAt,
    })
    .from(yuhoDocuments)
    .where(eq(yuhoDocuments.docId, docId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    console.warn(`[zip-repair] skip(未知の文書ID) ${docId}`);
    tally.unknown_doc += 1;
    continue;
  }
  try {
    let csvZip: Awaited<ReturnType<typeof downloadDocument>>;
    try {
      csvZip = await downloadDocument(docId, 5);
    } catch (e) {
      if (e instanceof EdinetNotFoundError) {
        console.warn(`[zip-repair] skip(EDINETに無い) ${docId}`);
        tally.edinet_not_found += 1;
        continue;
      }
      throw e;
    }
    let xbrlZip: Awaited<ReturnType<typeof downloadDocument>> | null = null;
    try {
      xbrlZip = await downloadDocument(docId, 1);
    } catch (e) {
      if (!(e instanceof EdinetNotFoundError)) throw e;
    }
    const submittedAt =
      row.submittedAt instanceof Date
        ? row.submittedAt
        : new Date((row.submittedAt as unknown as number) * 1000);
    const r = await recordPrimaryData({
      service: "yuho-quant",
      key: docId,
      source: `EDINET API v2 /documents/${docId} (type=1 XBRL / type=5 CSV)`,
      fetchedAt: submittedAt.toISOString(),
      metadata: {
        docID: docId,
        edinetCode: row.edinetCode,
        filerName: row.filerName,
        docTypeCode: row.docTypeCode,
        periodEnd: row.periodEnd,
        submitDateTime: submittedAt.toISOString(),
        repairedBy: "p6-zip-gap",
      },
      files: [
        {
          bytes: new Uint8Array(csvZip),
          filename: `${docId}_csv.zip`,
          contentType: "application/zip",
        },
        ...(xbrlZip
          ? [
              {
                bytes: new Uint8Array(xbrlZip),
                filename: `${docId}_xbrl.zip`,
                contentType: "application/zip",
              },
            ]
          : []),
      ],
      force,
    });
    console.info(`[zip-repair] ${docId}: ${r.outcome}`);
    tally[r.outcome === "recorded" ? "recorded" : "skipped_existing"] += 1;
  } catch (e) {
    tally.error += 1;
    console.warn(`[zip-repair] 失敗 ${docId}: ${(e as Error).message}`);
  }
}

console.info("[zip-repair] 完了: " + Object.entries(tally).map(([k, v]) => `${k}=${v}`).join(" "));
if (tally.unknown_doc + tally.edinet_not_found + tally.error > 0) {
  process.exitCode = 1;
}
