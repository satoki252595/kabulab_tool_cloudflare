import "dotenv/config";
// 全銘柄の日足を更新（未取得は10年バックフィル、既存は直近1ヶ月差分）→ R2 daily/{code}.json
// 実行: npx tsx scripts/ingest-daily.ts [--codes=7203,6758] [--limit=50]
import { fileURLToPath } from "node:url";
import { fetchDaily } from "../../src/shared/yahoo/client.js";
import { r2Get, r2Put, mapLimit, sleep, retry, R2PutRejectedError, R2PutUnknownError } from "./lib/r2.js";
import { mergeDailySplits, type DailySplit } from "./lib/daily-merge.js";
import { assertCodesInUniverse, loadCodes, arg } from "./lib/codes.js";
import { sharedEnv } from "../../src/shared/env.js";
import { archiveSummaryOrFatal, assertSavedDailyShape, bodyPin, buildIngestSummary, findInvalidBars, resolveExitCode, resolveRunId, sanitizeLogText, shouldSkipPut, universePin, type IngestCodeOutcome, type SavedDaily } from "./lib/ingest-guard.js";
import { recordPrimaryData } from "../../src/shared/notion-archive/index.js";

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
      console.error(`  ${code}: R2 fault のため新規作業を停止します: ${why}`);
    }
  };
  await mapLimit(codes, CONC, async (code) => {
    if (aborted || fatal) return;                        // ブロック/故障検知後は残りを叩かない
    await sleep(DELAY + Math.floor(Math.random() * 400));  // ジッタで規則性を避ける
    if (aborted || fatal) return;                        // delay 後に再確認してから R2 へ
    // R2 GET fault は fatal。null は明示 NoSuchKey の正常 bootstrap のみ。
    // 空文字列は bootstrap ではなく腐敗 (=== null 判定。truthiness 禁止)。
    let existing: string | null;
    try {
      existing = await r2Get(`daily/${code}.json`);
    } catch (e) {
      errors++; if (errors <= 5) console.error(`  ${code}: ${e}`);
      outcomes[code] = { status: "error", latestSourceBar: null, bodySha: null };
      stopNewWork(code, e);
      return;
    }
    if (aborted || fatal) return;                        // GET await 中に counterpart が fatal 化しうる
    // 既存は Yahoo 取得より先に検証する。source empty でも腐敗を見逃さない。
    let old: SavedDaily | null = null;
    if (existing !== null) {
      try {
        old = assertSavedDailyShape(existing, `daily/${code}.json`, code);
      } catch (e) {
        errors++; if (errors <= 5) console.error(`  ${code}: ${e}`);
        outcomes[code] = { status: "error", latestSourceBar: null, bodySha: null };
        return;
      }
    }
    const range = existing === null ? "10y" : "1mo";
    if (existing === null) backfilled++;
    let bars: Awaited<ReturnType<typeof fetchDaily>>["bars"];
    let splits: Awaited<ReturnType<typeof fetchDaily>>["splits"];
    try {
      ({ bars, splits } = await retry(() => fetchDaily(`${code}.T`, range), 3));
    } catch (e) {
      // レート制限は「これ以上叩くな」のシグナル。即リトライせず連続数を数え、
      // しきい値で全体を中断する (ブロックを延長しない / 低負荷化)。
      if ((e as { name?: string })?.name === "YahooRateLimitError") {
        rateLimited++; consecRL++;
        outcomes[code] = { status: "error", latestSourceBar: null, bodySha: null };
        if (consecRL >= MAX_RL && !aborted) {
          aborted = true;
          console.error(`[abort] Yahoo 429/503 が ${MAX_RL} 連続。IP がレート制限中のため中断します。別回線(テザリング等)か時間を空けて再実行してください。`);
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
    let merged = bars;
    // 初回 (10y backfill) は応答の全履歴が正。差分更新は窓マージする。
    let mergedSplits = splits;
    if (old !== null) {
      const map = new Map<string, any>(old.bars.map((b) => [b.date as string, b]));
      for (const b of bars) map.set(b.date, b);
      merged = [...map.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
      // splits だけ全置換すると窓外の分割履歴が消える (F-09)。bars と同じ
      // 日付キーで窓マージする (窓外保持・窓内は fresh が正)。
      mergedSplits = mergeDailySplits(
        old.splits as unknown as DailySplit[],
        splits,
        bars[0].date,
        bars[bars.length - 1].date
      );
    }
    // same-cached-input 2回目は内容同一で PUT skip (updated 不変)。
    // 比較対象は保存 object そのもの (Sol HOLD1: code/bars/splits 抜粋禁止)。
    const payload = { code, updated: new Date().toISOString(), bars: merged, splits: mergedSplits };
    const payloadJson = JSON.stringify(payload);
    if (shouldSkipPut(existing, payload)) {
      skipped++;
      // skip の pin は standing の既存 bytes (新規 timestamp 付き payload ではない)。
      outcomes[code] = { status: "skipped", latestSourceBar: latest, bodySha: existing === null ? null : bodyPin(existing) };
      return;
    }
    if (aborted || fatal) {
      // prepared だが send 前に停止。未送信として記録する。
      outcomes[code] = { status: "notStarted", latestSourceBar: latest, bodySha: null };
      return;
    }
    try {
      await r2Put(`daily/${code}.json`, payloadJson);
    } catch (e) {
      // PUT fault は全件 fatal。区別は正直計数する (unknown/rejected/想定外)。
      if (e instanceof R2PutUnknownError) {
        unknownCodes.push(code);
        outcomes[code] = { status: "unknown", latestSourceBar: latest, bodySha: bodyPin(payloadJson) };
      } else if (e instanceof R2PutRejectedError) {
        rejectedCodes.push(code);
        outcomes[code] = { status: "error", latestSourceBar: latest, bodySha: bodyPin(payloadJson) };
      } else {
        errors++; if (errors <= 5) console.error(`  ${code}: ${e}`);
        outcomes[code] = { status: "error", latestSourceBar: latest, bodySha: bodyPin(payloadJson) };
      }
      stopNewWork(code, e instanceof Error ? e.message : String(e));
      return;
    }
    written++;
    outcomes[code] = { status: "written", latestSourceBar: latest, bodySha: bodyPin(payloadJson) };
  });
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
  const summary = buildIngestSummary({ kind: "daily", range: "1mo-diff/10y-backfill", runId: resolveRunId(), codes: codes.length, written, skipped, empty, errors, invalid, rateLimited, backfilled, aborted, startedAt, finishedAt, unknown, rejected, universe: universePin(codes), outcomes: sortedOutcomes });
  console.log(JSON.stringify({ archive: "recording", key: summary.key }));
  const archived = await archiveSummaryOrFatal(() => recordPrimaryData({ ...summary, force: false }));
  if (archived.code === 2) {
    console.error(JSON.stringify({ archive: "failed", key: summary.key, reason: archived.reason }));
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
  main().catch((e: unknown) => {
    console.error(`ingest-daily fatal: ${sanitizeLogText(e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 300)}`);
    process.exit(2);
  });
}
