/**
 * 日次取込と公開面の一覧が共有する**母集団の述語** —
 * `core_stocks` の「上場中 (`is_active = 1`) かつ内国普通株 (`instrument_type = 'equity'`)」。
 * 日次 (`loadDailyTargets` / `aggregateSectorDaily` / `rebuildMomentumProjection` /
 * 月次 Phase 2)、公開面の一覧 5 サービス、優待の取込が同じ集合を見る。
 * TDnet / EDINET の取込は下の `disclosureIngestCondition()` (非普通株だけを除く)。
 *
 * 規則 (ライセンス判断 D-13-6 済み。経緯は git 履歴):
 * - `instrument_type` は personal-only のまま。述語に使うことは認めるが、
 *   値は select しない (`market` / `sector` を述語に使うことも禁止)。
 *   使ってよいのは WHERE と JOIN の ON だけ (`select` / `orderBy` / `groupBy` /
 *   関係クエリの `columns` に出さない)。
 * - この helper 1 箇所を経由する場合に限る
 *   (`core-stocks-license-boundary.test.ts` が参照元を固定)。
 * - 片方だけ絞ると分母と分子が別の集合になる (凍結値が一覧に残る・業種集計の
 *   カバレッジを割る)。前提が覆ったら呼び出し元と日次データ供給を両方決めること。
 *
 * 実装上の約束: 値は bind のまま。呼ぶたびに新しい SQL を返す (共有しない)。
 * 新しい呼び出し元を足すときは実際に発行される SQL で rows_read を測ること。
 */
import { and, eq, isNull, or, type SQL } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { INSTRUMENT_TYPE_EQUITY } from "../jpx/instrument-type.js";
import { stocks } from "./core-schema.js";

/** `core_stocks.is_active = 1 AND core_stocks.instrument_type = 'equity'` (値は bind)。 */
export function activeEquityCondition(): SQL {
  return and(
    eq(stocks.isActive, true),
    eq(stocks.instrumentType, INSTRUMENT_TYPE_EQUITY)
  ) as SQL;
}

/**
 * `core_stocks` にアクセスできれば足りる最小の drizzle db 型。Worker のバインディング版
 * (DrizzleD1Database) と Node の D1 HTTP 版 (sqlite-proxy) のどちらも渡せる
 * (src/shared/db/core-repo.ts と同じ形)。
 */
type CoreDb = BaseSQLiteDatabase<"async", unknown, Record<string, unknown>>;

/**
 * TDnet 開示・EDINET 有報の取込が証券コードから `stock_id` を引くときの述語
 * (X-05 で `ingestUniverseCondition` から改名)。
 * `equity OR (is_active = 0 AND instrument_type IS NULL)` (値は bind)。
 *
 * `activeEquityCondition()` と分ける理由: 開示・有報の取込を上場中の銘柄に
 * 絞る決定は無い。`is_active = 0` には上場廃止に加えて地域取引所の単独上場も
 * 入り、読み手は絞っていないので、取込だけ止めると既存の開示が出たまま
 * 更新が止まる。非普通株 (`equity` 以外) と区分が NULL の active 行だけを除く。
 *
 * 既知の限界: universe sync が区分を「非 NULL → NULL」に書き換えた非普通株が
 * 後で対象外化されると取り込む側へ戻る。塞ぐなら universe.ts の挙動変更
 * (この述語の範囲外)。`is_active = 0` も止めるなら `loadIngestCodeToId` の
 * WHERE を `activeEquityCondition()` に替える (ir-catalog の読み手の扱いも決めること)。
 */
export function disclosureIngestCondition(): SQL {
  return or(
    eq(stocks.instrumentType, INSTRUMENT_TYPE_EQUITY),
    and(eq(stocks.isActive, false), isNull(stocks.instrumentType))
  ) as SQL;
}

/**
 * 取込 (TDnet 開示・EDINET 有報) 用の code → `stock_id` 表。母集団は
 * `disclosureIngestCondition()`。表に無いコードは呼び出し側で飛ばす。
 */
export async function loadIngestCodeToId(db: CoreDb): Promise<Map<string, number>> {
  const rows = await db
    .select({ id: stocks.id, code: stocks.code })
    .from(stocks)
    .where(disclosureIngestCondition());
  return new Map(rows.map((r) => [r.code, r.id]));
}

/**
 * 1 コードぶんの `stock_id`。母集団 (active かつ equity) に無ければ `null`。
 *
 * **`core_stocks` に行を足さない。** 以前の優待取込は、見つからなければ INSERT
 * していた。ここで `null` を返し、呼び出し側が件数を記録して飛ばす。
 *
 * rows_read (本番 2026-09-14 実測): 1。`code` の一意索引で引くので、絞らない形と同じ。
 */
export async function findActiveEquityStockId(db: CoreDb, code: string): Promise<number | null> {
  const rows = await db
    .select({ id: stocks.id })
    .from(stocks)
    .where(and(eq(stocks.code, code), activeEquityCondition()));
  return rows[0]?.id ?? null;
}
