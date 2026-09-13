/**
 * ソースを静的に走査するテストが共有する**走査範囲と前処理**。
 *
 * 使っているのは src/shared/db/core-stocks-license-boundary.test.ts (personal-only 列
 * の境界) と src/shared/db/active-equity.test.ts (母集団の述語)。2 つが別々に持つと、
 * 公開面のディレクトリを片方にだけ足したときに、もう片方が「走査対象に入っていない
 * ので緑」のまま残る。ここ 1 箇所で決める。
 *
 * このファイルは `tests` ディレクトリに置いてある。`collectSources` は `tests` を
 * 含むパスを走査しないので、検査用の正規表現を持つこのファイル自身は検査に掛からない。
 */
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** リポジトリルート (src/shared/db/tests/ から 4 階層上)。 */
export const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

/**
 * 公開面 = Worker がレスポンスを組み立てる層のディレクトリ。
 *
 * 取込 (data-scripts / src/cron) とスキーマ定義は対象外 (`NOT_PUBLIC_SURFACE`)。
 * core-stocks-license-boundary.test.ts は、ここを走査して見つかった公開面が
 * `PUBLIC_SURFACE` の明示リストに載っているかを見ている。
 */
export const PUBLIC_SURFACE_DIRS = [
  join("services", "rsi-screening", "src"),
  join("services", "swing-trading", "src"),
  join("services", "otakara-yutai"),
  join("services", "financial-math", "src"),
  join("services", "ir-catalog", "src"),
  join("services", "yuho-quant", "src"),
];

/** 公開面の判定から外すもの (取込経路・スキーマ定義・クライアント JS 生成)。 */
export const NOT_PUBLIC_SURFACE = /(^|[\\/])(data-scripts|db|tests)[\\/]/;

/** コメント (ブロック / 行) を除いた実コード。説明文まで弾かないため。 */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** 走査対象のソース (テストと型定義は除く)。 */
export function collectSources(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === "coverage") {
      continue;
    }
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      collectSources(path, acc);
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    if (/\.test\.tsx?$/.test(entry) || /\.d\.ts$/.test(entry)) continue;
    if (relative(ROOT, path).split(sep).includes("tests")) continue;
    acc.push(path);
  }
  return acc;
}
