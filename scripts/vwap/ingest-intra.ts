import "dotenv/config";
// 全銘柄の5分足を取得→既存とマージ→保持期間で剪定→ R2 intra/{code}.json（1ファイル）
// 配信はWorker素通し1回で済み低遅延。剪定はここに内包（別スクリプト不要）。
// 取得範囲は INTRA_RANGE / --range で指定 (既定 5d=日次トップアップ)。Yahoo は 5分足を
// 最大 60d まで提供するので、初回は INTRA_RANGE=60d でバックフィルし、以後 5d で延伸。
// 実行: npx tsx scripts/ingest-intra.ts [--codes=...] [--limit=N] [--range=60d]   KEEP_DAYS=365
import { fileURLToPath } from "node:url";
import { fetchBars5m } from "../../src/shared/yahoo/client.js";
import { r2GetVersion, r2Put, mapLimit, sleep, retry, R2PutRejectedError, R2PutUnknownError } from "./lib/r2.js";
import { assertCodesInUniverse, loadCodes, arg } from "./lib/codes.js";
import { sharedEnv } from "../../src/shared/env.js";
import { archiveSummaryOrFatal, assertSavedIntraShape, bodyPin, buildIngestSummary, findInvalidBars, resolveExitCode, resolveRunId, sanitizeLogText, shouldSkipPut, universePin, writeSummaryLocal, type IngestCodeOutcome, type SavedIntra } from "./lib/ingest-guard.js";
import { recordPrimaryData } from "../../src/shared/notion-archive/index.js";

export async function main() {
  // knob は main 内で型付き取得する (未設定・不正値は final catch で exit 2)。
  // 通常値は vwap-ingest.yml・.env.example で明示宣言。黙示既定なし。
  const { conc: CONC, delayMs: DELAY, maxRateLimit: MAX_RL, keepDays: KEEP_DAYS } = sharedEnv.vwapKnobs();
  // 5分足の取得範囲。通常値は INTRA_RANGE 明示宣言、CLI --range で上書き可。
  // Yahoo の 5m 上限は 60d。未知値は弾く (ルール2: 黙って既定に倒さない)。
  // どちらも無ければ必須エラー (未設定フォールバックなし)。
  const rangeArg = arg("range");
  const RANGE = rangeArg ?? sharedEnv.VWAP_INTRA_RANGE();
  if (!/^([1-9]|[1-5][0-9]|60)d$/.test(RANGE)) {
    throw new Error("INTRA_RANGE/--range は 1d〜60d で指定してください");
  }
  const universe = await loadCodes();
  const only = arg("codes");
  if (only) assertCodesInUniverse(only.split(","), universe);
  let codes = only ? only.split(",") : universe;
  const limit = arg("limit"); if (limit) codes = codes.slice(0, Number(limit));

  const cutoffTs = Math.floor(Date.now() / 1000) - KEEP_DAYS * 86400;
  const startedAt = new Date().toISOString();
  let written = 0, empty = 0, errors = 0, rateLimited = 0, invalid = 0, skipped = 0, done = 0;
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
  await mapLimit(codes, CONC, async (code) => {
    if (aborted || fatal) return;                        // ブロック/故障検知後は残りを叩かない
    await sleep(DELAY + Math.floor(Math.random() * 400));  // ジッタで規則性を避ける
    if (aborted || fatal) return;                        // delay 後に再確認してから source へ
    done++;
    // 途中で timeout kill されても進捗が分かるよう定期的に出す(60d バックフィルは長時間)。
    if (done % 500 === 0) console.log(JSON.stringify({ progress: done, total: codes.length, range: RANGE, written, empty, errors, rateLimited }));
    let fresh: Awaited<ReturnType<typeof fetchBars5m>>;
    try {
      fresh = await retry(() => fetchBars5m(`${code}.T`, RANGE), 3);
    } catch (e) {
      // レート制限は即リトライせず連続数を数え、しきい値で全体を中断する。
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
    if (aborted || fatal) return;                        // source await 中に counterpart が fatal 化しうる
    // R2 GET fault は fatal。null は明示 NoSuchKey の正常 bootstrap のみ。
    let existing: string | null;
    let observedVersion: string | null;
    try {
      const current = await r2GetVersion(`intra/${code}.json`);
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
    // 既存は empty 判定より先に検証する。source empty でも腐敗を見逃さない。
    // 空文字列は bootstrap ではなく腐敗 (=== null 判定。truthiness 禁止)。
    let old: SavedIntra | null = null;
    if (existing !== null) {
      try {
        old = assertSavedIntraShape(existing, `intra/${code}.json`, code);
      } catch (e) {
        errors++; if (errors <= 5) console.error(`  ${code}: ${e}`);
        outcomes[code] = { status: "error", latestSourceBar: null, bodySha: null };
        return;
      }
    }
    if (!fresh.length) { empty++; outcomes[code] = { status: "empty", latestSourceBar: null, bodySha: null }; return; }
    // 実応答の最新 source ts (実秒の最大)。完了取引日の推定はしない。
    let latest = -1;
    for (const b of fresh) if (b.ts > latest) latest = b.ts;
    // 保存前 invalid-price STOP: 壊れた実値は書かず数える (欠落と混同しない)。
    const bad = findInvalidBars(fresh);
    if (bad.length > 0) {
      invalid++;
      if (invalid <= 5) console.error(`  ${code}: invalid bars ${JSON.stringify(bad.slice(0, 3))}`);
      outcomes[code] = { status: "error", latestSourceBar: latest, bodySha: null };
      return;
    }
    const map = new Map<number, any>();
    if (old !== null) for (const b of old.bars) map.set(b.ts as number, b);
    for (const b of fresh) map.set(b.ts, b);               // 当日/前日分を上書きマージ
    const bars = [...map.values()].filter((b) => b.ts >= cutoffTs).sort((a, b) => a.ts - b.ts);
    // same-cached-input 2回目は内容同一で PUT skip (updated 不変)。
    // keep 剪定で集合が変われば内容が変わるため PUT する。
    // 比較対象は保存 object そのもの (Sol HOLD1: code/bars/splits 抜粋禁止)。
    const payload = { code, updated: new Date().toISOString(), bars };
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
      await r2Put(`intra/${code}.json`, payloadJson, observedVersion);
    } catch (e) {
      // PUT fault は全件 fatal。区別は正直計数する (unknown/rejected/想定外)。
      if (e instanceof R2PutUnknownError) {
        unknownCodes.push(code);
        outcomes[code] = { status: "unknown", latestSourceBar: latest, bodySha: bodyPin(payloadJson) };
      } else if (e instanceof R2PutRejectedError) {
        rejectedCodes.push(code);
        outcomes[code] = { status: "error", latestSourceBar: latest, bodySha: bodyPin(payloadJson) };
      } else {
        const text = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        errors++; if (errors <= 5) console.error(`  ${code}: ${sanitizeLogText(text).slice(0, 200)}`);
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
  console.log(JSON.stringify({ codes: codes.length, range: RANGE, written, skipped, empty, errors, invalid, rateLimited, keepDays: KEEP_DAYS, aborted, fatal, unknown: unknown.length, rejected: rejected.length }));
  // run 粒度バッチ保管 (per-stock 鏡像は作らない)。通常 intra に必須接続。
  // 保管失敗は fatal exit 2 にする (未保管の成功なし)。
  const summary = buildIngestSummary({ kind: "intra", range: RANGE, runId: resolveRunId(), codes: codes.length, written, skipped, empty, errors, invalid, rateLimited, keepDays: KEEP_DAYS, aborted, startedAt, finishedAt, unknown, rejected, universe: universePin(codes), outcomes: sortedOutcomes });
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
  // R2 fault (fatal) は 2。
  process.exitCode = resolveExitCode({ aborted, fatalUnknown: fatal, errors, invalid, rateLimited });
}
// loadCodes/config 等の想定外失敗は exit 2。sanitized 1 行のみ、再試行なし。
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e: unknown) => {
    console.error(`ingest-intra fatal: ${sanitizeLogText(e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 300)}`);
    process.exit(2);
  });
}
