/**
 * ⚠️ `core_stocks` は drizzle 管理外で列が先行適用されている。
 *
 * 2026-09-12 に stockStock 側の移行 P4a が、本番 D1 の `core_stocks` へ
 * 12 列 (instrument_type / sector33 / sector17 / edinet_code / listing_status /
 * listing_date / delisting_date / license_tag / src_source / src_data_date /
 * src_fetched_at / quality) と 2 索引 (idx_core_stocks_active_market /
 * idx_core_stocks_edinet) を直接 ALTER で追加した。
 *
 * このため drizzle の最新スナップショット (drizzle/d1/meta/0008_snapshot.json) は
 * `core_stocks` を 9 列・索引 1 本として記録したままで、**本番 (21 列・索引 3 本)
 * と乖離している**。
 *
 * `src/shared/db/core-schema.ts` にこれらの列を足して `pnpm db:generate:d1` を
 * 実行すると、drizzle は 9 列スナップショットとの差分から
 * `ALTER TABLE core_stocks ADD ...` を生成する。そのまま適用すると
 * `duplicate column name` で落ちるので、**生成された SQL から該当文を手で落とす**
 * こと。詳細は stockStock の docs/CF-CANONICAL-DESIGN.md「P4a 実施記録」。
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
 *
 * 移行が進むにつれ schema 配列へ各サービスの sqlite スキーマを追加していく。
 */
export default defineConfig({
  schema: [
    "./src/shared/db/core-schema.ts",
    "./services/yuho-quant/src/db/schema.ts",
    "./services/ir-catalog/src/db/schema.ts",
    // ADR-0001 第2弾: 001/002/003/004 を Neon→D1 へ移行 (cluster)。
    // swing-readonly.ts は swing/schema.ts のテーブルの再宣言なので追加しない
    // (同名 CREATE TABLE 重複を避ける)。
    "./services/rsi-screening/src/db/schema.ts",
    "./services/swing-trading/src/db/schema.ts",
    "./services/otakara-yutai/src/db/schema.ts",
    "./services/financial-math/src/db/finmath-schema.ts",
  ],
  out: "./drizzle/d1",
  dialect: "sqlite",
});
