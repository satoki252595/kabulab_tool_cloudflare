/**
 * 有報の取りこぼし埋め戻し (Node → D1 HTTP 書込)。
 *
 * 日次キャッチアップ (Worker) は 1 実行の上限 (件数・時間) があり、
 * 流入が多い時期 (6 月の 3 月決算ピーク等) の文書を取りこぼす。60 日窓を
 * 過ぎた文書は日次では二度と拾われないため、本スクリプトで期間指定して
 * 回収する (例: --from=2026-06-01 --to=2026-08-31)。
 *
 * 1 通あたり: CSV(5) 取得 → キーワード事前判定 → 必要なら XBRL(1) 取得 →
 * 受注・海外・定性 24 項目を構造化 → 物理 ZIP を Notion へ冪等記録
 * (ルール6。DB batch より先。raw-before-DB) → D1 へ冪等 upsert →
 * 定性テキスト本文のみ DBid 解決後に保管。パーサは本番と同一物を共有する。
 * 1 通処理の正本は lib/missing-backfill.ts processMissingDoc。
 * 書込は 1 文書ぶん (文書 upsert + 3 表の置換) を createD1HttpBatchSender の
 * 単一 batch で原子適用する (ingest.ts と同一組成。docId サブクエリ参照)。
 * 逐次だと upsert 後に落ちた場合「メタだけ埋まって facts 0 件」の部分行が
 * 残り、次回は既存扱いで永久欠損になる。per-statement フォールバックはしない。
 *
 * 冪等・再開可能: docId 既存は (force 無しなら) スキップ。
 *
 * 必要env(.env): EDINET_API_KEY, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID,
 *               D1_DATABASE_ID, NOTION_*(ルール6)。
 *
 * 実行: pnpm yuho:backfill:missing -- --from=2026-06-01 --to=2026-08-31 [--limit=N] [--force] [--dry-run]
 */
import "dotenv/config";
import {
  createD1HttpBatchSender,
  createD1HttpDb,
} from "../../../src/shared/db/d1-http-client.js";
import { processMissingDoc } from "./lib/missing-backfill.js";
import { loadIngestCodeToId } from "../../../src/shared/db/active-equity.js";
import {
  archiveTallyFailed,
  checkDocsCustody,
  recordEdinetZip,
  type DocCustody,
} from "../src/services/edinet/archive.js";
import {
  downloadDocument,
  listDocuments,
} from "../src/services/edinet/client.js";
import type { EdinetDoc } from "../src/services/edinet/types.js";
import { backupDocTextToNotion } from "../src/services/text-backup.js";
import type { Database } from "../src/db/client.js";
import { applyCompletionFilter, selectMissingDocs } from "../src/services/edinet/missing.js";
import * as yuhoSchema from "../src/db/schema.js";

const arg = (n: string) =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const force = process.argv.includes("--force");
const dryRun = process.argv.includes("--dry-run");
const limit = arg("limit") ? Number(arg("limit")) : Infinity;
const fromArg = arg("from");
const toArg = arg("to");
if (!fromArg || !toArg || !/^\d{4}-\d{2}-\d{2}$/.test(fromArg) || !/^\d{4}-\d{2}-\d{2}$/.test(toArg)) {
  console.error("usage: --from=YYYY-MM-DD --to=YYYY-MM-DD [--limit=N] [--force] [--dry-run]");
  process.exit(1);
}
// raw-before-DB 契約: write mode で --no-archive は未対応 (明示 STOP)。
if (process.argv.includes("--no-archive") && !dryRun) {
  console.error("[missing] --no-archive は write mode 未対応のため STOP します (raw-before-DB 契約)");
  process.exit(1);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

const db = createD1HttpDb(yuhoSchema);
// D1 書込口の明示指定 (Node では必須)。sender は無状態なので run 全体で
// 1 個を使い回す。他 backfill と同一の窓口。
const d1HttpBatch = createD1HttpBatchSender();
const { yuhoDocuments } = yuhoSchema;
const codeToId = await loadIngestCodeToId(db);
console.info(`[missing] 母集団 ${codeToId.size} 社 range=${fromArg}〜${toArg} force=${force} dryRun=${dryRun}`);

// 取込済み docId は全件 1 回だけ引く (日ごとに引くと 22k 行 × 日数になる)。
// 本文ポインタの有無も一緒に引き、parse 済み (ok) なのにポインタ NULL の通は
// 既存扱いスキップから外して回収対象にする (本文ポインタ共有根因)。
const inDbAll = await db
  .select({
    docId: yuhoDocuments.docId,
    textParseStatus: yuhoDocuments.textParseStatus,
    notionDocPageId: yuhoDocuments.notionDocPageId,
  })
  .from(yuhoDocuments);
const existingAll = new Set(inDbAll.map((r) => r.docId));
// 本文ポインタ未完成の既存通 (ok なのに行 ID NULL)。保管済み判定から外す。
const pointerIncomplete = new Set(
  inDbAll
    .filter((r) => r.textParseStatus === "ok" && r.notionDocPageId === null)
    .map((r) => r.docId)
);

const tally: Record<string, number> = {};
// type 保管完成の run 内メモ (docId → DocCustody)。日ごとの一括取得で足し、
// 適用は毎回 applyCompletionFilter で行う (false/未完成の適用漏れ防止)。
const custodyMemo = new Map<string, DocCustody>();
let done = 0;
let target = 0;

for (const date of eachDay(fromArg, toArg)) {
  if (target >= limit) break;
  let listed: EdinetDoc[];
  try {
    listed = (await listDocuments(date)).results;
  } catch (e) {
    console.warn(`[missing] list 失敗 ${date}: ${(e as Error).message} (スキップ)`);
    continue;
  }
  // 既存扱いスキップは「完成済み」に限定する。type 保管完成は日ごとに
  // 一括取得し run 内メモへ足す (通ごとの照会はしない)。適用は純粋関数で
  // 毎回行い、memo の未完成が翌日以降も除外に反映されるようにする。
  if (!force) {
    const unmemoized = listed
      .map((doc) => doc.docID)
      .filter((id) => !custodyMemo.has(id));
    if (unmemoized.length > 0) {
      const batch = await checkDocsCustody("yuho-quant", unmemoized);
      for (const [id, c] of batch) custodyMemo.set(id, c);
    }
  }
  const { effective: effectiveExisting, metadataOnly } = applyCompletionFilter(
    existingAll,
    pointerIncomplete,
    custodyMemo,
    listed.map((doc) => doc.docID)
  );
  for (const id of metadataOnly) {
    console.error(`[missing] archive metadata-only のため STOP (明示修復が必要) docID=${id}`);
    tally.archive_metadata_only = (tally.archive_metadata_only ?? 0) + 1;
  }
  const { missing, skippedExisting, outOfUniverse } = selectMissingDocs(
    listed,
    effectiveExisting,
    codeToId,
    force
  );
  if (dryRun) {
    console.info(`[missing:dry] ${date} listed=${listed.length} missing=${missing.length} skipped=${skippedExisting} outOfUniverse=${outOfUniverse}`);
    target += missing.length;
    continue;
  }
  for (const { doc, stockId } of missing) {
    if (target >= limit) break;
    target++;
    // 1 通処理の正本は lib/missing-backfill.ts processMissingDoc (IO 境界は
    // 実物を注入)。失敗は内部で tally 計上済みのためここでは数えない。
    await processMissingDoc(
      db as unknown as Database,
      {
        downloadDocument,
        recordEdinetZip,
        d1HttpBatch,
        backupDocTextToNotion,
        tally: (key) => {
          tally[key] = (tally[key] ?? 0) + 1;
        },
      },
      { doc, stockId, force }
    );
    done++;
    if (done % 50 === 0) {
      console.info(`[missing] ${done}件処理 ` + Object.entries(tally).map(([k, v]) => `${k}=${v}`).join(" "));
    }
    await sleep(200);
  }
}

console.info("[missing] 完了: " + Object.entries(tally).map(([k, v]) => `${k}=${v}`).join(" "));
// 保管失敗 (recordEdinetZip の throw を含む) は tally.error に加算される。
// 本文保管の失敗 (保管 throw・コード不明・行 ID 未取得) と metadata-only 行の
// STOP も同様に非0終了にし、失敗を job green にしない (Sol HOLD1 + 共有根因)。
if (
  archiveTallyFailed(
    (tally.error ?? 0) +
      (tally.notion_text_error ?? 0) +
      (tally.notion_text_no_code ?? 0) +
      (tally.notion_text_no_pointer ?? 0) +
      (tally.archive_metadata_only ?? 0)
  )
) {
  process.exitCode = 1;
}
