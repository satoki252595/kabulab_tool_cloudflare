import "dotenv/config";
// 全銘柄の日足を更新（未取得は10年バックフィル、既存は直近1ヶ月差分）→ R2 daily/{code}.json
// 実行: npx tsx scripts/ingest-daily.ts [--codes=7203,6758] [--limit=50]
import { fetchDaily } from "../../src/shared/yahoo/client.js";
import { r2Get, r2Put, mapLimit, sleep, retry } from "./lib/r2.js";
import { loadCodes, arg } from "./lib/codes.js";

// 既定は低負荷 (逐次・約1.5s間隔 + ジッタ)。速度優先なら CONC / DELAY_MS で上書き。
const CONC = Number(process.env.CONC || 1);
const DELAY = Number(process.env.DELAY_MS || 1500);
// 429/503 がこの回数連続したら IP レート制限と判断し全体を中断する (叩き続けない)。
const MAX_RL = Number(process.env.MAX_RATE_LIMIT || 5);

async function main() {
  let codes = await loadCodes();
  const only = arg("codes"); if (only) codes = only.split(",");
  const limit = arg("limit"); if (limit) codes = codes.slice(0, Number(limit));

  let written = 0, empty = 0, errors = 0, backfilled = 0, rateLimited = 0;
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
      let merged = bars;
      if (existing) {
        const old = JSON.parse(existing);
        const map = new Map<string, any>((old.bars || []).map((b: any) => [b.date, b]));
        for (const b of bars) map.set(b.date, b);
        merged = [...map.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
      }
      await r2Put(`daily/${code}.json`, JSON.stringify({ code, updated: new Date().toISOString(), bars: merged, splits }));
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
  console.log(JSON.stringify({ codes: codes.length, written, empty, errors, rateLimited, backfilled, aborted }));
  if (aborted) process.exitCode = 2;
}
main();
