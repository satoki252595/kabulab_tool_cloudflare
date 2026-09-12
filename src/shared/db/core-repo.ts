/**
 * 共有 core アクセス層（ADR-0001 / 共通化 P1）。
 *
 * core が単一正本（src/shared/db/core-schema, D1）になったことで、各サービスに
 * 散在していた「コードで1件取得 / 名称・コード検索 / active一覧 / code→id 解決」を
 * ここへ集約する（survey: get-by-code 6箇所・searchStocks 2箇所・listActive 8+箇所）。
 *
 * 設計（CLAUDE.md ルール1/2）: 見つからないものは null / 空配列 を返し、`??` で
 * デフォルト値に化けさせない。銘柄コードの正規化は共有 jpx ヘルパを再利用する。
 *
 * db 引数は drizzle の async SQLite 基底型で受けるため、Worker のバインディング版
 * (DrizzleD1Database) と Node の D1 HTTP 版 (sqlite-proxy) のどちらでも使える。
 */
import { and, eq, like, or, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { stocks } from "./core-schema.js";
import { publicMarketColumn, publicSectorColumn } from "./public-columns.js";
import { parseStockCode } from "../jpx/stock-code.js";

export interface StockRef {
  id: number;
  code: string;
  name: string;
  /**
   * 市場区分。`PUBLISH_JPX_DERIVED_COLUMNS` が `false` の間は常に `null`
   * (JPX 由来 = personal-only なので公開面へ出さない)。詳細は
   * src/shared/db/public-columns.ts。
   */
  market: string | null;
  /** 業種。既定では `core_stocks.sector33` (EDINET 提出者業種)。 */
  sector: string | null;
}

/** core テーブルにアクセスできれば足りる最小の drizzle db 型 */
type CoreDb = BaseSQLiteDatabase<"async", unknown, Record<string, unknown>>;

/**
 * 公開面へ渡してよい列だけを並べた select 形。市場区分と業種は
 * src/shared/db/public-columns.ts 経由 (JPX 由来を直接読まない)。
 *
 * ⚠️ **取込・集計はこの形を使わないこと。** `market` は常に `null`、`sector` は
 * EDINET 由来の `sector33` (本番は当面全行 NULL) なので、ここで引いた値を
 * `core_stocks` へ書き戻すと JPX の値を NULL で潰す。JPX の値が必要な writer は
 * `coreSchema.stocks.market` / `.sector` を自分で指名すること
 * (下の `listActiveStocks` は母集団 = id / code / name の取得用)。
 */
const STOCK_REF = {
  id: stocks.id,
  code: stocks.code,
  name: stocks.name,
  market: publicMarketColumn,
  sector: publicSectorColumn,
} as const;

/** 正準化したコードで 1 銘柄を引く。形式不正・該当なしは null（捏造しない）。 */
export async function getStockByCode(
  db: CoreDb,
  code: string
): Promise<StockRef | null> {
  const c = parseStockCode(code);
  if (c === null) return null;
  const [row] = await db
    .select(STOCK_REF)
    .from(stocks)
    .where(eq(stocks.code, c))
    .limit(1);
  return row ?? null;
}

/** コード→内部 id。該当なしは null。 */
export async function resolveStockId(
  db: CoreDb,
  code: string
): Promise<number | null> {
  const s = await getStockByCode(db, code);
  return s?.id ?? null;
}

/**
 * コード前方/部分一致 or 名称部分一致で active 銘柄を検索。完全一致コードを先頭へ。
 * 空クエリは空配列（架空候補を作らない・ルール1）。
 */
export async function searchStocks(
  db: CoreDb,
  query: string,
  limit = 20
): Promise<StockRef[]> {
  const q = query.trim();
  if (q === "") return [];
  const pat = `%${q}%`;
  const exact = parseStockCode(q); // コードとして妥当な時だけ完全一致を昇格
  return db
    .select(STOCK_REF)
    .from(stocks)
    .where(
      and(eq(stocks.isActive, true), or(like(stocks.code, pat), like(stocks.name, pat)))
    )
    .orderBy(sql`case when ${stocks.code} = ${exact} then 0 else 1 end`, stocks.code)
    .limit(limit);
}

/** active な全銘柄（コード昇順）。日次 sync 等の母集団取得に使う。 */
export async function listActiveStocks(db: CoreDb): Promise<StockRef[]> {
  return db
    .select(STOCK_REF)
    .from(stocks)
    .where(eq(stocks.isActive, true))
    .orderBy(stocks.code);
}

/** code→id の Map。取込で証券コードから stock_id を引く用途。 */
export async function loadCodeToIdMap(db: CoreDb): Promise<Map<string, number>> {
  const rows = await db.select({ id: stocks.id, code: stocks.code }).from(stocks);
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.code, r.id);
  return map;
}
