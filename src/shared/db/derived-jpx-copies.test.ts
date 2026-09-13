/**
 * **保存済みの派生コピー**から JPX 由来が公開面へ漏れるのを防ぐ。
 *
 * `src/shared/db/public-columns.ts` は `core_stocks` を読む経路だけを塞ぐ。
 * ところが日次 cron が JPX の値を別の表へ**コピーして保存**している箇所があり、
 * そこは core_stocks を読まないのでフラグが届かない。
 *
 * 実測 (2026-09-13): 6 サービスから JPX 由来を外した直後も
 * `GET /swing-trading/` だけが「銀行業」「ゴム製品」を返していた。
 * `swing_sector_daily.sector` は `src/cron/daily.ts` が `core_stocks.sector`
 * (= JPX 33 業種) を集約キーにして書いた行だったため。
 *
 * この形は静的には見えない (列名も表名も personal-only を名乗らない) ので、
 * **派生コピーの表を名指しで持ち、公開ルートが読むならフラグで閉じられている
 * ことを要求する**。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PUBLISH_JPX_DERIVED_COLUMNS, SECTOR_DAILY_PUBLIC_KEY_SINCE } from "./public-columns.js";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/**
 * JPX 由来の値を保存している派生表の、drizzle スキーマ上の識別子。
 *
 * 足すときは「その列の値がどこから来たか」を必ず追うこと。表名ではなく
 * **値の出所**が基準。`swing_sector_daily.sector` は `core_stocks.sector` の
 * コピーなので JPX 由来。
 */
const DERIVED_JPX_TABLES = ["sectorDaily"] as const;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".git" || e === "dist") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

/** 公開ルート = services 配下の routes と views (無認証で叩ける面)。 */
const PUBLIC_DIRS = ["services"];

describe("保存済みの派生コピー経由での JPX 由来の漏れ", () => {
  const files = PUBLIC_DIRS.flatMap((d) => walk(join(ROOT, d)));

  it.each(DERIVED_JPX_TABLES)(
    "%s を公開面が読むなら PUBLISH_JPX_DERIVED_COLUMNS で閉じている",
    (table) => {
      const offenders: string[] = [];
      for (const f of files) {
        const src = readFileSync(f, "utf-8");
        // `.from(sectorDaily)` の形で読んでいるか
        if (!new RegExp(String.raw`\.from\(\s*(?:\w+\.)?${table}\s*\)`).test(src)) continue;
        // 同じファイルでフラグを参照していれば、閉じる意図があると見なす。
        // **これは弱い検査**（import だけでも通る）。実際にガードが効いている
        // ことは下の 2 本目が式の形で固定している。ここが拾うのは「フラグの
        // 存在を知らないまま新しく読み始めたファイル」。
        if (src.includes("PUBLISH_JPX_DERIVED_COLUMNS")) continue;
        offenders.push(f.slice(ROOT.length));
      }
      expect(offenders).toEqual([]);
    }
  );

  it("既定 (false) では集約キー切り替え日より前の業種ランキングを引かない", () => {
    // フラグの既定値を固定する。true に倒す判断をしたらこのテストの期待値も
    // 変える (通すためにガードを緩めるのではなく、判断が変わった記録を残す)。
    expect(PUBLISH_JPX_DERIVED_COLUMNS).toBe(false);

    // 2026-09-13 に期待値を変えた。旧: `latestSectorDate && PUBLISH_JPX_DERIVED_COLUMNS`
    // (= 既定では常に閉じる)。日次 cron の集約キーを `publicSectorColumn`
    // (sector33 / EDINET) へ移したので、**切り替え後に書かれた日付の行**は
    // 出してよくなった。
    //
    // ただし `swing_sector_daily` の **2026-09-11 以前の行は JPX 33 業種を
    // キーにしたまま残る** (cron は当日分しか書き直さない。本番の実測で
    // 最新 2026-09-11 = JPX キー 33 業種 + 未分類)。だから日付の下限を外して
    // `latestSectorDate` だけにする変更は漏れの再発で、ここで落とす。
    // 下限の値そのものと、その値が正しい前提は SECTOR_DAILY_PUBLIC_KEY_SINCE の
    // コメント。値でも固定する: 後ろへずらすのは安全側だが、前へずらすと
    // JPX キーの行が出るので、変えるなら理由をコミットに残すこと。
    expect(SECTOR_DAILY_PUBLIC_KEY_SINCE).toBe("2026-09-14");

    const src = readFileSync(join(ROOT, "services/swing-trading/src/routes/pages.ts"), "utf-8");
    expect(src).toMatch(
      /if\s*\(\s*latestSectorDate\s*&&\s*\(\s*PUBLISH_JPX_DERIVED_COLUMNS\s*\|\|\s*latestSectorDate\s*>=\s*SECTOR_DAILY_PUBLIC_KEY_SINCE\s*\)\s*\)/
    );
  });

  it("日次 cron が業種ランキングを書く集約キーは公開面と同じ列", () => {
    // 読み側 (pages.ts) で日付を見て開けている前提は「書き側が公開面と同じ列で
    // 集約している」こと。書き側が `coreSchema.stocks.sector` (JPX) に
    // 戻ると、切り替え日以降の行にも JPX の業種名が入り、読み側のガードは
    // 素通りする。値での確認は src/cron/daily-sector-aggregate.test.ts。
    const src = readFileSync(join(ROOT, "src/cron/daily.ts"), "utf-8");
    const start = src.indexOf("export async function aggregateSectorDaily(");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\n}\n", start));
    expect(body).toMatch(/sector:\s*publicSectorColumn\b/);
    expect(body).not.toMatch(/stocks\.sector\b(?!33)/);
  });
});
