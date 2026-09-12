/**
 * 母集団 (core_stocks) 同期オーケストレータ（Cloudflare D1 / Node 取込版） — ADR-0001。
 *
 * JPX 公式 data_j.xlsx の東証内国株 (プライム/スタンダード/グロース) のうち
 * 共有4文字コード契約に合う ~3,700 銘柄を
 * core_stocks に upsert する。これにより日次/月次 sync・001/003/004 の母集団が
 * 「優待縛り ~1,600」から「東証内国普通株」へ拡張される。
 *
 * 書き込みは Node から D1 REST API 経由 (createD1HttpDb)。D1 はバインディング
 * 経由でのみ触れるが、JPX XLS のパースは Node 専用 (zip/xls) なので取込は Node 側。
 *
 * 設計:
 *   - is_yutai は触らない (otakara の優待スクレイパーが writer)
 *   - 対象外化は **raw JPX (全行)** に code が無いもの、または共有4文字コード契約
 *     の対象外になったものだけに限定する。
 *     これにより優待 REIT 等 (内国普通株フィルタ外だが JPX には掲載) を
 *     誤って inactivate しない
 *
 * CLAUDE.md フォールバック禁止: JPX の件数不足・既存母集団からの異常縮小は
 * 書き込み前に throw し、大量 inactivate を防ぐ。
 *
 * 実行:
 *   pnpm sync:universe              (CLI / scripts/sync/universe.ts)
 *   月次 cron は sync:universe の後に sync:monthly:core を呼ぶ
 */

import { sql, inArray, eq } from "drizzle-orm";
import { createD1HttpDb } from "../shared/db/d1-http-client.js";

import * as coreSchema from "../../services/rsi-screening/src/db/core-schema.js";
import {
  downloadJpxListing,
  isListedEquity,
  type JpxRow,
} from "../shared/jpx/sectors.js";
import { isValidStockCode } from "../shared/jpx/stock-code.js";

type Db = ReturnType<typeof createUniverseDb>;

/**
 * core_stocks への書き込みに必要なメソッドのみを要求する構造的な型。
 * 月次/日次 sync は別スキーマ generic の db を持つため Pick で受け口を広げる。
 */
type CoreWriterDb = Pick<Db, "insert" | "select" | "update">;

/**
 * upsert の bind 上限 (D1: 100/文) 対策チャンク。core_stocks は upsert で
 * 6 列 (code/name/market/sector/is_active/is_yutai既定値) を bind するので
 * 16 行/文 (96 bind) に抑える。
 */
const UPSERT_CHUNK = 16;
/** inactivate の IN リスト bind 上限対策チャンク (1 列 × N 値、80 < 100)。 */
const INACT_CHUNK = 80;
/** 2026-06-30版の raw 行は4,437件。非株式行の欠落も検出する保守的下限。 */
const MIN_JPX_ROWS = 4_000;
/** 2026-06-30版は内国株式3,716件・4文字対象3,709件。部分取得を拒否する下限。 */
const MIN_EQUITY_ROWS = 3_000;
/** 既存active母集団に対し一度に2%超縮小する入力は異常として拒否する。 */
const MIN_EXISTING_COVERAGE = 0.98;
/** 1 run で既存activeの2%超を対象外化する入力は mutation 前に拒否する。 */
const MAX_DEACTIVATION_RATIO = 0.02;

export interface UniverseSyncResult {
  /** JPX ファイル内の基準日 (YYYY-MM-DD) */
  sourceAsOf: string;
  /** data_j.xlsx の全行数 */
  jpxRows: number;
  /** 内国普通株 (sync 対象) 件数 */
  equities: number;
  /** core_stocks に upsert した件数 */
  upserted: number;
  /** raw JPX 不在またはコード契約対象外として inactive にした件数 */
  deactivated: number;
}

export function createUniverseDb() {
  // createD1HttpDb は core_* スキーマを自動登録するので追加スキーマは不要。
  return createD1HttpDb({});
}

/** 部分取得・パース崩れによる大量対象外化を mutation 前に拒否する。 */
export function assertUniverseCoverage(
  rawCount: number,
  equityCount: number,
  existingActiveCount: number,
  pendingDeactivationCount: number
): void {
  if (rawCount < MIN_JPX_ROWS) {
    throw new Error(
      `JPX listing が ${rawCount} 件で安全下限 ${MIN_JPX_ROWS} 件未満です。` +
        " data_j.xlsx の部分取得・列形式変更を疑ってください。"
    );
  }
  if (equityCount < MIN_EQUITY_ROWS) {
    throw new Error(
      `JPX 対象株が ${equityCount} 件で安全下限 ${MIN_EQUITY_ROWS} 件未満です。` +
        " data_j.xlsx の部分取得・列形式変更を疑ってください。"
    );
  }
  if (
    existingActiveCount > 0 &&
    equityCount / existingActiveCount < MIN_EXISTING_COVERAGE
  ) {
    throw new Error(
      `JPX 対象株 ${equityCount} 件が既存 active ${existingActiveCount} 件の ` +
        `${(MIN_EXISTING_COVERAGE * 100).toFixed(0)}% 未満です。` +
        " 大量対象外化を防ぐため同期を中止します。"
    );
  }
  if (
    existingActiveCount > 0 &&
    pendingDeactivationCount / existingActiveCount > MAX_DEACTIVATION_RATIO
  ) {
    throw new Error(
      `対象外化候補 ${pendingDeactivationCount} 件が既存 active ${existingActiveCount} 件の ` +
        `${(MAX_DEACTIVATION_RATIO * 100).toFixed(0)}% を超えています。` +
        " JPX 入力または市場スコープを確認してください。"
    );
  }
}

/** universe のスコープから外す条件を一箇所に固定する。 */
export function shouldDeactivateUniverseCode(
  code: string,
  rawCodes: ReadonlySet<string>
): boolean {
  return !rawCodes.has(code) || !isValidStockCode(code);
}

/**
 * 取得済み JPX 行から core_stocks を東証内国普通株へ同期する。
 *
 * @param db      core スキーマに書ける drizzle クライアント
 * @param jpxRows downloadJpxListing() の戻り (raw 全行を渡すこと)
 */
export async function seedUniverse(
  db: CoreWriterDb,
  jpxRows: JpxRow[]
): Promise<UniverseSyncResult> {
  if (jpxRows.length === 0) {
    throw new Error("JPX listing が 0 行。data_j.xlsx の取得を確認してください。");
  }
  const equities = jpxRows.filter(isListedEquity);
  const sourceDates = new Set(jpxRows.map((row) => row.asOf));
  if (sourceDates.size !== 1) {
    throw new Error(
      `JPX listing の基準日が一意ではありません: ${[...sourceDates].join(", ")}`
    );
  }
  const sourceAsOf = jpxRows[0].asOf;
  const rawCodes = new Set(jpxRows.map((r) => r.code));
  const existing = await db
    .select({ id: coreSchema.stocks.id, code: coreSchema.stocks.code })
    .from(coreSchema.stocks)
    .where(eq(coreSchema.stocks.isActive, true));
  const deactivatedIds = existing
    .filter((s) => shouldDeactivateUniverseCode(s.code, rawCodes))
    .map((s) => s.id);
  assertUniverseCoverage(
    jpxRows.length,
    equities.length,
    existing.length,
    deactivatedIds.length
  );

  // --- 内国普通株を upsert (is_yutai は触らない) ---
  let upserted = 0;
  for (let i = 0; i < equities.length; i += UPSERT_CHUNK) {
    const slice = equities.slice(i, i + UPSERT_CHUNK);
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
          isActive: sql`1`,
          updatedAt: sql`(unixepoch())`,
        },
      });
    upserted += slice.length;
  }

  // --- 対象外化: raw JPX 不在、または共有4文字コード契約の対象外 ---
  // 5桁種類株は Yahoo 自体に存在しても全サービスのコード契約外なので、
  // 過去runでactive化済みの行もここで明示的に外す。
  for (let i = 0; i < deactivatedIds.length; i += INACT_CHUNK) {
    await db
      .update(coreSchema.stocks)
      .set({ isActive: false, updatedAt: sql`(unixepoch())` })
      .where(
        inArray(
          coreSchema.stocks.id,
          deactivatedIds.slice(i, i + INACT_CHUNK)
        )
      );
  }

  return {
    sourceAsOf,
    jpxRows: jpxRows.length,
    equities: equities.length,
    upserted,
    deactivated: deactivatedIds.length,
  };
}

/** CLI / 単独実行用: JPX を DL してから seed する */
export async function runUniverseSync(
  db: CoreWriterDb
): Promise<UniverseSyncResult> {
  const jpxRows = await downloadJpxListing();
  return seedUniverse(db, jpxRows);
}
