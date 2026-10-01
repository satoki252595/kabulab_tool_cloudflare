import "dotenv/config";
// 全銘柄の日足を更新（既存有無に関わらず 10y を 1 社 1 回取得し全置換）→ R2 daily/{code}.json
// 実行: npx tsx scripts/ingest-daily.ts [--codes=7203,6758] [--limit=50]
import { fileURLToPath } from "node:url";
import { fetchDaily, YahooRawTooLargeError, MAX_YAHOO_RAW_BYTES } from "../../src/shared/yahoo/client.js";
import { r2GetVersion, r2Put, mapLimit, sleep, R2PutRejectedError, R2PutUnknownError } from "./lib/r2.js";
import { buildRepairPost } from "./lib/repair-daily.js";
import { assertCodesInUniverse, loadCodes, arg } from "./lib/codes.js";
import { sharedEnv } from "../../src/shared/env.js";
import { archiveSummaryOrFatal, assertSavedDailyShape, bodyPin, buildIngestSummary, findInvalidBars, resolveExitCode, resolveRunId, sanitizeLogText, shouldSkipPut, universePin, writeSummaryLocal, type IngestCodeOutcome } from "./lib/ingest-guard.js";
import { isCalendarDateString, isStrictIsoUtc, jstDateSec } from "../../src/shared/vwap/proof.js";
import { recordPrimaryData } from "../../src/shared/notion-archive/index.js";
import { archiveYahooRawBatch, type YahooRawAttempt, type YahooRawMissing } from "../../src/shared/yahoo/raw-custody.js";

/**
 * 明示 10y range (run 起点の JST 暦日)。応答からの導出は禁止
 * (fresh 先頭日からの from 推定は欠落隠しになる)。
 */
export function tenYearRange(nowIso: string): { from: string; to: string } {
  // 実 clock は厳格 ISO UTC のみ (緩い Date.parse は繰上げを通すため HOLD)。
  if (!isStrictIsoUtc(nowIso)) {
    throw new Error(`tenYearRange: 無効な now のため HOLD`);
  }
  const ms = Date.parse(nowIso);
  const to = jstDateSec(Math.floor(ms / 1000));
  if (!isCalendarDateString(to)) {
    throw new Error(`tenYearRange: 無効な to のため HOLD`);
  }
  const [y, m, d] = to.split("-").map(Number);
  // うるう日 (02-29) のみ明示 rule: target 年に 02-29 は存在しない
  // (10 年差はうるう年同士になり得ない) ため 02-28 に倒す。
  if (m === 2 && d === 29) return { from: `${y - 10}-02-28`, to };
  const from = `${y - 10}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  // 構造上ここは常に有効 (02-29 は上で処理済み)。念のため HOLD。
  if (!isCalendarDateString(from)) {
    throw new Error(`tenYearRange: 無効な from のため HOLD (now=${nowIso})`);
  }
  return { from, to };
}

export async function main() {
  // knob は main 内で型付き取得する (未設定・不正値は final catch で exit 2)。
  // 通常値は vwap-ingest.yml・.env.example で明示宣言。黙示既定なし。
  const { conc: CONC, delayMs: DELAY, maxRateLimit: MAX_RL } = sharedEnv.vwapKnobs();
  const universe = await loadCodes();
  const only = arg("codes");
  if (only) assertCodesInUniverse(only.split(","), universe);
  let codes = only ? only.split(",") : universe;
  const limit = arg("limit"); if (limit) codes = codes.slice(0, Number(limit));

  const startedAt = new Date().toISOString();
  const runId = resolveRunId();
  const TEN_Y_RANGE = tenYearRange(startedAt); // run 内一定の明示 10y range
  let written = 0, empty = 0, errors = 0, backfilled = 0, rateLimited = 0, invalid = 0, skipped = 0;
  let consecRL = 0, aborted = false, fatal = false;
  const unknownCodes: string[] = [];
  const rejectedCodes: string[] = [];
  const outcomes: Record<string, IngestCodeOutcome> = {};
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
  for (let offset = 0; offset < codes.length && !aborted && !fatal;) {
    const batchStart = offset;
    let rawBytes = 0;
    const captures: YahooRawAttempt[] = [];
    const missing: YahooRawMissing[] = [];
    const writes: Array<() => Promise<void>> = [];
    // 各波は既存CONC件。8MiB到達・6波・30銘柄で収集を止め、全inflightを
    // settle後、同じ本文のNotion物理保管/readbackを通してからR2へ送る。
    // ponytail: 最大30銘柄まで先行取得し、Notion呼出しを減らす (PUT unknown検知前の取得済が最大30)。
    for (let wave = 0; wave < 6 && offset < codes.length && !aborted && !fatal &&
      offset - batchStart < 30 && rawBytes < MAX_YAHOO_RAW_BYTES; wave++) {
      const waveCodes = codes.slice(offset, offset + Math.min(CONC, 30 - (offset - batchStart)));
      offset += waveCodes.length;
      const captureStart = captures.length;
      const settled = await Promise.allSettled(waveCodes.map(async (code) => {
        if (aborted || fatal) return;                        // ブロック/故障検知後は残りを叩かない
        await sleep(DELAY + Math.floor(Math.random() * 400));  // ジッタで規則性を避ける
        if (aborted || fatal) return;                        // delay 後に再確認してから R2 へ
        // R2 GET fault は fatal。null は明示 NoSuchKey の正常 bootstrap のみ。
        // 空文字列は bootstrap ではなく腐敗 (=== null 判定。truthiness 禁止)。
        let existing: string | null;
        let observedVersion: string | null;
        try {
          const current = await r2GetVersion(`daily/${code}.json`);
          existing = current === null ? null : current.body;
          observedVersion = current === null ? null : current.etag;
        } catch (e) {
          // GET fault は typed family のみ記録する (生 SDK cause を出さない)。
          const text = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
          errors++; if (errors <= 5) console.error(`  ${code}: ${sanitizeLogText(text).slice(0, 200)}`);
          outcomes[code] = { status: "error", latestSourceBar: null, bodySha: null };
          stopNewWork(code, text);
          return;
        }
        if (aborted || fatal) return;                        // GET await 中に counterpart が fatal 化しうる
        // 既存は Yahoo 取得より先に検証する。source empty でも腐敗を見逃さない。
        if (existing !== null) {
          try {
            assertSavedDailyShape(existing, `daily/${code}.json`, code);
          } catch (e) {
            errors++; if (errors <= 5) console.error(`  ${code}: ${e}`);
            outcomes[code] = { status: "error", latestSourceBar: null, bodySha: null };
            return;
          }
        }
        // 通常 daily は 10y を 1 社 1 回取得し全置換する (1mo 差分マージなし)。
        backfilled++;
        let bars: Awaited<ReturnType<typeof fetchDaily>>["bars"];
        let splits: Awaited<ReturnType<typeof fetchDaily>>["splits"];
        let proof: Awaited<ReturnType<typeof fetchDaily>>["proof"];
        let captured = false;
        try {
          // 1 社 1 回の単発取得 (producer 側の chart retry なし。失敗は error/HOLD 計数へ)。
          ({ bars, splits, proof } = await fetchDaily(`${code}.T`, "10y", {
            onRaw: (capture) => {
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
          if (e instanceof YahooRawTooLargeError) fatal = true;
          if (!captured) missing.push({ api: "daily", symbol: `${code}.T`, attempt: 1,
            error: sanitizeLogText(e instanceof Error ? e.message : String(e)), failedAt: new Date().toISOString() });
          // レート制限は「これ以上叩くな」のシグナル。即リトライせず連続数を数え、
          // しきい値で全体を中断する (ブロックを延長しない / 低負荷化)。
          if ((e as { name?: string })?.name === "YahooRateLimitError") {
            rateLimited++; consecRL++;
            outcomes[code] = { status: "error", latestSourceBar: null, bodySha: null };
            const retryAt = (e as { retryAtMs?: number | null }).retryAtMs;
            const cooling = typeof retryAt === "number" && Number.isFinite(retryAt) && retryAt > Date.now();
            if ((cooling || consecRL >= MAX_RL) && !aborted) {
              aborted = true;
              console.error(`[abort] Yahoo 429/503 のため新規取得を停止します (retry-at-ms=${retryAt}, consecutive=${consecRL})。取得済原文を保管して終了します。`);
            }
            return;
          }
          errors++; if (errors <= 5) console.error(`  ${code}: ${e}`);
          outcomes[code] = { status: "error", latestSourceBar: null, bodySha: null };
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
          outcomes[code] = { status: "error", latestSourceBar: latest, bodySha: null };
          return;
        }
        // whole-post rebuild (repair guard reuse): 明示 10y range 内の旧有効日付は
        // fresh 必須 (欠落 HOLD)、range 外旧は明示破棄。bars/splits/proof 全置換。
        // 旧無しは空 old 扱いの単一 path。旧移行の温存は要求しない。
        let rp: ReturnType<typeof buildRepairPost>;
        try {
          rp = buildRepairPost({
            code,
            oldRaw: existing ?? JSON.stringify({ code, bars: [], splits: [] }),
            fresh: { bars, splits, proof },
            range: TEN_Y_RANGE,
            updatedAt: new Date().toISOString(),
          });
        } catch (e) {
          errors++; if (errors <= 5) console.error(`  ${code}: ${e}`);
          outcomes[code] = { status: "error", latestSourceBar: latest, bodySha: null };
          return;
        }
        const postJson = rp.postJson;
        // range 外旧の破棄は outcome に残す (件数+端。0 件はキーなし)。
        const discarded = rp.discardedOutOfRange.count > 0 ? rp.discardedOutOfRange : undefined;
        // same-cached-input 2回目は内容同一で PUT skip (updated 不変・初回 clock 保持)。
        // 比較対象は保存 object そのもの (Sol HOLD1: code/bars/splits 抜粋禁止)。
        if (shouldSkipPut(existing, JSON.parse(postJson) as Record<string, unknown>)) {
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
          if (aborted || fatal) return;
          try {
            await r2Put(`daily/${code}.json`, postJson, observedVersion);
          } catch (e) {
            // PUT fault は全件 fatal。区別は正直計数する (unknown/rejected/想定外)。
            if (e instanceof R2PutUnknownError) {
              unknownCodes.push(code);
              outcomes[code] = { status: "unknown", latestSourceBar: latest, bodySha: bodyPin(postJson) };
            } else if (e instanceof R2PutRejectedError) {
              rejectedCodes.push(code);
              outcomes[code] = { status: "error", latestSourceBar: latest, bodySha: bodyPin(postJson) };
            } else {
              const text = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
              errors++; if (errors <= 5) console.error(`  ${code}: ${sanitizeLogText(text).slice(0, 200)}`);
              outcomes[code] = { status: "error", latestSourceBar: latest, bodySha: bodyPin(postJson) };
            }
            stopNewWork(code, e instanceof Error ? e.message : String(e));
            return;
          }
          written++;
          outcomes[code] = { status: "written", latestSourceBar: latest, bodySha: bodyPin(postJson) };
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
        console.log(JSON.stringify({ rawCustody: "daily", pages: raw.pages.length,
          rawBytes: raw.rawBytes, compressedBytes: raw.compressedBytes }));
      }
    } catch (e) {
      fatal = true;
      console.error(`daily raw custody STOP: ${sanitizeLogText(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
    }
    await mapLimit(writes, CONC, async (write) => write());
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
  console.log(JSON.stringify({ codes: codes.length, written, skipped, empty, errors, invalid, rateLimited, backfilled, aborted, fatal, unknown: unknown.length, rejected: rejected.length }));
  // run 粒度バッチ保管 (per-stock 鏡像は作らない)。通常 daily に必須接続。
  // 保管失敗は fatal exit 2 にして後続 intra を走らせない (未保管の成功なし)。
  const summary = buildIngestSummary({ kind: "daily", range: "10y-full", runId, codes: codes.length, written, skipped, empty, errors, invalid, rateLimited, backfilled, aborted, startedAt, finishedAt, unknown, rejected, universe: universePin(codes), outcomes: sortedOutcomes });
  const local = writeSummaryLocal(summary);
  if (!local.ok) {
    console.error(JSON.stringify({ archive: "local-failed", key: summary.key, reason: local.reason }));
    process.exitCode = 2;
    return;
  }
  console.log(JSON.stringify({ archive: "local", key: summary.key, path: local.path }));
  console.log(JSON.stringify({ archive: "recording", key: summary.key }));
  const archived = await archiveSummaryOrFatal(() => recordPrimaryData({ ...summary, force: false }));
  if (archived.code === 2) {
    console.error(JSON.stringify({ archive: "failed", key: summary.key, local: local.path, reason: archived.reason }));
    process.exitCode = 2;
    return;
  }
  console.log(JSON.stringify({ archive: "recorded", key: summary.key }));
  // errors/invalid/rateLimited 計数があれば非0終了 (銘柄 PUT0 は上で確定済み)。
  // R2 fault (fatal) は 2。ワークフローは exit 2 で intra を走らせない。
  process.exitCode = resolveExitCode({ aborted, fatalUnknown: fatal, errors, invalid, rateLimited });
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
  }
}
