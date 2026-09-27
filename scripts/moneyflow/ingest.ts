import "dotenv/config";
/**
 * moneyflow (008・計画 notion-velvet-goose.md) の日次取込 CLI。
 *
 * 実行: npx tsx scripts/moneyflow/ingest.ts [--dry-run] [--only=jpx-sector-marketcap,jpx-short-selling,sector-turnover]
 *
 * 必要 env (.env):
 *   NOTION_TOKEN / NOTION_MONEYFLOW_PAGE_ID (--dry-run 以外)
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
 */
import {
  ensureIndicatorDefsDb,
  ensureObservationsDb,
  ensureRunLogDb,
  isMoneyflowRunStatus,
  recordPrimaryData,
  recordRunLog,
  upsertIndicatorDef,
  upsertObservation,
  notionEnv,
} from "../../src/shared/notion-archive/index.js";
import { notionRequest } from "../../src/shared/notion-archive/client.js";
import { findBackupChildByTitle } from "../../src/shared/notion-archive/archive.js";
import { sharedEnv } from "../../src/shared/env.js";
import { rootCauseMessage } from "../../src/shared/errors.js";
import { JPX_33_SECTORS } from "../../services/moneyflow/lib/sector-names.js";
import { MONEYFLOW_INDICATORS } from "../../services/moneyflow/lib/indicators.js";
import {
  fetchSectorMarketCap,
  sectorMarketCapArchiveInput,
} from "../../services/moneyflow/lib/jpx-sector-marketcap.js";
import {
  aggregateMonthlyShortSellingRatio,
  parseShortSellingSectorText,
  fetchShortSellingSector,
  shortSellingArchiveInput,
  type ShortSellingData,
} from "../../services/moneyflow/lib/jpx-short-selling.js";
import { isoWeekLabelOf, mostRecentMondayOf } from "../../services/moneyflow/lib/iso-week.js";
import { extractText, getDocumentProxy } from "unpdf";

const SOURCES = ["jpx-sector-marketcap", "jpx-short-selling", "sector-turnover"] as const;
type Source = (typeof SOURCES)[number];

function arg(key: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${key}=`));
  return a ? a.slice(key.length + 3) : undefined;
}
const DRY_RUN = process.argv.includes("--dry-run");
const ONLY: readonly Source[] = (() => {
  const only = arg("only");
  if (!only) return SOURCES;
  const requested = only.split(",").map((s) => s.trim());
  for (const r of requested) {
    if (!(SOURCES as readonly string[]).includes(r)) {
      throw new Error(`--only: 不明な取得元です: ${r} (使える値: ${SOURCES.join(", ")})`);
    }
  }
  return requested as Source[];
})();

interface RunOutcome {
  source: Source;
  ok: boolean;
  detail: string;
}

/** 指標キー→Notion ページ ID のキャッシュ (1 実行内で使い回す)。 */
const indicatorPageIds = new Map<string, string>();

async function syncIndicatorCatalog(): Promise<void> {
  const { dbId } = await ensureIndicatorDefsDb();
  for (const ind of MONEYFLOW_INDICATORS) {
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

// ---------------------------------------------------------------------------
// jpx-sector-marketcap (月次)
// ---------------------------------------------------------------------------

async function runSectorMarketCap(): Promise<RunOutcome> {
  const data = await fetchSectorMarketCap();
  if (DRY_RUN) {
    console.info(JSON.stringify({ source: "jpx-sector-marketcap", dryRun: true, data }, null, 2));
    return { source: "jpx-sector-marketcap", ok: true, detail: `dry-run asOfDate=${data.asOfDate}` };
  }

  const archive = await recordPrimaryData({
    ...sectorMarketCapArchiveInput(data),
    parentPageId: notionEnv.NOTION_MONEYFLOW_PAGE_ID(),
  });
  if (archive.outcome === "skipped_existing") {
    return {
      source: "jpx-sector-marketcap",
      ok: true,
      detail: `月次未更新のためスキップ (${data.asOfDate.slice(0, 7)} は取得済み)`,
    };
  }

  const { dbId: obsDbId } = await ensureObservationsDb(JPX_33_SECTORS);
  const indicatorPageId = requireIndicatorPageId("sector_market_cap");
  const period = data.asOfDate.slice(0, 7);
  for (const row of data.sectors) {
    await upsertObservation(obsDbId, {
      period,
      periodStart: firstDayOfMonth(period),
      periodEnd: data.asOfDate,
      indicatorKey: "sector_market_cap",
      indicatorPageId,
      category: row.sector,
      categoryKind: "業種",
      value: row.marketCapMillionYen * 1_000_000,
      unit: "円",
      changeFromPrev: null,
      approximate: true,
      measureKind: "実測",
      primaryDataPageId: archive.pageId,
    });
  }
  return { source: "jpx-sector-marketcap", ok: true, detail: `${data.sectors.length}業種を記録 (${period})` };
}

// ---------------------------------------------------------------------------
// jpx-short-selling (日次archive + 当月の月次集計)
// ---------------------------------------------------------------------------

interface ArchivedFileRef {
  pageId: string;
  key: string;
  fileUrl: string;
}

/** 「一次データ｜moneyflow」から今月分の空売り日次 PDF アーカイブ済みページを列挙する。 */
async function listArchivedShortSellingFiles(month: string, primaryDbId: string): Promise<ArchivedFileRef[]> {
  const prefix = `jpx-short-selling-sector-${month}`;
  const out: ArchivedFileRef[] = [];
  let cursor: string | null = null;
  for (;;) {
    const body: Record<string, unknown> = {
      filter: { property: "Key", title: { starts_with: prefix } },
      page_size: 100,
    };
    if (cursor) body.start_cursor = cursor;
    const res = await notionRequest<{
      results: Array<{
        id: string;
        properties: {
          Key?: { title?: Array<{ plain_text?: string }> };
          Files?: { files?: Array<{ name: string; file?: { url: string }; external?: { url: string } }> };
        };
      }>;
      has_more: boolean;
      next_cursor: string | null;
    }>("POST", `/databases/${primaryDbId}/query`, body);
    for (const r of res.results) {
      const key = (r.properties.Key?.title ?? []).map((t) => t.plain_text ?? "").join("");
      const file = r.properties.Files?.files?.[0];
      const fileUrl = file?.file?.url ?? file?.external?.url;
      if (!fileUrl) {
        throw new Error(`listArchivedShortSellingFiles: page ${r.id} (key=${key}) にファイル URL がありません`);
      }
      out.push({ pageId: r.id, key, fileUrl });
    }
    if (!res.has_more || !res.next_cursor) break;
    cursor = res.next_cursor;
  }
  // key (= jpx-short-selling-sector-YYYY-MM-DD) の日付昇順で処理する。
  out.sort((a, b) => a.key.localeCompare(b.key));
  return out;
}

async function reparseArchivedShortSelling(
  ref: ArchivedFileRef
): Promise<Omit<ShortSellingData, "pdfBytes" | "pdfUrl">> {
  const res = await fetch(ref.fileUrl);
  if (!res.ok) {
    throw new Error(`reparseArchivedShortSelling: ${ref.key} の再取得に失敗 status=${res.status}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: true });
  return parseShortSellingSectorText(text);
}

async function runShortSelling(): Promise<RunOutcome> {
  const data = await fetchShortSellingSector();
  if (DRY_RUN) {
    console.info(JSON.stringify({ source: "jpx-short-selling", dryRun: true, data }, null, 2));
    return { source: "jpx-short-selling", ok: true, detail: `dry-run date=${data.date}` };
  }

  const archive = await recordPrimaryData({
    ...shortSellingArchiveInput(data),
    parentPageId: notionEnv.NOTION_MONEYFLOW_PAGE_ID(),
  });
  const archivedNote =
    archive.outcome === "skipped_existing" ? "既取得PDFを再利用" : "新規PDFを記録";

  // 当月分の月次集計 (今日ぶんを含む、Notion に既に積んである日次 PDF を
  // すべて再取得して加重平均する — recordPrimaryData 以外の追加ストレージを
  // 持たない設計上の帰結。運用開始直後は月初からの日数分しか無いため、
  // 月が進むほど正確になる)。
  const month = data.date.slice(0, 7);
  const primaryDbId = await findBackupChildByTitle({
    parentPageId: notionEnv.NOTION_MONEYFLOW_PAGE_ID(),
    title: "一次データ｜moneyflow",
    kind: "database",
  });
  if (!primaryDbId) {
    throw new Error("runShortSelling: 「一次データ｜moneyflow」DB が見つかりません (recordPrimaryData 直後のはず)");
  }
  const files = await listArchivedShortSellingFiles(month, primaryDbId);
  const dailyRows = await Promise.all(files.map(reparseArchivedShortSelling));
  const monthly = aggregateMonthlyShortSellingRatio(dailyRows);

  const { dbId: obsDbId } = await ensureObservationsDb(JPX_33_SECTORS);
  const indicatorPageId = requireIndicatorPageId("sector_short_selling_ratio");
  for (const row of monthly.sectors) {
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
    detail: `日次 ${data.date} (${archivedNote})・月次 ${monthly.month} を ${monthly.sectors.length}日分で集計`,
  };
}

// ---------------------------------------------------------------------------
// sector-turnover (週次・既存 D1 経由)
// ---------------------------------------------------------------------------

interface MoneyflowSectorApiRow {
  sector: string;
  turnover: number;
  turnoverShare: number;
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
  const base = process.env.WORKER_BASE_URL;
  const secret = process.env.CRON_SECRET;
  if (!base) throw new Error("WORKER_BASE_URL が設定されていません (.env)");
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

  const { dbId: obsDbId } = await ensureObservationsDb(JPX_33_SECTORS);
  const period = isoWeekLabelOf(today);
  const turnoverPageId = requireIndicatorPageId("sector_turnover");
  const sharePageId = requireIndicatorPageId("sector_turnover_share");
  const upPageId = requireIndicatorPageId("sector_up_turnover");
  const downPageId = requireIndicatorPageId("sector_down_turnover");

  for (const row of result.sectors) {
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

const RUNNERS: Record<Source, () => Promise<RunOutcome>> = {
  "jpx-sector-marketcap": runSectorMarketCap,
  "jpx-short-selling": runShortSelling,
  "sector-turnover": runSectorTurnover,
};

async function main(): Promise<void> {
  if (!DRY_RUN) {
    await syncIndicatorCatalog();
  }

  const outcomes: RunOutcome[] = [];
  const failures: string[] = [];
  for (const source of ONLY) {
    try {
      outcomes.push(await RUNNERS[source]());
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
  const status = failedCount === 0 ? "完了" : successCount > 0 ? "一部失敗" : "失敗";
  if (!isMoneyflowRunStatus(status)) throw new Error(`unreachable: 不正な status ${status}`);

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

main().catch((e) => {
  console.error("[moneyflow] 致命的エラー:", e);
  process.exit(1);
});
