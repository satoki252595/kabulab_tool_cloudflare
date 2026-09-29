// JPX 信用残高 (日次 mtall PDF) → Notion 一次データ保管 → R2 保存。
// 週次版は公表廃止のため通常取込では使わない (旧 R2 オブジェクトは残すが読まない)。
import { fileURLToPath } from "node:url";
import { recordPrimaryData } from "../../src/shared/notion-archive/index.js";
import {
  dailyMarginArchiveInput,
  fetchDailyMargin,
} from "../../services/vwap-analysis/lib/margin.js";
import { validateDailyMarginSnapshot } from "../../services/vwap-analysis/lib/margin-daily.js";
import { r2Get, r2Put } from "./lib/r2.js";

/** `--date=YYYYMMDD` (基準日) をパースする純関数。未指定なら undefined (最新)。 */
export function parseDateArg(argv: readonly string[]): string | undefined {
  const arg = argv.find((a) => a.startsWith("--date="));
  if (arg === undefined) return undefined;
  const value = arg.slice("--date=".length);
  if (!/^\d{8}$/.test(value)) {
    throw new Error(`margin --date の形式が不正です (YYYYMMDD): ${value}`);
  }
  return value;
}

/**
 * 基準日リスト (`margin/dates.json`) へ今回分を追加する純関数。
 * 形式不正の日付が混ざっていたら throw する (黙って落とさない)。
 */
export function mergeDailyMarginDates(saved: readonly string[], current: string): string[] {
  const fmt = /^\d{4}-\d{2}-\d{2}$/;
  if (!fmt.test(current)) throw new Error(`margin 基準日の形式が不正です (YYYY-MM-DD): ${current}`);
  for (const d of saved) {
    if (!fmt.test(d)) throw new Error(`margin dates.json の日付形式が不正です (YYYY-MM-DD): ${d}`);
  }
  return [...new Set([...saved, current])].sort();
}

export async function main(): Promise<void> {
  const requested = parseDateArg(process.argv.slice(2));
  const data = await fetchDailyMargin(requested);
  // 全 PUT (R2) より前に検証する — 保管失敗時の部分保存を防ぐため。
  validateDailyMarginSnapshot(data.snapshot);
  const input = dailyMarginArchiveInput(data);
  const archived = await recordPrimaryData(input);
  const snapshot = { ...data.snapshot, rawPageId: archived.pageId };
  const basis = snapshot.basisDate;
  await r2Put(`margin/daily/${basis}.json`, JSON.stringify(snapshot));
  const savedRaw = await r2Get("margin/dates.json");
  const saved: string[] = savedRaw === null ? [] : (JSON.parse(savedRaw) as string[]);
  await r2Put("margin/dates.json", JSON.stringify(mergeDailyMarginDates(saved, basis)));
  console.info(
    `margin daily ingest: basis=${basis} pub=${snapshot.publicationDate} rows=${snapshot.rows.length} page=${archived.pageId}`
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
