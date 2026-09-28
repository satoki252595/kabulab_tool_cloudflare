import "dotenv/config";
// JPX週次PDF(銘柄別信用取引週末残高)を解析→ R2 margin/{week}.json + margin/weeks.json
// ルール6: 物理ファイルの一次取得物なので PDF 実体を Notion へ冪等記録する。
// 実行: npx tsx scripts/vwap/ingest-margin.ts [--week=YYYYMMDD]
//   --week: 指定週の PDF を一覧から取得する (欠落週の手動補修用。一覧に無ければ
//     throw し、最新週で代用しない)。
import { fileURLToPath } from "node:url";
import {
  fetchMargin,
  marginArchiveInput,
  validateMarginData,
  weeksMissing,
} from "../../services/vwap-analysis/lib/margin.js";
import { recordPrimaryData } from "../../src/shared/notion-archive/index.js";
import { r2Get, r2Put } from "./lib/r2.js";

/**
 * `--week=YYYYMMDD` を解析する純関数。未指定なら undefined (最新週)。
 * 形式が違えば throw する (推測でその場をしのがない — ルール2)。
 */
export function parseWeekArg(argv: readonly string[]): string | undefined {
  const prefix = "--week=";
  const a = argv.find((x) => x.startsWith(prefix));
  if (!a) return undefined;
  const week = a.slice(prefix.length);
  if (!/^\d{8}$/.test(week)) {
    throw new Error(`--week: 形式が不正です (YYYYMMDD): ${week}`);
  }
  return week;
}

/**
 * 週次信用残を 1 週分取り込む。順序は「検証 → 原本保管 → R2 PUT」の固定。
 * 原本 (Notion 一次データ保管) を先にし、R2 (派生 JSON) は後にする —
 * 保管に失敗したら何も保存せず終える (R2 だけ残る部分保存を作らない)。
 * 派生は原本から再生成できるが、逆はできない (7/3・7/10 の実例)。
 */
export async function main(): Promise<void> {
  const requestedWeek = parseWeekArg(process.argv);
  const data = await fetchMargin(requestedWeek);
  validateMarginData(data);
  const { week, rows } = data;
  // 週一覧の読取・検証も全 PUT より前 (壊れた一覧で半端な PUT をしない)。
  const wl = await r2Get("margin/weeks.json");
  const weeks: string[] = wl ? JSON.parse(wl) : [];
  // 最新のみ取得のため土曜 job を落とした週は永久に飛ばされる (7/3・7/10 の実例)。
  // 欠落は推測補完せず、今回の出力に明示して運用者に見せる。
  const missingWeeks = weeksMissing(weeks, week);
  await recordPrimaryData(marginArchiveInput(data));
  await r2Put(`margin/${week}.json`, JSON.stringify({ week, rows }));
  if (!weeks.includes(week)) weeks.push(week);
  weeks.sort();
  await r2Put("margin/weeks.json", JSON.stringify(weeks));
  if (missingWeeks.length > 0) {
    console.error(`[margin] 欠落週あり (--week で個別補修可能): ${missingWeeks.join(", ")}`);
  }
  console.info(JSON.stringify({ week, count: rows.length, requestedWeek: requestedWeek ?? null, missingWeeks }));
}

// CLI として直接実行された場合のみ main() を走らせる (import だけでは走らない —
// テストが parseWeekArg を安全に import できるようにするためのガード。
// scripts/moneyflow/ingest.ts と同方式)。
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error("[margin] 致命的エラー:", e);
    process.exit(1);
  });
}
