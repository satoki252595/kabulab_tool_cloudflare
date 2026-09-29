/**
 * Issue #163: 9/29 OHLCV 欠損の保管原文 replay 修復 (手動実行・PREP)。
 *
 * live 診断 (PR192) で custody した Chart 原文だけを入力にする。
 * Yahoo への追加 GET は 0 (fetch 系を import しない)。
 * `writeStockSnapshot` / `flushSnapshots` は使わない
 * (fundamentals/RSI/signals/投影に触れるため)。対象表は
 * `swing_daily_ohlcv` のみ。指標・財務は変更しない。
 *
 * 手順:
 *  1. 固定 diag key のバッチを Notion hosted から全件再 DL し、
 *     55 件数・名前・manifest pinned-SHA・コード別 full-bytes SHA で再照合。
 *     manifest が complete でなければ STOP。
 *  2. has_real_bar の原文を `parseChartResponse` + 共有 `guardChartBars`
 *     (全履歴 guard。9/29 切断より前) で replay し、exact-date unique な
 *     9/29 バーを選ぶ。raw close 正有限必須。欠落・重複・不正は HOLD。
 *     保存値は guarded バーの原文のまま (調整換算なし、adj 別列、null・
 *     正当 v0 はそのまま)。manifest の evidence 値は保存へ流用しない。
 *  3. D1: active equity の code→stockID 確認。既存行なしだけ INSERT 候補。
 *     既存全 7 値同値は write0、既存 NULL・有効差異・drift は HOLD。
 *  4. 12 行/chunk の batch [銘柄同一性・不存在 CAS・INSERT] を
 *     `createD1HttpBatchSender` で送る。CAS 競合は batch rollback で
 *     全 STOP (盲再送なし)。bind は 100/文以下。
 *  5. 書込行を再 SELECT して 7 値 readback し、repair receipt を
 *     Notion 共有窓口へ 1 件記録する (曖昧 POST の再送禁止)。
 *
 * 本番 INSERT は Root 最終 review + gate まで行わない (PREP のみ)。
 * `--execute` が無いと起動しない。
 */
import { and, eq, inArray } from "drizzle-orm";
import {
  createDailyDb,
  loadDailyTargets,
  priceSyncBatchRunId,
} from "../../src/cron/daily.js";
import { parseChartResponse } from "../../src/shared/yahoo/client.js";
import { guardChartBars } from "../../src/shared/yahoo/bar-sanity.js";
import {
  findBackupChildByTitle,
  queryUniqueRow,
} from "../../src/shared/notion-archive/archive.js";
import {
  listPageFiles,
  recordPrimaryData,
} from "../../src/shared/notion-archive/index.js";
import { NotionUnknownResultError } from "../../src/shared/notion-archive/client.js";
import { notionEnv } from "../../src/shared/notion-archive/env.js";
import { sha256HexBytes } from "../../src/shared/sha256.js";
import { rootCauseMessage } from "../../src/shared/errors.js";
import {
  OHLCV_REPAIR_CHUNK_ROWS,
  buildOhlcvInsertStatement,
  buildOhlcvNonexistencePreflightStatement,
  buildStockIdentityPreflightStatement,
  type OhlcvInsertRow,
} from "../../src/shared/repair-preflight.js";
import {
  createD1HttpBatchSender,
  type D1BatchStatement,
} from "../../src/shared/db/d1-http-client.js";
import * as swingSchema from "../../services/swing-trading/src/db/schema.js";

type RepairDb = ReturnType<typeof createDailyDb>;

/** 修復対象日 (manifest.date と照合する)。 */
export const REPAIR_DATE = "2026-09-29";
/** 入力 custody の固定 diag key (live 診断の記録)。 */
export const REPAIR_DIAG_KEY = "price-sync-diag-20260929-local-1790720602657";
/** 診断バッチの添付数 (Chart 原文 54 + manifest 1)。 */
export const REPAIR_DIAG_FILES = 55;
/**
 * 診断 manifest の pinned SHA256 (live 記録時の readback 証拠)。
 * manifest 自体の改ざんを検知する錨。コード別原文は manifest 内の
 * per-code SHA と照合する。
 */
export const REPAIR_DIAG_MANIFEST_SHA256 =
  "f509f5dbc2e1838d9073067b9b7059de8cee760ac4878f1da3df63f8e1af894d";
const SERVICE = "stock-sync";

/** OHLCV 7 値 (stock_id を除く保存単位。比較・INSERT の粒度)。 */
export interface OhlcvSeven {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  adj: number | null;
}

/** 診断 manifest のコード行 (保存に必要な最小面)。 */
export interface DiagManifestCode {
  code: string;
  httpStatus: number | null;
  sha256: string | null;
  byteLength: number | null;
  category: string;
  reason: string;
}

export interface DiagManifest {
  key: string;
  date: string;
  completeness: string;
  codes: DiagManifestCode[];
  unattempted: { code: string; reason: string }[];
}

/** 未知 JSON を fail-closed で読む (不足・型違いは throw)。 */
export function parseDiagManifest(json: unknown): DiagManifest {
  const fail = (why: string): never => {
    throw new Error(`診断 manifest の検証に失敗したため STOP: ${why}`);
  };
  if (!json || typeof json !== "object") fail("object ではない");
  const m = json as Record<string, unknown>;
  if (m["key"] !== REPAIR_DIAG_KEY) fail(`key 不一致 (${String(m["key"])})`);
  if (m["date"] !== REPAIR_DATE) fail(`date 不一致 (${String(m["date"])})`);
  if (typeof m["completeness"] !== "string") fail("completeness なし");
  if (!Array.isArray(m["codes"])) fail("codes なし");
  if (!Array.isArray(m["unattempted"])) fail("unattempted なし");
  const codes: DiagManifestCode[] = (m["codes"] as unknown[]).map((c) => {
    if (!c || typeof c !== "object") fail("codes 要素が object ではない");
    const r = c as Record<string, unknown>;
    if (typeof r["code"] !== "string" || typeof r["category"] !== "string") {
      fail("codes 要素に code/category なし");
    }
    return {
      code: r["code"] as string,
      httpStatus: typeof r["httpStatus"] === "number" ? r["httpStatus"] : null,
      sha256: typeof r["sha256"] === "string" ? r["sha256"] : null,
      byteLength: typeof r["byteLength"] === "number" ? r["byteLength"] : null,
      category: r["category"] as string,
      reason: typeof r["reason"] === "string" ? r["reason"] : "",
    };
  });
  return {
    key: m["key"] as string,
    date: m["date"] as string,
    completeness: m["completeness"] as string,
    codes,
    unattempted: (m["unattempted"] as { code: string; reason: string }[]).map((u) => ({
      code: String(u.code),
      reason: String(u.reason),
    })),
  };
}

export type ReplayOutcome =
  | { kind: "ok"; row: OhlcvSeven }
  | { kind: "held"; reason: string };

/**
 * 保管原文 1 件の replay (純粋関数)。
 * 全履歴 guard 後に exact-date unique な 9/29 バーを選び、raw close の
 * 正有限を要求する。保存値は guarded バーの原文のまま。
 * evidence 値は一切見ない (保存への流用禁止)。
 */
export function replayRawBar(code: string, bytes: Uint8Array): ReplayOutcome {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { kind: "held", reason: "raw-not-json" };
  }
  let parsed;
  try {
    parsed = parseChartResponse(json, code);
  } catch (e) {
    return { kind: "held", reason: `raw-parse-failed:${e instanceof Error ? e.message.slice(0, 120) : "unknown"}` };
  }
  let guarded;
  try {
    guarded = guardChartBars(parsed.bars, parsed.meta.regularMarketPrice, code);
  } catch (e) {
    return { kind: "held", reason: `guard-rejected:${e instanceof Error ? e.message.slice(0, 120) : "unknown"}` };
  }
  const raw29 = parsed.bars.filter((b) => b.date === REPAIR_DATE);
  if (raw29.length === 0) return { kind: "held", reason: "raw-9/29-missing" };
  if (raw29.length > 1) return { kind: "held", reason: "raw-9/29-duplicate" };
  const raw = raw29[0];
  if (raw.close === null || !Number.isFinite(raw.close) || raw.close <= 0) {
    return { kind: "held", reason: "raw-close-not-positive-finite" };
  }
  const kept29 = guarded.bars.filter((b) => b.date === REPAIR_DATE);
  if (kept29.length === 0) return { kind: "held", reason: "guarded-9/29-missing" };
  if (kept29.length > 1) return { kind: "held", reason: "guarded-9/29-duplicate" };
  const k = kept29[0];
  return {
    kind: "ok",
    row: {
      date: REPAIR_DATE,
      open: k.open,
      high: k.high,
      low: k.low,
      close: k.close,
      volume: k.volume,
      adj: k.adj ?? null,
    },
  };
}

/** 7 値の null-safe 同値 (NaN は来ない前提。来たら不一致)。 */
export function ohlcvSevenEqual(a: OhlcvSeven, b: OhlcvSeven): boolean {
  return (
    a.date === b.date &&
    a.open === b.open &&
    a.high === b.high &&
    a.low === b.low &&
    a.close === b.close &&
    a.volume === b.volume &&
    a.adj === b.adj
  );
}

export interface RepairCustody {
  manifest: DiagManifest;
  rawByCode: ReadonlyMap<string, Uint8Array>;
}

/**
 * 固定 diag バッチの再取得 + 再照合 (Notion hosted のみ。Yahoo 0)。
 * 55 件数・名前集合・hosted・manifest pinned-SHA・コード別 full-bytes SHA
 * を全件確認する。不一致・manifest 非 complete・未試行残は STOP。
 */
export async function loadRepairCustody(): Promise<RepairCustody> {
  const fail = (why: string): never => {
    throw new Error(`修復入力 custody の再照合に失敗したため STOP: ${why}`);
  };
  const dbId =
    (await findBackupChildByTitle({
      parentPageId: notionEnv.NOTION_ARCHIVE_PAGE_ID(),
      title: "一次データ｜stock-sync",
      kind: "database",
    })) ?? fail("「一次データ｜stock-sync」DB なし");
  const row =
    (await queryUniqueRow<{ id: string }>(
      dbId,
      { property: "Key", title: { equals: REPAIR_DIAG_KEY } },
      `修復入力の診断バッチの重複 key=${REPAIR_DIAG_KEY} を選ばず保全停止`
    )) ?? fail(`診断バッチ key=${REPAIR_DIAG_KEY} なし`);
  const hosted = await listPageFiles(row.id, "Files");
  if (hosted.length !== REPAIR_DIAG_FILES) {
    fail(`添付 ${hosted.length} 件 ≠ 期待 ${REPAIR_DIAG_FILES} 件`);
  }
  const byName = new Map(hosted.map((h) => [h.name, h]));
  const manifestName = `${REPAIR_DIAG_KEY}-manifest.json`;
  const download = async (name: string): Promise<Uint8Array> => {
    const ref = byName.get(name) ?? fail(`添付「${name}」なし`);
    if (ref.kind !== "file") fail(`添付「${name}」が hosted ではありません`);
    const res = await fetch(ref.url);
    if (!res.ok) fail(`「${name}」の再取得に失敗 status=${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  };
  const manifestBytes = await download(manifestName);
  const manifestSha = await sha256HexBytes(Uint8Array.from(manifestBytes));
  if (manifestSha !== REPAIR_DIAG_MANIFEST_SHA256) fail("manifest SHA 不一致 (改ざん疑い)");
  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch {
    fail("manifest JSON の parse に失敗");
  }
  const manifest = parseDiagManifest(manifestJson);
  if (manifest.completeness !== "complete") fail(`manifest が ${manifest.completeness} (complete 前提)`);
  if (manifest.unattempted.length > 0) fail(`未試行 ${manifest.unattempted.length} 件あり (complete 前提)`);
  const rawByCode = new Map<string, Uint8Array>();
  for (const entry of manifest.codes) {
    const name = `${entry.code}-chart-5y.json`;
    const bytes = await download(name);
    if (entry.sha256 === null || entry.byteLength === null) fail(`「${name}」の manifest SHA/長さなし`);
    if (bytes.length !== entry.byteLength) fail(`「${name}」のバイト長不一致`);
    const sha = await sha256HexBytes(Uint8Array.from(bytes));
    if (sha !== entry.sha256) fail(`「${name}」の SHA256 不一致`);
    rawByCode.set(entry.code, bytes);
  }
  if (rawByCode.size + 1 !== hosted.length) fail("添付集合の不一致 (想定外ファイル)");
  return { manifest, rawByCode };
}

export interface RepairTarget {
  code: string;
  stockId: number;
  row: OhlcvSeven;
}

export type RepairDisposition =
  | { kind: "insert"; target: RepairTarget }
  | { kind: "write0"; code: string }
  | { kind: "held"; code: string; reason: string };

export interface GapRepairDeps {
  loadCustody: () => Promise<RepairCustody>;
  /** active equity の code→id (drift 検出用。既定は loadDailyTargets)。 */
  loadTargets: () => Promise<{ id: number; code: string }[]>;
  /** 指定 (stockId, date) の既存 7 値 (行なしは欠番)。readback で再利用。 */
  readRows: (stockIds: readonly number[], date: string) => Promise<Map<number, OhlcvSeven>>;
  sendBatch: (statements: readonly D1BatchStatement[]) => Promise<void>;
  record: typeof recordPrimaryData;
}

export interface GapRepairReport {
  date: string;
  runId: string;
  diagKey: string;
  receiptKey: string | null;
  applied: number;
  write0: string[];
  held: { code: string; reason: string }[];
  excluded: { code: string; reason: string }[];
  aborted: boolean;
  abortReason: string | null;
}

/**
 * 修復の実行。disposition 決定→chunk batch→readback→receipt。
 * CAS 競合・readback 不一致は全 STOP (盲再送なし)。stdout 報告に
 * 価格値は含めない (値は Notion receipt の custody にだけ残す)。
 */
export async function runGapRepair(
  runId: string,
  eligibleCodes: ReadonlySet<string>,
  deps: GapRepairDeps,
  nowIso: () => string = () => new Date().toISOString()
): Promise<GapRepairReport> {
  // 保存対象は eligible (date-effective 資格検証済み。Root が grant 時に支給)
  // に属する has_real_bar のみ。暫定 denylist を埋め込まず、active flag や
  // 欠落データから資格を推測しない。空・未知・非 has_real_bar は即 STOP。
  if (eligibleCodes.size === 0) {
    throw new Error("修復 STOP: eligible 集合が空です (Root が grant 時に支給すること)");
  }
  const { manifest, rawByCode } = await deps.loadCustody();
  if (manifest.completeness !== "complete") {
    throw new Error(`修復 STOP: 診断 manifest が ${manifest.completeness} (complete 前提)`);
  }
  if (manifest.unattempted.length > 0) {
    throw new Error(`修復 STOP: 診断に未試行 ${manifest.unattempted.length} 件あり (complete 前提)`);
  }
  const byCode = new Map(manifest.codes.map((e) => [e.code, e]));
  for (const code of eligibleCodes) {
    const entry = byCode.get(code);
    if (!entry) {
      throw new Error(`修復 STOP: eligible の ${code} が診断 manifest にありません`);
    }
    if (entry.category !== "has_real_bar") {
      throw new Error(`修復 STOP: eligible の ${code} は ${entry.category} (保存不可)`);
    }
  }
  const targets = new Map((await deps.loadTargets()).map((t) => [t.code, t.id]));

  // disposition 決定: has_real_bar のみ replay。 evidence 値は見ない。
  const replayed: { code: string; row: OhlcvSeven }[] = [];
  const held: { code: string; reason: string }[] = [];
  const excluded: { code: string; reason: string }[] = [];
  for (const entry of manifest.codes) {
    if (entry.category !== "has_real_bar") {
      excluded.push({ code: entry.code, reason: `diag-category:${entry.category}` });
      continue;
    }
    if (!eligibleCodes.has(entry.code)) {
      held.push({ code: entry.code, reason: "not-in-eligible-set" });
      continue;
    }
    const bytes = rawByCode.get(entry.code);
    if (!bytes) {
      held.push({ code: entry.code, reason: "raw-bytes-missing" });
      continue;
    }
    const replay = replayRawBar(entry.code, bytes);
    if (replay.kind === "held") {
      held.push({ code: entry.code, reason: replay.reason });
      continue;
    }
    replayed.push({ code: entry.code, row: replay.row });
  }

  // D1 照合: code→ID・既存行。INSERT 候補だけ残す。
  const withIds = replayed.flatMap((r) => {
    const stockId = targets.get(r.code);
    if (stockId === undefined) {
      held.push({ code: r.code, reason: "code-not-active-equity" });
      return [];
    }
    return [{ ...r, stockId }];
  });
  const existing = await deps.readRows(
    withIds.map((r) => r.stockId),
    REPAIR_DATE
  );
  const inserts: OhlcvInsertRow[] = [];
  const write0: string[] = [];
  for (const r of withIds) {
    const row = existing.get(r.stockId);
    if (row === undefined) {
      inserts.push({ stockId: r.stockId, code: r.code, ...r.row });
    } else if (ohlcvSevenEqual(row, r.row)) {
      write0.push(r.code);
    } else {
      held.push({ code: r.code, reason: "existing-row-differs" });
    }
  }

  // chunk batch 送信。競合・失敗は全 STOP (後続 chunk を送らない)。
  let applied = 0;
  let aborted = false;
  let abortReason: string | null = null;
  const sent: OhlcvInsertRow[] = [];
  for (let i = 0; i < inserts.length; i += OHLCV_REPAIR_CHUNK_ROWS) {
    const chunk = inserts.slice(i, i + OHLCV_REPAIR_CHUNK_ROWS);
    try {
      await deps.sendBatch([
        buildStockIdentityPreflightStatement(chunk),
        buildOhlcvNonexistencePreflightStatement(chunk),
        buildOhlcvInsertStatement(chunk),
      ]);
    } catch (e) {
      aborted = true;
      abortReason = `chunk-${Math.floor(i / OHLCV_REPAIR_CHUNK_ROWS)}:${rootCauseMessage(e).slice(0, 200)}`;
      break;
    }
    applied += chunk.length;
    sent.push(...chunk);
  }

  // readback: 送信分を再 SELECT して 7 値照合。
  let readbackOk = true;
  let readbackDetail = "not-applicable";
  if (sent.length > 0) {
    const reread = await deps.readRows(
      sent.map((r) => r.stockId),
      REPAIR_DATE
    );
    const bad: string[] = [];
    for (const s of sent) {
      const row = reread.get(s.stockId);
      if (!row || !ohlcvSevenEqual(row, s)) bad.push(s.code);
    }
    readbackOk = bad.length === 0;
    readbackDetail = readbackOk ? `matched:${sent.length}` : `mismatch:[${bad.join(",")}]`;
    if (!readbackOk) {
      aborted = true;
      abortReason = `readback:${readbackDetail}`;
    }
  }

  // receipt 記録 (値は custody にだけ残す)。曖昧 POST は再送しない。
  const receiptKey = `price-sync-repair-20260929-${runId}`;
  const receipt = {
    service: SERVICE,
    kind: "price-sync-repair-receipt",
    key: receiptKey,
    date: REPAIR_DATE,
    runId,
    diagKey: REPAIR_DIAG_KEY,
    diagManifestSha256: REPAIR_DIAG_MANIFEST_SHA256,
    generatedAt: nowIso(),
    applied,
    write0,
    held,
    excluded,
    aborted,
    abortReason,
    readback: readbackDetail,
    // 監査用の行値 (Notion custody 内のみ。stdout/Git には出さない)。
    writes: sent.map((s) => ({
      code: s.code,
      stockId: s.stockId,
      row: { date: s.date, open: s.open, high: s.high, low: s.low, close: s.close, volume: s.volume, adj: s.adj },
    })),
  };
  let recordedReceiptKey: string | null = null;
  try {
    const res = await deps.record({
      service: SERVICE,
      key: receiptKey,
      source: "stock-gap-repair (custodied Chart replay → D1 OHLCV INSERT)",
      fetchedAt: nowIso(),
      metadata: {
        date: REPAIR_DATE,
        runId,
        diagKey: REPAIR_DIAG_KEY,
        applied,
        write0Count: write0.length,
        heldCount: held.length,
        excludedCount: excluded.length,
        aborted,
        abortReason,
        readback: readbackDetail,
      },
      files: [
        {
          filename: `${receiptKey}.json`,
          bytes: new TextEncoder().encode(JSON.stringify(receipt)),
          contentType: "application/json",
        },
      ],
      force: false,
    });
    if (res.fileTooLarge) {
      throw new Error(`修復 receipt 保管が不完全 (fileTooLarge): ${receiptKey}`);
    }
    if (res.outcome !== "recorded") {
      throw new Error(`修復 receipt 保管が不完全 (outcome=${res.outcome}): ${receiptKey}`);
    }
    recordedReceiptKey = receiptKey;
  } catch (e) {
    // Unknown を含め再送しない (単発呼出)。元の成否は abortReason に残す。
    if (e instanceof NotionUnknownResultError) throw e;
    throw new Error(`修復 receipt の記録に失敗: ${rootCauseMessage(e)}`);
  }

  return {
    date: REPAIR_DATE,
    runId,
    diagKey: REPAIR_DIAG_KEY,
    receiptKey: recordedReceiptKey,
    applied,
    write0,
    held,
    excluded,
    aborted,
    abortReason,
  };
}

// ---------------------------------------------------------------------------
// live 配線 + CLI (手動実行。`--execute --eligible-codes ...` が無いと起動しない)
// ---------------------------------------------------------------------------

/** 既存 7 値の読取 (99 stockId/chunk + date の 100 bind/文)。 */
async function readExistingRows(
  db: RepairDb,
  stockIds: readonly number[],
  date: string
): Promise<Map<number, OhlcvSeven>> {
  const out = new Map<number, OhlcvSeven>();
  for (let i = 0; i < stockIds.length; i += 99) {
    const chunk = stockIds.slice(i, i + 99);
    const rows = await db
      .select({
        stockId: swingSchema.dailyOhlcv.stockId,
        date: swingSchema.dailyOhlcv.date,
        open: swingSchema.dailyOhlcv.open,
        high: swingSchema.dailyOhlcv.high,
        low: swingSchema.dailyOhlcv.low,
        close: swingSchema.dailyOhlcv.close,
        volume: swingSchema.dailyOhlcv.volume,
        adj: swingSchema.dailyOhlcv.adj,
      })
      .from(swingSchema.dailyOhlcv)
      .where(and(eq(swingSchema.dailyOhlcv.date, date), inArray(swingSchema.dailyOhlcv.stockId, chunk)));
    for (const r of rows) {
      out.set(r.stockId, {
        date: r.date,
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: r.volume,
        adj: r.adj,
      });
    }
  }
  return out;
}

function printScopeAndExit(): never {
  console.info(
    [
      "[stock-gap-repair] Issue #163 9/29 欠損の保管原文 replay 修復 (PREP 実装)。",
      `入力 custody: ${REPAIR_DIAG_KEY} (55 添付・Notion hosted のみ。Yahoo 追加 GET 0)。`,
      "保存対象は --eligible-codes で支給された date-effective 資格集合のみ。",
      "live 実行 (D1 INSERT + Notion receipt) には --execute が必要です。",
      "本番 INSERT は Root 最終 review + gate まで行いません。",
    ].join("\n")
  );
  process.exit(2);
  throw new Error("unreachable");
}

function parseEligibleCodes(args: readonly string[]): ReadonlySet<string> | null {
  const flag = args.find((a) => a.startsWith("--eligible-codes="));
  if (!flag) return null;
  const codes = flag
    .slice("--eligible-codes=".length)
    .split(",")
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  return new Set(codes);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const eligible = parseEligibleCodes(args);
  if (!args.includes("--execute") || eligible === null) printScopeAndExit();
  const startedAt = Date.now();
  const db = createDailyDb();
  const sendBatch = createD1HttpBatchSender();
  const runId = priceSyncBatchRunId(startedAt);
  const report = await runGapRepair(runId, eligible, {
    loadCustody: loadRepairCustody,
    loadTargets: async () => {
      const targets = await loadDailyTargets(db);
      return targets.map((t) => ({ id: t.id, code: t.code }));
    },
    readRows: (stockIds, date) => readExistingRows(db, stockIds, date),
    sendBatch: (statements) => sendBatch(statements),
    record: recordPrimaryData,
  });
  // 価格値は出さない (集計のみ。値は Notion receipt の custody のみ)。
  console.info(
    JSON.stringify(
      {
        date: report.date,
        runId: report.runId,
        diagKey: report.diagKey,
        receiptKey: report.receiptKey,
        applied: report.applied,
        write0: report.write0,
        held: report.held,
        excluded: report.excluded,
        aborted: report.aborted,
        abortReason: report.abortReason,
      },
      null,
      2
    )
  );
  console.info(
    `[stock-gap-repair] 完了: 適用 ${report.applied} / write0 ${report.write0.length} / ` +
      `held ${report.held.length} / 除外 ${report.excluded.length}` +
      `${report.aborted ? ` ABORT(${report.abortReason})` : ""} (receipt ${report.receiptKey})`
  );
  if (report.aborted || report.held.length > 0) {
    process.exitCode = 1;
  }
}

// CLI として直接実行された場合のみ main() を走らせる
// (テストの import では走らない)。
if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch((e) => {
    console.error("[stock-gap-repair] エラー:", rootCauseMessage(e));
    process.exit(1);
  });
}
