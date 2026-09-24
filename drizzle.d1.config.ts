/**
 * ⚠️ **D1 に対して `drizzle-kit push` を絶対に使わない。**
 *
 * `push` は宣言とライブ DB の差分を取り、drizzle が知らないオブジェクトを
 * DROP しようとする。かつて `core_stocks` にあった `idx_core_stocks_edinet`
 * (2026-09-25 に列ごと DROP。drizzle/d1/0024) は
 * `WHERE edinet_code IS NOT NULL` の**部分索引**で、drizzle がこれを完全に
 * 表現できるとは限らなかった。表現が 1 文字でもずれれば push は「不要な索引」
 * と判断して落としにかかり、対応するクエリが無言で全表スキャンに落ちる —
 * という**部分索引一般の危険性**を示す実例だった。3,700 銘柄 × 日次の経路
 * なので、気付くのは D1 の課金か遅延が出てから。
 *
 * D1 への反映は **`generate` した SQL を読んでから `wrangler d1 execute --file`**
 * の一本道だけ。Neon (postgres) 向けの `db:push:*` は K1a で削除した。
 * D1 用の push スクリプトは作らないこと。
 *
 * 本番 `core_stocks` は移行 P4a (2026-09-12) 直後は 21 列・索引 3 本だった
 * (stockStock 側が直接 ALTER で 12 列・2 索引を追加し、長らく snapshot が
 * 9 列・索引 1 本のまま乖離していた)。現在は `src/shared/db/core-schema.ts`
 * に宣言を足して snapshot を揃えてある (drizzle/d1/0010)。**生成済みの 0010
 * は本番へ流さない** (適用済み。流すと duplicate column name で落ちる)。
 * その後 `sector17`(0023, 適用済み) と 9 列 + 1 索引(0024, 未適用) を
 * DROP しており、0024 適用後は 11 列・索引 2 本になる。
 * 新規 DB / 適用先ごとの手順は drizzle/d1/README.md を読むこと。
 */
import { defineConfig } from "drizzle-kit";

/**
 * Cloudflare D1(SQLite) スキーマ生成設定。
 *
 * 旧 Neon 用の各 drizzle.<service>.config.ts（dialect=postgresql。K1a で削除済み）とは別に、
 * D1 へ移行したサービスの sqlite-core スキーマをここへ集約する。D1 は 1 DB = 1 SQLite
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
    // 001/002/003/004 の D1 スキーマ。
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
