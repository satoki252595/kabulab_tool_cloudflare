/**
 * 005 yuho-quant — EDINET 有報の日次キャッチアップ (Node / Worker 共通)。
 *
 * Node 日次 CLI は既存 D1 HTTP 接続と atomic sender で同じ処理を実行する。
 * Worker 認証ルートは引き続き D1 binding を渡す。長い取込・L2 の完了を
 * 1 本の Worker HTTP 応答待ちにせず、Node が各処理を直接 await する。
 *
 * 動作:
 *   - 最初は直近 WINDOW_DAYS 日をseed、その後は保存進捗の次の日を追加
 *   - 取込の母集団 (src/shared/db/active-equity.ts の `loadIngestCodeToId`。core_stocks から
 *     非普通株と、区分が NULL の active 行を除いたもの) の有報 (120/130) のうち未取込のものを
 *     ingestDocument で構造化保存 (CSV 事前判定で受注なしは XBRL を落とさない)
 *   - 1 回の実行は MAX_INGEST 件 / TIME_BUDGET_MS で打ち切り。残りは次回実行が
 *     保存原一覧・完了docIDから再開する。未完の日は期間窓を過ぎても残す。
 */
import type { createD1HttpBatchSender } from "../shared/db/d1-http-client.js";
import type { Database } from "../../services/yuho-quant/src/db/client.js";
import { loadIngestCodeToId } from "../shared/db/active-equity.js";
import { captureListSnapshot, readListSnapshot, EdinetListQualificationError } from "../../services/yuho-quant/src/services/edinet/list-snapshot.js";
import { enqueueDates, progressQueue, progressContents, progressSummary, saveProgress, jstDate, type PendingDocument } from "../../services/yuho-quant/src/services/edinet/catchup-progress.js";
import { EdinetListFetchError } from "../../services/yuho-quant/src/services/edinet/client.js";
import {
  isAnnualSecuritiesReport,
} from "../../services/yuho-quant/src/services/edinet/types.js";
import { loadEdinetTickerMap, loadKnownStockCodes, resolveAnnualTicker } from "../../services/yuho-quant/src/services/edinet/identity.js";
import { ingestDocument } from "../../services/yuho-quant/src/services/ingest.js";
import { checkDocsCustody } from "../../services/yuho-quant/src/services/edinet/archive.js";
import { rebuildYuhoGrowthProjection } from "../../services/yuho-quant/src/services/projection.js";

const WINDOW_DAYS = 60;
/**
 * 新しい取込の開始は60通まで。保管と全文読戻しの時間を含め、予算到達後は
 * checkpointから次回へ回す。上限到達は未完として非0終了する。
 */
const MAX_INGEST = 60;
/**
 * 実時間の上限。Workers の CPU 時間制限 (Paid 既定 30s, 最大 5 分まで引上可) と
 * は別に、fetch/sleep 主体の本処理はこの壁時計予算で新しい日・通の開始を止める。
 * 開始済みの通は await し、その後の全体 L2 も予算外なので全実行の期限ではない。
 * shard 指定時は docId ハッシュで 1/of の文書だけを担当するので、複数実行
 * (cron 並走 or 連続実行) 合算で全件をカバーし、打ち切った残りも次回が docId
 * 冪等で拾う (取りこぼさない)。
 */
const TIME_BUDGET_MS = 300_000;

export interface ShardOpts {
  part: number;
  of: number;
}

export interface YuhoEdinetResult {
  shard: ShardOpts | null;
  scannedDays: number;
  matched: number;
  ingested: number;
  skippedExisting: number;
  /**
   * 有報 (120/130) のうち、証券コードが取込の母集団 (`loadIngestCodeToId`) に無く取り込まなかった
   * 件数 (非普通株・区分が NULL の active 行・core_stocks に無いコード)。シャード指定時は
   * このシャードの担当分だけを数える。
   */
  outOfUniverse: number;
  /** 未解決 identity/metadata/parser は未提出扱いせず、保存 snapshot に保留。 */
  pendingDocuments: number;
  byStatus: Record<string, number>;
  reachedCap: boolean;
  elapsedSec: number;
  /** L2 投影 `p_yuho_growth` の再生成銘柄数。シャード実行では 0 (再生成しない) */
  projectionStocks: number;
  /** 一覧取得に失敗した日付 (EDINET list の throw)。空でないと job 失敗。 */
  listErrors: string[];
  /** 完了応答では空。取込例外は結果を返さず即停止する (応答 schema は維持)。 */
  ingestErrors: string[];
}

/**
 * 完了結果の成功判定。一覧取得失敗があれば Worker は 500 + result、
 * Node CLI は exit 1。取込例外は結果を返さず伝播し、Node CLI は exit 2。
 * 母集団外・既取込は正当結果。cap/保留は未完として500 (Node exit1)。
 * ingestErrors は既存応答 schema の互換項目で、例外停止後の結果は作らない。
 */
export function catchupHttpStatus(
  r: Pick<YuhoEdinetResult, "listErrors" | "ingestErrors" | "reachedCap" | "pendingDocuments">
): 200 | 500 {
  return r.listErrors.length > 0 || r.ingestErrors.length > 0 || r.reachedCap || r.pendingDocuments > 0 ? 500 : 200;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** docId の安定ハッシュ (FNV-1a 32bit, 非負)。シャード分配に使う */
function hashDocId(docId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < docId.length; i++) {
    h ^= docId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export async function runYuhoEdinetCatchup(
  db: Database,
  shard?: ShardOpts,
  d1HttpBatch?: ReturnType<typeof createD1HttpBatchSender>
): Promise<YuhoEdinetResult> {
  const startedAt = Date.now();

  // 進捗 checkpoint (1/5): 各 await 直前に入口だけ出す。前段の完了は次の
  // checkpoint (または末尾の完了 summary) の到達で判る。日付・件数・docID
  // のみで URL/キー/ヘッダ/本文は出さない。retry/timeout/業務処理は不変。
  console.info(
    `[yuho-edinet] 開始: shard=${shard ? `${shard.part}/${shard.of}` : "-"} window=${WINDOW_DAYS}日`
  );

  // 取込の母集団。変更前 (core_stocks の全行) から、非普通株と、区分が NULL の active 行
  // だけを除く。is_active=0 の会社 (上場廃止・地域取引所の単独上場) の有報は取り込み続ける
  // (理由は src/shared/db/active-equity.ts の disclosureIngestCondition)。
  const codeToId = await loadIngestCodeToId(db);

  const byStatus: Record<string, number> = {};
  let scannedDays = 0;
  let matched = 0;
  let ingested = 0;
  let skippedExisting = 0;
  let outOfUniverse = 0;
  const listErrors: string[] = [];
  const ingestErrors: string[] = [];

  const overBudget = () => Date.now() - startedAt > TIME_BUDGET_MS;

  const today = jstDate();
  const scope = shard ? `shard-${shard.part}-of-${shard.of}` : "main";
  if (shard && (!Number.isSafeInteger(shard.part) || !Number.isSafeInteger(shard.of) ||
      shard.part < 0 || shard.of <= 0 || shard.part >= shard.of)) throw new Error("EDINET shard 不正");
  const enqueuePending = await enqueueDates(db, scope, today);
  const queue = await progressQueue(db, scope, today);
  let attempted = 0;
  let reachedCap = enqueuePending;
  for (let row of queue) {
    if (attempted >= MAX_INGEST || overBudget() || scannedDays >= WINDOW_DAYS) {
      reachedCap = true;
      break;
    }
    if (row.inFlightDocId !== null) {
      throw new Error("EDINET 未確定 in-flight が残っています。読取照合が必要です (再送なし)。");
    }
    const date = row.date;
    scannedDays++;
    const contents = progressContents(row);
    const completed = contents.completed;
    let {pending, snapshot} = contents;
    let list;
    // 当日の20時一覧は未封印。翌日、完了済IDを保持して終日一覧を再観測する。
    // 途中の snapshot は先に同じ原文から再開し、完了後の次回にだけ再観測する。
    if (snapshot === null || !snapshot.qualified || (row.finished && !row.sealed && date < today)) {
      row = await saveProgress(db, row, {inFlightDocId: "@list"});
      console.info(`[yuho-edinet] list 開始 ${date}`);
      try {
        const captured = await captureListSnapshot(date);
        list = captured.list;
        snapshot = captured.snapshot;
      } catch (error) {
        if (error instanceof EdinetListFetchError) {
          // 副作用のない源GET未完は次の定期runで再開。今のrunでは再送しない。
          await saveProgress(db, row, {inFlightDocId: null});
        } else if (error instanceof EdinetListQualificationError) {
          // 受信した失敗応答は既に全文物理保管済み。原本を残して次回再観測する。
          await saveProgress(db, row, {snapshot: JSON.stringify(error.snapshot),
            inFlightDocId: null, finished: false, sealed: false});
        }
        // Notion/D1の未知結果はmarkerを保持。読取照合まで自動再送しない。
        console.error(`[yuho-edinet] list 失敗 ${date}: 取得/保管未完 (再送なし)`);
        listErrors.push(date);
        break;
      }
      row = await saveProgress(db, row, {snapshot: JSON.stringify(snapshot),
        inFlightDocId: null, finished: false, sealed: jstDate(new Date(snapshot.fetchedAt)) > date});
    } else {
      console.info(`[yuho-edinet] 保存 list 再開 ${date}`);
      list = await readListSnapshot(snapshot);
    }
    const targets = list.results.filter((doc) => isAnnualSecuritiesReport(doc) &&
      (!shard || hashDocId(doc.docID) % shard.of === shard.part));
    if (new Set(targets.map((doc) => doc.docID)).size !== targets.length) {
      throw new Error("EDINET 年次対象docIDが重複 (保管原文を保持・再送なし)");
    }
    if (completed.some((id) => !list.results.some((d) => d.docID === id))) {
      // 再観測で既処理文書が消えていても履歴は削除しない。現在対象だけを処理する。
      console.info(`[yuho-edinet] ${date}: 過去完了文書の一覧差分を保持`);
    }
    const remaining = targets.filter((doc) => !completed.includes(doc.docID));
    const edinetToTicker = await loadEdinetTickerMap(db, remaining
      .filter((doc) => doc.secCode === null && doc.edinetCode !== null)
      .map((doc) => doc.edinetCode!));
    const resolvedTargets = remaining.filter((doc) => {
      const code = resolveAnnualTicker(doc, edinetToTicker);
      return code !== null && codeToId.has(code);
    });
    const knownCodes = await loadKnownStockCodes(db, remaining.map((d) => resolveAnnualTicker(d, edinetToTicker))
      .filter((code): code is string => code !== null && !codeToId.has(code)));
    if (resolvedTargets.length > 0) {
      console.info(`[yuho-edinet] custody 照会 ${date} ${resolvedTargets.length}件`);
    }
    const custodyByDoc = resolvedTargets.length > 0
      ? await checkDocsCustody("yuho-quant", resolvedTargets.map((doc) => doc.docID)) : new Map();
    // 保留集合はこの保存一覧で観測した文書だけ。訂正/取下げなど後の一覧変化も保持。
    pending = pending.filter((p) => targets.some((d) => d.docID === p.docId));
    for (const doc of remaining) {
      if (attempted >= MAX_INGEST || overBudget()) { reachedCap = true; break; }
      const code = resolveAnnualTicker(doc, edinetToTicker);
      const putPending = (reason: PendingDocument["reason"]) => {
        pending = [...pending.filter((p) => p.docId !== doc.docID), {docId: doc.docID, reason}];
      };
      if (code === null) {
        putPending("identity_unresolved");
        continue;
      }
      const stockId = codeToId.get(code);
      if (stockId === undefined) {
        if (!knownCodes.has(code)) {
          putPending("identity_unresolved"); // マスタ未到着。新規銘柄を恒久除外しない。
          continue;
        }
        // 一意な証券コードはあるが正規取込母集団外。identity未解決とは別の既知除外。
        outOfUniverse++;
        completed.push(doc.docID);
        pending = pending.filter((p) => p.docId !== doc.docID);
        continue;
      }
      attempted++;
      matched++;
      // source/DB/Notion の不明結果を次回に blind replay しない予約。
      row = await saveProgress(db, row, {completedIds: JSON.stringify(completed),
        pendingIds: JSON.stringify(pending), inFlightDocId: doc.docID});
      console.info(`[yuho-edinet] ingest 開始 ${date} docID=${doc.docID}`);
      const r = await ingestDocument(db, {stockId, stockCode: code, doc,
        archiveToNotion: true, custody: custodyByDoc.get(doc.docID), d1HttpBatch});
      if (r.outcome !== "skipped_existing") {
        byStatus[r.parseStatus] = (byStatus[r.parseStatus] ?? 0) + 1;
        const ok = `oseas:${r.overseasParseStatus}`;
        byStatus[ok] = (byStatus[ok] ?? 0) + 1;
        const tx = `text:${r.textParseStatus}`;
        byStatus[tx] = (byStatus[tx] ?? 0) + 1;
      }
      if (r.outcome === "skipped_no_period" || r.outcome === "skipped_invalid_meta") {
        putPending("metadata_unresolved");
      } else if (r.parseStatus === "parse_error" || r.overseasParseStatus === "parse_error" ||
          r.textParseStatus === "parse_error") {
        putPending("parse_error");
      } else if (r.overseasParseStatus === null || r.textParseStatus === null) {
        putPending("metadata_unresolved");
      } else {
        completed.push(doc.docID);
        pending = pending.filter((p) => p.docId !== doc.docID);
      }
      if (r.outcome === "ingested") ingested++;
      else skippedExisting++;
      row = await saveProgress(db, row, {completedIds: JSON.stringify(completed),
        pendingIds: JSON.stringify(pending), inFlightDocId: null});
      await sleep(300);
    }
    const finished = targets.every((doc) => completed.includes(doc.docID) || pending.some((p) => p.docId === doc.docID));
    row = await saveProgress(db, row, {completedIds: JSON.stringify(completed),
      pendingIds: JSON.stringify(pending), finished, pendingCheckedDate: today});
    if (!finished || (date < today && !row.sealed)) reachedCap = true;
    await sleep(150);
  }
  const storedSummary = await progressSummary(db, scope, today);
  const pendingDocuments = storedSummary.pendingDocuments;
  reachedCap = reachedCap || storedSummary.queuedDays > 0;

  // L2 投影 `p_yuho_growth` の再生成 (L-51/K4b)。シャード実行では走らせない
  // (各シャードが全表を書き直すと sweep が競合する。非シャードの定時実行が
  // 拾う。手動バックフィル直後は次回定時まで画面が古いまま)。
  let projectionStocks = 0;
  if (!shard && listErrors.length === 0) {
    // 進捗 checkpoint (5/5): L2 投影再生成の入口。完了は末尾 summary の 投影= で判る。
    console.info(`[yuho-edinet] 投影再生成 開始`);
    const proj = await rebuildYuhoGrowthProjection(db);
    projectionStocks = proj.stocks;
  }

  const elapsedSec = (Date.now() - startedAt) / 1000;
  console.info(
    `[yuho-edinet] ${listErrors.length || reachedCap || pendingDocuments ? "終了（未完あり）" : "完了"}: shard=${shard ? `${shard.part}/${shard.of}` : "-"} 走査${scannedDays}日 matched=${matched} ingested=${ingested} skip=${skippedExisting} outOfUniverse=${outOfUniverse} pending=${pendingDocuments} cap=${reachedCap} listErrors=${listErrors.length} ingestErrors=${ingestErrors.length} 投影=${projectionStocks} ${elapsedSec.toFixed(1)}s`
  );
  return {
    shard: shard ?? null,
    scannedDays,
    matched,
    ingested,
    skippedExisting,
    outOfUniverse,
    pendingDocuments,
    byStatus,
    reachedCap,
    elapsedSec,
    projectionStocks,
    listErrors,
    ingestErrors,
  };
}
