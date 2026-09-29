import "dotenv/config";
// 全銘柄の日足を更新（未取得は10年バックフィル、既存は直近1ヶ月差分）→ R2 daily/{code}.json
// 実行: npx tsx scripts/ingest-daily.ts [--codes=7203,6758] [--limit=50]
import { fetchDaily } from "../../src/shared/yahoo/client.js";
import { r2Get, r2Put, mapLimit, sleep, retry } from "./lib/r2.js";
import { mergeDailySplits } from "./lib/daily-merge.js";
import { assertCodesInUniverse, loadCodes, arg } from "./lib/codes.js";
import { buildIngestSummary, findInvalidBars, resolveExitCode, resolveRunId, shouldSkipPut } from "./lib/ingest-guard.js";
import { recordPrimaryData } from "../../src/shared/notion-archive/index.js";

// 既定は低負荷 (逐次・約1.5s間隔 + ジッタ)。速度優先なら CONC / DELAY_MS で上書き。
const CONC = Number(process.env.CONC || 1);
const DELAY = Number(process.env.DELAY_MS || 1500);
// 429/503 がこの回数連続したら IP レート制限と判断し全体を中断する (叩き続けない)。
const MAX_RL = Number(process.env.MAX_RATE_LIMIT || 5);

async function main() {
  const universe = await loadCodes();
  const only = arg("codes");
  if (only) assertCodesInUniverse(only.split(","), universe);
  let codes = only ? only.split(",") : universe;
  const limit = arg("limit"); if (limit) codes = codes.slice(0, Number(limit));

  const startedAt = new Date().toISOString();
  let written = 0, empty = 0, errors = 0, backfilled = 0, rateLimited = 0, invalid = 0, skipped = 0;
  let consecRL = 0, aborted = false;
  await mapLimit(codes, CONC, async (code) => {
    if (aborted) return;                                   // ブロック検知後は残りを叩かない
    await sleep(DELAY + Math.floor(Math.random() * 400));  // ジッタで規則性を避ける
    try {
      const existing = await r2Get(`daily/${code}.json`);
      const range = existing ? "1mo" : "10y";
      if (!existing) backfilled++;
      const { bars, splits } = await retry(() => fetchDaily(`${code}.T`, range), 3);
      consecRL = 0;                                        // 成功で連続カウントをリセット
      if (!bars.length) { empty++; return; }
      // 保存前 invalid-price STOP: 壊れた実値は書かず数える (欠落と混同しない)。
      const bad = findInvalidBars(bars);
      if (bad.length > 0) {
        invalid++;
        if (invalid <= 5) console.error(`  ${code}: invalid bars ${JSON.stringify(bad.slice(0, 3))}`);
        return;
      }
      let merged = bars;
      // 初回 (10y backfill) は応答の全履歴が正。差分更新は窓マージする。
      let mergedSplits = splits;
      if (existing) {
        const old = JSON.parse(existing);
        const map = new Map<string, any>((old.bars || []).map((b: any) => [b.date, b]));
        for (const b of bars) map.set(b.date, b);
        merged = [...map.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
        // splits だけ全置換すると窓外の分割履歴が消える (F-09)。bars と同じ
        // 日付キーで窓マージする (窓外保持・窓内は fresh が正)。
        mergedSplits = mergeDailySplits(
          old.splits ?? [],
          splits,
          bars[0].date,
          bars[bars.length - 1].date
        );
      }
      // same-cached-input 2回目は内容同一で PUT skip (updated 不変)。
      // 比較対象は保存 object そのもの (Sol HOLD1: code/bars/splits 抜粋禁止)。
      const payload = { code, updated: new Date().toISOString(), bars: merged, splits: mergedSplits };
      if (shouldSkipPut(existing, payload)) { skipped++; return; }
      await r2Put(`daily/${code}.json`, JSON.stringify(payload));
      written++;
    } catch (e) {
      // レート制限は「これ以上叩くな」のシグナル。即リトライせず連続数を数え、
      // しきい値で全体を中断する (ブロックを延長しない / 低負荷化)。
      if ((e as { name?: string })?.name === "YahooRateLimitError") {
        rateLimited++; consecRL++;
        if (consecRL >= MAX_RL && !aborted) {
          aborted = true;
          console.error(`[abort] Yahoo 429/503 が ${MAX_RL} 連続。IP がレート制限中のため中断します。別回線(テザリング等)か時間を空けて再実行してください。`);
        }
        return;
      }
      errors++; if (errors <= 5) console.error(`  ${code}: ${e}`);
    }
  });
  const finishedAt = new Date().toISOString();
  console.log(JSON.stringify({ codes: codes.length, written, skipped, empty, errors, invalid, rateLimited, backfilled, aborted }));
  // run 粒度バッチ保管 (per-stock 鏡像は作らない)。通常 daily に必須接続。
  // 保管失敗は握り潰さず throw を伝播させ job 失敗にする (未保管の成功なし)。
  // outcome/fileTooLarge を明示確認し、skipped/partial を成功扱いしない。
  const summary = buildIngestSummary({ kind: "daily", range: "1mo-diff/10y-backfill", runId: resolveRunId(), codes: codes.length, written, skipped, empty, errors, invalid, rateLimited, backfilled, aborted, startedAt, finishedAt });
  console.log(JSON.stringify({ archive: "recording", key: summary.key }));
  const archived = await recordPrimaryData({ ...summary, force: false });
  if (archived.outcome !== "recorded" || archived.fileTooLarge) {
    throw new Error(`バッチ保管が不完全 (outcome=${archived.outcome} fileTooLarge=${archived.fileTooLarge}): ${summary.key}`);
  }
  // errors/invalid/rateLimited 計数があれば非0終了 (銘柄 PUT0 は上で確定済み)。
  process.exitCode = resolveExitCode({ aborted, errors, invalid, rateLimited });
}
main();
