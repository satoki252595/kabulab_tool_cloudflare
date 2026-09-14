/**
 * ⚠️ **D1 に対して `drizzle-kit push` を絶対に使わない。**
 *
 * `push` は宣言とライブ DB の差分を取り、drizzle が知らないオブジェクトを
 * DROP しようとする。`core_stocks` の `idx_core_stocks_edinet` は
 * `WHERE edinet_code IS NOT NULL` の**部分索引**で、drizzle がこれを完全に
 * 表現できるとは限らない。表現が 1 文字でもずれれば push は「不要な索引」と
 * 判断して落としにかかり、EDINET 突合クエリが無言で全表スキャンに落ちる。
 * 3,700 銘柄 × 日次の経路なので、気付くのは D1 の課金か遅延が出てから。
 *
 * D1 への反映は **`generate` した SQL を読んでから `wrangler d1 execute --file`**
 * の一本道だけ。Neon (postgres) 向けの `db:push:*` は K1a で削除した。
 * D1 用の push スクリプトは作らないこと。
 *
 * 本番 `core_stocks` は 21 列・索引 3 本。うち 12 列と 2 索引は stockStock 側の
 * 移行 P4a (2026-09-12) が直接 ALTER で入れたもので、長らく snapshot が 9 列・
 * 索引 1 本のまま乖離していた。現在は `src/shared/db/core-schema.ts` に宣言を
 * 足して snapshot を揃えてある (drizzle/d1/0010)。**生成済みの 0010 は本番へ
 * 流さない** (適用済み。流すと duplicate column name で落ちる)。
 * 新規 DB / 適用先ごとの手順は drizzle/d1/README.md を読むこと。
 */
import { defineConfig } from "drizzle-kit";

/**
 * Cloudflare D1(SQLite) スキーマ生成設定（ADR-0001）。
 *
 * Neon 用の各 drizzle.<service>.config.ts（dialect=postgresql）とは別に、D1 へ
 * 移行したサービスの sqlite-core スキーマをここへ集約する。D1 は 1 DB = 1 SQLite
 * のため、共有 core と各サービスを単一 DB に同居させ、接頭辞でテーブルを分ける。
 *
 *   pnpm exec drizzle-kit generate --config=drizzle.d1.config.ts   # SQL 生成
 *   wrangler d1 execute kabulab-cf --remote --file=drizzle/d1/<n>.sql  # 反映
 *                                                    ↑ 流す前に drizzle/d1/README.md
 *
 * 移行が進むにつれ schema 配列へ各サービスの sqlite スキーマを追加していく。
 */
export default defineConfig({
  schema: [
    "./src/shared/db/core-schema.ts",
    // L2 投影層 (p_*)。writer は共有の日次 cron、reader は各サービスの画面。
    // 所有が 1 サービスに閉じないのでここへ独立させてある
    // (置き場が暫定である理由と撤去条件はファイル冒頭のコメント)。
    "./src/shared/db/projection-schema.ts",
    "./services/yuho-quant/src/db/schema.ts",
    "./services/ir-catalog/src/db/schema.ts",
    // ADR-0001 第2弾: 001/002/003/004 を Neon→D1 へ移行 (cluster)。
    // swing-readonly.ts は swing/schema.ts のテーブルの再宣言なので追加しない
    // (同名 CREATE TABLE 重複を避ける)。
    "./services/rsi-screening/src/db/schema.ts",
    "./services/swing-trading/src/db/schema.ts",
    "./services/otakara-yutai/src/db/schema.ts",
    // 004 financial-math は所有する表を持たない。旧 finmath_price_snapshot /
    // finmath_daily_ohlcv は読み書きが無くなったので宣言を消し、0012 で DROP する。
  ],
  out: "./drizzle/d1",
  dialect: "sqlite",
});
