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
 * ローカルパース) のため createD1HttpDb (sqlite-proxy / D1 REST) で読む。
 * 書込は 1 文書ぶん (status UPDATE + facts DELETE + INSERT 群) を
 * createD1HttpBatchSender の単一 batch で原子適用する。逐次だと UPDATE 後に
 * 落ちた場合「status だけ埋まって facts 0 件」の部分行が残り、次回 force 無し
 * では対象外 (= 永久欠損) になる。per-statement フォールバックはしない。
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
import {
  createD1HttpBatchSender,
  createD1HttpDb,
  toD1BatchStatements,
} from "../../../src/shared/db/d1-http-client.js";
import {
  downloadDocument,
  EdinetNotFoundError,
} from "../src/services/edinet/client.js";
import { recordEdinetZip } from "../src/services/edinet/archive.js";
import {
  parseOverseasData,
  validateOverseasSaveSet,
  type OverseasParseStatus,
} from "../src/services/overseas-parser.js";
import * as yuhoSchema from "../src/db/schema.js";

const arg = (n: string) =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const force = process.argv.includes("--force");
const limit = arg("limit") ? Number(arg("limit")) : Infinity;
const offset = arg("offset") ? Number(arg("offset")) : 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 保存行変換は共有正準 (overseas-save-rows.ts) を使用する。
import { toOverseasSaveRows } from "../src/services/overseas-save-rows.js";
function chunk<T>(a: T[], s: number): T[][] {
  const o: T[][] = [];
  for (let i = 0; i < a.length; i += s) o.push(a.slice(i, i + s));
  return o;
}

const db = createD1HttpDb(yuhoSchema);
// D1 書込口の明示指定 (Node では必須)。sender は無状態なので run 全体で
// 1 個を使い回す。backfill.ts の ingestDocument 経由と同一の窓口。
const d1HttpBatch = createD1HttpBatchSender();
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
  // 全経路 (try 成功・catch・検証降格) で代入後に初読される。初期値なし。
  let status: OverseasParseStatus | "parse_error";
  let honbunFile: string | null = null;
  let facts: ReturnType<typeof parseOverseasData>["facts"] = [];
  let proof: ReturnType<typeof parseOverseasData>["proof"];
  let zipBytes: Buffer | null = null;
  try {
    const zip = await downloadDocument(r.docId, 1);
    zipBytes = zip;
    const ex = parseOverseasData(zip, r.periodEnd);
    status = ex.status;
    honbunFile = ex.honbunFile;
    facts = ex.facts;
    proof = ex.proof;
  } catch (e) {
    if (e instanceof EdinetNotFoundError) {
      status = "parse_error"; // type=1 未提供 → 構造化不能を正直に記録
    } else {
      status = "parse_error";
      console.warn(`[oseas-backfill] ${r.docId} ${r.filerName}: ${(e as Error).message}`);
    }
  }
  // 保存前検証を通す。違反があれば parse_error + 空保存
  // (先頭行 dedup で回復させない = aggregate-before-dedup の再発防止)。
  try {
    validateOverseasSaveSet(facts, proof);
  } catch (e) {
    console.warn(
      `[oseas-backfill] save-set invalid; downgrade to parse_error ${r.docId}: ${(e as Error).message}`
    );
    status = "parse_error";
    facts = [];
  }
  tally[status] = (tally[status] ?? 0) + 1;

  // ルール6: 取得した Type1 実体を type 別 key で記録する (共通契約)。
  // D1 書込より先に置く: 記録に失敗したら D1 は旧値のまま残り再実行できる。
  // 既存 key は recordPrimaryData 側で冪等スキップする。
  if (zipBytes) {
    await recordEdinetZip({
      service: "yuho-quant",
      docID: r.docId,
      type: 1,
      zip: zipBytes,
      source: `EDINET API v2 /documents/${r.docId}?type=1`,
      fetchedAt: new Date().toISOString(),
      metadata: {
        docID: r.docId,
        filerName: r.filerName,
        periodEnd: r.periodEnd,
        overseasParseStatus: status,
        overseasHonbunFile: honbunFile,
        overseasFactCount: facts.length,
        archivedBy: "backfill-overseas",
      },
    });
  }

  // overseas 列の更新 (受注列・受注ファクトには触れない) + 海外ファクトの
  // 置換 (delete → insert) を 1 文書ぶんの単一 batch で原子適用する。
  // facts 0 件 (parse_error 等) でも UPDATE + DELETE の 2 文は送る
  // (全 tuple に status を記録する契約は維持)。失敗は throw が外へ伝播し
  // 非 0 終了する (握り潰さない)。statement fallback なし。
  const rows = toOverseasSaveRows(facts, status).map((o) => ({
    documentId: r.id,
    stockId: r.stockId,
    ...o,
  }));
  const statements = [
    db
      .update(yuhoDocuments)
      .set({ overseasParseStatus: status, overseasHonbunFile: honbunFile })
      .where(eq(yuhoDocuments.id, r.id)),
    db.delete(overseasSalesFacts).where(eq(overseasSalesFacts.documentId, r.id)),
    ...chunk(rows, 8).map((part) =>
      db.insert(overseasSalesFacts).values(part)
    ),
  ];
  await d1HttpBatch(toD1BatchStatements(statements));

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
