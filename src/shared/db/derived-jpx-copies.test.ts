/**
 * 業種ランキングの集約キーが公開面と同じ列であることのガード。
 *
 * P5 で切り替え前の JPX キー行を DELETE したため、`swing_sector_daily` に
 * JPX 由来の派生コピーは残っていない (L-64 で日付ガードと派生表リストを撤去)。
 * 残る危険は「書き側が JPX の `sector` に戻る」ことだけなので、集約キーを固定する。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

describe("業種ランキングの集約キー", () => {
  it("日次 cron が業種ランキングを書く集約キーは公開面と同じ列", () => {
    // 書き側が `coreSchema.stocks.sector` (JPX) に戻ると、JPX の業種名が
    // そのまま公開面に出る。値での確認は src/cron/daily-sector-aggregate.test.ts。
    const src = readFileSync(join(ROOT, "src/cron/daily.ts"), "utf-8");
    const start = src.indexOf("export async function aggregateSectorDaily(");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\n}\n", start));
    expect(body).toMatch(/sector:\s*publicSectorColumn\b/);
    expect(body).not.toMatch(/stocks\.sector\b(?!33)/);
  });
});
