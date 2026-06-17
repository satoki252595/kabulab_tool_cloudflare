/**
 * 母集団 (core.stocks) 同期オーケストレータ
 *
 * JPX 公式 data_j.xls の内国普通株 (プライム/スタンダード/グロース) ~4,000 を
 * core.stocks に upsert する。これにより日次/月次 sync・001/003/004 の母集団が
 * 「優待縛り ~1,600」から「全 JPX 上場株」へ拡張される。
 *
 * 設計:
 *   - is_yutai は触らない (otakara の優待スクレイパーが writer)
 *   - 廃止判定は **raw JPX (全行)** に code が無いものだけ inactivate する。
 *     これにより優待 REIT 等 (内国普通株フィルタ外だが JPX には掲載) を
 *     誤って inactivate しない
 *
 * CLAUDE.md フォールバック禁止: JPX 取得 0 件・内国株 0 件は throw。
 *
 * 実行:
 *   pnpm sync:universe              (CLI / scripts/sync/universe.ts)
 *   月次 cron からは seedUniverse() を JPX 再 DL 無しで呼ぶ
 */

import { sql, inArray, eq } from "drizzle-orm";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";

import * as coreSchema from "../../services/rsi-screening/src/db/core-schema.js";
import {
  downloadJpxListing,
  isListedEquity,
  type JpxRow,
} from "../shared/jpx/sectors.js";

const SCHEMAS = { ...coreSchema };
type Db = ReturnType<typeof drizzle<typeof SCHEMAS>>;

/**
 * core.stocks への書き込みに必要なメソッドのみを要求する構造的な型。
 * 月次 sync は別スキーマ generic の db を持つため Pick で受け口を広げる。
 */
type CoreWriterDb = Pick<Db, "insert" | "select" | "update">;

/** バルク upsert / inactivate のチャンクサイズ (Neon HTTP 1 リクエスト当たり) */
const CHUNK = 500;

export interface UniverseSyncResult {
  /** data_j.xls の全行数 */
  jpxRows: number;
  /** 内国普通株 (sync 対象) 件数 */
  equities: number;
  /** core.stocks に upsert した件数 */
  upserted: number;
  /** raw JPX に無く inactivate した件数 (上場廃止) */
  delisted: number;
}

export function createUniverseDb(databaseUrl: string): Db {
  return drizzle(neon(databaseUrl), { schema: SCHEMAS });
}

/**
 * 取得済み JPX 行から core.stocks を全 JPX 内国株へ同期する。
 *
 * @param db    core スキーマに書ける drizzle クライアント
 * @param jpxRows downloadJpxListing() の戻り (raw 全行を渡すこと)
 */
export async function seedUniverse(
  db: CoreWriterDb,
  jpxRows: JpxRow[]
): Promise<UniverseSyncResult> {
  if (jpxRows.length === 0) {
    throw new Error("JPX listing が 0 行。data_j.xls の取得を確認してください。");
  }
  const equities = jpxRows.filter(isListedEquity);
  if (equities.length === 0) {
    throw new Error(
      "JPX 内国普通株が 0 件。data_j.xls の市場区分フォーマット変更を疑ってください。"
    );
  }
  const rawCodes = new Set(jpxRows.map((r) => r.code));

  // --- 内国普通株を upsert (is_yutai は触らない) ---
  let upserted = 0;
  for (let i = 0; i < equities.length; i += CHUNK) {
    const slice = equities.slice(i, i + CHUNK);
    await db
      .insert(coreSchema.stocks)
      .values(
        slice.map((r) => ({
          code: r.code,
          name: r.name,
          market: r.marketCategory,
          sector: r.sector33,
          isActive: true,
        }))
      )
      .onConflictDoUpdate({
        target: coreSchema.stocks.code,
        set: {
          name: sql`excluded.name`,
          market: sql`excluded.market`,
          sector: sql`excluded.sector`,
          isActive: sql`true`,
          updatedAt: sql`now()`,
        },
      });
    upserted += slice.length;
  }

  // --- 上場廃止判定: raw JPX に code が無い active 銘柄を inactivate ---
  const existing = await db
    .select({ id: coreSchema.stocks.id, code: coreSchema.stocks.code })
    .from(coreSchema.stocks)
    .where(eq(coreSchema.stocks.isActive, true));
  const delistedIds = existing
    .filter((s) => !rawCodes.has(s.code))
    .map((s) => s.id);
  for (let i = 0; i < delistedIds.length; i += CHUNK) {
    await db
      .update(coreSchema.stocks)
      .set({ isActive: false, updatedAt: sql`now()` })
      .where(inArray(coreSchema.stocks.id, delistedIds.slice(i, i + CHUNK)));
  }

  return {
    jpxRows: jpxRows.length,
    equities: equities.length,
    upserted,
    delisted: delistedIds.length,
  };
}

/** CLI / 単独実行用: JPX を DL してから seed する */
export async function runUniverseSync(
  db: CoreWriterDb
): Promise<UniverseSyncResult> {
  const jpxRows = await downloadJpxListing();
  return seedUniverse(db, jpxRows);
}
