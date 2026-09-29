/**
 * JPX 信用残高 (日次) の 33 業種別集計 — 取得・解析。
 *
 * GPT-sol 最小 callpath (msg_012a2f098519)。Worker 新 endpoint は作らず、
 * Node の既存経路だけで閉じる:
 *   resolve: 既存 R2 (`scripts/vwap/lib/r2.ts`) から `margin/dates.json` →
 *     実 latest 基準日 → `margin/daily/{基準日}.json` (snapshot replay。
 *     JPX 原本への二重取得なし) → shared 検証 → 既存 D1 HTTP
 *     (`createD1HttpDb` + `activeEquityCondition()` WHERE) で id/code/sector
 *     だけの mapping SELECT → mapping/coverage JSON を固定 capture。
 *   fetch: resolve 取得 input を返す closure (`ResolvedBatch` の既存契約)。
 *   toObservations (adapter): snapshot JSON + mapping JSON の 2 bytes/key から
 *     純粋に 33 業種 (+ 未分類) × 14 指標の drafts を作る。
 *
 * 集計 JSON は derived (JPX 原本と偽らない)。元 PDF の rawPageId/SHA/URL は
 * metadata/typed provenance に保持し、moneyflow 一次データ保管 (capture page)
 * と由来 PDF identity を明示する。保管 replay で同 input を復元でき、
 * 再 Source GET はしない。
 *
 * ライセンス境界: `instrument_type` の値は select しない
 * (`core-stocks-license-boundary.test.ts`)。母集団の述語は
 * `activeEquityCondition()` helper 経由のみ。sector は grouping key として
 * select する (sector-turnover の Worker 集計と同型。非公開の内部面)。
 */
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { activeEquityCondition } from "../../../../src/shared/db/active-equity.js";
import * as coreSchema from "../../../../src/shared/db/core-schema.js";
import { createD1HttpDb } from "../../../../src/shared/db/d1-http-client.js";
import {
  MARGIN_DAILY_FORMAT,
  validateDailyMarginSnapshot,
  type MarginDailyRow,
  type MarginDailySnapshot,
} from "../../../../services/vwap-analysis/lib/margin-daily.js";
import { r2Get } from "../../../../scripts/vwap/lib/r2.js";
import {
  JPX_33_SECTORS,
  MONEYFLOW_UNCLASSIFIED_SECTOR,
} from "../sector-names.js";

/** この取得元の spec 名・冪等キー prefix。 */
export const MARGIN_SECTOR_SPEC_NAME = "jpx-margin-sector";
/** mapping/coverage capture JSON の形式タグ。 */
export const MARGIN_SECTOR_INPUT_FORMAT = "kabulab-margin-sector-input-v1";

/** 残高 6 本 (売/買/一般売/制度売/一般買/制度買)。null なし (原文必須セル)。 */
export interface MarginSectorBalances {
  sell: number;
  buy: number;
  negSell: number;
  stdSell: number;
  negBuy: number;
  stdBuy: number;
}

/** 公式前営業日差 6 本。構成銘柄のいずれかが `-` (未公表) なら null (0 埋めしない)。 */
export interface MarginSectorChg {
  sell: number | null;
  buy: number | null;
  negSell: number | null;
  stdSell: number | null;
  negBuy: number | null;
  stdBuy: number | null;
}

export interface MarginSectorRow {
  sector: string;
  /** 寄与ティッカー数 (activeEquity)。 */
  stockCount: number;
  /** 寄与 PDF 行数 (同一ティッカー複数行あり)。 */
  rowCount: number;
  shares: MarginSectorBalances;
  sharesChg: MarginSectorChg;
  amounts: MarginSectorBalances;
  amountsChg: MarginSectorChg;
}

/**
 * 除外・未解決の内訳。universe の分母は「当該基準日の JPX 行数」
 * (source から定義)。price54missing や全 core active 数を分母にしない。
 * JPX 未掲載銘柄の 0 補完はしない。未解決 mapping はここに残し、
 * STOP 基準 (空母集団・33 欠落・照合不一致・replay 不一致) に触れたら失敗させる。
 *
 * 除外ルール (Sol final HOLD4): ticker だけで join せず、raw 行の eligible を
 * 先に要求する。eligible=false 行・同一ティッカー複数行 (ISIN/行同一性の根拠が
 * 無い合算は不可) は派生集計から除外する。raw 全行は snapshot に保存したまま
 * (除外は派生対象からのみ)。
 */
export interface MarginSectorCoverage {
  /** 対象母集団の PDF 明細行数。 */
  universe: number;
  /** 集計対象行数 (eligible かつ一意ティッカーかつ activeEquity)。 */
  matched: number;
  /** eligible=false のうち ticker 不能行の原文コード (例: 種別欠落行)。 */
  excludedNoTicker: string[];
  /** eligible=false のうち ticker あり行の原文コード (非普通株)。 */
  excludedNonEligible: string[];
  /** 同一ティッカー複数行 (eligible。ISIN 同一性の根拠が無いため合算せず除外)。 */
  duplicateTickers: Array<{ ticker: string; codes: string[] }>;
  /** master に無いティッカー。 */
  excludedNotInMaster: string[];
  /** master にあるが active かつ equity でないティッカー (理由の内訳は出さない)。 */
  excludedOutsideActiveEquity: string[];
  /** sector NULL の active 行数 (未分類へ集計)。 */
  unclassifiedRows: number;
}

export interface MarginSectorReconcile {
  /** 全セクター合計 (残高)。 */
  shares: MarginSectorBalances;
  amounts: MarginSectorBalances;
  /** 除外行の合計 (残高)。 */
  excludedShares: MarginSectorBalances;
  excludedAmounts: MarginSectorBalances;
  /** PDF 総合計 (残高)。合計 + 除外 = 総合計が exact で一致する。 */
  grandShares: MarginSectorBalances;
  grandAmounts: MarginSectorBalances;
}

/**
 * resolve 時に固定 capture する join mapping + coverage (derived JSON)。
 * 集計値 (sums) は持たない — toObservations が snapshot + mapping から
 * 純粋に再計算し、coverage と突合して replay を証明する。
 */
export interface MarginSectorInput {
  format: typeof MARGIN_SECTOR_INPUT_FORMAT;
  basisDate: string;
  publicationDate: string;
  sourceUrl: string;
  pdfSha256: string;
  snapshotKey: string;
  /** activeEquity ティッカー → sector (NULL 可)。 */
  tickerSector: Record<string, string | null>;
  /** master の全ティッカー (除外理由の再導出用)。 */
  masterTickers: string[];
  coverage: MarginSectorCoverage;
}

const BALANCE_KEYS: ReadonlyArray<keyof MarginSectorBalances> = [
  "sell",
  "buy",
  "negSell",
  "stdSell",
  "negBuy",
  "stdBuy",
];

function fail(msg: string): never {
  throw new Error(`margin-sector: ${msg}`);
}

function zeroBalances(): MarginSectorBalances {
  return { sell: 0, buy: 0, negSell: 0, stdSell: 0, negBuy: 0, stdBuy: 0 };
}

function zeroChg(): MarginSectorChg & Record<string, number | null> {
  return { sell: 0, buy: 0, negSell: 0, stdSell: 0, negBuy: 0, stdBuy: 0 };
}

/** snapshot 行の 6 本残高を抜く純関数。 */
function rowBalances(fig: {
  sellOutstanding: number;
  buyOutstanding: number;
  negSell: number;
  stdSell: number;
  negBuy: number;
  stdBuy: number;
}): MarginSectorBalances {
  return {
    sell: fig.sellOutstanding,
    buy: fig.buyOutstanding,
    negSell: fig.negSell,
    stdSell: fig.stdSell,
    negBuy: fig.negBuy,
    stdBuy: fig.stdBuy,
  };
}

/** snapshot 行の 6 本前日比を抜く純関数。 */
function rowChg(fig: {
  sellChg: number | null;
  buyChg: number | null;
  negSellChg: number | null;
  stdSellChg: number | null;
  negBuyChg: number | null;
  stdBuyChg: number | null;
}): MarginSectorChg {
  return {
    sell: fig.sellChg,
    buy: fig.buyChg,
    negSell: fig.negSellChg,
    stdSell: fig.stdSellChg,
    negBuy: fig.negBuyChg,
    stdBuy: fig.stdBuyChg,
  };
}

/** 行単位の解決結果。build (coverage) と aggregate (集計) で共用する単一規則。 */
export type MarginRowStatus =
  | { kind: "included"; sector: string | null }
  | { kind: "excluded"; reason: "noTicker" | "nonEligible" | "duplicate" | "notInMaster" | "outsideActive" };

export interface MarginJoinContext {
  tickerSector: ReadonlyMap<string, string | null>;
  master: ReadonlySet<string>;
  /** eligible 行が 2 件以上あるティッカー。 */
  dupTickers: ReadonlySet<string>;
}

/** eligible 行だけを数えて複数行ティッカー集合を作る純関数。 */
export function findDuplicateTickers(rows: readonly MarginDailyRow[]): Map<string, string[]> {
  const byTicker = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.eligible || row.ordinaryTicker === null) continue;
    const list = byTicker.get(row.ordinaryTicker) ?? [];
    list.push(row.sourceCode);
    byTicker.set(row.ordinaryTicker, list);
  }
  return new Map([...byTicker.entries()].filter(([, codes]) => codes.length > 1));
}

/**
 * snapshot 1 行 → join 解決の純関数 (Sol final HOLD4)。
 * ticker だけで join せず raw 行の eligible を先に要求する。eligible=false 行と
 * 同一ティッカー複数行 (ISIN/行同一性の根拠が無い合算は不可) は除外する。
 */
export function classifyMarginRow(row: MarginDailyRow, ctx: MarginJoinContext): MarginRowStatus {
  const t = row.ordinaryTicker;
  if (!row.eligible) {
    return { kind: "excluded", reason: t === null ? "noTicker" : "nonEligible" };
  }
  if (t === null) return { kind: "excluded", reason: "noTicker" };
  if (ctx.dupTickers.has(t)) return { kind: "excluded", reason: "duplicate" };
  const sector = ctx.tickerSector.get(t);
  if (sector === undefined) {
    return { kind: "excluded", reason: ctx.master.has(t) ? "outsideActive" : "notInMaster" };
  }
  return { kind: "included", sector };
}

/**
 * snapshot 行 → join 解決の純関数。mapping に無いティッカー・master 判定は
 * 呼び出し側の master 集合で行う (replay でも同一規則)。
 */
export function buildMarginSectorInput(
  snapshot: MarginDailySnapshot,
  tickerSector: ReadonlyMap<string, string | null>,
  master: ReadonlySet<string>
): MarginSectorInput {
  validateDailyMarginSnapshot(snapshot);
  const dupGroups = findDuplicateTickers(snapshot.rows);
  const duplicateTickers = [...dupGroups.entries()]
    .map(([ticker, codes]) => ({ ticker, codes: [...codes].sort() }))
    .sort((a, b) => (a.ticker < b.ticker ? -1 : 1));
  const ctx: MarginJoinContext = { tickerSector, master, dupTickers: new Set(dupGroups.keys()) };

  const excludedNoTicker: string[] = [];
  const excludedNonEligible: string[] = [];
  const excludedNotInMaster: string[] = [];
  const excludedOutsideActiveEquity: string[] = [];
  let matched = 0;
  let unclassifiedRows = 0;
  for (const row of snapshot.rows) {
    const st = classifyMarginRow(row, ctx);
    if (st.kind === "included") {
      matched += 1;
      if (st.sector === null) unclassifiedRows += 1;
      continue;
    }
    const t = row.ordinaryTicker as string;
    switch (st.reason) {
      case "noTicker":
        excludedNoTicker.push(row.sourceCode);
        break;
      case "nonEligible":
        excludedNonEligible.push(row.sourceCode);
        break;
      case "duplicate":
        break; // duplicateTickers に記録済み。
      case "notInMaster":
        excludedNotInMaster.push(t);
        break;
      case "outsideActive":
        excludedOutsideActiveEquity.push(t);
        break;
    }
  }
  // ティッカー単位で一意化 (複数行ティッカーの除外は 1 件に)。
  const uniq = (xs: string[]): string[] => [...new Set(xs)].sort();
  return {
    format: MARGIN_SECTOR_INPUT_FORMAT,
    basisDate: snapshot.basisDate,
    publicationDate: snapshot.publicationDate,
    sourceUrl: snapshot.sourceUrl,
    pdfSha256: snapshot.rawSha256,
    snapshotKey: `margin/daily/${snapshot.basisDate}.json`,
    tickerSector: Object.fromEntries([...tickerSector.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
    masterTickers: [...master].sort(),
    coverage: {
      universe: snapshot.rows.length,
      matched,
      excludedNoTicker: excludedNoTicker.sort(),
      excludedNonEligible: excludedNonEligible.sort(),
      duplicateTickers,
      excludedNotInMaster: uniq(excludedNotInMaster),
      excludedOutsideActiveEquity: uniq(excludedOutsideActiveEquity),
      unclassifiedRows,
    },
  };
}

/** capture JSON の形状検査の純関数 (unknown → MarginSectorInput)。 */
export function parseMarginSectorInput(input: unknown): MarginSectorInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    fail("mapping JSON がオブジェクトではありません");
  }
  const r = input as Record<string, unknown>;
  if (r["format"] !== MARGIN_SECTOR_INPUT_FORMAT) fail(`mapping JSON の形式タグが未知です: ${String(r["format"])}`);
  for (const k of ["basisDate", "publicationDate", "sourceUrl", "pdfSha256", "snapshotKey"]) {
    if (typeof r[k] !== "string" || (r[k] as string).length === 0) fail(`mapping JSON の ${k} が非空文字ではありません`);
  }
  if (!/^[0-9a-f]{64}$/.test(r["pdfSha256"] as string)) fail("mapping JSON の pdfSha256 が 64 桁 hex ではありません");
  const ts = r["tickerSector"];
  if (typeof ts !== "object" || ts === null || Array.isArray(ts)) fail("mapping JSON の tickerSector がオブジェクトではありません");
  for (const [k, v] of Object.entries(ts as Record<string, unknown>)) {
    if (v !== null && typeof v !== "string") fail(`mapping JSON の tickerSector[${k}] が string|null ではありません`);
  }
  if (!Array.isArray(r["masterTickers"]) || !(r["masterTickers"] as unknown[]).every((x) => typeof x === "string")) {
    fail("mapping JSON の masterTickers が文字列配列ではありません");
  }
  const c = r["coverage"];
  if (typeof c !== "object" || c === null || Array.isArray(c)) fail("mapping JSON の coverage がオブジェクトではありません");
  const cov = c as Record<string, unknown>;
  for (const k of ["universe", "matched", "unclassifiedRows"]) {
    if (typeof cov[k] !== "number" || !Number.isFinite(cov[k] as number)) fail(`mapping JSON の coverage.${k} が有限数ではありません`);
  }
  for (const k of ["excludedNoTicker", "excludedNonEligible", "excludedNotInMaster", "excludedOutsideActiveEquity"]) {
    if (!Array.isArray(cov[k]) || !(cov[k] as unknown[]).every((x) => typeof x === "string")) {
      fail(`mapping JSON の coverage.${k} が文字列配列ではありません`);
    }
  }
  if (!Array.isArray(cov["duplicateTickers"])) fail("mapping JSON の coverage.duplicateTickers が配列ではありません");
  for (const d of cov["duplicateTickers"] as unknown[]) {
    if (
      typeof d !== "object" ||
      d === null ||
      typeof (d as Record<string, unknown>)["ticker"] !== "string" ||
      !Array.isArray((d as Record<string, unknown>)["codes"]) ||
      ((d as Record<string, unknown>)["codes"] as unknown[]).length < 2
    ) {
      fail("mapping JSON の coverage.duplicateTickers の形が不正です (ticker + 2 件以上の codes)");
    }
  }
  return input as MarginSectorInput;
}

interface SectorAgg {
  tickers: Set<string>;
  rowCount: number;
  shares: MarginSectorBalances;
  sharesChg: MarginSectorChg & Record<string, number | null>;
  amounts: MarginSectorBalances;
  amountsChg: MarginSectorChg & Record<string, number | null>;
}

function newAgg(): SectorAgg {
  return {
    tickers: new Set(),
    rowCount: 0,
    shares: zeroBalances(),
    sharesChg: zeroChg(),
    amounts: zeroBalances(),
    amountsChg: zeroChg(),
  };
}

function addChg(acc: MarginSectorChg & Record<string, number | null>, got: MarginSectorChg): void {
  for (const k of BALANCE_KEYS) {
    const cur = acc[k];
    const v = got[k];
    acc[k] = cur === null || v === null ? null : cur + v;
  }
}

/**
 * snapshot + mapping capture → 33 業種集計の純関数 (toObservations の本体)。
 *   - mapping を snapshot に当てて coverage を再導出し、capture の coverage と
 *     exact 照合する (replay 証明。保管 JSON の差し替え・破損は STOP)。
 *   - STOP 基準: 空母集団・matched 空・33 業種のいずれか空・照合不一致。
 *   - 残高: セクター合計 + 除外合計 = PDF 総合計 (exact)。前日比の合計突合は
 *     しない (原文 `-` の集計定義が未確認のため)。
 */
export function aggregateMarginSectors(
  snapshot: MarginDailySnapshot,
  mapping: MarginSectorInput
): { sectors: MarginSectorRow[]; coverage: MarginSectorCoverage; reconcile: MarginSectorReconcile } {
  validateDailyMarginSnapshot(snapshot);
  if (snapshot.basisDate !== mapping.basisDate) {
    fail(`snapshot と mapping の基準日が不一致です: ${snapshot.basisDate} vs ${mapping.basisDate}`);
  }
  if (snapshot.rawSha256 !== mapping.pdfSha256) {
    fail("snapshot と mapping の pdfSha256 が不一致です (別原本の混入のため STOP)");
  }
  // coverage の再導出 + capture 照合 (replay 証明)。
  const rebuilt = buildMarginSectorInput(
    snapshot,
    new Map(Object.entries(mapping.tickerSector)),
    new Set(mapping.masterTickers)
  );
  const a = JSON.stringify(rebuilt.coverage);
  const b = JSON.stringify(mapping.coverage);
  if (a !== b) fail(`mapping coverage の replay が一致しません (capture 破損のため STOP)`);
  const coverage = mapping.coverage;

  if (!(coverage.universe > 0)) fail(`母集団が空です (universe=${coverage.universe}。成功にしない)`);
  if (!(coverage.matched > 0)) fail(`matched が空です (universe=${coverage.universe}。成功にしない)`);

  const bySector = new Map<string, SectorAgg>();
  const ensure = (sector: string): SectorAgg => {
    const cur = bySector.get(sector);
    if (cur) return cur;
    const fresh = newAgg();
    bySector.set(sector, fresh);
    return fresh;
  };
  const excludedShares = zeroBalances();
  const excludedAmounts = zeroBalances();
  // build と同一の単一規則で解決する (両 callpath 一貫)。
  const ctx: MarginJoinContext = {
    tickerSector: new Map(Object.entries(mapping.tickerSector)),
    master: new Set(mapping.masterTickers),
    dupTickers: new Set(findDuplicateTickers(snapshot.rows).keys()),
  };
  let includedRows = 0;
  let excludedRows = 0;
  for (const row of snapshot.rows) {
    const st = classifyMarginRow(row, ctx);
    if (st.kind === "excluded") {
      excludedRows += 1;
      const bs = rowBalances(row.shares);
      const ba = rowBalances(row.amounts);
      for (const k of BALANCE_KEYS) {
        excludedShares[k] += bs[k];
        excludedAmounts[k] += ba[k];
      }
      continue;
    }
    includedRows += 1;
    const t = row.ordinaryTicker as string;
    const agg = ensure(st.sector ?? MONEYFLOW_UNCLASSIFIED_SECTOR);
    agg.tickers.add(t);
    agg.rowCount += 1;
    const bs = rowBalances(row.shares);
    const ba = rowBalances(row.amounts);
    for (const k of BALANCE_KEYS) {
      agg.shares[k] += bs[k];
      agg.amounts[k] += ba[k];
    }
    addChg(agg.sharesChg, rowChg(row.shares));
    addChg(agg.amountsChg, rowChg(row.amounts));
  }
  // 行会計: 組込 + 除外 = universe、組込 = matched (ゼロ残高行の取りこぼし防止)。
  if (includedRows !== coverage.matched) {
    fail(`組込行数が coverage と不一致です: ${includedRows} != ${coverage.matched}`);
  }
  if (includedRows + excludedRows !== coverage.universe) {
    fail(`行会計が合いません: 組込 ${includedRows} + 除外 ${excludedRows} != ${coverage.universe}`);
  }

  // 33 業種の過不足検査 (未分類はある場合のみ)。
  const want33 = new Set<string>(JPX_33_SECTORS);
  const missing = [...want33].filter((n) => !bySector.has(n));
  const extra = [...bySector.keys()].filter((n) => !want33.has(n) && n !== MONEYFLOW_UNCLASSIFIED_SECTOR);
  if (missing.length > 0 || extra.length > 0) {
    fail(`33 業種と一致しません。不足: [${missing.join(", ")}] 想定外: [${extra.join(", ")}]`);
  }
  const unclassified = bySector.get(MONEYFLOW_UNCLASSIFIED_SECTOR);
  if (unclassified && unclassified.rowCount !== coverage.unclassifiedRows) {
    fail(`未分類の行数が coverage と不一致です: ${unclassified.rowCount} != ${coverage.unclassifiedRows}`);
  }
  if (!unclassified && coverage.unclassifiedRows !== 0) {
    fail(`未分類行が無いのに coverage.unclassifiedRows=${coverage.unclassifiedRows} です`);
  }

  // 残高の照合: セクター合計 + 除外合計 = PDF 総合計 (exact)。
  const grand = snapshot.totals.find((t) => t.scope === "grand" && t.market === null);
  if (!grand) fail("PDF 総合計 (grand) がありません");
  const sumShares = zeroBalances();
  const sumAmounts = zeroBalances();
  for (const agg of bySector.values()) {
    for (const k of BALANCE_KEYS) {
      sumShares[k] += agg.shares[k];
      sumAmounts[k] += agg.amounts[k];
    }
  }
  const grandShares = rowBalances(grand.shares);
  const grandAmounts = rowBalances(grand.amounts);
  for (const k of BALANCE_KEYS) {
    if (sumShares[k] + excludedShares[k] !== grandShares[k]) {
      fail(`株数の照合不一致 (${k}): セクター ${sumShares[k]} + 除外 ${excludedShares[k]} != 総合計 ${grandShares[k]}`);
    }
    if (sumAmounts[k] + excludedAmounts[k] !== grandAmounts[k]) {
      fail(`金額の照合不一致 (${k}): セクター ${sumAmounts[k]} + 除外 ${excludedAmounts[k]} != 総合計 ${grandAmounts[k]}`);
    }
  }

  // 決定順: 正準 33 順 + 未分類末尾。
  const order = new Map<string, number>([...JPX_33_SECTORS].map((n, i) => [n, i]));
  const sectors: MarginSectorRow[] = [...bySector.entries()]
    .map(([sector, agg]) => ({
      sector,
      stockCount: agg.tickers.size,
      rowCount: agg.rowCount,
      shares: agg.shares,
      sharesChg: agg.sharesChg,
      amounts: agg.amounts,
      amountsChg: agg.amountsChg,
    }))
    .sort((x, y) => (order.get(x.sector) ?? 999) - (order.get(y.sector) ?? 999));

  return {
    sectors,
    coverage,
    reconcile: {
      shares: sumShares,
      amounts: sumAmounts,
      excludedShares,
      excludedAmounts,
      grandShares,
      grandAmounts,
    },
  };
}

/** D1 から join mapping を読む最小の drizzle db 型 (Node D1 HTTP 版を渡す)。 */
export type MarginSectorDb = BaseSQLiteDatabase<"async", unknown, Record<string, unknown>>;

/**
 * D1 から ticker → sector mapping + master 集合を読む。
 * activeEquity の述語は helper 経由のみ。select するのは id/code/sector
 * だけで、`instrument_type` の値は読まない (ライセンス境界)。
 * `IN (...)` は使わず全件 SELECT (D1 の 100 bind 上限に触れない)。
 */
export async function loadMarginSectorMaps(db: MarginSectorDb): Promise<{
  tickerSector: Map<string, string | null>;
  master: Set<string>;
}> {
  const activeRows = (await db
    .select({ code: coreSchema.stocks.code, sector: coreSchema.stocks.sector })
    .from(coreSchema.stocks)
    .where(activeEquityCondition())) as Array<{ code: string; sector: string | null }>;
  const masterRows = (await db
    .select({ code: coreSchema.stocks.code })
    .from(coreSchema.stocks)) as Array<{ code: string }>;
  return {
    tickerSector: new Map(activeRows.map((r) => [r.code, r.sector])),
    master: new Set(masterRows.map((r) => r.code)),
  };
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * resolve の本体 (impure: R2 + D1)。実 latest 基準日を R2 から決め
 * (price 最新日/as-of は使わない)、snapshot を replay して mapping を固定する。
 */
export async function resolveMarginSectorBatch(): Promise<{
  key: string;
  basisDate: string;
  snapshotJson: string;
  snapshot: MarginDailySnapshot;
  mapping: MarginSectorInput;
}> {
  const datesRaw = await r2Get("margin/dates.json");
  if (datesRaw === null) fail("R2 margin/dates.json がありません (日次信用残の初回取込がまだです)");
  const dates: unknown = JSON.parse(datesRaw);
  if (!Array.isArray(dates) || dates.length === 0) fail("R2 margin/dates.json が空です");
  for (const d of dates as unknown[]) {
    if (typeof d !== "string" || !YMD_RE.test(d)) fail(`R2 margin/dates.json に不正な日付があります: ${String(d)}`);
  }
  const basisDate = [...(dates as string[])].sort().at(-1) as string;

  const snapshotKey = `margin/daily/${basisDate}.json`;
  const snapshotJson = await r2Get(snapshotKey);
  if (snapshotJson === null) fail(`R2 ${snapshotKey} がありません (dates.json と不整合のため STOP)`);
  const snapshot = JSON.parse(snapshotJson) as MarginDailySnapshot;
  if (snapshot.format !== MARGIN_DAILY_FORMAT) fail(`snapshot の形式タグが未知です: ${String(snapshot.format)}`);
  validateDailyMarginSnapshot(snapshot);
  if (snapshot.basisDate !== basisDate) {
    fail(`snapshot の基準日が index と不一致です: index=${basisDate} body=${snapshot.basisDate}`);
  }
  // 由来 PDF の保管証明が必須 (rawPageId + rawSHA が無い snapshot は使わない)。
  if (typeof snapshot.rawPageId !== "string" || snapshot.rawPageId.length === 0) {
    fail("snapshot に rawPageId (Notion 保管ページ) がありません");
  }
  if (!/^[0-9a-f]{64}$/.test(snapshot.rawSha256)) fail("snapshot の rawSha256 が 64 桁 hex ではありません");

  const db = createD1HttpDb({});
  const { tickerSector, master } = await loadMarginSectorMaps(db);
  const mapping = buildMarginSectorInput(snapshot, tickerSector, master);
  // 出荷前に集計まで通す (STOP 基準に触れたら resolve 時点で失敗させる)。
  aggregateMarginSectors(snapshot, mapping);
  return { key: `${MARGIN_SECTOR_SPEC_NAME}-${basisDate}`, basisDate, snapshotJson, snapshot, mapping };
}
