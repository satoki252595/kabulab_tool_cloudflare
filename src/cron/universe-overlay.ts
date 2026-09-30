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
  loadAppliedOverlaySets,
  updateCoreStocksMarketByIds,
  type OverlayWriterDb,
} from "./universe.js";
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

/** ISO 8601 (UTC Z) の数値検証。文字列 gate の前提。 */
function isValidIso(s: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(s) &&
    !Number.isNaN(Date.parse(s))
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
      Date.parse(ev.basicFetchedAt) >= Date.parse(batch.eventsFetchedAt) &&
      isFullSha(ev.entrySha) &&
      isFullSha(ev.searchSha) &&
      isFullSha(ev.rawSha) &&
      ev.custody !== null &&
      ev.custody.pageId !== "" &&
      ev.defsPins.countryGuide === DEFS_COUNTRY_GUIDE.sha256 &&
      ev.defsPins.ordinaryCode === DEFS_ORDINARY_CODE.sha256 &&
      ev.qualificationDate !== null &&
      ev.qualificationDate === batch.eligibilityAsOf &&
      (ev.qualificationBasis === "current-owner-qualified" ||
        (ev.qualificationBasis === "current-observation" &&
          observedJstDate(ev.basicFetchedAt) === batch.eligibilityAsOf)) &&
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
  // sector は NULL (EDINET 所有)。instrument_type='equity' は helper が
  // 明示する (NULL だと日次の activeEquityCondition() に載らない)。
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
      const stamp =
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
      // 全文 SHA readback は上記 pageId 確定で完了済み。実 basicFetchedAt の
      // JST 暦日が elig と一致し、同一 cycle の実証拠が positive complete
      // (code4/code5 予備桁 0・event 市場一致・国内短名・defs・世代時刻) の
      // 場合のみ stamp する。日付は実観測 JST 日 (requested elig・UTC 日・
      // listing 日・sourceAsOf の代用禁止)。historic・異日・R3 跨日は HOLD。
      const observedJst =
        stamp === null ? observedJstDate(got.evidence.basicFetchedAt) : null;
      const observed =
        stamp === null &&
        observedJst !== null &&
        observedJst === input.eligibilityAsOf &&
        got.evidence.code4 === row.code &&
        got.evidence.code5 === `${row.code}0` &&
        got.evidence.marketBare === row.market &&
        resolveDomesticFullMarket(got.evidence) !== null &&
        got.evidence.defsPins.countryGuide === DEFS_COUNTRY_GUIDE.sha256 &&
        got.evidence.defsPins.ordinaryCode === DEFS_ORDINARY_CODE.sha256 &&
        isValidIso(batch.eventsFetchedAt) &&
        Date.parse(got.evidence.basicFetchedAt) >=
          Date.parse(batch.eventsFetchedAt)
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
  // 全 code identity を読む (inactive 衝突 HOLD + composer 不要取得の除外)。
  const existing = (await db
    .select({
      id: stocks.id,
      code: stocks.code,
      name: stocks.name,
      market: stocks.market,
      isActive: stocks.isActive,
    })
    .from(stocks)) as OverlayExistingRow[];
  const batch = await opts.collect({
    baseAsOf: sets.baseAsOf,
    eligibilityAsOf: opts.eligibilityAsOf,
    skipBasicsFor: new Set(existing.map((r) => r.code)),
  });
  const result = await applyUniverseOverlay(db, batch, existing);
  assertNoHeldListings(result);
  return { applied: true, result };
}
