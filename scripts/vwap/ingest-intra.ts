import "dotenv/config";
// 全銘柄の5分足(直近5日)を取得→既存とマージ→保持期間で剪定→ R2 intra/{code}.json（1ファイル）
// 配信はWorker素通し1回で済み低遅延。剪定はここに内包（別スクリプト不要）。
// 実行: npx tsx scripts/ingest-intra.ts [--codes=...] [--limit=N]   KEEP_DAYS=365
import { fetchBars5m } from "../../services/vwap-analysis/lib/yahoo.ts";
import { r2Get, r2Put, mapLimit, sleep, retry } from "./lib/r2.ts";
import { loadCodes, arg } from "./lib/codes.ts";

const CONC = Number(process.env.CONC || 3);
const DELAY = Number(process.env.DELAY_MS || 200);
const KEEP_DAYS = Number(process.env.KEEP_DAYS || 365);

async function main() {
  let codes = await loadCodes();
  const only = arg("codes"); if (only) codes = only.split(",");
  const limit = arg("limit"); if (limit) codes = codes.slice(0, Number(limit));

  const cutoffTs = Math.floor(Date.now() / 1000) - KEEP_DAYS * 86400;
  let written = 0, empty = 0, errors = 0;
  await mapLimit(codes, CONC, async (code) => {
    await sleep(DELAY);
    try {
      const fresh = await retry(() => fetchBars5m(`${code}.T`, "5d"), 3);
      if (!fresh.length) { empty++; return; }
      const existing = await r2Get(`intra/${code}.json`);
      const map = new Map<number, any>();
      if (existing) for (const b of (JSON.parse(existing).bars || [])) map.set(b.ts, b);
      for (const b of fresh) map.set(b.ts, b);               // 当日/前日分を上書きマージ
      const bars = [...map.values()].filter((b) => b.ts >= cutoffTs).sort((a, b) => a.ts - b.ts);
      await r2Put(`intra/${code}.json`, JSON.stringify({ code, updated: new Date().toISOString(), bars }));
      written++;
    } catch (e) { errors++; if (errors <= 5) console.error(`  ${code}: ${e}`); }
  });
  console.log(JSON.stringify({ codes: codes.length, written, empty, errors, keepDays: KEEP_DAYS }));
}
main();
