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
import { sha256HexBytes } from "../shared/sha256.js";
import {
  collectBasicProfile,
  DEFS_COUNTRY_GUIDE,
  DEFS_ORDINARY_CODE,
  resolveDomesticFullMarket,
  type BasicFetch,
  type BasicProfileEvidence,
  type BasicReceiptPins,
} from "../shared/jpx/basic-profile.js";
import {
  listPageFiles,
  recordPrimaryData,
} from "../shared/notion-archive/index.js";
import {
  listingOfficialEvents,
  universeOverlayState,
} from "../shared/db/universe-events.js";
import type { TransferRow } from "../shared/jpx/transfers.js";
import {
  deactivateCoreStocksByIds,
  insertCoreStocks,
  updateCoreStocksMarketByIds,
  type OverlayStatementBuilder,
  type OverlayWriterDb,
} from "./universe.js";
import {
  toD1BatchStatements,
  type D1BatchStatement,
} from "../shared/db/d1-http-client.js";
import type { UniverseOfficialEventsBatch } from "./universe-official-events.js";

/**
 * C collector の実型を正本とする alias (同型二重維持はしない)。
 * B 側の命名安定のための別名のみ。
 */
/**
 * collector 返却 batch + Basic 分類証拠 (composer が保管後に束縛)。
 * C の型には触らず intersection で足す。証拠なし = 全 IPO HOLD。
 */
export type OverlayBatchInput = UniverseOfficialEventsBatch & {
  basics?: ReadonlyMap<string, BasicProfileEvidence>;
};

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
/** listing insert: 6 binds/行 → 14 行/文 (84 binds)。 */
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
 * ISO 8601 (UTC Z) の暦妥当性検証。文字列 gate の前提。
 * Date.parse は存在しない暦日 (9/31 等) を正規化して通すため、
 * UTC 成分の round-trip 一致を要求する (millis は任意)。
 */
function isValidIso(s: string): boolean {
  const m =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?Z$/.exec(s);
  if (m === null) return false;
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) return false;
  const d = new Date(ms);
  return (
    d.getUTCFullYear() === Number(m[1]) &&
    d.getUTCMonth() + 1 === Number(m[2]) &&
    d.getUTCDate() === Number(m[3]) &&
    d.getUTCHours() === Number(m[4]) &&
    d.getUTCMinutes() === Number(m[5]) &&
    d.getUTCSeconds() === Number(m[6])
  );
}

/** 全文 SHA256 (64 hex) の形式検証。 */
function isFullSha(s: string): boolean {
  return /^[0-9a-f]{64}$/.test(s);
}

/**
 * 実観測 ISO 時刻の JST 暦日 (YYYY-MM-DD)。invalid ISO は null。
 * UTC slice・listing 日・sourceAsOf の代用はしない。
 * sourceAsOf は UNKNOWN のまま (本関数は観測日の読取であり as-of 推定ではない)。
 */
function observedJstDate(iso: string): string | null {
  if (!isValidIso(iso)) return null;
  return new Date(Date.parse(iso) + 9 * 3600 * 1000)
    .toISOString()
    .slice(0, 10);
}

/**
 * batch と既存 core から適用計画を作る。書込も DB 読込もしない純粋関数。
 * 未確定 IPO は listingInserts (market=null) に積み、held 判定は呼び出し側。
 * IPO の market 解決は batch.basics の証拠のみ (hardcoded map なし)。
 * identity・同世代束縛・保管・定義 pins・event 市場一致の全 gate を
 * 満たす国内普通株のみ full-form。欠落・stale・mismatch は null (= HOLD)。
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
    const currentShort = cur.market.slice(0, cur.market.length - suffix.length);
    // chronologically connected chain 検証: to[i] == from[i+1]。
    // 中間 event 欠落は説明不能のため STOP (曖昧 replay 禁止)。
    for (let i = 1; i < group.length; i++) {
      if (group[i].fromMarket !== group[i - 1].toMarket) {
        throw new OverlayHoldError(
          [code],
          `transfer chain 非接続 (${group[i - 1].effectiveDate} ${group[i - 1].fromMarket}→${group[i - 1].toMarket} と ${group[i].effectiveDate} ${group[i].fromMarket}→${group[i].toMarket})。説明不能のため STOP。`
        );
      }
    }
    // resume 位置: 現状態が chain 上の node と一致する末尾 (source 証明 prefix)。
    // 先頭一致なら全体適用。chain 上に無ければ説明不能のため STOP。
    let resume = -1;
    if (currentShort !== group[0].fromMarket) {
      for (let i = group.length - 1; i >= 0; i--) {
        if (group[i].toMarket === currentShort) {
          resume = i;
          break;
        }
      }
      if (resume === -1) {
        throw new OverlayHoldError(
          [code],
          `transfer chain 上に現 ${currentShort} が無い (${group.map((g) => `${g.effectiveDate} ${g.fromMarket}→${g.toMarket}`).join(", ")})。説明不能のため STOP。`
        );
      }
      plan.skipped.transferAlreadyReflected += resume + 1;
    }
    let curShort = currentShort;
    let lastDate = "";
    for (let i = resume + 1; i < group.length; i++) {
      curShort = group[i].toMarket;
      lastDate = group[i].effectiveDate;
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
    const inactiveHit = cur !== undefined && !cur.isActive;
    if (inactiveHit) {
      // inactive 衝突は新上場 identity proof 不足として HOLD (現役化しない)。
      plan.skipped.listingInactiveCollision++;
    }
    // 最終 eligible が廃止なら現役 insert 禁止 (再上場は delist 日 < listing 日で通過)。
    const delistFinal = delistFinalByCode.get(row.code);
    if (delistFinal !== undefined && delistFinal >= row.listingDate) {
      plan.skipped.listingDelisted++;
      continue;
    }
    // 証明済み国内普通株のみ market full-form に解決する。
    // inactive 衝突は証拠があっても HOLD (現役化しない)。
    const ev = batch.basics?.get(row.code);
    let market: string | null = null;
    if (
      !inactiveHit &&
      ev !== undefined &&
      ev.code4 === row.code &&
      ev.code5 === `${row.code}0` &&
      ev.marketBare === row.market &&
      ev.boundEventsFetchedAt !== null &&
      ev.boundEventsFetchedAt === batch.eventsFetchedAt &&
      isValidIso(batch.eventsFetchedAt) &&
      isValidIso(ev.basicFetchedAt) &&
      isValidIso(ev.entryFetchedAt) &&
      isValidIso(ev.searchFetchedAt) &&
      Date.parse(ev.entryFetchedAt) <= Date.parse(ev.searchFetchedAt) &&
      Date.parse(ev.searchFetchedAt) <= Date.parse(ev.basicFetchedAt) &&
      Date.parse(ev.basicFetchedAt) >= Date.parse(batch.eventsFetchedAt) &&
      isFullSha(ev.entrySha) &&
      isFullSha(ev.searchSha) &&
      isFullSha(ev.rawSha) &&
      ev.custody !== null &&
      ev.custody.pageId !== "" &&
      // receipt 3SHA は証拠 3SHA と一致し、保管対応は非空 (両 basis)。
      // page 集合の一致は要求しない (通常 composite 1 頁と
      // reviewed 原本 3 頁は provenance が異なるため)。
      ev.reviewedPins !== null &&
      ev.reviewedPins.entrySha === ev.entrySha &&
      ev.reviewedPins.searchSha === ev.searchSha &&
      ev.reviewedPins.rawSha === ev.rawSha &&
      ev.reviewedPins.custodyPageIds.length > 0 &&
      ev.reviewedPins.custodyPageIds.every((p) => p !== "") &&
      ev.defsPins.countryGuide === DEFS_COUNTRY_GUIDE.sha256 &&
      ev.defsPins.ordinaryCode === DEFS_ORDINARY_CODE.sha256 &&
      ev.qualificationDate !== null &&
      ev.qualificationDate === batch.eligibilityAsOf &&
      (ev.qualificationBasis === "current-owner-qualified" ||
        (ev.qualificationBasis === "current-observation" &&
          observedJstDate(ev.entryFetchedAt) === batch.eligibilityAsOf &&
          observedJstDate(ev.searchFetchedAt) === batch.eligibilityAsOf &&
          observedJstDate(ev.basicFetchedAt) === batch.eligibilityAsOf &&
          observedJstDate(batch.eventsFetchedAt) === batch.eligibilityAsOf &&
          ev.reviewedPins.custodyPageIds.includes(ev.custody.pageId))) &&
      ev.datedSourcePin === null
    ) {
      market = resolveDomesticFullMarket(ev);
    }
    plan.listingInserts.push({
      code: row.code,
      name: row.companyName,
      market,
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

/** snapshot が読む core_stocks 全 11 列 (生の格納値。型は正す)。 */
export interface OverlaySnapshotCoreRow {
  id: number;
  code: string;
  name: string;
  market: string;
  sector: string | null;
  isActive: number;
  isYutai: number;
  createdAt: number;
  updatedAt: number;
  instrumentType: string | null;
  sector33: string | null;
}

/** snapshot が読む state 行 (不在は null)。 */
export interface OverlaySnapshotStateRow {
  id: number;
  baseAsOf: string | null;
  eventsFetchedAt: string | null;
  eventsSha: string | null;
  eligibilityAsOf: string | null;
  appliedAt: string | null;
  appliedDelist: number;
  appliedListing: number;
  appliedTransfer: number;
  heldListingCodes: string | null;
}

/** snapshot が読む events 行 (全 12 列)。 */
export interface OverlaySnapshotEventRow {
  id: number;
  code: string;
  kind: string;
  effectiveDate: string;
  name: string | null;
  marketFrom: string | null;
  marketTo: string | null;
  sourceUrl: string;
  fetchedAt: string;
  rawSha: string;
  archiveKey: string;
  lastSeenFetchedAt: string | null;
}

/**
 * 適用の同一 snapshot。plan と guard はこの同一 object から作る
 * (plan 後に fresh 読替えない。drift の見逃しになる)。
 */
export interface OverlaySnapshot {
  core: OverlaySnapshotCoreRow[];
  state: OverlaySnapshotStateRow | null;
  events: OverlaySnapshotEventRow[];
}

/**
 * batch 1 件分の送信口。本番は `createD1HttpBatchSender()`、テストでは差し替える。
 * 1 回の send が 1 リクエスト (retry 0)。送信口の形は
 * services/otakara-yutai の atomic 適用と同一。
 */
export type OverlayBatchSender = (
  statements: readonly D1BatchStatement[]
) => Promise<void>;

/** D1 1 文の bind 上限。compiler は全ての文で検査する (送る前に止める)。 */
export const OVERLAY_MAX_BINDS_PER_STATEMENT = 100;

/**
 * snapshot を 3 SELECT で読む。drizzle の mode 変換 (boolean/Date) を避け、
 * 格納値そのまま (整数/文字列/NULL) で取るため raw SQL 射影にする。
 * guard の json_extract 比較と型一致させる要請 (型 drift も検知する)。
 */
export async function readOverlaySnapshot(
  db: OverlayWriterDb
): Promise<OverlaySnapshot> {
  const core = (await db
    .select({
      id: sql<number>`id`,
      code: sql<string>`code`,
      name: sql<string>`name`,
      market: sql<string>`market`,
      sector: sql<string | null>`sector`,
      isActive: sql<number>`is_active`,
      isYutai: sql<number>`is_yutai`,
      createdAt: sql<number>`created_at`,
      updatedAt: sql<number>`updated_at`,
      instrumentType: sql<string | null>`instrument_type`,
      sector33: sql<string | null>`sector33`,
    })
    .from(stocks)
    .orderBy(stocks.id)) as OverlaySnapshotCoreRow[];
  const stateRows = (await db
    .select({
      id: sql<number>`id`,
      baseAsOf: sql<string | null>`base_as_of`,
      eventsFetchedAt: sql<string | null>`events_fetched_at`,
      eventsSha: sql<string | null>`events_sha`,
      eligibilityAsOf: sql<string | null>`eligibility_as_of`,
      appliedAt: sql<string | null>`applied_at`,
      appliedDelist: sql<number>`applied_delist`,
      appliedListing: sql<number>`applied_listing`,
      appliedTransfer: sql<number>`applied_transfer`,
      heldListingCodes: sql<string | null>`held_listing_codes`,
    })
    .from(universeOverlayState)
    .orderBy(universeOverlayState.id)) as OverlaySnapshotStateRow[];
  const events = (await db
    .select({
      id: sql<number>`id`,
      code: sql<string>`code`,
      kind: sql<string>`kind`,
      effectiveDate: sql<string>`effective_date`,
      name: sql<string | null>`name`,
      marketFrom: sql<string | null>`market_from`,
      marketTo: sql<string | null>`market_to`,
      sourceUrl: sql<string>`source_url`,
      fetchedAt: sql<string>`fetched_at`,
      rawSha: sql<string>`raw_sha`,
      archiveKey: sql<string>`archive_key`,
      lastSeenFetchedAt: sql<string | null>`last_seen_fetched_at`,
    })
    .from(listingOfficialEvents)
    .orderBy(
      listingOfficialEvents.kind,
      listingOfficialEvents.code,
      listingOfficialEvents.effectiveDate
    )) as OverlaySnapshotEventRow[];
  // singleton 以外 (複数行) は明示 reject (id=1 だけ見て他を隠さない)。
  if (stateRows.length > 1) {
    throw new Error(
      `overlay snapshot STOP: universe_overlay_state が ${stateRows.length} 行 (singleton のみ有効)`
    );
  }
  const snapshot: OverlaySnapshot = {
    core,
    state: stateRows[0] ?? null,
    events,
  };
  assertValidSnapshotShape(snapshot);
  return snapshot;
}

function isFiniteInteger(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

function assertStringOrNull(v: unknown, what: string): void {
  if (v !== null && typeof v !== "string") {
    throw new Error(`overlay snapshot STOP: ${what} が string|null ではない`);
  }
}

/**
 * snapshot の形状検証 (DB 読取にも外部 frozen object にも適用)。
 * state は 0 行または id=1 の 1 行のみ。core の id/code、events の
 * id/(code,kind,effective_date) の重複は Map collapse による計画欠落の
 * ため STOP する (DB 制約は供給 object を検証しない)。
 * 全射影 field は存在 + 格納 primitive/null 型を検証する。JSON 化は
 * NaN/Infinity を null に変質させ undefined を落とすため、guard bind
 * (既に string) より前のこの時点で弾く。不正 snapshot の nullable
 * field が NaN→null で偽一致してはならない。
 */
export function assertValidSnapshotShape(snapshot: OverlaySnapshot): void {
  if (snapshot.state !== null) {
    const st = snapshot.state;
    if (!isFiniteInteger(st.id) || st.id !== 1) {
      throw new Error(
        "overlay snapshot STOP: state 行は id=1 の 1 行のみ有効"
      );
    }
    for (const f of ["baseAsOf", "eventsFetchedAt", "eventsSha", "eligibilityAsOf", "appliedAt", "heldListingCodes"] as const) {
      assertStringOrNull(st[f], `state.${f}`);
    }
    for (const f of ["appliedDelist", "appliedListing", "appliedTransfer"] as const) {
      if (!isFiniteInteger(st[f])) {
        throw new Error(`overlay snapshot STOP: state.${f} が有限整数ではない`);
      }
    }
  }
  for (const r of snapshot.core) {
    if (!isFiniteInteger(r.id)) {
      throw new Error("overlay snapshot STOP: core.id が有限整数ではない");
    }
    for (const f of ["code", "name", "market"] as const) {
      if (typeof r[f] !== "string") {
        throw new Error(`overlay snapshot STOP: core.${f} が string ではない`);
      }
    }
    for (const f of ["sector", "instrumentType", "sector33"] as const) {
      assertStringOrNull(r[f], `core.${f}`);
    }
    for (const f of ["isActive", "isYutai"] as const) {
      if (r[f] !== 0 && r[f] !== 1) {
        throw new Error(`overlay snapshot STOP: core.${f} が 0/1 ではない`);
      }
    }
    for (const f of ["createdAt", "updatedAt"] as const) {
      if (!isFiniteInteger(r[f])) {
        throw new Error(`overlay snapshot STOP: core.${f} が有限整数ではない`);
      }
    }
  }
  for (const r of snapshot.events) {
    if (!isFiniteInteger(r.id)) {
      throw new Error("overlay snapshot STOP: events.id が有限整数ではない");
    }
    for (const f of ["code", "kind", "effectiveDate", "sourceUrl", "fetchedAt", "rawSha", "archiveKey"] as const) {
      if (typeof r[f] !== "string") {
        throw new Error(`overlay snapshot STOP: events.${f} が string ではない`);
      }
    }
    for (const f of ["name", "marketFrom", "marketTo", "lastSeenFetchedAt"] as const) {
      assertStringOrNull(r[f], `events.${f}`);
    }
  }
  const coreIds = new Set<number>();
  for (const r of snapshot.core) {
    if (coreIds.has(r.id)) {
      throw new Error(`overlay snapshot STOP: core id 重複 ${r.id}`);
    }
    coreIds.add(r.id);
  }
  const coreCodes = new Set<string>();
  for (const r of snapshot.core) {
    if (coreCodes.has(r.code)) {
      throw new Error(`overlay snapshot STOP: core code 重複 ${r.code}`);
    }
    coreCodes.add(r.code);
  }
  const evIds = new Set<number>();
  for (const r of snapshot.events) {
    if (evIds.has(r.id)) {
      throw new Error(`overlay snapshot STOP: events id 重複 ${r.id}`);
    }
    evIds.add(r.id);
  }
  const evKeys = new Set<string>();
  for (const r of snapshot.events) {
    const k = JSON.stringify([r.code, r.kind, r.effectiveDate]);
    if (evKeys.has(k)) {
      throw new Error(`overlay snapshot STOP: events 複合重複 ${k}`);
    }
    evKeys.add(k);
  }
}

/**
 * batch 先頭の preflight (CAS guard)。snapshot 不一致は `json('')` の
 * SQL エラーで batch 全体 rollback する。機構は承認済み
 * services/otakara-yutai/data-scripts/atomic-apply.ts の
 * buildStockPreflightStatement と同一 (trigger/guard table なし)。
 *
 * 比較 (全て同一 snapshot 由来。bind は JSON 1 件。SQL は固定):
 * - core 全行の件数 + 全 11 列の両方向 EXCEPT (値・NULL・型・行の
 *   追加/削除を検知。EXCEPT は NULL-safe かつ型区別、json_extract は型保持。
 *   対象外行の drift も縮小せず検知する)
 * - state 全行の件数 + 両方向 EXCEPT (同形で一様に扱う)
 * - events 全行の件数 + 両方向 EXCEPT (同上)
 */
export function buildOverlayPreflightStatement(
  snapshot: OverlaySnapshot
): D1BatchStatement {
  const doc = JSON.stringify({
    count: snapshot.core.length,
    core: snapshot.core,
    state: snapshot.state === null ? [] : [snapshot.state],
    events: snapshot.events,
  });
  const coreCols =
    "id, code, name, market, sector, is_active, is_yutai, created_at, updated_at, instrument_type, sector33";
  const coreJson =
    "json_extract(value,'$.id'), json_extract(value,'$.code'), json_extract(value,'$.name'), json_extract(value,'$.market'), json_extract(value,'$.sector'), json_extract(value,'$.isActive'), json_extract(value,'$.isYutai'), json_extract(value,'$.createdAt'), json_extract(value,'$.updatedAt'), json_extract(value,'$.instrumentType'), json_extract(value,'$.sector33')";
  const stateCols =
    "id, base_as_of, events_fetched_at, events_sha, eligibility_as_of, applied_at, applied_delist, applied_listing, applied_transfer, held_listing_codes";
  const stateJson =
    "json_extract(value,'$.id'), json_extract(value,'$.baseAsOf'), json_extract(value,'$.eventsFetchedAt'), json_extract(value,'$.eventsSha'), json_extract(value,'$.eligibilityAsOf'), json_extract(value,'$.appliedAt'), json_extract(value,'$.appliedDelist'), json_extract(value,'$.appliedListing'), json_extract(value,'$.appliedTransfer'), json_extract(value,'$.heldListingCodes')";
  const evCols =
    "id, code, kind, effective_date, name, market_from, market_to, source_url, fetched_at, raw_sha, archive_key, last_seen_fetched_at";
  const evJson =
    "json_extract(value,'$.id'), json_extract(value,'$.code'), json_extract(value,'$.kind'), json_extract(value,'$.effectiveDate'), json_extract(value,'$.name'), json_extract(value,'$.marketFrom'), json_extract(value,'$.marketTo'), json_extract(value,'$.sourceUrl'), json_extract(value,'$.fetchedAt'), json_extract(value,'$.rawSha'), json_extract(value,'$.archiveKey'), json_extract(value,'$.lastSeenFetchedAt')";
  const sqlText = [
    "-- preflight: snapshot 不一致は SQL エラーで batch 全体 rollback",
    "WITH snap(j) AS (VALUES (?)),",
    `exp_t(${coreCols}) AS (SELECT ${coreJson} FROM json_each(json_extract((SELECT j FROM snap), '$.core'))),`,
    `act_t(${coreCols}) AS (SELECT ${coreCols} FROM core_stocks),`,
    `exp_state(${stateCols}) AS (SELECT ${stateJson} FROM json_each(json_extract((SELECT j FROM snap), '$.state'))),`,
    `act_state(${stateCols}) AS (SELECT ${stateCols} FROM universe_overlay_state),`,
    `exp_ev(${evCols}) AS (SELECT ${evJson} FROM json_each(json_extract((SELECT j FROM snap), '$.events'))),`,
    `act_ev(${evCols}) AS (SELECT ${evCols} FROM universe_official_events)`,
    "SELECT json(CASE WHEN",
    "  (SELECT COUNT(*) FROM core_stocks) = json_extract((SELECT j FROM snap), '$.count')",
    "  AND (SELECT COUNT(*) FROM exp_t) = json_extract((SELECT j FROM snap), '$.count')",
    "  AND (SELECT COUNT(*) FROM act_t) = (SELECT COUNT(*) FROM exp_t)",
    "  AND NOT EXISTS (SELECT * FROM act_t EXCEPT SELECT * FROM exp_t)",
    "  AND NOT EXISTS (SELECT * FROM exp_t EXCEPT SELECT * FROM act_t)",
    "  AND (SELECT COUNT(*) FROM act_state) = (SELECT COUNT(*) FROM exp_state)",
    "  AND NOT EXISTS (SELECT * FROM act_state EXCEPT SELECT * FROM exp_state)",
    "  AND NOT EXISTS (SELECT * FROM exp_state EXCEPT SELECT * FROM act_state)",
    "  AND (SELECT COUNT(*) FROM act_ev) = (SELECT COUNT(*) FROM exp_ev)",
    "  AND NOT EXISTS (SELECT * FROM act_ev EXCEPT SELECT * FROM exp_ev)",
    "  AND NOT EXISTS (SELECT * FROM exp_ev EXCEPT SELECT * FROM act_ev)",
    "THEN 'null' ELSE '' END)",
  ].join("\n");
  return { sql: sqlText, params: [doc] };
}

/** plan + 先頭 guard + 書込 30 文の batch 全体。 */
export interface OverlayBatchPlan {
  plan: OverlayPlan;
  statements: D1BatchStatement[];
}

function eventUpsertBuilders(
  db: OverlayWriterDb,
  batch: OverlayBatchInput,
  upserts: readonly OverlayEventUpsert[]
): OverlayStatementBuilder[] {
  const out: OverlayStatementBuilder[] = [];
  for (let i = 0; i < upserts.length; i += OVERLAY_EVENT_CHUNK) {
    const slice = upserts.slice(i, i + OVERLAY_EVENT_CHUNK);
    out.push(
      db
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
        })
    );
  }
  return out;
}

function stateCommitBuilder(
  db: OverlayWriterDb,
  batch: OverlayBatchInput,
  plan: OverlayPlan,
  listed: number
): OverlayStatementBuilder {
  // base_as_of は月次 seed の所有。conflict 時は events 系のみ更新する。
  // held は pre-send throw のため常に NULL (完全のみ commit する)。
  return db
    .insert(universeOverlayState)
    .values({
      id: 1,
      baseAsOf: batch.baseAsOf,
      eventsFetchedAt: batch.eventsFetchedAt,
      eventsSha: batch.eventsSha,
      eligibilityAsOf: batch.eligibilityAsOf,
      appliedAt: new Date().toISOString(),
      appliedDelist: plan.deactivations.length,
      appliedListing: listed,
      appliedTransfer: plan.marketUpdates.length,
      heldListingCodes: null,
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
}

/**
 * 同一 snapshot から計画と batch 全体を組立てる (副作用なし)。
 * 順序: [guard, events upsert, delist, transfer, IPO inserts, state commit]。
 * 未確定 IPO が 1 件でもあれば sender の前に throw し、core/state/events
 * への書込は 0 (従来の部分書込経路は除去。archive の保管は collector 側で
 * 保全済みのため残る)。全ての文は bind 100 以内を送る前に検査する。
 */
export function planOverlayBatch(
  db: OverlayWriterDb,
  batch: OverlayBatchInput,
  snapshot: OverlaySnapshot
): OverlayBatchPlan {
  // 外部 frozen snapshot も同一検証 (DB 制約は供給 object を守らない)。
  assertValidSnapshotShape(snapshot);
  const byCode = new Map(
    snapshot.core.map((r) => [
      r.code,
      {
        id: r.id,
        code: r.code,
        name: r.name,
        market: r.market,
        isActive: r.isActive === 1,
      } satisfies OverlayExistingRow,
    ])
  );
  const plan = planOverlayDeltas(batch, byCode);

  // IPO: market 未確定 (unknown) が 1 件でもあれば送信前に HOLD。
  const heldCodes = plan.listingInserts
    .filter((l) => l.market === null)
    .map((l) => l.code);
  if (heldCodes.length > 0) {
    throw new OverlayHoldError(
      heldCodes,
      "required IPO 未解決のため不完全失敗 (atomic batch 未送信: core/state/events 書込 0)。"
    );
  }
  // sector は NULL (JPX 月次所有; overlay は書かない)。instrument_type='equity' は helper が
  // 明示する (NULL だと日次の activeEquityCondition() に載らない)。
  const ready = plan.listingInserts.filter(
    (l): l is OverlayListingInsert & { market: string } => l.market !== null
  );

  const guard = buildOverlayPreflightStatement(snapshot);
  // drizzle builder が要るのは toSQL のためだけ。実行は sender が担う。
  const builders: OverlayStatementBuilder[] = [
    ...eventUpsertBuilders(db, batch, plan.eventUpserts),
    ...deactivateCoreStocksByIds(
      db,
      plan.deactivations.map((d) => d.id)
    ),
  ];
  const idsByMarket = new Map<string, number[]>();
  for (const u of plan.marketUpdates) {
    const ids = idsByMarket.get(u.to) ?? [];
    ids.push(u.id);
    idsByMarket.set(u.to, ids);
  }
  for (const [to, ids] of idsByMarket) {
    builders.push(...updateCoreStocksMarketByIds(db, to, ids));
  }
  for (let i = 0; i < ready.length; i += OVERLAY_LISTING_CHUNK) {
    const b = insertCoreStocks(db, ready.slice(i, i + OVERLAY_LISTING_CHUNK));
    if (b !== null) builders.push(b);
  }
  builders.push(stateCommitBuilder(db, batch, plan, ready.length));
  const statements = [guard, ...toD1BatchStatements(builders)];
  for (const [i, s] of statements.entries()) {
    if (s.params.length > OVERLAY_MAX_BINDS_PER_STATEMENT) {
      throw new Error(
        `overlay batch: ${i + 1} 件目の bind ${s.params.length} が上限 ${OVERLAY_MAX_BINDS_PER_STATEMENT} 超 (送らず STOP)`
      );
    }
  }
  return { plan, statements };
}

/**
 * 計画を原子適用する。snapshot は呼出側の確定入力 (必須。内部で
 * fresh 読替えしない — review 済み preimage の無言置換を禁じる)。
 * 同一 snapshot から plan と guard を作り、[guard, 書込] 全体を
 * sender へ 1 回だけ送る (retry 0)。db は toSQL builder 構築専用。
 * 未確定 IPO は送信前に throw し、core/state/events 書込は 0。
 * 件数は送信成功 (sender が全 statements の成否を検査) をもって plan 値で返す。
 * D1 書込は Root grant 後の本番実行のみ。
 */
export async function applyUniverseOverlay(
  db: OverlayWriterDb,
  batch: OverlayBatchInput,
  snapshot: OverlaySnapshot,
  send: OverlayBatchSender
): Promise<OverlayApplyResult> {
  const { plan, statements } = planOverlayBatch(db, batch, snapshot);
  await send(statements);
  return {
    eventsUpserted: plan.eventUpserts.length,
    deactivated: plan.deactivations.length,
    marketUpdated: plan.marketUpdates.length,
    listed: plan.listingInserts.length,
    heldListingCodes: [],
    skipped: plan.skipped,
    stateCommitted: true,
  };
}

export interface EnsureOverlayResult {
  applied: boolean;
  result: OverlayApplyResult | null;
}

/** collector 注入型 (本番は withBasicEvidence 合成済み)。 */
export type OverlayCollectFn = (input: {
  baseAsOf: string | null;
  eligibilityAsOf: string;
  /** core 収録済み code (composer は Basic 取得を省く)。 */
  skipBasicsFor?: ReadonlySet<string>;
}) => Promise<OverlayBatchInput>;

/**
 * Root 承認済みの reviewed qualification input (別途用意)。
 * 日付は requested elig から割り当てない。receipt pins は実保管のもの。
 */
export type ReviewedQualificationInput = ReadonlyMap<
  string,
  {
    date: string;
    basis: "current-owner-qualified";
    marketBare: string;
    receiptPins: BasicReceiptPins;
  }
>;

export interface BasicsComposerDeps {
  collectBasic?: (code4: string) => Promise<{
    entry: BasicFetch;
    search: BasicFetch;
    basic: BasicFetch;
    evidence: BasicProfileEvidence;
  }>;
  record?: typeof recordPrimaryData;
  listFiles?: typeof listPageFiles;
  downloadBytes?: (url: string) => Promise<Uint8Array>;
  /** reviewed qualification input。未指定の code は qualification null。 */
  qualificationInput?: ReviewedQualificationInput;
}

async function defaultBasicsDownloadBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`hosted 再取得に失敗 status=${res.status}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * custody 記録 + 物理 readback (件数・名前一意・全 hosted・全 bytes SHA)。
 * universe-official-events.ts の recordAndVerify と同 pattern (private 実装)。
 */
async function recordBasicsAndVerify(
  record: typeof recordPrimaryData,
  listFiles: typeof listPageFiles,
  downloadBytes: (url: string) => Promise<Uint8Array>,
  key: string,
  source: string,
  fetchedAt: string,
  metadata: Record<string, unknown>,
  files: { filename: string; bytes: Uint8Array; contentType: string }[],
  label: string
): Promise<string> {
  const fail = (why: string): never => {
    throw new Error(`${label} の readback 照合に失敗したため STOP: ${why}`);
  };
  const res = await record({
    service: "universe-basic",
    key,
    source,
    fetchedAt,
    metadata,
    files,
    force: false,
  });
  if (res.fileTooLarge) {
    throw new Error(`${label} の保管が不完全 (fileTooLarge): ${key}`);
  }
  const ok =
    res.outcome === "recorded" ||
    (res.outcome === "skipped_existing" && res.manifestMatch === "same");
  if (!ok) {
    throw new Error(
      `${label} の保管が不完全 (outcome=${res.outcome} manifestMatch=${res.manifestMatch}): ${key}`
    );
  }
  const names = files.map((f) => f.filename);
  if (new Set(names).size !== names.length) fail("添付名の重複 (内部不整合)");
  const hosted = await listFiles(res.pageId, "Files");
  if (hosted.length !== files.length) {
    fail(`添付 ${hosted.length} 件 ≠ 記録 ${files.length} 件`);
  }
  const hostedNames = hosted.map((h) => h.name);
  if (new Set(hostedNames).size !== hostedNames.length) fail("hosted 添付名の重複");
  const byName = new Map(hosted.map((h) => [h.name, h]));
  for (const f of files) {
    const got = byName.get(f.filename) ?? fail(`添付「${f.filename}」なし`);
    if (got.kind !== "file") fail(`「${f.filename}」が Notion-hosted 添付ではありません`);
    const bytes = await downloadBytes(got.url);
    if (bytes.length !== f.bytes.length) {
      fail(`「${f.filename}」のバイト長 ${bytes.length} ≠ ${f.bytes.length}`);
    }
    const [gotSha, wantSha] = await Promise.all([
      sha256HexBytes(Uint8Array.from(bytes)),
      sha256HexBytes(Uint8Array.from(f.bytes)),
    ]);
    if (gotSha !== wantSha) fail(`「${f.filename}」の SHA256 不一致`);
  }
  return res.pageId;
}

/**
 * base batch へ Basic 分類証拠を束縛する composer。
 * 要取得 IPO (eligible・core 未収録・delist 非阻止) の各 code について
 * collectBasicProfile (同 cycle fresh) → 一次保管+readback →
 * custody/bound stamp。保管 key は rawSHA+世代を束縛する
 * (同日変更頁の masquerade 防止)。
 * qualification は reviewed input がある code のみ stamp する。
 * requested elig からの割当・UTC/JST 推定はしない。未指定は null (= HOLD)。
 * 未取得 (失敗・partial 保管済み) は warn + 証拠省略
 * (planner HOLD → assert で不完全失敗)。保管失敗は loud STOP。
 */
export function withBasicEvidence(
  baseCollect: OverlayCollectFn,
  deps: BasicsComposerDeps = {}
): OverlayCollectFn {
  const collectBasic =
    deps.collectBasic ?? ((code4: string) => collectBasicProfile(code4));
  const record = deps.record ?? recordPrimaryData;
  const listFiles = deps.listFiles ?? listPageFiles;
  const downloadBytes = deps.downloadBytes ?? defaultBasicsDownloadBytes;
  const qualificationInput = deps.qualificationInput;
  return async (input) => {
    const batch = await baseCollect(input);
    // planner と同一の delist-final map (不要取得の除外用)。
    const delistFinalByCode = new Map<string, string>();
    for (const row of batch.sources.delisted.rows) {
      if (row.effectiveDate > input.eligibilityAsOf) continue;
      const prev = delistFinalByCode.get(row.code);
      if (prev === undefined || row.effectiveDate > prev) {
        delistFinalByCode.set(row.code, row.effectiveDate);
      }
    }
    const basics = new Map<string, BasicProfileEvidence>();
    for (const row of batch.sources.newListings.rows) {
      if (row.listingDate > input.eligibilityAsOf) continue;
      if (input.skipBasicsFor?.has(row.code) === true) continue;
      const delistFinal = delistFinalByCode.get(row.code);
      if (delistFinal !== undefined && delistFinal >= row.listingDate) continue;
      let got: {
        entry: BasicFetch;
        search: BasicFetch;
        basic: BasicFetch;
        evidence: BasicProfileEvidence;
      };
      try {
        got = await collectBasic(row.code);
      } catch (e) {
        // 得済み partial raw は保管してから省略する (黙殺禁止)。
        const partial = (e as { partial?: Partial<Record<"entry" | "search" | "basic", BasicFetch>> }).partial;
        const partialFiles = (
          [
            ["r1.html", partial?.entry],
            ["r2.html", partial?.search],
            ["r3.html", partial?.basic],
          ] as const
        ).flatMap(([suffix, fetch]) =>
          fetch === undefined
            ? []
            : [{ filename: `${row.code}-${suffix}`, bytes: fetch.bytes, contentType: "text/html" }]
        );
        if (partialFiles.length > 0) {
          const pageId = await recordBasicsAndVerify(
            record,
            listFiles,
            downloadBytes,
            `basic-${row.code}-${input.eligibilityAsOf}-partial`,
            "JPX 東証上場会社情報サービス basic partial",
            batch.eventsFetchedAt,
            { code: row.code, partial: true },
            partialFiles,
            `basic ${row.code} partial`
          );
          console.warn(
            `[universe-overlay] basic ${row.code} partial 保管済み ${pageId} (HOLD へ)`
          );
        } else {
          // 値を含まない message のみ (fail() は bool/count のみ)。
          console.warn(
            `[universe-overlay] basic ${row.code} 取得失敗のため証拠なし (HOLD へ): ${e instanceof Error ? e.message : String(e)}`
          );
        }
        continue;
      }
      const files = [
        {
          filename: `${row.code}-r1.html`,
          bytes: got.entry.bytes,
          contentType: "text/html",
        },
        {
          filename: `${row.code}-r2.html`,
          bytes: got.search.bytes,
          contentType: "text/html",
        },
        {
          filename: `${row.code}-r3.html`,
          bytes: got.basic.bytes,
          contentType: "text/html",
        },
      ];
      const genDigits = batch.eventsFetchedAt.replace(/[^0-9]/g, "");
      const pageId = await recordBasicsAndVerify(
        record,
        listFiles,
        downloadBytes,
        `basic-${row.code}-${input.eligibilityAsOf}-gen-${genDigits}-sha-${got.evidence.rawSha.slice(0, 12)}`,
        "JPX 東証上場会社情報サービス basic (entry/search/basic)",
        got.evidence.basicFetchedAt,
        {
          code: row.code,
          eligibilityAsOf: input.eligibilityAsOf,
          eventsFetchedAt: batch.eventsFetchedAt,
          basicFetchedAt: got.evidence.basicFetchedAt,
          entrySha: got.evidence.entrySha,
          searchSha: got.evidence.searchSha,
          rawSha: got.evidence.rawSha,
          sourceUrl: got.evidence.sourceUrl,
          defsCountryGuide: got.evidence.defsPins.countryGuide,
          defsOrdinaryCode: got.evidence.defsPins.ordinaryCode,
        },
        files,
        `basic ${row.code}`
      );
      // qualification は reviewed input の明示指定のみ。実証拠との束縛:
      // market 一致 + receipt pins の全文 SHA 完全一致を要求する。
      // 将来頁・同 market 別頁への stale 印流用は HOLD。
      const reviewed = qualificationInput?.get(row.code);
      const pins = reviewed?.receiptPins;
      // seam 主張 (evidence) と実 fetch (got) の一致を要求する。
      // 不一致は黙って上書きせず、両 basis とも stamp しない (HOLD)。
      // 原文メタは書き換えない (日付 rewrite 禁止)。
      const seamConsistent =
        got.evidence.entrySha === got.entry.sha256 &&
        got.evidence.searchSha === got.search.sha256 &&
        got.evidence.rawSha === got.basic.sha256 &&
        got.evidence.entryFetchedAt === got.entry.fetchedAt &&
        got.evidence.searchFetchedAt === got.search.fetchedAt &&
        got.evidence.basicFetchedAt === got.basic.fetchedAt;
      const stamp =
        seamConsistent &&
        reviewed !== undefined &&
        /^\d{4}-\d{2}-\d{2}$/.test(reviewed.date) &&
        reviewed.basis === "current-owner-qualified" &&
        reviewed.marketBare === got.evidence.marketBare &&
        pins !== undefined &&
        isFullSha(pins.entrySha) &&
        isFullSha(pins.searchSha) &&
        isFullSha(pins.rawSha) &&
        pins.custodyPageIds.length > 0 &&
        pins.custodyPageIds.every((p) => p !== "") &&
        pins.entrySha === got.entry.sha256 &&
        pins.searchSha === got.search.sha256 &&
        pins.rawSha === got.basic.sha256
          ? {
              date: reviewed.date,
              basis: reviewed.basis,
              pins: {
                entrySha: pins.entrySha,
                searchSha: pins.searchSha,
                rawSha: pins.rawSha,
                custodyPageIds: [...pins.custodyPageIds],
              } satisfies BasicReceiptPins,
            }
          : null;
      // current-observation (通常 caller・reviewed なし用)。3 raw の実保管 +
      // 全文 SHA readback は上記 pageId 確定で完了済み。R1/R2/R3 実受信時刻
      // (got 由来) + event 世代の JST 暦日が全て elig と一致し、実時刻が
      // 順序 (entry≤search≤basic) で、同一 cycle の実証拠が positive
      // complete (code4/code5 予備桁 0・event 市場一致・国内短名・defs・
      // 世代時刻) の場合のみ stamp する。日付は実観測 JST 日 (requested
      // elig・UTC 日・listing 日・sourceAsOf の代用禁止)。UTC 日跨ぎは
      // 許容、JST cycle 跨ぎ・historic・異日は HOLD。
      const r1At = got.entry.fetchedAt;
      const r2At = got.search.fetchedAt;
      const r3At = got.basic.fetchedAt;
      const observedJst =
        stamp === null ? observedJstDate(r3At) : null;
      const observed =
        stamp === null &&
        seamConsistent &&
        observedJst !== null &&
        observedJst === input.eligibilityAsOf &&
        observedJstDate(r1At) === input.eligibilityAsOf &&
        observedJstDate(r2At) === input.eligibilityAsOf &&
        observedJstDate(batch.eventsFetchedAt) === input.eligibilityAsOf &&
        Date.parse(r1At) <= Date.parse(r2At) &&
        Date.parse(r2At) <= Date.parse(r3At) &&
        got.evidence.code4 === row.code &&
        got.evidence.code5 === `${row.code}0` &&
        got.evidence.marketBare === row.market &&
        resolveDomesticFullMarket(got.evidence) !== null &&
        got.evidence.defsPins.countryGuide === DEFS_COUNTRY_GUIDE.sha256 &&
        got.evidence.defsPins.ordinaryCode === DEFS_ORDINARY_CODE.sha256 &&
        Date.parse(r3At) >= Date.parse(batch.eventsFetchedAt)
          ? {
              date: observedJst,
              basis: "current-observation" as const,
              pins: {
                entrySha: got.entry.sha256,
                searchSha: got.search.sha256,
                rawSha: got.basic.sha256,
                custodyPageIds: [pageId],
              } satisfies BasicReceiptPins,
            }
          : null;
      const final = stamp ?? observed;
      basics.set(row.code, {
        ...got.evidence,
        custody: { pageId },
        boundEventsFetchedAt: batch.eventsFetchedAt,
        qualificationDate: final?.date ?? null,
        qualificationBasis: final?.basis ?? null,
        datedSourcePin: null,
        reviewedPins: final?.pins ?? null,
      });
    }
    batch.basics = basics;
    return batch;
  };
}

/**
 * target-load 前の共通 pre-step。既適用なら no-op。
 * 適用時は collect→apply→assert (HOLD 残で不完全失敗を throw)。
 */
export async function ensureUniverseOverlay(
  db: OverlayWriterDb,
  opts: {
    eligibilityAsOf: string;
    collect: OverlayCollectFn;
    /** batch 送信口 (必須。daily/monthly/CLI 同一 seam。fallback なし)。 */
    sendBatch: OverlayBatchSender;
  }
): Promise<EnsureOverlayResult> {
  // 同一 snapshot が base/reuse/skip/plan/guard を駆動する (collect 前に確定)。
  // collect 中の並行変更は guard が送信時に止める。旧 state で collect して
  // 新 state で適用する rebase はしない。owner は確定 frozen snapshot を
  // apply へ直接渡す (本 gate 外。内部読替えなし)。
  const snapshot = await readOverlaySnapshot(db);
  const st = snapshot.state;
  // bootstrap base 未確定なら reuse/collect 前に HOLD。base_as_of は月次 seed の
  // 所有 (成功時のみ commit)。null のまま collector へ進むと bootstrapPartial
  // (当年1年のみ被覆) が適用され、writer が base NULL を永続化する。
  if (st === null || st.baseAsOf === null) {
    throw new OverlayHoldError(
      [],
      "母集団 base 未確定のため bootstrap HOLD (月次 seed が base_as_of を所有。明示 base なしには進行不可)。"
    );
  }
  if (st.eligibilityAsOf === opts.eligibilityAsOf) {
    // 同日再入でも HOLD 残があれば正常 return 禁止 (不完全母数での進行を防ぐ)。
    // held JSON は文字列配列を検証してから使う (cast のみで変な object を
    // 通さない。壊れ値は STOP)。
    let held: readonly string[] = [];
    if (st.heldListingCodes !== null && st.heldListingCodes !== "") {
      const parsed: unknown = JSON.parse(st.heldListingCodes);
      if (
        !Array.isArray(parsed) ||
        !parsed.every((p): p is string => typeof p === "string")
      ) {
        throw new Error(
          `overlay snapshot STOP: held_listing_codes が文字列配列ではない (${st.heldListingCodes.slice(0, 80)})`
        );
      }
      held = parsed;
    }
    if (held.length > 0) {
      throw new OverlayHoldError(
        [...held],
        `elig=${opts.eligibilityAsOf} は HOLD 残ありのため不完全失敗 (再試行で解消するまで進行不可)。`
      );
    }
    // 完全 generation tuple (現世代 pin) の成立を確認して reuse する。
    // eventsFetchedAt/eventsSha は source archive pin、不在なら不完全 HOLD。
    if (
      st.eventsFetchedAt === null ||
      st.eventsSha === null ||
      st.appliedAt === null
    ) {
      throw new OverlayHoldError(
        [],
        `elig=${opts.eligibilityAsOf} の state は不完全な世代 tuple のため HOLD (再適用で解消するまで進行不可)。`
      );
    }
    return { applied: false, result: null };
  }
  const batch = await opts.collect({
    baseAsOf: st.baseAsOf,
    eligibilityAsOf: opts.eligibilityAsOf,
    skipBasicsFor: new Set(snapshot.core.map((r) => r.code)),
  });
  const result = await applyUniverseOverlay(db, batch, snapshot, opts.sendBatch);
  return { applied: true, result };
}
