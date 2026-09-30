/**
 * 母集団所有者の公式イベント overlay (Issue #196, B 所有)。
 *
 * C collector (`src/cron/universe-official-events.ts`) の batch を受け、
 * events 台帳へ upsert してから core_stocks へ日付順 delta を適用する。
 * batch 型は C の `UniverseOfficialEventsBatch` を正本として import する
 * (同型二重維持はしない)。C 所有 file 自体は B は編集しない。
 *
 * 世代管理: batch.eventsFetchedAt が今回共通世代。events 行の
 * last_seen_fetched_at に刻み、適用は current-gen 一致行のみ。
 * 表から消えた旧予定行 (延期/取消) を自動発効させない。
 * IPO 挿入は分類契約の確定まで guard で HOLD (無言 skip しない)。
 */
import { sql } from "drizzle-orm";
import { stocks } from "../shared/db/core-schema.js";
import {
  listingOfficialEvents,
  universeOverlayState,
} from "../shared/db/universe-events.js";
import type { TransferRow } from "../shared/jpx/transfers.js";
import {
  deactivateCoreStocksByIds,
  insertCoreStocks,
  loadAppliedOverlaySets,
  updateCoreStocksMarketByIds,
  type OverlayWriterDb,
} from "./universe.js";
import type { UniverseOfficialEventsBatch } from "./universe-official-events.js";

/**
 * C collector の実型を正本とする alias (同型二重維持はしない)。
 * B 側の命名安定のための別名のみ。
 */
export type OverlayBatchInput = UniverseOfficialEventsBatch;

/** 適用計画が見る既存 core_stocks 行。 */
export interface OverlayExistingRow {
  id: number;
  code: string;
  name: string;
  market: string;
  isActive: boolean;
}

export interface OverlayEventUpsert {
  code: string;
  kind: "delist" | "listing" | "transfer";
  effectiveDate: string;
  name: string | null;
  marketFrom: string | null;
  marketTo: string | null;
  sourceUrl: string;
  fetchedAt: string;
  rawSha: string;
  archiveKey: string;
}

export interface OverlayDeactivation {
  id: number;
  code: string;
  effectiveDate: string;
}

export interface OverlayMarketUpdate {
  id: number;
  code: string;
  from: string;
  to: string;
  effectiveDate: string;
}

export interface OverlayListingInsert {
  code: string;
  name: string;
  /** full-form market。分類未確定は null (書込不可・guard 対象)。 */
  market: string | null;
  listingDate: string;
}

export interface OverlayPlan {
  eventUpserts: OverlayEventUpsert[];
  deactivations: OverlayDeactivation[];
  marketUpdates: OverlayMarketUpdate[];
  listingInserts: OverlayListingInsert[];
  skipped: {
    delistNotInCore: number;
    delistAlreadyInactive: number;
    transferNotInCore: number;
    transferMarketCurrent: number;
    transferInactive: number;
    transferAlreadyReflected: number;
    listingAlreadyInCore: number;
    listingInactiveCollision: number;
    listingDelisted: number;
    futureDelist: number;
    futureListing: number;
    futureTransfer: number;
  };
}

/** events upsert: 11 binds/行 → 9 行/文 (99 binds)。 */
export const OVERLAY_EVENT_CHUNK = 9;
/** listing insert: 5 binds/行 → 14 行/文 (70 binds)。 */
export const OVERLAY_LISTING_CHUNK = 14;

/** HOLD の拒否ガード。retry-safe (delist/transfer は冪等再適用)。 */
export class OverlayHoldError extends Error {
  readonly codes: readonly string[];
  constructor(codes: readonly string[], reason: string) {
    super(`IPO HOLD (${codes.length}件): ${codes.join(",")}。${reason}`);
    this.name = "OverlayHoldError";
    this.codes = codes;
  }
}

/**
 * 市場区分の接尾辞 (`（内国株式）` 等) を温存取得する。
 * 形式外は null。transfer 適用は接尾辞を推測で補わない。
 */
export function parseMarketSuffix(market: string): string | null {
  const m = market.match(/^(?:プライム|スタンダード|グロース)(（.+）)$/);
  return m?.[1] ?? null;
}

/**
 * batch と既存 core から適用計画を作る。書込も DB 読込もしない純粋関数。
 * 未確定 IPO は listingInserts (market=null) に積み、held 判定は呼び出し側。
 */
export function planOverlayDeltas(
  batch: OverlayBatchInput,
  existingByCode: ReadonlyMap<string, OverlayExistingRow>
): OverlayPlan {
  const plan: OverlayPlan = {
    eventUpserts: [],
    deactivations: [],
    marketUpdates: [],
    listingInserts: [],
    skipped: {
      delistNotInCore: 0,
      delistAlreadyInactive: 0,
      transferNotInCore: 0,
      transferMarketCurrent: 0,
      transferInactive: 0,
      transferAlreadyReflected: 0,
      listingAlreadyInCore: 0,
      listingInactiveCollision: 0,
      listingDelisted: 0,
      futureDelist: 0,
      futureListing: 0,
      futureTransfer: 0,
    },
  };
  const elig = batch.eligibilityAsOf;
  // 同 window の delist 最終日 (IPO との交差判定用)。
  const delistFinalByCode = new Map<string, string>();
  for (const row of batch.sources.delisted.rows) {
    if (row.effectiveDate > elig) continue;
    const prev = delistFinalByCode.get(row.code);
    if (prev === undefined || row.effectiveDate > prev) {
      delistFinalByCode.set(row.code, row.effectiveDate);
    }
  }

  for (const row of batch.sources.delisted.rows) {
    plan.eventUpserts.push({
      code: row.code,
      kind: "delist",
      effectiveDate: row.effectiveDate,
      name: row.companyName,
      marketFrom: null,
      marketTo: row.market,
      sourceUrl: batch.sources.delisted.sourceUrl,
      fetchedAt: batch.eventsFetchedAt,
      rawSha: batch.sources.delisted.rawSha,
      archiveKey: batch.archiveKey,
    });
    if (row.effectiveDate > elig) {
      plan.skipped.futureDelist++;
      continue;
    }
    const cur = existingByCode.get(row.code);
    if (cur === undefined) {
      plan.skipped.delistNotInCore++;
      continue;
    }
    if (!cur.isActive) {
      plan.skipped.delistAlreadyInactive++;
      continue;
    }
    plan.deactivations.push({
      id: cur.id,
      code: row.code,
      effectiveDate: row.effectiveDate,
    });
  }

  // transfer は code 毎に実日付昇順で現在状態へ reduce する。
  // 入力順 (通常 newest-first) のまま適用すると同 code 複数変更で巻戻る。
  const transfersByCode = new Map<string, TransferRow[]>();
  for (const row of batch.sources.transfers.rows) {
    plan.eventUpserts.push({
      code: row.code,
      kind: "transfer",
      effectiveDate: row.effectiveDate,
      name: row.companyName,
      marketFrom: row.fromMarket,
      marketTo: row.toMarket,
      sourceUrl: batch.sources.transfers.sourceUrl,
      fetchedAt: batch.eventsFetchedAt,
      rawSha: batch.sources.transfers.rawSha,
      archiveKey: batch.archiveKey,
    });
    if (row.effectiveDate > elig) {
      plan.skipped.futureTransfer++;
      continue;
    }
    const group = transfersByCode.get(row.code) ?? [];
    group.push(row);
    transfersByCode.set(row.code, group);
  }
  for (const [code, group] of transfersByCode) {
    const dates = group.map((r) => r.effectiveDate);
    if (new Set(dates).size !== dates.length) {
      throw new Error(
        `transfer ${code}: 同日矛盾 (${dates.join(",")})。判定不能のため HOLD (throw)。`
      );
    }
    group.sort((a, b) =>
      a.effectiveDate < b.effectiveDate ? -1 : 1
    );
    const cur = existingByCode.get(code);
    if (cur === undefined) {
      plan.skipped.transferNotInCore++;
      continue;
    }
    if (!cur.isActive) {
      plan.skipped.transferInactive++;
      continue;
    }
    const suffix = parseMarketSuffix(cur.market);
    if (suffix === null) {
      throw new Error(
        `transfer ${code}: 現 market の形式が未知 (${JSON.stringify(cur.market)})。接尾辞を推測しない`
      );
    }
    let curShort = cur.market.slice(0, cur.market.length - suffix.length);
    let lastDate = "";
    for (const ev of group) {
      // fromMarket 整合: 一致のみ連鎖。to 側が現状態と一致すれば
      // 反映済み (source 証明あり) として skip。それ以外は説明不能のため STOP。
      if (ev.fromMarket !== curShort) {
        if (ev.toMarket === curShort) {
          plan.skipped.transferAlreadyReflected++;
          continue;
        }
        throw new OverlayHoldError(
          [code],
          `transfer fromMarket 不一致 (${ev.fromMarket}→${ev.toMarket} に対し現 ${curShort}、${ev.effectiveDate})。説明不能のため STOP。`
        );
      }
      curShort = ev.toMarket;
      lastDate = ev.effectiveDate;
    }
    const next = curShort + suffix;
    if (next === cur.market) {
      plan.skipped.transferMarketCurrent++;
      continue;
    }
    plan.marketUpdates.push({
      id: cur.id,
      code,
      from: cur.market,
      to: next,
      effectiveDate: lastDate,
    });
  }

  for (const row of batch.sources.newListings.rows) {
    plan.eventUpserts.push({
      code: row.code,
      kind: "listing",
      effectiveDate: row.listingDate,
      name: row.companyName,
      marketFrom: null,
      marketTo: row.market,
      sourceUrl: batch.sources.newListings.sourceUrl,
      fetchedAt: batch.eventsFetchedAt,
      rawSha: batch.sources.newListings.rawSha,
      archiveKey: batch.archiveKey,
    });
    if (row.listingDate > elig) {
      plan.skipped.futureListing++;
      continue;
    }
    const cur = existingByCode.get(row.code);
    if (cur !== undefined && cur.isActive) {
      plan.skipped.listingAlreadyInCore++;
      continue;
    }
    if (cur !== undefined && !cur.isActive) {
      // inactive 衝突は新上場 identity proof 不足として HOLD (現役化しない)。
      plan.skipped.listingInactiveCollision++;
    }
    // 最終 eligible が廃止なら現役 insert 禁止 (再上場は delist 日 < listing 日で通過)。
    const delistFinal = delistFinalByCode.get(row.code);
    if (delistFinal !== undefined && delistFinal >= row.listingDate) {
      plan.skipped.listingDelisted++;
      continue;
    }
    // 分類契約が未確定のため market full-form は作らない (null=HOLD)。
    plan.listingInserts.push({
      code: row.code,
      name: row.companyName,
      market: null,
      listingDate: row.listingDate,
    });
  }

  plan.deactivations.sort((a, b) =>
    a.effectiveDate < b.effectiveDate
      ? -1
      : a.effectiveDate > b.effectiveDate
        ? 1
        : 0
  );
  return plan;
}

export interface OverlayApplyResult {
  eventsUpserted: number;
  deactivated: number;
  marketUpdated: number;
  listed: number;
  heldListingCodes: string[];
  skipped: OverlayPlan["skipped"];
  stateCommitted: boolean;
}

export type { OverlayWriterDb };

/**
 * 計画を実行する。順序: events upsert → delist → transfer → IPO guard →
 * inserts → state commit。guard 発動時は delist/transfer まで書込済みで
 * state 未確定 (再実行で冪等継続)。D1 書込は Root grant 後の本番実行のみ。
 */
export async function applyUniverseOverlay(
  db: OverlayWriterDb,
  batch: OverlayBatchInput,
  existing: ReadonlyArray<OverlayExistingRow>
): Promise<OverlayApplyResult> {
  const byCode = new Map(existing.map((r) => [r.code, r]));
  const plan = planOverlayDeltas(batch, byCode);

  // 空 batch でも state 世代は進める (complete empty generation)。
  // 旧世代に留まると stale 世代選択が残る。
  for (let i = 0; i < plan.eventUpserts.length; i += OVERLAY_EVENT_CHUNK) {
    const slice = plan.eventUpserts.slice(i, i + OVERLAY_EVENT_CHUNK);
    await db
      .insert(listingOfficialEvents)
      .values(
        slice.map((e) => ({
          code: e.code,
          kind: e.kind,
          effectiveDate: e.effectiveDate,
          name: e.name,
          marketFrom: e.marketFrom,
          marketTo: e.marketTo,
          sourceUrl: e.sourceUrl,
          fetchedAt: e.fetchedAt,
          rawSha: e.rawSha,
          archiveKey: e.archiveKey,
          lastSeenFetchedAt: batch.eventsFetchedAt,
        }))
      )
      .onConflictDoUpdate({
        target: [
          listingOfficialEvents.code,
          listingOfficialEvents.kind,
          listingOfficialEvents.effectiveDate,
        ],
        // 同 key の訂正 (name/market/source) は fresh 実値で上書きする。
        // lastSeen のみ更新では古い meta が残る。
        set: {
          name: sql`excluded.name`,
          marketFrom: sql`excluded.market_from`,
          marketTo: sql`excluded.market_to`,
          sourceUrl: sql`excluded.source_url`,
          fetchedAt: sql`excluded.fetched_at`,
          rawSha: sql`excluded.raw_sha`,
          archiveKey: sql`excluded.archive_key`,
          lastSeenFetchedAt: sql`excluded.last_seen_fetched_at`,
        },
      });
  }

  // core_stocks 書込は single-writer 契約のため universe.ts helper 経由。
  await deactivateCoreStocksByIds(
    db,
    plan.deactivations.map((d) => d.id)
  );

  const idsByMarket = new Map<string, number[]>();
  for (const u of plan.marketUpdates) {
    const ids = idsByMarket.get(u.to) ?? [];
    ids.push(u.id);
    idsByMarket.set(u.to, ids);
  }
  for (const [to, ids] of idsByMarket) {
    await updateCoreStocksMarketByIds(db, to, ids);
  }

  // IPO: market 未確定 (unknown) は HOLD。確定 positive のみ挿入する。
  // 汎用 permission flag による暫定固定停止は残さない。
  // HOLD は throw せず結果に載せる。loudness は assertNoHeldListings が担う。
  const heldCodes = plan.listingInserts
    .filter((l) => l.market === null)
    .map((l) => l.code);
  // sector は NULL (EDINET 所有)。instrument_type も NULL のまま
  // (月次 backfill が充填。書くのは universe sync だけ)。
  const ready = plan.listingInserts.filter(
    (l): l is OverlayListingInsert & { market: string } => l.market !== null
  );
  for (let i = 0; i < ready.length; i += OVERLAY_LISTING_CHUNK) {
    await insertCoreStocks(db, ready.slice(i, i + OVERLAY_LISTING_CHUNK));
  }

  // base_as_of は月次 seed の所有。conflict 時は events 系のみ更新する。
  // held (per-code UNKNOWN) は NULL/空=完全。HOLD 残は不完全として記録する。
  const heldJson = heldCodes.length > 0 ? JSON.stringify(heldCodes) : null;
  await db
    .insert(universeOverlayState)
    .values({
      id: 1,
      baseAsOf: batch.baseAsOf,
      eventsFetchedAt: batch.eventsFetchedAt,
      eventsSha: batch.eventsSha,
      eligibilityAsOf: batch.eligibilityAsOf,
      appliedAt: new Date().toISOString(),
      appliedDelist: plan.deactivations.length,
      appliedListing: ready.length,
      appliedTransfer: plan.marketUpdates.length,
      heldListingCodes: heldJson,
    })
    .onConflictDoUpdate({
      target: universeOverlayState.id,
      set: {
        eventsFetchedAt: sql`excluded.events_fetched_at`,
        eventsSha: sql`excluded.events_sha`,
        eligibilityAsOf: sql`excluded.eligibility_as_of`,
        appliedAt: sql`excluded.applied_at`,
        appliedDelist: sql`excluded.applied_delist`,
        appliedListing: sql`excluded.applied_listing`,
        appliedTransfer: sql`excluded.applied_transfer`,
        heldListingCodes: sql`excluded.held_listing_codes`,
      },
    });

  return {
    eventsUpserted: plan.eventUpserts.length,
    deactivated: plan.deactivations.length,
    marketUpdated: plan.marketUpdates.length,
    listed: ready.length,
    heldListingCodes: heldCodes,
    skipped: plan.skipped,
    stateCommitted: true,
  };
}

/**
 * HOLD 残ありの結果を不完全失敗にする。未知 IPO を除いた母数での
 * 正常完了・株価 fetch 継続を禁止する。daily/monthly pre-step と
 * 単独 entry の両方が適用後に呼ぶ (retry-safe)。
 */
export function assertNoHeldListings(result: OverlayApplyResult): void {
  if (result.heldListingCodes.length > 0) {
    throw new OverlayHoldError(
      result.heldListingCodes,
      "required IPO 未解決のため不完全失敗 (delist/transfer は適用済み)。"
    );
  }
}

export interface EnsureOverlayResult {
  applied: boolean;
  result: OverlayApplyResult | null;
}

/** collector 注入型 (本番は C の collectUniverseOfficialEvents)。 */
export type OverlayCollectFn = (input: {
  baseAsOf: string | null;
  eligibilityAsOf: string;
}) => Promise<UniverseOfficialEventsBatch>;

/**
 * target-load 前の共通 pre-step。既適用なら no-op。
 * 適用時は collect→apply→assert (HOLD 残で不完全失敗を throw)。
 */
export async function ensureUniverseOverlay(
  db: OverlayWriterDb,
  opts: {
    eligibilityAsOf: string;
    collect: OverlayCollectFn;
  }
): Promise<EnsureOverlayResult> {
  const sets = await loadAppliedOverlaySets(db);
  if (sets.eligibilityAsOf === opts.eligibilityAsOf) {
    // 同日再入でも HOLD 残があれば正常 return 禁止 (不完全母数での進行を防ぐ)。
    if (sets.heldListingCodes.length > 0) {
      throw new OverlayHoldError(
        sets.heldListingCodes,
        `elig=${opts.eligibilityAsOf} は HOLD 残ありのため不完全失敗 (再試行で解消するまで進行不可)。`
      );
    }
    // 完全 generation tuple (現世代 pin) の成立を確認して reuse する。
    // eventsFetchedAt/eventsSha は source archive pin、不在なら不完全 HOLD。
    if (
      sets.eventsFetchedAt === null ||
      sets.eventsSha === null ||
      sets.appliedAt === null
    ) {
      throw new OverlayHoldError(
        [],
        `elig=${opts.eligibilityAsOf} の state は不完全な世代 tuple のため HOLD (再適用で解消するまで進行不可)。`
      );
    }
    return { applied: false, result: null };
  }
  const batch = await opts.collect({
    baseAsOf: sets.baseAsOf,
    eligibilityAsOf: opts.eligibilityAsOf,
  });
  // 全 code identity を読む (inactive 衝突の HOLD 判定に必要)。
  const existing = (await db
    .select({
      id: stocks.id,
      code: stocks.code,
      name: stocks.name,
      market: stocks.market,
      isActive: stocks.isActive,
    })
    .from(stocks)) as OverlayExistingRow[];
  const result = await applyUniverseOverlay(db, batch, existing);
  assertNoHeldListings(result);
  return { applied: true, result };
}
