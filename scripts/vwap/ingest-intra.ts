import "dotenv/config";
// 全銘柄の5分足を取得→既存とマージ→保持期間で剪定→ R2 intra/{code}.json（1ファイル）
// 配信はWorker素通し1回で済み低遅延。剪定はここに内包（別スクリプト不要）。
// 取得範囲は INTRA_RANGE / --range で指定 (既定 5d=日次トップアップ)。Yahoo は 5分足を
// 最大 60d まで提供するので、初回は INTRA_RANGE=60d でバックフィルし、以後 5d で延伸。
// 実行: npx tsx scripts/ingest-intra.ts [--codes=...] [--limit=N] [--range=60d]   KEEP_DAYS=365
import { fetchBars5m } from "../../src/shared/yahoo/client.js";
import { r2Get, r2Put, mapLimit, sleep, retry } from "./lib/r2.js";
import { loadCodes, arg } from "./lib/codes.js";

// 既定は低負荷 (逐次・約1.5s間隔 + ジッタ)。速度優先なら CONC / DELAY_MS で上書き。
const CONC = Number(process.env.CONC || 1);
const DELAY = Number(process.env.DELAY_MS || 1500);
const KEEP_DAYS = Number(process.env.KEEP_DAYS || 365);
// 5分足の取得範囲。Yahoo の 5m 上限は 60d。未知値は誤発注事故防止に弾く (ルール2: 黙って既定に倒さない)。
const RANGE = arg("range") || process.env.INTRA_RANGE || "5d";
if (!/^([1-9]|[1-5][0-9]|60)d$/.test(RANGE)) {
  throw new Error(`INTRA_RANGE/--range は 1d〜60d で指定してください (受領: "${RANGE}")`);
}
// 429/503 がこの回数連続したら IP レート制限と判断し全体を中断する (叩き続けない)。
const MAX_RL = Number(process.env.MAX_RATE_LIMIT || 5);

async function main() {
  let codes = await loadCodes();
  const only = arg("codes"); if (only) codes = only.split(",");
  const limit = arg("limit"); if (limit) codes = codes.slice(0, Number(limit));

  const cutoffTs = Math.floor(Date.now() / 1000) - KEEP_DAYS * 86400;
  let written = 0, empty = 0, errors = 0, rateLimited = 0, done = 0;
  let consecRL = 0, aborted = false;
  await mapLimit(codes, CONC, async (code) => {
    if (aborted) return;                                   // ブロック検知後は残りを叩かない
    await sleep(DELAY + Math.floor(Math.random() * 400));  // ジッタで規則性を避ける
    done++;
    // 途中で timeout kill されても進捗が分かるよう定期的に出す(60d バックフィルは長時間)。
    if (done % 500 === 0) console.log(JSON.stringify({ progress: done, total: codes.length, range: RANGE, written, empty, errors, rateLimited }));
    try {
      const fresh = await retry(() => fetchBars5m(`${code}.T`, RANGE), 3);
      consecRL = 0;                                        // 成功で連続カウントをリセット
      if (!fresh.length) { empty++; return; }
      const existing = await r2Get(`intra/${code}.json`);
      const map = new Map<number, any>();
      if (existing) for (const b of (JSON.parse(existing).bars || [])) map.set(b.ts, b);
      for (const b of fresh) map.set(b.ts, b);               // 当日/前日分を上書きマージ
      const bars = [...map.values()].filter((b) => b.ts >= cutoffTs).sort((a, b) => a.ts - b.ts);
      await r2Put(`intra/${code}.json`, JSON.stringify({ code, updated: new Date().toISOString(), bars }));
      written++;
    } catch (e) {
      // レート制限は即リトライせず連続数を数え、しきい値で全体を中断する。
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
  console.log(JSON.stringify({ codes: codes.length, range: RANGE, written, empty, errors, rateLimited, keepDays: KEEP_DAYS, aborted }));
  if (aborted) process.exitCode = 2;
}
main();
