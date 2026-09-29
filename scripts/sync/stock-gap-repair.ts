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
 * `--execute --eligible-file <pinned-grant.json>` が無いと起動しない。
 * receipt POST 前に 0600 証拠を persist し、ack 後は添付 readback で
 * 物理完了を確認する。`resume-receipt --run-id` は既存 key の一意照会 +
 * hosted readback のみ (再 POST なし・D1 不使用)。
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

/** POST 前に 0600 persist する receipt 証拠 (resume の照合原器)。 */
export interface ReceiptProof {
  key: string;
  runId: string;
  sha256: string;
  bytes: Uint8Array;
}

export interface GapRepairDeps {
  loadCustody: () => Promise<RepairCustody>;
  /** active equity の code→id (drift 検出用。既定は loadDailyTargets)。 */
  loadTargets: () => Promise<{ id: number; code: string }[]>;
  /** 指定 (stockId, date) の既存 7 値 (行なしは欠番)。readback で再利用。 */
  readRows: (stockIds: readonly number[], date: string) => Promise<Map<number, OhlcvSeven>>;
  /** 同 runId proof の事前存在確認 (D1 送信前。既存なら resume-only 誘導で HOLD)。 */
  probeProofAbsent: (runId: string) => Promise<void>;
  sendBatch: (statements: readonly D1BatchStatement[]) => Promise<void>;
  record: typeof recordPrimaryData;
  /** receipt POST 前の 0600 persist (既定は repo tmp/ へ 0600 書込)。 */
  persistProof: (proof: ReceiptProof) => Promise<string>;
  /** receipt ack 後の物理 readback (既定は verifyReceiptAttachment)。 */
  verifyReceipt: (pageId: string, filename: string, bytes: Uint8Array) => Promise<void>;
}

export interface GapRepairReport {
  date: string;
  runId: string;
  diagKey: string;
  receiptKey: string | null;
  /** readback の exact-match で確定した適用数 (応答成功だけでは数えない)。 */
  applied: number;
  /**
   * readback の非確定 (0 としない。HOLD 扱い。再送なし)。
   * SELECT 時点の不存在は rollback 確定にしない (切断 POST の遅延 commit が
   * あり得るため observed-absent-at-readback として HOLD する)。
   * この sender は明示 rollback 応答を型で区別できないため、rollback 確定の
   * 区分は持たない。
   */
  unknown: { code: string; reason: string }[];
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
/** Root grant の eligible 入力 (pinned file。bare list は受けない)。 */
export interface EligibleGrant {
  codes: ReadonlySet<string>;
  /** grant file 自体の SHA256 (receipt へ残す証拠)。 */
  fileSha256: string;
  source: string;
  sourceSha256: string;
  archivePins: readonly string[];
}

/**
 * eligible grant file の strict parse (fail-closed)。
 * 必須: date 一致・source・sourceSha256(hex64)・archivePins 非空・
 * codes 非空一意。資格の意味は grant が決める (コードは推測しない)。
 */
export function parseEligibleFile(text: string): Omit<EligibleGrant, "fileSha256"> {
  const fail = (why: string): never => {
    throw new Error(`eligible file の検証に失敗したため STOP: ${why}`);
  };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    fail("JSON ではない");
  }
  if (!json || typeof json !== "object") fail("object ではない");
  const o = json as Record<string, unknown>;
  if (o["date"] !== REPAIR_DATE) fail(`date 不一致 (${String(o["date"])})`);
  if (typeof o["source"] !== "string" || o["source"].length === 0) fail("source なし");
  if (typeof o["sourceSha256"] !== "string" || !/^[0-9a-f]{64}$/.test(o["sourceSha256"])) {
    fail("sourceSha256 が hex64 ではない");
  }
  if (!Array.isArray(o["archivePins"]) || o["archivePins"].length === 0) fail("archivePins なし");
  for (const p of o["archivePins"] as unknown[]) {
    if (typeof p !== "string" || p.length === 0) fail("archivePins 要素が空");
  }
  if (!Array.isArray(o["codes"]) || o["codes"].length === 0) fail("codes が空");
  const codes = new Set<string>();
  for (const c of o["codes"] as unknown[]) {
    if (typeof c !== "string" || c.length === 0) fail("codes 要素が空");
    const code = c as string;
    if (codes.has(code)) fail(`codes 重複 (${code})`);
    codes.add(code);
  }
  return {
    codes,
    source: o["source"] as string,
    sourceSha256: o["sourceSha256"] as string,
    archivePins: (o["archivePins"] as string[]).slice(),
  };
}

export async function runGapRepair(
  runId: string,
  eligible: EligibleGrant,
  deps: GapRepairDeps,
  nowIso: () => string = () => new Date().toISOString()
): Promise<GapRepairReport> {
  // 保存対象は eligible (date-effective 資格検証済み。Root が grant 時に支給)
  // に属する has_real_bar のみ。暫定 denylist を埋め込まず、active flag や
  // 欠落データから資格を推測しない。空・未知・非 has_real_bar は即 STOP。
  const eligibleCodes = eligible.codes;
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

  // D1 送信前: 同 runId proof の存在確認。再実行の二重送信を防ぐ。
  // 既存があればここで HOLD (resume-only へ誘導)。原器の上書きはしない。
  await deps.probeProofAbsent(runId);

  // chunk batch 送信。応答不明 (throw) の chunk は attempted として残し、
  // 後続を送らず STOP する (再 POST なし)。適用数は readback 確定まで数えない。
  const confirmed: OhlcvInsertRow[] = [];
  const attempted: OhlcvInsertRow[] = [];
  let aborted = false;
  let abortReason: string | null = null;
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
      attempted.push(...chunk);
      break;
    }
    confirmed.push(...chunk);
  }

  // readback: 応答成功 + 応答不明の全対象を再 SELECT する。
  // raw 全 tuple の exact-match だけを observed-committed (適用確定) とする。
  // SELECT 時点の不存在は rollback の証明にならない (fetch 切断・invalid
  // response 時に server transaction の終了証明はなく、元 POST の遅延 commit
  // があり得る) ため observed-absent-at-readback として unknown/HOLD に残す。
  // different は drift、SELECT 失敗は unobserved。適用 0 の断定・再送はしない。
  const appliedCodes: string[] = [];
  const unknown: { code: string; reason: string }[] = [];
  const verifyTargets = [...confirmed, ...attempted];
  let reread: Map<number, OhlcvSeven> | null = null;
  if (verifyTargets.length > 0) {
    try {
      reread = await deps.readRows(
        verifyTargets.map((r) => r.stockId),
        REPAIR_DATE
      );
    } catch (e) {
      for (const t of verifyTargets) {
        unknown.push({ code: t.code, reason: `readback-unobserved:${rootCauseMessage(e).slice(0, 120)}` });
      }
      aborted = true;
      abortReason = `readback-unobserved:${rootCauseMessage(e).slice(0, 120)}`;
    }
  }
  if (reread !== null) {
    for (const s of confirmed) {
      const row = reread.get(s.stockId);
      if (row !== undefined && ohlcvSevenEqual(row, s)) {
        appliedCodes.push(s.code);
      } else if (row === undefined) {
        unknown.push({ code: s.code, reason: "observed-absent-at-readback" });
      } else {
        unknown.push({ code: s.code, reason: "confirmed-row-drift" });
      }
    }
    for (const s of attempted) {
      const row = reread.get(s.stockId);
      if (row !== undefined && ohlcvSevenEqual(row, s)) {
        appliedCodes.push(s.code);
      } else if (row === undefined) {
        unknown.push({ code: s.code, reason: "observed-absent-at-readback" });
      } else {
        unknown.push({ code: s.code, reason: "attempted-row-drift" });
      }
    }
    if (unknown.length > 0 && !aborted) {
      aborted = true;
      abortReason = `readback-unknown:[${unknown.map((u) => u.code).join(",")}]`;
    }
  }
  const readbackDetail =
    verifyTargets.length === 0 ? "not-applicable" : `applied:${appliedCodes.length}/unknown:${unknown.length}`;

  // receipt 記録 (値は custody にだけ残す)。POST 前に 0600 persist し、
  // ack 後は readback (件数・名前・hosted・bytes SHA) で物理完了を確認する。
  // 曖昧 POST は再送しない (resume-receipt で readonly 回復)。
  const receiptKey = `price-sync-repair-20260929-${runId}`;
  const applied = appliedCodes.length;
  const byVerifyCode = new Map(verifyTargets.map((r) => [r.code, r]));
  const receipt = {
    service: SERVICE,
    kind: "price-sync-repair-receipt",
    key: receiptKey,
    date: REPAIR_DATE,
    runId,
    diagKey: REPAIR_DIAG_KEY,
    diagManifestSha256: REPAIR_DIAG_MANIFEST_SHA256,
    eligible: {
      fileSha256: eligible.fileSha256,
      source: eligible.source,
      sourceSha256: eligible.sourceSha256,
      archivePins: [...eligible.archivePins],
      codes: [...eligibleCodes],
    },
    generatedAt: nowIso(),
    applied,
    unknown,
    write0,
    held,
    excluded,
    aborted,
    abortReason,
    readback: readbackDetail,
    // 監査用の行値 (Notion custody 内のみ。stdout/Git には出さない)。
    writes: appliedCodes.map((code) => {
      const s = byVerifyCode.get(code) as OhlcvInsertRow;
      return {
        code: s.code,
        stockId: s.stockId,
        row: { date: s.date, open: s.open, high: s.high, low: s.low, close: s.close, volume: s.volume, adj: s.adj },
      };
    }),
  };
  const receiptBytes = new TextEncoder().encode(JSON.stringify(receipt));
  const receiptSha = await sha256HexBytes(Uint8Array.from(receiptBytes));
  const proofPath = await deps.persistProof({ key: receiptKey, runId, sha256: receiptSha, bytes: receiptBytes });
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
        eligibleFileSha256: eligible.fileSha256,
        eligibleCount: eligibleCodes.size,
        applied,
        unknownCount: unknown.length,
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
          bytes: receiptBytes,
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
    await deps.verifyReceipt(res.pageId, `${receiptKey}.json`, receiptBytes);
    recordedReceiptKey = receiptKey;
  } catch (e) {
    // Unknown を含め再送しない (単発呼出)。
    // 同一 runId の再 POST は禁止。原実行の回収は readonly のみ:
    // `resume-receipt --run-id=${runId}` で既存 key + 0600 証拠 bytes を照合し、
    // 不在/読取失敗は HOLD。別 runId で同 receipt を書き直さない
    // (独立した後日の通常実行と原 Unknown 解消を混同しない)。
    const resumeHint = `同一runIdの再POST禁止。resume-receipt --run-id=${runId} で既存key+0600証拠のreadonly回収のみ。不在/読取失敗はHOLD (receiptKey=${receiptKey} proof=${proofPath})`;
    if (e instanceof NotionUnknownResultError) {
      const u = e as Error;
      u.message = `${u.message} (${resumeHint})`;
      throw u;
    }
    throw new Error(`修復 receipt の記録に失敗: ${rootCauseMessage(e)} (${resumeHint})`);
  }

  return {
    date: REPAIR_DATE,
    runId,
    diagKey: REPAIR_DIAG_KEY,
    receiptKey: recordedReceiptKey,
    applied,
    unknown,
    write0,
    held,
    excluded,
    aborted,
    abortReason,
  };
}

/**
 * receipt 添付 1 件の readback (ack だけでは物理完了を宣言しない)。
 * 件数・名前・hosted・全 bytes (長さ+SHA256) を照合する。
 */
export async function verifyReceiptAttachment(
  pageId: string,
  filename: string,
  expected: Uint8Array
): Promise<void> {
  const fail = (why: string): never => {
    throw new Error(`修復 receipt の readback 照合に失敗したため HOLD: ${why}`);
  };
  const hosted = await listPageFiles(pageId, "Files");
  if (hosted.length !== 1) fail(`添付 ${hosted.length} 件 ≠ 期待 1 件`);
  const got = hosted[0];
  if (got.name !== filename) fail(`添付名不一致「${got.name}」`);
  if (got.kind !== "file") fail("receipt が Notion-hosted 添付ではありません");
  const res = await fetch(got.url);
  if (!res.ok) fail(`再取得に失敗 status=${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length !== expected.length) fail(`バイト長 ${bytes.length} ≠ ${expected.length}`);
  const [gotSha, wantSha] = await Promise.all([
    sha256HexBytes(Uint8Array.from(bytes)),
    sha256HexBytes(Uint8Array.from(expected)),
  ]);
  if (gotSha !== wantSha) fail("SHA256 不一致");
}

// ---------------------------------------------------------------------------
// receipt 証拠の 0600 persist + readonly resume
// ---------------------------------------------------------------------------

/** 0600 証拠の既定 dir (repo tmp/ 配下。git 管理外)。 */
export const RECEIPT_PROOF_DIR = "tmp/stock-gap-repair";

export function receiptProofPath(dir: string, runId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(runId) || runId.includes("..")) {
    throw new Error(`runId が証拠パスに使えません: ${runId}`);
  }
  return `${dir.replace(/\/+$/, "")}/receipt-${runId}.json`;
}

/**
 * 同 runId proof の事前存在確認 (D1 送信より前に呼ぶ)。
 * 既存があれば新規送信せず resume-only へ誘導して HOLD する
 * (Actions 再実行・同 run.attempt の二重送信防止。原器の上書きはしない)。
 */
export async function probeReceiptProofAbsent(dir: string, runId: string): Promise<void> {
  const { stat } = await import("node:fs/promises");
  const path = receiptProofPath(dir, runId);
  try {
    await stat(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  throw new Error(
    `修復の開始を HOLD: 同 runId の receipt 証拠が既にあります (path=${path})。` +
      `D1 送信前に停止します。新規送信はせず resume-receipt --run-id=${runId} で readonly 回収すること`
  );
}

function proofBytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * receipt 証拠の persist。原器の無条件 truncate はしない。
 * - 新規のみ `wx` 排他作成 (0600)。競合 (EEXIST) は HOLD。
 * - 既存があれば key/SHA/bytes 完全一致のときだけ再利用する。
 *   不一致・parse 不可・mode 非 0600 は D1/POST 前 HOLD とし、原器は
 *   一切変更しない (自動 chmod なし、信用もしない)。
 * 再実行で write0/時刻が変わっても Unknown 元の expected bytes を壊さない。
 */
export async function persistReceiptProofFile(dir: string, proof: ReceiptProof): Promise<string> {
  const { mkdir, writeFile, readFile, stat } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });
  const path = receiptProofPath(dir, proof.runId);
  const resumeOnly =
    `原器は変更しません。新規送信はせず resume-receipt --run-id=${proof.runId} で readonly 回収すること`;
  // 書込開始前の既存確認 (原器保護が先、書込は後)。
  let existing: string | null = null;
  try {
    existing = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (existing !== null) {
    const st = await stat(path);
    if ((st.mode & 0o777) !== 0o600) {
      throw new Error(
        `receipt 証拠の再利用を HOLD: 既存 proof の mode が 0600 ではありません (path=${path})。` +
          `${resumeOnly} (自動 chmod はしません)`
      );
    }
    let o: unknown;
    try {
      o = JSON.parse(existing);
    } catch {
      throw new Error(`receipt 証拠の再利用を HOLD: 既存 proof の parse に失敗 (path=${path})。${resumeOnly}`);
    }
    const prev = o as { key: string; runId: string; sha256: string; bytesBase64: string };
    const prevBytes =
      typeof prev?.bytesBase64 === "string" ? new Uint8Array(Buffer.from(prev.bytesBase64, "base64")) : null;
    const prevSha = prevBytes ? await sha256HexBytes(Uint8Array.from(prevBytes)) : null;
    const identical =
      prev?.key === proof.key &&
      prev?.runId === proof.runId &&
      typeof prev?.sha256 === "string" &&
      prev.sha256 === proof.sha256 &&
      prevSha === proof.sha256 &&
      prevBytes !== null &&
      proofBytesEqual(prevBytes, proof.bytes);
    if (!identical) {
      throw new Error(
        `receipt 証拠の再利用を HOLD: 既存 proof と内容不一致 (key/SHA/bytes のいずれかが相違 path=${path})。` +
          `${resumeOnly}`
      );
    }
    return path;
  }
  const body = JSON.stringify({
    key: proof.key,
    runId: proof.runId,
    sha256: proof.sha256,
    bytesBase64: Buffer.from(proof.bytes).toString("base64"),
  });
  try {
    await writeFile(path, body, { mode: 0o600, flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`receipt 証拠の作成を HOLD: 同 runId の proof が既にあります (path=${path})。${resumeOnly}`);
    }
    throw e;
  }
  return path;
}

export async function loadReceiptProofFile(dir: string, runId: string): Promise<ReceiptProof | null> {
  const { readFile } = await import("node:fs/promises");
  let text: string;
  try {
    text = await readFile(receiptProofPath(dir, runId), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  const o = JSON.parse(text) as { key: string; runId: string; sha256: string; bytesBase64: string };
  if (o.key === undefined || o.runId !== runId || typeof o.sha256 !== "string" || typeof o.bytesBase64 !== "string") {
    throw new Error(`receipt 証拠ファイルの形式不正: ${runId}`);
  }
  const bytes = new Uint8Array(Buffer.from(o.bytesBase64, "base64"));
  const sha = await sha256HexBytes(Uint8Array.from(bytes));
  if (sha !== o.sha256) {
    throw new Error(`receipt 証拠ファイルの SHA 不一致 (改ざん疑い): ${runId}`);
  }
  return { key: o.key, runId: o.runId, sha256: o.sha256, bytes };
}

export interface ResumeResult {
  status: "adopted" | "absent";
  key: string;
  runId: string;
  pageId: string | null;
  detail: string;
}

/**
 * receipt の readonly resume。新規 mutation なし (D1・Notion 書込ゼロ、
 * receipt 再 POST なし)。0600 証拠と既存 key の一意照会 + hosted 全件
 * readback のみで回復可否を決める。不在/読取失敗は HOLD (再 POST しない。
 * 別 runId での書直しはしない。独立した後日の通常実行と原 Unknown 解消は
 * 別に扱う)。
 */
export async function resumeReceiptProof(
  runId: string,
  opts?: { dir?: string }
): Promise<ResumeResult> {
  const dir = opts?.dir ?? RECEIPT_PROOF_DIR;
  const proof = await loadReceiptProofFile(dir, runId);
  if (!proof) {
    throw new Error(
      `resume HOLD: 0600 証拠なし (dir=${dir} runId=${runId})。` +
        `同一マシンの証拠で再実行すること。再 POST・別 runId での書直しはしない`
    );
  }
  const dbId = await findBackupChildByTitle({
    parentPageId: notionEnv.NOTION_ARCHIVE_PAGE_ID(),
    title: "一次データ｜stock-sync",
    kind: "database",
  });
  if (!dbId) {
    throw new Error("resume STOP: 「一次データ｜stock-sync」DB なし");
  }
  const row = await queryUniqueRow<{ id: string }>(
    dbId,
    { property: "Key", title: { equals: proof.key } },
    `resume の重複 key=${proof.key} を選ばず保全停止`
  );
  if (!row) {
    return { status: "absent", key: proof.key, runId, pageId: null, detail: "key なし (未記録のため HOLD。再 POST しない)" };
  }
  await verifyReceiptAttachment(row.id, `${proof.key}.json`, proof.bytes);
  return { status: "adopted", key: proof.key, runId, pageId: row.id, detail: "既存記録と 0600 証拠が一致" };
}

// ---------------------------------------------------------------------------
// live 配線 + CLI
// (修復実行は `--execute --eligible-file ...` が無いと起動しない)
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
      "保存対象は --eligible-file の pinned grant のみ (bare list は受けない)。",
      "live 実行 (D1 INSERT + Notion receipt) には --execute が必要です。",
      "resume-receipt --run-id <id>: 0600 証拠と既存 key の readonly 照合のみ (再 POST なし)。",
      "本番 INSERT は Root 最終 review + gate まで行いません。",
    ].join("\n")
  );
  process.exit(2);
  throw new Error("unreachable");
}

function flagValue(args: readonly string[], name: string): string | null {
  const flag = args.find((a) => a.startsWith(`${name}=`));
  return flag ? flag.slice(name.length + 1) : null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "resume-receipt") {
    const runId = flagValue(args, "--run-id");
    if (!runId) {
      console.error("[stock-gap-repair] resume-receipt には --run-id=<id> が必要です");
      process.exit(2);
    }
    const dir = flagValue(args, "--receipt-dir") ?? RECEIPT_PROOF_DIR;
    const r = await resumeReceiptProof(runId, { dir });
    console.info(JSON.stringify(r, null, 2));
    if (r.status !== "adopted") process.exitCode = 1;
    return;
  }
  const eligiblePath = flagValue(args, "--eligible-file");
  if (!args.includes("--execute") || eligiblePath === null) printScopeAndExit();
  const { readFile } = await import("node:fs/promises");
  const eligibleText = await readFile(eligiblePath, "utf8");
  const eligibleBytes = new TextEncoder().encode(eligibleText);
  const eligibleParsed = parseEligibleFile(eligibleText);
  const eligible: EligibleGrant = {
    ...eligibleParsed,
    fileSha256: await sha256HexBytes(Uint8Array.from(eligibleBytes)),
  };
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
    persistProof: (proof) => persistReceiptProofFile(RECEIPT_PROOF_DIR, proof),
    verifyReceipt: (pageId, filename, bytes) => verifyReceiptAttachment(pageId, filename, bytes),
    probeProofAbsent: (probeRunId) => probeReceiptProofAbsent(RECEIPT_PROOF_DIR, probeRunId),
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
        unknown: report.unknown,
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
    `[stock-gap-repair] 完了: 適用 ${report.applied} / ` +
      `unknown ${report.unknown.length} / write0 ${report.write0.length} / held ${report.held.length} / ` +
      `除外 ${report.excluded.length}` +
      `${report.aborted ? ` ABORT(${report.abortReason})` : ""} (receipt ${report.receiptKey})`
  );
  if (report.aborted || report.held.length > 0 || report.unknown.length > 0) {
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
