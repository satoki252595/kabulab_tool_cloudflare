import "dotenv/config";
/**
 * moneyflow (008・計画 notion-velvet-goose.md) の日次取込 CLI。
 *
 * 実行: npx tsx scripts/moneyflow/ingest.ts [--dry-run] [--only=jpx-sector-marketcap,jpx-short-selling,sector-turnover]
 *
 * 必要 env (.env):
 *   NOTION_TOKEN / NOTION_STOCK_INFO_PAGE_ID (3 DB の親「株式情報」) /
 *   NOTION_ARCHIVE_PAGE_ID (一次データの親「一次データ保管」) (--dry-run 以外)
 *   WORKER_BASE_URL / CRON_SECRET (sector-turnover が Worker の内部読取
 *   エンドポイントを叩くため。D1 は Node から直接読めない — ADR-0001)
 *
 * 取得元 (今回実装分。信用残の日次化は TODO — docs/moneyflow.md 参照):
 *   - jpx-sector-marketcap: JPX 業種別時価総額 (月次PDF・プライムのみ)
 *   - jpx-short-selling: JPX 空売り業種別集計 (日次PDF取込 + 当月分の月次集計)
 *   - sector-turnover: 既存 D1 (swing_daily_ohlcv×core_stocks.sector) の
 *     週次売買代金・シェア・上昇/下落日売買代金 (Worker 内部エンドポイント経由)
 *
 * --dry-run: 取得・解析はするが Notion には一切書かず、JSON を標準出力へ出す。
 * --only=<source,...>: 指定した取得元だけ実行する。
 *
 * 月次資料 (jpx-sector-marketcap) の再取得方針: 平日 cron (週5回) に対し月次PDFは
 * 月1回しか更新されないため、毎回 JPX へ実体PDFを取りに行くと過剰アクセスになる。
 * 一覧ページの軽量GETで対象年月を先に特定し、`isArchived()` で当月分が既に
 * アーカイブ済みなら PDF 本体の GET はスキップする。ただし「アーカイブ済み」と
 * 「観測ログへの書込済み」は別概念として扱う (観測ログ書込がその後失敗しても
 * 次回以降ずっと欠落させない) — 既にアーカイブ済みの場合も Notion 側に保管済みの
 * PDF を再取得・再パースして観測ログの upsert を毎回試みる (JPX への再取得は
 * しない。upsertObservation は「期間|指標キー|区分」で冪等なので再実行しても安全)。
 */
import { fileURLToPath } from "node:url";
import {
  ensureIndicatorDefsDb,
  ensureObservationsDb,
  ensureRunLogDb,
  isArchived,
  recordPrimaryData,
  recordRunLog,
  upsertIndicatorDef,
  upsertObservation,
  type MoneyflowRunStatus,
} from "../../src/shared/notion-archive/index.js";
import { sharedEnv } from "../../src/shared/env.js";
import { rootCauseMessage } from "../../src/shared/errors.js";
import { MONEYFLOW_INDICATORS } from "../../services/moneyflow/lib/indicators.js";
import {
  fetchSectorMarketCap,
  sectorMarketCapArchiveInput,
  sectorMarketCapKey,
  sectorMarketCapPeriodFromYearMonth,
  latestSectorMarketCapPdfUrl,
  parseSectorMarketCapText,
  type SectorMarketCapData,
} from "../../services/moneyflow/lib/jpx-sector-marketcap.js";
import {
  aggregateMonthlyShortSellingRatio,
  parseShortSellingSectorText,
  fetchShortSellingSector,
  shortSellingArchiveInput,
  type ShortSellingData,
} from "../../services/moneyflow/lib/jpx-short-selling.js";
import { isoWeekLabelOf, mostRecentMondayOf } from "../../services/moneyflow/lib/iso-week.js";
import type { IndicatorDefInput } from "../../src/shared/notion-archive/index.js";
import { extractPdfText } from "../../services/moneyflow/lib/pdf-text.js";
import {
  downloadArchivedFile,
  findArchivedRecordByKey,
  listArchivedRecordsByPrefix,
  requirePrimaryDataDbId,
  type ArchivedRecord,
} from "./lib/archived-files.js";
import { runSpec } from "./lib/run-spec.js";
import { SPEC_SOURCES } from "./sources.js";

/** Phase 1 (R1 東証33業種) の取得元。個別の runner 関数で実装している。 */
export const PHASE1_SOURCES = ["jpx-sector-marketcap", "jpx-short-selling", "sector-turnover"] as const;
type Phase1Source = (typeof PHASE1_SOURCES)[number];

/** Phase 1 の各取得元が書く指標キー (指標定義の同期範囲を実行対象に絞るため)。 */
const PHASE1_INDICATOR_KEYS: Record<Phase1Source, readonly string[]> = {
  "jpx-sector-marketcap": ["sector_market_cap"],
  "jpx-short-selling": ["sector_short_selling_ratio"],
  "sector-turnover": ["sector_turnover", "sector_turnover_share", "sector_up_turnover", "sector_down_turnover"],
};

/** `--only=` に使える全取得元名 (Phase 1 + Phase 2〜5 の spec)。 */
export const SOURCES: readonly string[] = [...PHASE1_SOURCES, ...SPEC_SOURCES.map((s) => s.name)];

function isPhase1Source(name: string): name is Phase1Source {
  return (PHASE1_SOURCES as readonly string[]).includes(name);
}

/**
 * `--only=a,b` を解析する純関数。`sources` に含まれない値があれば throw する
 * (推測でその場をしのがない — ルール2)。未指定なら `sources` 全件を返す。
 */
export function parseOnlyArg(argv: readonly string[], sources: readonly string[]): string[] {
  const prefix = "--only=";
  const a = argv.find((x) => x.startsWith(prefix));
  if (!a) return [...sources];
  const requested = a.slice(prefix.length).split(",").map((s) => s.trim());
  for (const r of requested) {
    if (!sources.includes(r)) {
      throw new Error(`--only: 不明な取得元です: ${r} (使える値: ${sources.join(", ")})`);
    }
  }
  return requested;
}

/**
 * 実行対象の取得元が使う指標定義を集める純関数 (Phase 1 + spec)。
 * 同じ指標キーが別定義で重複していたら throw する (観測ログの relation 先が
 * どちらの定義か曖昧になるため)。
 */
export function indicatorsForSources(selected: readonly string[]): IndicatorDefInput[] {
  const byKey = new Map<string, IndicatorDefInput>();
  const add = (ind: IndicatorDefInput, owner: string) => {
    const prev = byKey.get(ind.key);
    if (prev && JSON.stringify(prev) !== JSON.stringify(ind)) {
      throw new Error(`指標キー「${ind.key}」が複数の取得元で異なる定義になっています (${owner})`);
    }
    byKey.set(ind.key, ind);
  };
  for (const name of selected) {
    if (isPhase1Source(name)) {
      for (const k of PHASE1_INDICATOR_KEYS[name]) {
        const ind = MONEYFLOW_INDICATORS.find((i) => i.key === k);
        if (!ind) throw new Error(`Phase 1 の指標キー「${k}」が MONEYFLOW_INDICATORS にありません`);
        add(ind, name);
      }
      continue;
    }
    const spec = SPEC_SOURCES.find((s) => s.name === name);
    if (!spec) throw new Error(`取得元「${name}」の定義が見つかりません`);
    for (const ind of spec.indicators) add(ind, name);
  }
  return [...byKey.values()];
}

/** 成功/失敗件数から実行ステータスを分類する純関数。 */
export function classifyRunStatus(successCount: number, failedCount: number): MoneyflowRunStatus {
  if (failedCount === 0) return "完了";
  return successCount > 0 ? "一部失敗" : "失敗";
}

const DRY_RUN = process.argv.includes("--dry-run");
const ONLY: readonly string[] = parseOnlyArg(process.argv, SOURCES);

interface RunOutcome {
  source: string;
  ok: boolean;
  detail: string;
}

/** 指標キー→Notion ページ ID のキャッシュ (1 実行内で使い回す)。 */
const indicatorPageIds = new Map<string, string>();

/** 実行対象の取得元が使う指標だけを「資金フロー｜指標定義」へ同期する。 */
async function syncIndicatorCatalog(selected: readonly string[]): Promise<void> {
  const { dbId } = await ensureIndicatorDefsDb();
  for (const ind of indicatorsForSources(selected)) {
    const { pageId } = await upsertIndicatorDef(dbId, ind);
    indicatorPageIds.set(ind.key, pageId);
  }
}

function requireIndicatorPageId(key: string): string {
  const id = indicatorPageIds.get(key);
  if (!id) {
    throw new Error(`指標キー「${key}」の Notion ページ ID が見つかりません (syncIndicatorCatalog 未実行?)`);
  }
  return id;
}

function firstDayOfMonth(yyyyMm: string): string {
  return `${yyyyMm}-01`;
}

/** Notion に実体アップロード済みの PDF (1 ファイル) を取り直し、テキスト抽出する (JPX への再取得はしない)。 */
async function fetchArchivedPdfText(ref: ArchivedRecord, context: string): Promise<string> {
  const file = ref.files[0];
  if (!file || ref.files.length !== 1) {
    throw new Error(`${context}: ${ref.key} の保管ファイルが ${ref.files.length} 件です (PDF 1 件であるべき)`);
  }
  const bytes = await downloadArchivedFile(file, `${context} (${ref.key})`);
  return extractPdfText(bytes);
}

// ---------------------------------------------------------------------------
// jpx-sector-marketcap (月次)
// ---------------------------------------------------------------------------

/**
 * 月次PDFの本体取得をスキップした場合の実行ログ用メッセージ (純関数)。
 * 「アーカイブ済み」であって「観測ログ書込済み」ではない点に注意 — 呼び出し元は
 * この分岐でも Notion 保管済みファイルから観測ログの upsert を毎回試みる。
 */
export function sectorMarketCapSkipDetail(period: string): string {
  return `月次未更新のためPDF再取得なし (${period} は取得済み・Notion保管ファイルから観測ログを再送)`;
}

async function reparseArchivedSectorMarketCap(
  ref: ArchivedRecord
): Promise<Pick<SectorMarketCapData, "asOfDate" | "sectors" | "segments">> {
  const text = await fetchArchivedPdfText(ref, "reparseArchivedSectorMarketCap");
  return parseSectorMarketCapText(text);
}

async function runSectorMarketCap(): Promise<RunOutcome> {
  if (DRY_RUN) {
    const data = await fetchSectorMarketCap();
    console.info(JSON.stringify({ source: "jpx-sector-marketcap", dryRun: true, data }, null, 2));
    return { source: "jpx-sector-marketcap", ok: true, detail: `dry-run asOfDate=${data.asOfDate}` };
  }

  const { yearMonth } = await latestSectorMarketCapPdfUrl();
  const period = sectorMarketCapPeriodFromYearMonth(yearMonth);
  const key = sectorMarketCapKey(period);
  const alreadyArchived = await isArchived("moneyflow", key);

  let asOfDate: string;
  let sectors: SectorMarketCapData["sectors"];
  let primaryDataPageId: string;
  let detail: string;

  if (alreadyArchived) {
    // 月次未更新: JPX への PDF 本体の再取得はせず、Notion に実体保管済みの
    // PDF を取り直して観測ログを再送する (アーカイブ済み ≠ 観測ログ書込済み)。
    const primaryDbId = await requirePrimaryDataDbId("runSectorMarketCap");
    const ref = await findArchivedRecordByKey(primaryDbId, key);
    if (!ref) {
      throw new Error(
        `runSectorMarketCap: isArchived("${key}")=true なのにアーカイブ済みページが見つかりません (整合性エラー)`
      );
    }
    const parsed = await reparseArchivedSectorMarketCap(ref);
    asOfDate = parsed.asOfDate;
    sectors = parsed.sectors;
    primaryDataPageId = ref.pageId;
    detail = sectorMarketCapSkipDetail(period);
  } else {
    const data = await fetchSectorMarketCap();
    const archive = await recordPrimaryData(sectorMarketCapArchiveInput(data));
    asOfDate = data.asOfDate;
    sectors = data.sectors;
    primaryDataPageId = archive.pageId;
    detail = `${data.sectors.length}業種を記録 (${period})`;
  }

  // アーカイブの成否とは無関係に、観測ログへは常に upsert を試みる
  // (upsertObservation は「期間|指標キー|区分」で冪等なので再実行しても安全・安価。
  // ここを archive の outcome で条件分岐すると、途中で失敗した月が Notion 側の
  // アーカイブ済み判定により以後ずっと欠落する — レビュー指摘の再発防止)。
  const { dbId: obsDbId } = await ensureObservationsDb();
  const indicatorPageId = requireIndicatorPageId("sector_market_cap");
  for (const row of sectors) {
    await upsertObservation(obsDbId, {
      period,
      periodStart: firstDayOfMonth(period),
      periodEnd: asOfDate,
      indicatorKey: "sector_market_cap",
      indicatorPageId,
      category: row.sector,
      categoryKind: "業種",
      value: row.marketCapMillionYen * 1_000_000,
      unit: "円",
      changeFromPrev: null,
      approximate: true,
      measureKind: "実測",
      primaryDataPageId,
    });
  }
  return { source: "jpx-sector-marketcap", ok: true, detail };
}

// ---------------------------------------------------------------------------
// jpx-short-selling (日次archive + 当月の月次集計)
// ---------------------------------------------------------------------------

async function reparseArchivedShortSelling(
  ref: ArchivedRecord
): Promise<Omit<ShortSellingData, "pdfBytes" | "pdfUrl">> {
  const text = await fetchArchivedPdfText(ref, "reparseArchivedShortSelling");
  return parseShortSellingSectorText(text);
}

async function runShortSelling(): Promise<RunOutcome> {
  const data = await fetchShortSellingSector();
  if (DRY_RUN) {
    console.info(JSON.stringify({ source: "jpx-short-selling", dryRun: true, data }, null, 2));
    return { source: "jpx-short-selling", ok: true, detail: `dry-run date=${data.date}` };
  }

  const archive = await recordPrimaryData(shortSellingArchiveInput(data));
  const archivedNote =
    archive.outcome === "skipped_existing" ? "既取得PDFを再利用" : "新規PDFを記録";

  // 当月分の月次集計 (今日ぶんを含む、Notion に既に積んである日次 PDF を
  // すべて再取得して加重平均する — recordPrimaryData 以外の追加ストレージを
  // 持たない設計上の帰結。運用開始直後は月初からの日数分しか無いため、
  // 月が進むほど正確になる)。
  const month = data.date.slice(0, 7);
  const primaryDbId = await requirePrimaryDataDbId("runShortSelling");
  // key (= jpx-short-selling-sector-YYYY-MM-DD) の日付昇順
  const files = await listArchivedRecordsByPrefix(primaryDbId, `jpx-short-selling-sector-${month}`);
  const dailyRows = await Promise.all(files.map(reparseArchivedShortSelling));
  const monthly = aggregateMonthlyShortSellingRatio(dailyRows);

  const { dbId: obsDbId } = await ensureObservationsDb();
  const indicatorPageId = requireIndicatorPageId("sector_short_selling_ratio");
  // 当月の売買代金合計が 0 の業種は比率が定義できない (null)。0 で埋めて
  // 書かず、行自体を書かない (取込ログの詳細に業種名を残す — ルール2)。
  const undefinedRatioSectors: string[] = [];
  for (const row of monthly.sectors) {
    if (row.shortRatio === null) {
      undefinedRatioSectors.push(row.sector);
      continue;
    }
    await upsertObservation(obsDbId, {
      period: monthly.month,
      periodStart: firstDayOfMonth(monthly.month),
      periodEnd: data.date,
      indicatorKey: "sector_short_selling_ratio",
      indicatorPageId,
      category: row.sector,
      categoryKind: "業種",
      value: row.shortRatio,
      unit: "比率",
      changeFromPrev: null,
      approximate: true,
      measureKind: "実測",
      // 単一ファイルではなく当月の複数日次 PDF から加重平均した値のため、
      // 一次データへの relation は付けない (捏造して1件だけ選ばない — ルール2)。
      primaryDataPageId: null,
    });
  }
  return {
    source: "jpx-short-selling",
    ok: true,
    detail:
      `日次 ${data.date} (${archivedNote})・月次 ${monthly.month} を ${dailyRows.length}日分で集計` +
      (undefinedRatioSectors.length > 0
        ? ` (売買代金0で比率を定義できず未記録: ${undefinedRatioSectors.join("・")})`
        : ""),
  };
}

// ---------------------------------------------------------------------------
// sector-turnover (週次・既存 D1 経由)
// ---------------------------------------------------------------------------

interface MoneyflowSectorApiRow {
  sector: string;
  turnover: number;
  /** 全業種の売買代金合計が 0 なら null (Worker 側 moneyflow-sector.ts)。 */
  turnoverShare: number | null;
  upTurnover: number;
  downTurnover: number;
  stockCount: number;
}
interface MoneyflowSectorApiResponse {
  from: string;
  to: string;
  sectors: MoneyflowSectorApiRow[];
}

async function fetchSectorTurnoverFromWorker(from: string, to: string): Promise<MoneyflowSectorApiResponse> {
  const base = sharedEnv.WORKER_BASE_URL();
  const secret = sharedEnv.CRON_SECRET();
  if (!secret) throw new Error("CRON_SECRET が設定されていません (.env)");
  const u = new URL(`${base.replace(/\/$/, "")}/api/ingest/moneyflow-sector`);
  u.searchParams.set("from", from);
  u.searchParams.set("to", to);
  const res = await fetch(u, { headers: { Authorization: `Bearer ${secret}` } });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`sector-turnover: Worker 呼び出し失敗 HTTP ${res.status} ${body}`);
  }
  return JSON.parse(body) as MoneyflowSectorApiResponse;
}

async function runSectorTurnover(): Promise<RunOutcome> {
  const today = new Date();
  const to = today.toISOString().slice(0, 10);
  const from = mostRecentMondayOf(today);
  const result = await fetchSectorTurnoverFromWorker(from, to);

  if (DRY_RUN) {
    console.info(JSON.stringify({ source: "sector-turnover", dryRun: true, result }, null, 2));
    return { source: "sector-turnover", ok: true, detail: `dry-run ${from}〜${to}` };
  }

  // 全業種の売買代金合計が 0 (= D1 に対象週の日足がまだ無い等) ならシェアが
  // 定義できない。0% として書かず失敗させる (取込ログに残る — ルール2)。
  const zeroTotalError = () =>
    new Error(
      `sector-turnover: ${result.from}〜${result.to} の売買代金合計が 0 のためシェアを計算できません ` +
        `(業種数=${result.sectors.length}。D1 の日足が未取込の可能性)`
    );
  if (result.sectors.length === 0) throw zeroTotalError();
  const rows = result.sectors.map((r) => {
    if (r.turnoverShare === null) throw zeroTotalError();
    return { ...r, turnoverShare: r.turnoverShare };
  });

  const { dbId: obsDbId } = await ensureObservationsDb();
  const period = isoWeekLabelOf(today);
  const turnoverPageId = requireIndicatorPageId("sector_turnover");
  const sharePageId = requireIndicatorPageId("sector_turnover_share");
  const upPageId = requireIndicatorPageId("sector_up_turnover");
  const downPageId = requireIndicatorPageId("sector_down_turnover");

  for (const row of rows) {
    const common = {
      period,
      periodStart: result.from,
      periodEnd: result.to,
      category: row.sector,
      categoryKind: "業種" as const,
      changeFromPrev: null,
      approximate: true,
      measureKind: "実測" as const,
      primaryDataPageId: null,
    };
    await upsertObservation(obsDbId, {
      ...common,
      indicatorKey: "sector_turnover",
      indicatorPageId: turnoverPageId,
      value: row.turnover,
      unit: "円",
    });
    await upsertObservation(obsDbId, {
      ...common,
      indicatorKey: "sector_turnover_share",
      indicatorPageId: sharePageId,
      value: row.turnoverShare,
      unit: "比率",
    });
    await upsertObservation(obsDbId, {
      ...common,
      indicatorKey: "sector_up_turnover",
      indicatorPageId: upPageId,
      value: row.upTurnover,
      unit: "円",
    });
    await upsertObservation(obsDbId, {
      ...common,
      indicatorKey: "sector_down_turnover",
      indicatorPageId: downPageId,
      value: row.downTurnover,
      unit: "円",
    });
  }
  return {
    source: "sector-turnover",
    ok: true,
    detail: `${result.sectors.length}業種 × 4指標を記録 (${period}, ${result.from}〜${result.to})`,
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const RUNNERS: Record<Phase1Source, () => Promise<RunOutcome>> = {
  "jpx-sector-marketcap": runSectorMarketCap,
  "jpx-short-selling": runShortSelling,
  "sector-turnover": runSectorTurnover,
};

async function runSource(source: string, now: Date): Promise<RunOutcome> {
  if (isPhase1Source(source)) return RUNNERS[source]();
  const spec = SPEC_SOURCES.find((s) => s.name === source);
  if (!spec) throw new Error(`取得元「${source}」の定義が見つかりません`);
  const detail = await runSpec(spec, { dryRun: DRY_RUN, now, indicatorPageId: requireIndicatorPageId });
  return { source, ok: true, detail };
}

export async function main(): Promise<void> {
  if (!DRY_RUN) {
    await syncIndicatorCatalog(ONLY);
  }

  const now = new Date();
  const outcomes: RunOutcome[] = [];
  const failures: string[] = [];
  for (const source of ONLY) {
    try {
      outcomes.push(await runSource(source, now));
    } catch (error) {
      const message = rootCauseMessage(error);
      console.error(`[moneyflow:${source}] エラー: ${message}`);
      outcomes.push({ source, ok: false, detail: message });
      failures.push(`${source}: ${message}`);
    }
  }

  console.info(JSON.stringify({ dryRun: DRY_RUN, only: ONLY, outcomes }, null, 2));

  if (DRY_RUN) return;

  const successCount = outcomes.filter((o) => o.ok).length;
  const failedCount = outcomes.filter((o) => !o.ok).length;
  const status = classifyRunStatus(successCount, failedCount);

  const { dbId: runLogDbId } = await ensureRunLogDb();
  await recordRunLog(runLogDbId, {
    runAt: new Date().toISOString(),
    status,
    sources: ONLY.join(","),
    successCount,
    failedCount,
    runUrl: sharedEnv.GITHUB_RUN_URL() ?? null,
    reason: failures.length > 0 ? failures.join(" / ") : null,
  });

  if (failedCount > 0) process.exitCode = 1;
}

// CLI として直接実行された場合のみ main() を走らせる (import だけでは走らない —
// テストがこのモジュールを安全に import できるようにするためのガード)。
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error("[moneyflow] 致命的エラー:", e);
    process.exit(1);
  });
}
