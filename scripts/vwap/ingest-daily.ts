import "dotenv/config";
// 全銘柄の日足を更新（未取得は10年バックフィル、既存は直近1ヶ月差分）→ R2 daily/{code}.json
// 実行: npx tsx scripts/ingest-daily.ts [--codes=7203,6758] [--limit=50]
import { fetchDaily } from "../../src/shared/yahoo/client.js";
import { r2Get, r2Put, mapLimit, sleep, retry } from "./lib/r2.js";
import { mergeDailySplits } from "./lib/daily-merge.js";
import { loadCodes, arg } from "./lib/codes.js";
import { buildIngestSummary, findInvalidBars } from "./lib/ingest-guard.js";
import { recordPrimaryData } from "../../src/shared/notion-archive/index.js";

// 既定は低負荷 (逐次・約1.5s間隔 + ジッタ)。速度優先なら CONC / DELAY_MS で上書き。
const CONC = Number(process.env.CONC || 1);
const DELAY = Number(process.env.DELAY_MS || 1500);
// 429/503 がこの回数連続したら IP レート制限と判断し全体を中断する (叩き続けない)。
const MAX_RL = Number(process.env.MAX_RATE_LIMIT || 5);

async function main() {
  let codes = await loadCodes();
  const only = arg("codes"); if (only) codes = only.split(",");
  const limit = arg("limit"); if (limit) codes = codes.slice(0, Number(limit));

  const startedAt = new Date().toISOString();
  let written = 0, empty = 0, errors = 0, backfilled = 0, rateLimited = 0, invalid = 0;
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
      await r2Put(`daily/${code}.json`, JSON.stringify({ code, updated: new Date().toISOString(), bars: merged, splits: mergedSplits }));
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
  console.log(JSON.stringify({ codes: codes.length, written, empty, errors, invalid, rateLimited, backfilled, aborted }));
  // run 粒度バッチ保管 (per-stock 鏡像は作らない)。新物理 key のため
  // VWAP_ARCHIVE_SUMMARY=1 の明示指定時のみ記録し、既定では出さない。
  const summary = buildIngestSummary({ kind: "daily", range: "1mo-diff/10y-backfill", codes: codes.length, written, empty, errors, invalid, rateLimited, backfilled, aborted, startedAt, finishedAt });
  if (process.env.VWAP_ARCHIVE_SUMMARY === "1") {
    await recordPrimaryData({ ...summary, force: false });
  } else {
    console.log(JSON.stringify({ archive: "skipped", key: summary.key }));
  }
  if (aborted) process.exitCode = 2;
}
main();
