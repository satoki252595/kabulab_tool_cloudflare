import "dotenv/config";
// 全銘柄の日足を更新。同じ確定sessionの10y証跡があればsource前skipし、未完だけ取得。
// 実行: npx tsx scripts/ingest-daily.ts [--codes=7203,6758] [--limit=50]
import { fileURLToPath } from "node:url";
import { fetchDaily, YahooRawTooLargeError, MAX_YAHOO_RAW_BYTES, type YahooRawCapture } from "../../src/shared/yahoo/client.js";
import { r2GetVersion, r2Put, confirmUnknownPricePut, mapLimit, sleep, R2PutRejectedError, R2PutUnknownError, type PricePutReadback } from "./lib/r2.js";
import { buildRepairPost } from "./lib/repair-daily.js";
import { assertCodesInUniverse, loadCodes, arg } from "./lib/codes.js";
import { sharedEnv } from "../../src/shared/env.js";
import { archiveSummaryOrFatal, assertSavedDailyShape, bodyPin, buildIngestSummary, completedDailyFetch, findInvalidBars, hasCompletedDailyFetch, resolveExitCode, resolveRunId, sanitizeLogText, shouldSkipPut, universePin, writeSummaryLocal, type IngestCodeOutcome } from "./lib/ingest-guard.js";
import { isStrictIsoUtc, jstDateSec, tenYearRangeForDate } from "../../src/shared/vwap/proof.js";
import { fetchDailySessionReference, qualifyDailySourceRange, resolveDailySessionSource, loadArchivedDailySessionReference } from "./lib/daily-session.js";
import { recordPrimaryData } from "../../src/shared/notion-archive/index.js";
import { archiveYahooRawBatch, type ArchivedYahooPart, type YahooRawAttempt, type YahooRawMissing } from "../../src/shared/yahoo/raw-custody.js";
import { priceMetadata, readPriceReference, referenceFromArchivedParts, type PriceReference } from "../../src/shared/holdings/price-registry.js";
import { publishDailyPriceSnapshot } from "./lib/holdings-price-registry.js";
import { scheduledVwapGuard } from "./lib/scheduled-window.js";
import { notionStats } from "../../src/shared/notion-archive/client.js";
import { ScheduledSourceDeadlineError } from "../../src/shared/scheduled-admission.js";
import { createStockYahooDirectTransport } from "../sync/yahoo-direct.js";
import { YahooSharedCooldownError } from "../../src/shared/yahoo/shared-cooldown.js";

/**
 * 明示 10y range (run 起点の JST 暦日。repair保護上限/従来skip用)。先頭barからの導出は禁止
 * (fresh 先頭日からの from 推定は欠落隠しになる)。
 */
export function tenYearRange(nowIso: string): { from: string; to: string } {
  // 実 clock は厳格 ISO UTC のみ (緩い Date.parse は繰上げを通すため HOLD)。
  if (!isStrictIsoUtc(nowIso)) {
    throw new Error(`tenYearRange: 無効な now のため HOLD`);
  }
  const ms = Date.parse(nowIso);
  return tenYearRangeForDate(jstDateSec(Math.floor(ms / 1000)));
}

/** consoleの先頭5件制限と別に、全銘柄の停止理由をsummaryへ残す。 */
function failureReason(error: unknown): string {
  return sanitizeLogText(error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 300);
}

export async function main() {
  // knob は main 内で型付き取得する (未設定・不正値は final catch で exit 2)。
  // 通常値は vwap-ingest.yml・.env.example で明示宣言。黙示既定なし。
  const startedAt = new Date().toISOString();
  const sessionSource = resolveDailySessionSource(arg("session-source"), arg("session-date"), startedAt);
  const runId = resolveRunId();
  const directArgs = process.argv.slice(2).filter(value => value === "--yahoo-direct" || value.startsWith("--yahoo-direct="));
  if (directArgs.length > 0 && (directArgs.length !== 1 || directArgs[0] !== "--yahoo-direct" ||
      !/^\d+\.\d+$/.test(runId) || sharedEnv.BATCH_JOB_STARTED_AT() === undefined)) {
    throw new Error("--yahoo-directはjob開始時計のあるActions VWAPだけで指定してください");
  }
  if (arg("scheduled-date") !== undefined && sessionSource.kind !== "yahoo-direct") {
    throw new Error("定時VWAPの市場sessionは従来のyahoo-directだけです。保存原本は明示手動選択してください");
  }
  const schedule = scheduledVwapGuard({ plannedDate: arg("scheduled-date"), scheduledAt: arg("scheduled-at"), runId, phase: "daily",
    jobStartedAt: sharedEnv.BATCH_JOB_STARTED_AT() });
  const restore = schedule.installDeadline();
  try {
  schedule.assertSource();
  const transport = directArgs.length === 1 ? createStockYahooDirectTransport() : undefined;
  if (transport !== undefined) console.info("[vwap-daily] Yahoo transport=node-direct shared-cooldown=D1");
  const fetchReference = (stage?: string) => fetchDailySessionReference(runId, stage, schedule.assertSource, transport);
  console.info(JSON.stringify({ dailySessionSource: sessionSource }));
  const { delayMs: DELAY } = sharedEnv.vwapKnobs();
  const universe = await loadCodes();
  const only = arg("codes");
  if (only) assertCodesInUniverse(only.split(","), universe);
  let codes = only ? only.split(",") : universe;
  const limit = arg("limit"); if (limit) codes = codes.slice(0, Number(limit));

  const CONC = 1; // Yahoo取得は環境変数によらず直列。実HTTP間隔は共有clientで制御。
  const TEN_Y_RANGE = tenYearRange(startedAt); // run 内一定の明示 10y range
  schedule.assertSource();
  const archivedSession = sessionSource.kind === "archived-jp-leg" ? await loadArchivedDailySessionReference(sessionSource.date,
    schedule.ioOptions === undefined ? undefined : { ...schedule.ioOptions, maxBytes: 20 * 1024 * 1024 }) : undefined;
  let reference = archivedSession === undefined ? await fetchReference() : archivedSession.reference; // 原本照合済み独立session。
  let SOURCE_RANGE = tenYearRangeForDate(reference.date);
  let referenceGeneration = 0;
  let written = 0, empty = 0, errors = 0, backfilled = 0, rateLimited = 0, invalid = 0, skipped = 0;
  let consecRL = 0, aborted = false, fatal = false;
  let sourceStopped = false;
  const sourceAllowed = () => {
    try { schedule.assertSource(); return true; }
    catch (error) {
      if (!(error instanceof ScheduledSourceDeadlineError)) throw error;
      sourceStopped = true;
      return false;
    }
  };
  let rawCustodyError: unknown;
  let putBarrier: Promise<void> = Promise.resolve();
  const unknownCodes: string[] = [];
  const rejectedCodes: string[] = [];
  const outcomes: Record<string, IngestCodeOutcome> = {};
  const priceReferences = new Map<string, PriceReference>();
  // R2 fault (PUT unknown/rejected・GET fault) は新規作業を止める。
  // inflight は止めず settle させ正直計数する (取消成功の仮定なし)。
  const stopNewWork = (code: string, why: unknown) => {
    if (!fatal) {
      fatal = true;
      // 生 SDK cause (URL 等) を出さず sanitized のみ。
      const text = why instanceof Error ? `${why.name}: ${why.message}` : String(why);
      console.error(`  ${code}: R2 fault のため新規作業を停止します: ${sanitizeLogText(text).slice(0, 200)}`);
    }
  };
  for (let offset = 0; offset < codes.length && !aborted && !fatal && !sourceStopped;) {
    try { if (!sourceAllowed()) break; } catch (e) { fatal = true; rawCustodyError = e; break; }
    if (jstDateSec(Date.now() / 1000) !== jstDateSec(Date.parse(reference.observedAt) / 1000)) {
      try {
        // 前batchを物理保管/条件付PUTで閉じてから取得する。unknown後に未保管batchを送らない。
        if (sessionSource.kind === "archived-jp-leg") throw new Error("daily session HOLD: 保存同日原本は日跨ぎ後に更新・切替できません");
        const refreshed = await fetchReference(`vwap-daily-session-${++referenceGeneration}`);
        if (refreshed.date !== reference.date ||
            jstDateSec(Date.parse(refreshed.observedAt) / 1000) !== jstDateSec(Date.now() / 1000)) {
          throw new Error("daily session HOLD: 更新benchmarkの確定取引日/実観測暦日がrunと一致しません");
        }
        reference = refreshed;
        SOURCE_RANGE = tenYearRangeForDate(reference.date);
      } catch (e) {
        fatal = true;
        rawCustodyError = e;
        errors++;
        outcomes[codes[offset]] = { status: "error", latestSourceBar: null, bodySha: null, reason: failureReason(e) };
        console.error(`daily session refresh STOP: ${sanitizeLogText(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
        break;
      }
    }
    const batchStart = offset;
    let rawBytes = 0;
    const captures: YahooRawAttempt[] = [];
    const missing: YahooRawMissing[] = [];
    const writes: Array<() => Promise<void>> = [];
    let archivedParts: ArchivedYahooPart[] = [];
    // 各波は1件。8MiB到達・30波・30銘柄で収集を止め、全inflightを
    // settle後、同じ本文のNotion物理保管/readbackを通してからR2へ送る。
    // ponytail: 最大30銘柄まで先行取得し、Notion呼出しを減らす (PUT unknown検知前の取得済が最大30)。
    for (let wave = 0; wave < 30 && offset < codes.length && !aborted && !fatal &&
      offset - batchStart < 30 && rawBytes < MAX_YAHOO_RAW_BYTES; wave++) {
      await sleep(DELAY);
      if (aborted || fatal) break;
      try { if (!sourceAllowed()) break; } catch (e) { fatal = true; rawCustodyError = e; break; }
      // HTTP中に跨いだ1件は既存資格検査でHOLD。次銘柄前にbatchを閉じて基準原本を更新する。
      if (jstDateSec(Date.now() / 1000) !== jstDateSec(Date.parse(reference.observedAt) / 1000)) break;
      const waveCodes = codes.slice(offset, offset + Math.min(CONC, 30 - (offset - batchStart)));
      offset += waveCodes.length;
      const captureStart = captures.length;
      const settled = await Promise.allSettled(waveCodes.map(async (code) => {
        if (aborted || fatal) return;                        // ブロック/故障検知後は残りを叩かない
        // R2 GET fault は fatal。null は明示 NoSuchKey の正常 bootstrap のみ。
        // 空文字列は bootstrap ではなく腐敗 (=== null 判定。truthiness 禁止)。
        let existing: string | null;
        let observedVersion: string | null;
        let objectMetadata: Record<string, string> | undefined;
        try {
          const current = await r2GetVersion(`daily/${code}.json`, schedule.ioOptions);
          existing = current === null ? null : current.body;
          observedVersion = current === null ? null : current.etag;
          objectMetadata = current?.metadata;
        } catch (e) {
          // GET fault は typed family のみ記録する (生 SDK cause を出さない)。
          const text = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
          errors++; if (errors <= 5) console.error(`  ${code}: ${sanitizeLogText(text).slice(0, 200)}`);
          outcomes[code] = { status: "error", latestSourceBar: null, bodySha: null, reason: failureReason(e) };
          stopNewWork(code, text);
          return;
        }
        if (aborted || fatal) return;                        // GET await 中に counterpart が fatal 化しうる
        // 既存は Yahoo 取得より先に検証する。source empty でも腐敗を見逃さない。
        if (existing !== null) {
          try {
            const saved = assertSavedDailyShape(existing, `daily/${code}.json`, code);
            const standingReference = readPriceReference(objectMetadata, saved.proof);
            if (standingReference.status === "ready") priceReferences.set(code, standingReference.reference);
            // ponytail: 同じ確定sessionのvendor訂正は自動追跡しない。訂正取得は明示別scope。
            if (standingReference.status === "ready" && hasCompletedDailyFetch(saved, SOURCE_RANGE)) {
              skipped++;
              outcomes[code] = { status: "skipped", latestSourceBar: null,
                bodySha: bodyPin(existing), sourceFetched: false };
              return;
            }
          } catch (e) {
            errors++; if (errors <= 5) console.error(`  ${code}: ${e}`);
            outcomes[code] = { status: "error", latestSourceBar: null, bodySha: null, reason: failureReason(e) };
            return;
          }
        }
        // 通常 daily は 10y を 1 社 1 回取得し全置換する (1mo 差分マージなし)。
        backfilled++;
        let bars: Awaited<ReturnType<typeof fetchDaily>>["bars"];
        let splits: Awaited<ReturnType<typeof fetchDaily>>["splits"];
        let proof: Awaited<ReturnType<typeof fetchDaily>>["proof"];
        let corporateEvents: Awaited<ReturnType<typeof fetchDaily>>["corporateEvents"];
        let captured = false;
        let sourceCapture: YahooRawCapture | undefined;
        if (!sourceAllowed()) return;
        try {
          // 1 社 1 回の単発取得 (producer 側の chart retry なし。失敗は error/HOLD 計数へ)。
          ({ bars, splits, proof, corporateEvents } = await fetchDaily(`${code}.T`, "10y", {
            transport,
            beforeRequest: schedule.assertSource,
            onRaw: (capture) => {
              sourceCapture = capture;
              captures.push({ api: "daily", attempt: 1, capture });
              captured = true;
              if (capture.symbol !== `${code}.T`) {
                fatal = true;
                throw new Error("Yahoo日足の原本captureと要求銘柄が一致しません (raw custody STOP)");
              }
            },
          }));
          if (!captured) {
            fatal = true;
            throw new Error("Yahoo日足が返りましたが原HTTP本文captureがありません (raw custody STOP)");
          }
        } catch (e) {
          if (e instanceof ScheduledSourceDeadlineError) {
            sourceStopped = true;
            outcomes[code] = { status: "notStarted", latestSourceBar: null, bodySha: null, reason: failureReason(e) };
            return;
          }
          if (e instanceof YahooRawTooLargeError || e instanceof YahooSharedCooldownError) fatal = true;
          if (!captured) missing.push({ api: "daily", symbol: `${code}.T`, attempt: 1,
            error: sanitizeLogText(e instanceof Error ? e.message : String(e)), failedAt: new Date().toISOString() });
          // 429/503の初回で全体を中断する。期限や連続数に関係なく同run再取得なし。
          if ((e as { name?: string })?.name === "YahooRateLimitError") {
            rateLimited++; consecRL++;
            outcomes[code] = { status: "error", latestSourceBar: null, bodySha: null, reason: failureReason(e) };
            const retryAt = (e as { retryAtMs?: number | null }).retryAtMs;
            if (!aborted) {
              aborted = true;
              console.error(`[abort] Yahoo 429/503 のため新規取得を停止します (retry-at-ms=${retryAt}, consecutive=${consecRL})。取得済原文を保管して終了します。`);
            }
            return;
          }
          errors++; if (errors <= 5) console.error(`  ${code}: ${e}`);
          outcomes[code] = { status: "error", latestSourceBar: null, bodySha: null, reason: failureReason(e) };
          return;
        }
        consecRL = 0;                                        // 成功で連続カウントをリセット
        if (!bars.length) { empty++; outcomes[code] = { status: "empty", latestSourceBar: null, bodySha: null }; return; }
        // 実応答の最新 source bar 日 (Yahoo timestamp 由来 JST)。完了取引日の推定はしない。
        let latest = "";
        for (const b of bars) if (b.date > latest) latest = b.date;
        // 保存前 invalid-price STOP: 壊れた実値は書かず数える (欠落と混同しない)。
        const bad = findInvalidBars(bars);
        if (bad.length > 0) {
          invalid++;
          if (invalid <= 5) console.error(`  ${code}: invalid bars ${JSON.stringify(bad.slice(0, 3))}`);
          outcomes[code] = { status: "error", latestSourceBar: latest, bodySha: null,
            reason: failureReason(`invalid bars ${JSON.stringify(bad.slice(0, 3))}`) };
          return;
        }
        // whole-post rebuild (repair guard reuse): 明示 10y range 内の旧有効日付は
        // fresh 必須 (欠落 HOLD)、range 外旧は明示破棄。bars/splits/proof 全置換。
        // 旧無しは空 old 扱いの単一 path。旧移行の温存は要求しない。
        let rp: ReturnType<typeof buildRepairPost>;
        let postJson: string;
        try {
          const sourceRange = qualifyDailySourceRange({ bars, splits, proof, corporateEvents }, sourceCapture, reference);
          rp = buildRepairPost({
            code,
            oldRaw: existing ?? JSON.stringify({ code, bars: [], splits: [] }),
            fresh: { bars, splits, proof, corporateEvents },
            range: { from: sourceRange.from, to: TEN_Y_RANGE.to },
            updatedAt: new Date().toISOString(),
          });
          const completedFetch = completedDailyFetch({ bars, splits, proof, corporateEvents }, sourceCapture, sourceRange, reference);
          postJson = completedFetch === null ? rp.postJson : JSON.stringify({ ...rp.post, completedFetch });
          assertSavedDailyShape(postJson, `daily/${code}.json`, code);
        } catch (e) {
          errors++; if (errors <= 5) console.error(`  ${code}: ${e}`);
          outcomes[code] = { status: "error", latestSourceBar: latest, bodySha: null, reason: failureReason(e) };
          return;
        }
        // range 外旧の破棄は outcome に残す (件数+端。0 件はキーなし)。
        const discarded = rp.discardedOutOfRange.count > 0 ? rp.discardedOutOfRange : undefined;
        // same-cached-input 2回目は内容同一で PUT skip (updated 不変・初回 clock 保持)。
        // 比較対象は保存 object そのもの (Sol HOLD1: code/bars/splits 抜粋禁止)。
        if (priceReferences.has(code) && shouldSkipPut(existing, JSON.parse(postJson) as Record<string, unknown>)) {
          skipped++;
          // skip の pin は standing の既存 bytes (新規 timestamp 付き payload ではない)。
          outcomes[code] = { status: "skipped", latestSourceBar: latest, bodySha: existing === null ? null : bodyPin(existing) };
          if (discarded) outcomes[code].discardedOutOfRange = discarded;
          return;
        }
        if (aborted || fatal) {
          // prepared だが send 前に停止。未送信として記録する。
          outcomes[code] = { status: "notStarted", latestSourceBar: latest, bodySha: null };
          return;
        }
        outcomes[code] = { status: "notStarted", latestSourceBar: latest, bodySha: null };
        writes.push(async () => {
          for (;;) {
            const barrier = putBarrier;
            await barrier;
            if (aborted || fatal) return;
            if (barrier === putBarrier) break;
          }
          let putReadback: PricePutReadback | undefined;
          try {
            schedule.assertActive();
            const priceReference = referenceFromArchivedParts(archivedParts, proof);
            const metadata = priceMetadata(objectMetadata, priceReference);
            putReadback = await r2Put(`daily/${code}.json`, postJson, observedVersion, metadata, schedule.ioOptions)
              .then(() => undefined, error => {
                const confirmation = confirmUnknownPricePut(error, `daily/${code}.json`, postJson, metadata, schedule.assertActive, schedule.ioOptions);
                // 他の開始済みPUTはsettleさせるが、全readbackが閉じるまで次を開始しない。
                // 元confirmationのrejectは下の既存catchでunknownとして記録する。
                putBarrier = Promise.all([putBarrier, confirmation]).then(() => {}, () => { fatal = true; });
                return confirmation;
              });
            priceReferences.set(code, priceReference);
          } catch (e) {
            // PUT fault は全件 fatal。区別は正直計数する (unknown/rejected/想定外)。
            if (e instanceof R2PutUnknownError) {
              unknownCodes.push(code);
              outcomes[code] = { status: "unknown", latestSourceBar: latest, bodySha: bodyPin(postJson), reason: failureReason(e) };
            } else if (e instanceof R2PutRejectedError) {
              rejectedCodes.push(code);
              outcomes[code] = { status: "error", latestSourceBar: latest, bodySha: bodyPin(postJson), reason: failureReason(e) };
            } else {
              const text = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
              errors++; if (errors <= 5) console.error(`  ${code}: ${sanitizeLogText(text).slice(0, 200)}`);
              outcomes[code] = { status: "error", latestSourceBar: latest, bodySha: bodyPin(postJson), reason: failureReason(e) };
            }
            stopNewWork(code, e instanceof Error ? e.message : String(e));
            return;
          }
          written++;
          outcomes[code] = { status: "written", latestSourceBar: latest, bodySha: bodyPin(postJson) };
          if (putReadback !== undefined) {
            outcomes[code].putReadback = putReadback;
            console.info(JSON.stringify({ r2PriceWrite: "readback-confirmed", code, putAcknowledgement: "unknown", bodySha256: putReadback.bodySha256 }));
          }
          if (discarded) outcomes[code].discardedOutOfRange = discarded;
        });
      }));
      for (let i = captureStart; i < captures.length; i++) rawBytes += captures[i].capture.bytes.length;
      if (settled.some((r) => r.status === "rejected")) {
        fatal = true;
        console.error("daily prepare が想定外に中断しました。取得済原本を保管してSTOPします");
      }
    }
    try {
      if (captures.length > 0 || missing.length > 0) {
        const raw = await archiveYahooRawBatch({ service: "vwap-analysis", runId,
          stage: `vwap-daily-${batchStart}`, captures, missing });
        if (!raw.archives) throw new Error("日足原本の物理照合済み参照がありません (raw custody STOP)");
        archivedParts = raw.archives;
        console.info(JSON.stringify({ rawCustody: "daily", pages: raw.pages.length,
          rawBytes: raw.rawBytes, compressedBytes: raw.compressedBytes }));
      }
    } catch (e) {
      fatal = true;
      rawCustodyError = e;
      console.error(`daily raw custody STOP: ${sanitizeLogText(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
    }
    // 全batchの原本照合後、異なるR2 keyだけ最大2件。Yahoo取得のCONC=1とは分離する。
    await mapLimit(writes, 2, async (write) => write());
  }
  // 未着手の全件 accounting。prepared-but-stopped は上で latest 付き notStarted。
  for (const code of codes) {
    outcomes[code] ??= { status: "notStarted", latestSourceBar: null, bodySha: null };
  }
  const sortedOutcomes: Record<string, IngestCodeOutcome> = {};
  for (const k of Object.keys(outcomes).sort()) sortedOutcomes[k] = outcomes[k];
  const finishedAt = new Date().toISOString();
  const unknown = [...unknownCodes].sort();
  const rejected = [...rejectedCodes].sort();
  console.info(JSON.stringify({ codes: codes.length, written, skipped, empty, errors, invalid, rateLimited, backfilled, aborted, fatal, unknown: unknown.length, rejected: rejected.length }));
  // run 粒度バッチ保管 (per-stock 鏡像は作らない)。通常 daily に必須接続。
  // 保管失敗は fatal exit 2 にして後続 intra を走らせない (未保管の成功なし)。
  const summary = buildIngestSummary({ kind: "daily", range: "10y-full", runId, codes: codes.length, written, skipped, empty, errors, invalid, rateLimited, backfilled, aborted: aborted || sourceStopped, startedAt, finishedAt, unknown, rejected, universe: universePin(codes), outcomes: sortedOutcomes });
  const dailySession = { selection: sessionSource, reference, ...(archivedSession === undefined ? {} : { custody: archivedSession.custody }) };
  summary.metadata.dailySession = dailySession;
  if (schedule.admission !== null) summary.metadata.scheduledWindow = schedule.admission;
  const summaryBody = JSON.parse(new TextDecoder().decode(summary.files[0].bytes));
  summary.files[0].bytes = new TextEncoder().encode(JSON.stringify({ ...summaryBody, dailySession,
    ...(schedule.admission === null ? {} : { scheduledWindow: schedule.admission }) }));
  const local = writeSummaryLocal(summary);
  if (!local.ok) {
    console.error(JSON.stringify({ archive: "local-failed", key: summary.key, reason: local.reason }));
    process.exitCode = 2;
    return;
  }
  console.info(JSON.stringify({ archive: "local", key: summary.key, path: local.path }));
  console.info(JSON.stringify({ archive: "recording", key: summary.key }));
  const archived = await archiveSummaryOrFatal(() => recordPrimaryData({ ...summary, force: false }), rawCustodyError);
  if (archived.code === 2) {
    console.error(JSON.stringify({ archive: "failed", key: summary.key, local: local.path, reason: archived.reason }));
    process.exitCode = 2;
    return;
  }
  console.info(JSON.stringify({ archive: "recorded", key: summary.key }));
  // 全母集団のknown終端を会計した通常runだけ進める。source HOLDは明示除外し旧memberを継承しない。
  // 未着手/unknown/aborted/subset/custody不成立は旧activeを維持。activation自体のunknownも利用を止める。
  try {
    schedule.assertActive();
    const priceSnapshot = await publishDailyPriceSnapshot({ runId, sessionDate: reference.date, finishedAt,
      universe, codes, references: priceReferences,
      beforeMutation: schedule.assertActive, ioOptions: schedule.ioOptions,
      outcomes: sortedOutcomes, complete: !aborted && !fatal && !sourceStopped && rateLimited === 0 });
    schedule.assertActive();
    console.info(JSON.stringify({ holdingPriceSnapshot: priceSnapshot }));
  } catch (e) {
    console.error(`holding price snapshot STOP: ${sanitizeLogText(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
    process.exitCode = 2;
    return;
  }
  // errors/invalid/rateLimited 計数があれば非0終了 (銘柄 PUT0 は上で確定済み)。
  // R2 fault (fatal) は 2。ワークフローは exit 2 で intra を走らせない。
  process.exitCode = resolveExitCode({ aborted: aborted || sourceStopped, fatalUnknown: fatal, errors, invalid, rateLimited });
  } finally { restore(); }
}
// loadCodes/config 等の想定外失敗は exit 2 (daily crash 1 で intra を誘発しない)。
// sanitized 1 行のみ、再試行なし。
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // 未解決PromiseだけではNodeは生存しない。summaryまで完了する前の終了は失敗。
  process.exitCode = 2;
  try {
    await main();
  } catch (e: unknown) {
    console.error(`ingest-daily fatal: ${sanitizeLogText(e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 300)}`);
    process.exitCode = 2;
  } finally {
    console.info(JSON.stringify({ notionStats: notionStats(), phase: "vwap-daily" }));
  }
}
