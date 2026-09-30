/**
 * Issue #163: 2026-09-29 OHLCV 欠損 54 銘柄の固定診断 (手動実行)。
 *
 * GPT-sol 最終設計 (PREP)。通常の 3700 件 producer には手を付けない:
 *
 * - 対象は D1 SELECT で固定した 54 コード × date=2026-09-29 のみ。
 *   実 run 冒頭で live anti-join を再確認し、集合がずれていたら STOP する。
 * - 取得は Yahoo Chart 5y/1d だけを 54 GET (QuoteSummary は叩かない)。
 *   既存 `fetchChart` の任意 raw-capture hook (`response.clone()`、
 *   HTTP 判定・parse・guard より前) で原文 bytes を取る。二重 GET なし。
 * - 診断バッチ 1 行を共有 `recordPrimaryData` (service "stock-sync") に
 *   冪等 key 1 件で記録する。コード別 Chart 原文 bytes 添付 + manifest
 *   (code/HTTP 状態/SHA/未取得理由) 添付。記録後は `listPageFiles` +
 *   SHA で件数・名前・hosted・全 bytes を readback 照合する。
 * - 429/中断は取得済み分を partial 保管し、未取得を unknown として STOP。
 * - 9/29 バーは exact date で選ぶ。9/30 以降の末尾を 9/29 鮮度判定に使わない。
 *   sanitize 棄却された raw 9/29 バーを source absent と混同しない。
 * - Chart が正常でも旧 run の失敗理由は未確定のまま。次回通常 run の
 *   PR180 batch と照合する (本診断では断定しない)。
 * - D1 は SELECT のみ。修復 (D1 書込) は別 grant。live 実行は `--execute`
 *   が無いと起動しない (事故防止)。
 */
import { and, eq, isNotNull } from "drizzle-orm";
import { $ZodError } from "zod/v4/core";
import {
  createDailyDb,
  createDailyStockStartGate,
  loadDailyTargets,
  priceSyncBatchRunId,
} from "../../src/cron/daily.js";
import {
  fetchChart,
  parseChartResponse,
  type ChartResult,
} from "../../src/shared/yahoo/client.js";
import { recordPrimaryData, verifyArchivedAttachments } from "../../src/shared/notion-archive/index.js";
import { sha256HexBytes } from "../../src/shared/sha256.js";
import { requireYahooProxyForNodeSync, sharedEnv } from "../../src/shared/env.js";
import { rootCauseMessage } from "../../src/shared/errors.js";
import * as swingSchema from "../../services/swing-trading/src/db/schema.js";
import type { DailyOhlcv } from "../../src/shared/types.js";

/** D1 SELECT 用の DB handle (`createDailyDb` の戻り。書込には使わない)。 */
type DiagDb = ReturnType<typeof createDailyDb>;

/** 固定診断日。 */
export const STOCK_GAP_DIAG_DATE = "2026-09-29";
/** 本番と同一 range (sanitize の semantics を変えないため 5y を維持)。 */
const CHART_RANGE = "5y";
const SERVICE = "stock-sync";
/** 逐次 GET の開始間隔 (手動診断は控えめに。429 backoff は gate が吸収)。 */
const DIAG_START_INTERVAL_MS = 500;

/**
 * D1 SELECT で固定した 9/29 欠損 54 コード (52 latest_date<9/29 + 1909/2180
 * indicator 行なし)。順序は取得順。無断で変えない (drift 検出の基準)。
 */
export const STOCK_GAP_54_CODES: readonly string[] = [
  "1380", "1787", "1905", "1948", "291A", "3184", "3439", "3477",
  "3480", "3495", "3583", "3600", "3856", "3944", "4365", "4464",
  "4629", "4800", "4976", "5202", "5484", "5969", "5990", "6396",
  "6408", "6486", "6558", "6566", "7067", "7082", "7240", "7413",
  "7426", "7515", "7523", "7565", "7812", "7857", "7877", "9012",
  "9017", "9049", "9087", "9223", "9313", "9331", "9361", "9362",
  "9508", "9691", "9698", "9914", "1909", "2180",
];
{
  const uniq = new Set(STOCK_GAP_54_CODES);
  if (STOCK_GAP_54_CODES.length !== 54 || uniq.size !== 54) {
    throw new Error("STOCK_GAP_54_CODES が 54 件の一意集合ではありません (固定対象の破損)");
  }
}

/** 54 件の分類 (全件無省略。`unknown` は STOP 時・未試行に使う)。 */
export type GapCategory =
  | "source_gap"
  | "stale"
  | "priceguard"
  | "http"
  | "parse"
  | "has_real_bar"
  | "unknown";

export type FetchOutcome =
  | { kind: "ok"; status: number; rawBars: DailyOhlcv[]; sanitized: DailyOhlcv[] }
  | { kind: "http"; status: number; message: string }
  | { kind: "parse"; message: string; upstream: boolean }
  | { kind: "guard"; message: string }
  | { kind: "noresponse"; message: string };

export interface GapEvidence {
  reason: string;
  status?: number | null;
  message?: string;
  tailDate?: string | null;
  close?: number | null;
  adj?: number | null;
  volume?: number | null;
  bars?: number;
}

/**
 * 保管済み原文 bytes の再 parse (診断と本番で同一の `parseChartResponse`)。
 * JSON 構文・zod・Chart error payload の失敗は呼び出し側で分類する。
 */
export function parseCapturedChart(code: string, bytes: Uint8Array): DailyOhlcv[] {
  return parseChartResponse(JSON.parse(new TextDecoder().decode(bytes)), code).bars;
}

/**
 * 1 コードぶんの取得結果を分類する (純粋関数)。
 * 9/29 バーは exact date で選ぶ。sanitize で落とされた raw 9/29 正値バーは
 * priceguard (source absent と混同しない)。正の 9/29 値を捏造・上書きしない
 * (観測値の報告のみ)。
 */
export function classifyGap(code: string, outcome: FetchOutcome): {
  category: GapCategory;
  evidence: GapEvidence;
  stop: boolean;
} {
  void code;
  switch (outcome.kind) {
    case "noresponse":
      return {
        category: "unknown",
        evidence: { reason: "no-response", status: null, message: outcome.message },
        stop: true,
      };
    case "http":
      if (outcome.status === 429 || (outcome.status >= 500 && outcome.status <= 599)) {
        return {
          category: "unknown",
          evidence: { reason: "transient-http", status: outcome.status, message: outcome.message },
          stop: true,
        };
      }
      return {
        category: "http",
        evidence: { reason: "definitive-http", status: outcome.status, message: outcome.message },
        stop: false,
      };
    case "parse":
      return {
        category: outcome.upstream ? "http" : "parse",
        evidence: {
          reason: outcome.upstream ? "upstream-error-payload" : "malformed-body",
          message: outcome.message,
        },
        stop: false,
      };
    case "guard":
      return {
        category: "priceguard",
        evidence: { reason: "response-incoherent", message: outcome.message },
        stop: false,
      };
    case "ok": {
      const { rawBars, sanitized } = outcome;
      if (rawBars.length === 0) {
        return {
          category: "source_gap",
          evidence: { reason: "no-bars", status: outcome.status, bars: 0 },
          stop: false,
        };
      }
      const raw29 = rawBars.find((b) => b.date === STOCK_GAP_DIAG_DATE) ?? null;
      if (raw29 === null) {
        const tail = rawBars[rawBars.length - 1].date;
        if (tail < STOCK_GAP_DIAG_DATE) {
          return {
            category: "stale",
            evidence: { reason: "tail-before-date", status: outcome.status, tailDate: tail },
            stop: false,
          };
        }
        return {
          category: "source_gap",
          evidence: { reason: "bar-missing", status: outcome.status, tailDate: tail },
          stop: false,
        };
      }
      const used = raw29.adj ?? raw29.close;
      if (used === null || !Number.isFinite(used) || used <= 0) {
        return {
          category: "source_gap",
          evidence: {
            reason: "null-or-nonpositive-close",
            status: outcome.status,
            close: raw29.close,
            adj: raw29.adj,
            volume: raw29.volume,
          },
          stop: false,
        };
      }
      const san29 = sanitized.find((b) => b.date === STOCK_GAP_DIAG_DATE) ?? null;
      if (san29 === null) {
        return {
          category: "priceguard",
          evidence: {
            reason: "sanitize-rejected",
            status: outcome.status,
            close: raw29.close,
            adj: raw29.adj,
            volume: raw29.volume,
          },
          stop: false,
        };
      }
      return {
        category: "has_real_bar",
        evidence: {
          reason: "positive-bar-kept",
          status: outcome.status,
          close: used,
          volume: raw29.volume,
        },
        stop: false,
      };
    }
  }
}

/**
 * fetch 結果 + capture から `FetchOutcome` を組み立てる。
 * status ok の応答は原文 bytes を再 parse する (parse 失敗の証拠化)。
 * 200 + 再 parse 成功 + 非 guard throw の組合せは内部不整合として STOP する。
 */
export function resolveFetchOutcome(args: {
  code: string;
  capture: { status: number; bytes: Uint8Array } | null;
  chart: ChartResult | null;
  error: string | null;
}): FetchOutcome {
  const { code, capture, chart, error } = args;
  if (capture === null) {
    return { kind: "noresponse", message: error ?? "応答なし (capture なし・原因不明)" };
  }
  if (capture.status !== 200) {
    return {
      kind: "http",
      status: capture.status,
      message: error ?? `HTTP ${capture.status} (本文あり・要 custody 確認)`,
    };
  }
  let rawBars: DailyOhlcv[];
  try {
    rawBars = parseCapturedChart(code, capture.bytes);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // zod 判定は core の $ZodError で受ける (classic/mini を問わない。
    // src/shared/error-handler.ts と同じ方式。name 文字列に依存しない)。
    if (e instanceof SyntaxError || e instanceof $ZodError) {
      return { kind: "parse", message, upstream: false };
    }
    if (message.includes("Chart API エラー")) {
      return { kind: "parse", message, upstream: true };
    }
    return { kind: "noresponse", message: `再 parse の想定外失敗: ${message}` };
  }
  if (error !== null) {
    if (error.includes("10倍超乖離")) {
      return { kind: "guard", message: error };
    }
    return {
      kind: "noresponse",
      message: `200 + 再 parse 成功なのに取得失敗: ${error}`,
    };
  }
  if (chart === null) {
    return { kind: "noresponse", message: "200 + 再 parse 成功なのに chart なし (内部不整合)" };
  }
  return { kind: "ok", status: capture.status, rawBars, sanitized: chart.ohlcv };
}

/** live 再確認集合と固定 54 の差分 (空でなければ drift として STOP)。 */
export function findDrift(missingNow: readonly string[]): { missing: string[]; extra: string[] } {
  const now = new Set(missingNow);
  const fixed = new Set(STOCK_GAP_54_CODES);
  const missing = STOCK_GAP_54_CODES.filter((c) => !now.has(c));
  const extra = [...now].filter((c) => !fixed.has(c)).sort();
  return { missing, extra };
}

/**
 * D1 SELECT のみ: active かつ equity のうち、指定日に close 有効行が無い
 * コードを返す (行不存在 + NULL 行の両方。書込なし)。
 * 既存 `loadDailyTargets` (母集団) と単純 SELECT (保存済み) の差分で求め、
 * 複合 ON の JOIN を持ち込まない。
 */
export async function loadMissingCodesForDate(db: DiagDb, date: string): Promise<string[]> {
  const targets = await loadDailyTargets(db);
  const saved = await db
    .select({ stockId: swingSchema.dailyOhlcv.stockId })
    .from(swingSchema.dailyOhlcv)
    .where(and(eq(swingSchema.dailyOhlcv.date, date), isNotNull(swingSchema.dailyOhlcv.close)));
  const savedIds = new Set(saved.map((r) => r.stockId));
  return targets
    .filter((t) => !savedIds.has(t.id))
    .map((t) => t.code)
    .sort();
}

export interface DiagCodeEntry {
  code: string;
  httpStatus: number | null;
  sha256: string | null;
  byteLength: number | null;
  category: GapCategory;
  reason: string;
}

export interface DiagBatchFile {
  filename: string;
  bytes: Uint8Array;
  contentType: string;
}

/** 診断バッチの冪等 key (run 一意。同一 invocation の二重記録を防ぐ)。 */
export function diagBatchKey(runId: string): string {
  return `price-sync-diag-20260929-${runId}`;
}

/**
 * 診断バッチ 1 件分の純粋 builder。添付はコード別 Chart 原文 + manifest。
 * `unattempted` が空でなければ partial (中断・未試行あり)。
 */
export function buildDiagBatch(args: {
  runId: string;
  fetchedAt: string;
  entries: readonly DiagCodeEntry[];
  unattempted: readonly { code: string; reason: string }[];
  rawByCode: ReadonlyMap<string, Uint8Array>;
  /**
   * 停止の有無。最終コードで止まった場合は unattempted が空でも
   * partial にする (unattempted のみ判定では complete に誤る)。
   */
  stopped: boolean;
  stopReason: string | null;
}): {
  key: string;
  source: string;
  metadata: Record<string, unknown>;
  files: DiagBatchFile[];
} {
  const key = diagBatchKey(args.runId);
  const completeness = args.stopped || args.unattempted.length > 0 ? "partial" : "complete";
  const manifest = {
    service: SERVICE,
    kind: "price-sync-diag-batch",
    key,
    date: STOCK_GAP_DIAG_DATE,
    runId: args.runId,
    completeness,
    generatedAt: args.fetchedAt,
    codes: args.entries.map((e) => ({
      code: e.code,
      httpStatus: e.httpStatus,
      sha256: e.sha256,
      byteLength: e.byteLength,
      category: e.category,
      reason: e.reason,
    })),
    unattempted: args.unattempted.map((u) => ({ code: u.code, reason: u.reason })),
    stopped: args.stopped,
    stopReason: args.stopReason,
    priorRunCausesUndetermined: true,
    note: "旧 run の失敗理由は本診断では断定しない。次回通常 run の PR180 batch と照合すること。",
  };
  const files: DiagBatchFile[] = args.entries
    .filter((e) => args.rawByCode.has(e.code))
    .map((e) => ({
      filename: `${e.code}-chart-5y.json`,
      bytes: args.rawByCode.get(e.code) as Uint8Array,
      contentType: "application/json",
    }));
  files.push({
    filename: `${key}-manifest.json`,
    bytes: new TextEncoder().encode(JSON.stringify(manifest)),
    contentType: "application/json",
  });
  return {
    key,
    source: `stock-gap-diagnostic (Yahoo Chart 5y/1d → Notion, D1 SELECT only)`,
    metadata: {
      date: STOCK_GAP_DIAG_DATE,
      runId: args.runId,
      completeness,
      stopped: args.stopped,
      stopReason: args.stopReason,
      codes: STOCK_GAP_54_CODES,
      perCode: args.entries.map((e) => ({
        code: e.code,
        status: e.httpStatus,
        sha256: e.sha256,
        bytes: e.byteLength,
        category: e.category,
        reason: e.reason,
      })),
      unattempted: args.unattempted.map((u) => u.code),
    },
    files,
  };
}

type DiagRecorder = typeof recordPrimaryData;

/**
 * 診断バッチ 1 件を一次保管する。PR180 と同じ厳密さ:
 * fileTooLarge・非 recorded は成功と偽らず throw する。
 */
export async function recordDiagBatch(
  batch: { key: string; source: string; metadata: Record<string, unknown>; files: DiagBatchFile[] },
  fetchedAt: string,
  recorder: DiagRecorder = recordPrimaryData
): Promise<{ pageId: string; key: string }> {
  const res = await recorder({
    service: SERVICE,
    key: batch.key,
    source: batch.source,
    fetchedAt,
    metadata: batch.metadata,
    files: batch.files,
    force: false,
  });
  if (res.fileTooLarge) {
    throw new Error(`診断バッチ保管が不完全 (fileTooLarge): ${batch.key}`);
  }
  if (res.outcome !== "recorded") {
    throw new Error(`診断バッチ保管が不完全 (outcome=${res.outcome}): ${batch.key}`);
  }
  return { pageId: res.pageId, key: batch.key };
}

/**
 * 保管直後の readback 照合 (契約維持の薄い wrapper。実体は共有
 * `verifyArchivedAttachments` に移動し label「診断バッチ」で旧文面を保つ)。
 */
export async function verifyDiagBatchAttachments(
  pageId: string,
  files: readonly DiagBatchFile[]
): Promise<void> {
  return verifyArchivedAttachments(pageId, files, "診断バッチ");
}

export interface GapDiagFetchResult {
  capture: { status: number; bytes: Uint8Array } | null;
  chart: ChartResult | null;
  error: string | null;
}

export interface GapDiagDeps {
  fetchOne: (code: string) => Promise<GapDiagFetchResult>;
  record: DiagRecorder;
}

export interface GapDiagReport {
  date: string;
  runId: string;
  key: string;
  completeness: "complete" | "partial";
  /** 停止の有無・理由。CLI exit code は completeness 経由で必ず反映する。 */
  stopped: boolean;
  stopReason: string | null;
  total: number;
  attempted: number;
  categories: Record<GapCategory, number>;
  entries: (DiagCodeEntry & { evidence: GapEvidence })[];
  unattempted: { code: string; reason: string }[];
  priorRunCausesUndetermined: true;
}

/**
 * 固定 54 診断の実行。`missingNow` は run 冒頭の live anti-join 結果。
 * drift があれば 1 GET もせず STOP する。429/5xx・無応答・保管失敗でも
 * 取得済み分を partial 保管して STOP する (盲再試行なし)。
 */
export async function runGapDiagnostic(
  missingNow: readonly string[],
  runId: string,
  deps: GapDiagDeps,
  nowIso: () => string = () => new Date().toISOString()
): Promise<GapDiagReport> {
  const drift = findDrift(missingNow);
  if (drift.missing.length > 0 || drift.extra.length > 0) {
    throw new Error(
      `診断前提が drift したため STOP (取得なし): ` +
        `欠測から外れた ${drift.missing.length} 件 [${drift.missing.join(",")}] / ` +
        `新規欠測 ${drift.extra.length} 件 [${drift.extra.join(",")}]`
    );
  }
  const entries: (DiagCodeEntry & { evidence: GapEvidence })[] = [];
  const rawByCode = new Map<string, Uint8Array>();
  const categories: Record<GapCategory, number> = {
    source_gap: 0,
    stale: 0,
    priceguard: 0,
    http: 0,
    parse: 0,
    has_real_bar: 0,
    unknown: 0,
  };
  let stoppedAt = -1;
  let stopReason = "";
  for (let i = 0; i < STOCK_GAP_54_CODES.length; i += 1) {
    const code = STOCK_GAP_54_CODES[i];
    const fetched = await deps.fetchOne(code);
    const outcome = resolveFetchOutcome({ code, ...fetched });
    const { category, evidence, stop } = classifyGap(code, outcome);
    let sha256: string | null = null;
    let byteLength: number | null = null;
    if (fetched.capture !== null) {
      rawByCode.set(code, fetched.capture.bytes);
      byteLength = fetched.capture.bytes.length;
      sha256 = await sha256HexBytes(Uint8Array.from(fetched.capture.bytes));
    }
    entries.push({
      code,
      httpStatus: fetched.capture?.status ?? null,
      sha256,
      byteLength,
      category,
      reason: evidence.reason,
      evidence,
    });
    categories[category] += 1;
    if (stop) {
      stoppedAt = i;
      stopReason = `${category}/${evidence.reason}`;
      break;
    }
  }
  const unattempted =
    stoppedAt === -1
      ? []
      : STOCK_GAP_54_CODES.slice(stoppedAt + 1).map((code) => ({
          code,
          reason: `run-stopped(${stopReason})`,
        }));
  const fetchedAt = nowIso();
  const stopped = stoppedAt !== -1;
  const batch = buildDiagBatch({
    runId,
    fetchedAt,
    entries,
    unattempted,
    rawByCode,
    stopped,
    stopReason: stopped ? `${entries[stoppedAt].code}:${stopReason}` : null,
  });
  const { pageId, key } = await recordDiagBatch(batch, fetchedAt, deps.record);
  await verifyDiagBatchAttachments(pageId, batch.files);
  return {
    date: STOCK_GAP_DIAG_DATE,
    runId,
    key,
    completeness: stopped || unattempted.length > 0 ? "partial" : "complete",
    stopped,
    stopReason: stopped ? `${entries[stoppedAt].code}:${stopReason}` : null,
    total: STOCK_GAP_54_CODES.length,
    attempted: entries.length,
    categories,
    entries,
    unattempted,
    priorRunCausesUndetermined: true,
  };
}

// ---------------------------------------------------------------------------
// live 配線 + CLI (手動実行。`--execute` が無いと起動しない)
// ---------------------------------------------------------------------------

function createLiveFetchOne(): GapDiagDeps["fetchOne"] {
  const gate = createDailyStockStartGate(DIAG_START_INTERVAL_MS);
  return async (code: string): Promise<GapDiagFetchResult> => {
    await gate.wait();
    let capture: GapDiagFetchResult["capture"] = null;
    try {
      const chart = await fetchChart(code, CHART_RANGE, {
        onRaw: (c) => {
          capture = { status: c.status, bytes: c.bytes };
        },
      });
      return { capture, chart, error: null };
    } catch (e) {
      const message = rootCauseMessage(e);
      gate.observeFailure(message);
      return { capture, chart: null, error: message };
    }
  };
}

function printScopeAndExit(): never {
  console.info(
    [
      "[stock-gap-diagnostic] Issue #163 固定診断 (54 codes × 2026-09-29)。",
      `対象 54 件: ${STOCK_GAP_54_CODES.join(",")}`,
      "live 実行 (Yahoo 54 GET + Notion 保管 1 件 + D1 SELECT) には --execute が必要です。",
      "修復 (D1 書込) は含みません (別 grant)。",
    ].join("\n")
  );
  process.exit(2);
  throw new Error("unreachable");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (!args.includes("--execute")) printScopeAndExit();
  // Node から Yahoo を直接叩く構成は 429 と全銘柄リトライを招くため拒否
  // (scripts/sync/daily.ts と同じ gate)。
  requireYahooProxyForNodeSync();
  const startedAt = Date.now();
  const db = createDailyDb();
  const missingNow = await loadMissingCodesForDate(db, STOCK_GAP_DIAG_DATE);
  console.info(
    `[stock-gap-diagnostic] live anti-join: ${missingNow.length} 件欠測 (drift なら STOP)`
  );
  const runId = priceSyncBatchRunId(startedAt);
  const report = await runGapDiagnostic(
    missingNow,
    runId,
    { fetchOne: createLiveFetchOne(), record: recordPrimaryData },
    () => new Date().toISOString()
  );
  console.info(JSON.stringify(report, null, 2));
  console.info(
    `[stock-gap-diagnostic] 完了: ${report.completeness} ` +
      `(試行 ${report.attempted}/${report.total}, 保管 ${report.key}` +
      `${report.stopped ? `, STOP(${report.stopReason})` : ""})`
  );
  if (report.completeness !== "complete") {
    process.exitCode = 1;
    return;
  }
  if (sharedEnv.GITHUB_OUTPUT() !== undefined) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(sharedEnv.GITHUB_OUTPUT() as string, `diag_key=${report.key}\n`);
  }
}

// CLI として直接実行された場合のみ main() を走らせる
// (テストの import では走らない)。
if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch((e) => {
    console.error("[stock-gap-diagnostic] エラー:", rootCauseMessage(e));
    process.exit(1);
  });
}
