import "dotenv/config";
// 全銘柄の日足を更新（未取得は10年バックフィル、既存は直近1ヶ月差分）→ R2 daily/{code}.json
// 実行: npx tsx scripts/ingest-daily.ts [--codes=7203,6758] [--limit=50]
import { fetchDaily } from "../../services/vwap-analysis/lib/yahoo.ts";
import { r2Get, r2Put, mapLimit, sleep, retry } from "./lib/r2.ts";
import { loadCodes, arg } from "./lib/codes.ts";

const CONC = Number(process.env.CONC || 3);
const DELAY = Number(process.env.DELAY_MS || 200);

async function main() {
  let codes = await loadCodes();
  const only = arg("codes"); if (only) codes = only.split(",");
  const limit = arg("limit"); if (limit) codes = codes.slice(0, Number(limit));

  let written = 0, empty = 0, errors = 0, backfilled = 0;
  await mapLimit(codes, CONC, async (code) => {
    await sleep(DELAY);
    try {
      const existing = await r2Get(`daily/${code}.json`);
      const range = existing ? "1mo" : "10y";
      if (!existing) backfilled++;
      const { bars, splits } = await retry(() => fetchDaily(`${code}.T`, range), 3);
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
    } catch (e) { errors++; if (errors <= 5) console.error(`  ${code}: ${e}`); }
  });
  console.log(JSON.stringify({ codes: codes.length, written, empty, errors, backfilled }));
}
main();
