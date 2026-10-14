/** 独立市場sessionと同一原本の閉場証明。営業日/休日の推測はしない。 */
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { fetchChart, parseChartResponse, type DailyResult, type YahooRawCapture } from "../../../src/shared/yahoo/client.js";
import { guardChartBars } from "../../../src/shared/yahoo/bar-sanity.js";
import { assertStockSyncDeadline, assertStockSyncStart, stockSyncRunDate } from "../../../src/shared/stock-sync-window.js";
import { loadMacroJpLeg, macroJpCacheKey } from "../../../src/cron/macro-jp-leg.js";
import { notionRequest } from "../../../src/shared/notion-archive/client.js";
import { downloadArchivedFile } from "../../moneyflow/lib/archived-files.js";
import { r2GetVersion, type R2ReadOptions } from "./r2.js";
import { archiveYahooRawBatch, type YahooRawAttempt, type YahooRawMissing } from "../../../src/shared/yahoo/raw-custody.js";
import { diagnoseConfirmedCloses, selectConfirmedCloses } from "../../../src/cron/macro-session.js";
import { formatConfirmedHoldDiag, formatNullBandHoldLog } from "../../../src/cron/inc-financials-stale-diag.js";
import type { DailyOhlcv } from "../../../src/shared/types.js";
import { isCalendarDateString, isStrictIsoUtc, jstDateSec, tenYearRangeForDate } from "../../../src/shared/vwap/proof.js";
import { completedDailyFetch, isBeforeOpenHistoricalSession, sanitizeLogText, type DailySessionReference } from "./ingest-guard.js";

export type { DailySessionReference } from "./ingest-guard.js";

/** 同じN225原本だけで閉場済みsessionを証明する。direct/cacheで条件を共通にする。 */
export function qualifyDailySessionReference(capture: Pick<YahooRawCapture, "bytes" | "symbol" | "status" | "receivedAt">, bars: DailyOhlcv[]): DailySessionReference {
  if (capture.symbol !== "^N225" || capture.status !== 200) throw new Error("daily session HOLD: benchmarkの同一HTTP原本がありません");
  const confirmed = selectConfirmedCloses(capture.bytes, bars, "^N225");
  const result = JSON.parse(new TextDecoder().decode(capture.bytes)).chart?.result?.[0], meta = result?.meta;
  const regular = meta?.currentTradingPeriod?.regular;
  if (!isStrictIsoUtc(capture.receivedAt) || meta?.range !== "1mo" || meta?.exchangeTimezoneName !== "Asia/Tokyo" ||
    ![regular?.start, regular?.end, meta?.regularMarketTime].every((t) => typeof t === "number" && Number.isSafeInteger(t) && t > 0) ||
    regular.start >= regular.end || regular.timezone !== "JST" || regular.gmtoffset !== 32400 ||
    Date.parse(capture.receivedAt) / 1000 < meta.regularMarketTime || jstDateSec(meta.regularMarketTime) !== confirmed.date ||
    !Number.isSafeInteger(result.timestamp.at(-1)) || result.timestamp.at(-1) > meta.regularMarketTime ||
    jstDateSec(result.timestamp.at(-1)) !== confirmed.date || bars.at(-1)?.date !== confirmed.date) {
    throw new Error("daily session HOLD: benchmarkの現在sessionが閉場済みではありません");
  }
  const sameClosedSession = meta.regularMarketTime >= regular.end &&
    jstDateSec(regular.start) === confirmed.date && jstDateSec(regular.end) === confirmed.date;
  if (!sameClosedSession && !isBeforeOpenHistoricalSession(regular.start, regular.end, meta.regularMarketTime,
    confirmed.date, capture.receivedAt)) throw new Error("daily session HOLD: benchmarkの現在sessionが閉場済みではありません");
  return { date: confirmed.date, observedAt: capture.receivedAt,
    rawSha: createHash("sha256").update(capture.bytes).digest("hex") };
}

/** 通常共有benchmarkを取得・物理照合する。暦日更新時は別stageで元原本を保持する。 */
export async function fetchDailySessionReference(runId: string, stage = "vwap-daily-session", beforeRequest?: () => void): Promise<DailySessionReference> {
  const captures: YahooRawAttempt[] = [], missing: YahooRawMissing[] = [];
  let capture: YahooRawCapture | undefined;
  let diagBars: DailyOhlcv[] | undefined; // 計測のみ (INC-20261008-kabulab_tool_cloudflare-financials-stale)
  try {
    const chart = await fetchChart("^N225", "1mo", { ...(beforeRequest === undefined ? {} : { beforeRequest }), onRaw: (raw) => {
      captures.push({ api: "chart", attempt: 1, capture: raw });
      capture = raw;
    } });
    diagBars = chart.ohlcv;
    if (captures.length !== 1 || capture === undefined || capture.symbol !== "^N225" || capture.status !== 200) {
      throw new Error("daily session HOLD: benchmarkの同一HTTP原本がありません");
    }
    return qualifyDailySessionReference(capture, chart.ohlcv);
  } catch (e) {
    try {
      // 計測のみ (INC-20261008-kabulab_tool_cloudflare-financials-stale)。判定・例外には使わない。
      const raw = capture as YahooRawCapture | undefined;
      if (raw !== undefined && diagBars !== undefined) {
        const holdDiag = diagnoseConfirmedCloses(raw.bytes, diagBars, "^N225");
        console.warn(formatConfirmedHoldDiag("vwap-daily-session", "^N225", raw.receivedAt, holdDiag));
        console.warn(formatNullBandHoldLog({
          stage: "vwap-daily-session",
          symbol: "^N225",
          receivedAt: raw.receivedAt,
          raw: raw.bytes,
          bars: diagBars,
          targetDate: holdDiag.candidateDate,
        }));
      }
    } catch {
      // 計測ログの失敗は無視する (挙動不変)
    }
    if (captures.length === 0) missing.push({ api: "chart", symbol: "^N225", attempt: 1,
      failedAt: new Date().toISOString(), error: sanitizeLogText(e instanceof Error ? e.message : String(e)) });
    throw e;
  } finally {
    // 取得失敗/形成中HOLDも保管する。unknownは再送せず呼出元をSTOPする。
    await archiveYahooRawBatch({ service: "vwap-analysis", runId, stage, captures, missing });
  }
}


export type DailySessionSource = { kind: "yahoo-direct" } | { kind: "archived-jp-leg"; date: string };
/** sourceは取得前に明示確定する。欠測時に別source/旧日へ切り替えない。 */
export function resolveDailySessionSource(source: string | undefined, date: string | undefined, now: string): DailySessionSource {
  if (!isStrictIsoUtc(now)) throw new Error("daily session HOLD: 実run clock不正");
  if (source === undefined || source === "yahoo-direct") {
    if (date !== undefined) throw new Error("daily session HOLD: archived-jp-leg以外にdateを指定できません");
    return { kind: "yahoo-direct" };
  }
  if (source !== "archived-jp-leg" || date === undefined || !isCalendarDateString(date) || date !== jstDateSec(Date.parse(now) / 1000)) {
    throw new Error("daily session HOLD: sourceまたは同日dateの明示指定が不正");
  }
  return { kind: "archived-jp-leg", date };
}
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
type ArchivedDailySessionResult = {
  reference: DailySessionReference;
  custody: { source: "archived-jp-leg"; cacheKey: string; archivePageId: string; manifestSha256: string;
    n225ArchivePageId: string; n225Filename: string; n225GzipSha256: string };
};

/** VWAPは従来どおり読取前後の実JST当日だけを許可する。 */
export async function loadArchivedDailySessionReference(date: string, readOptions?: R2ReadOptions): Promise<ArchivedDailySessionResult> {
  return readArchivedDailySessionReference(date, readOptions, () => {
    resolveDailySessionSource("archived-jp-leg", date, new Date().toISOString());
  });
}

/** 明示した株式UTC対象日だけを読取。古い日付への切替や時刻の注入はしない。 */
export async function loadArchivedStockDailySessionReference(date: string, readOptions?: R2ReadOptions): Promise<ArchivedDailySessionResult & {
  qualification: { policy: "stock-sync-utc"; asOfDate: string; qualifiedAt: string };
}> {
  let qualifiedAt: string | undefined;
  const result = await readArchivedDailySessionReference(date, readOptions, () => {
    const now = Date.now();
    if (!isCalendarDateString(date) || date !== stockSyncRunDate(now)) {
      throw new Error("stock session HOLD: 明示as-of日が実UTC対象日と一致しません");
    }
    assertStockSyncStart(now);
    assertStockSyncDeadline(date, now);
    qualifiedAt = new Date(now).toISOString();
  });
  assert.ok(qualifiedAt !== undefined);
  return { ...result, qualification: { policy: "stock-sync-utc", asOfDate: date, qualifiedAt } };
}

/** 純読取。R2は1回、既存JP manifest/VIとN225原gzipをfresh物理照合する（原本再保管なし）。 */
async function readArchivedDailySessionReference(date: string, readOptions: R2ReadOptions | undefined, assertClock: () => void): Promise<ArchivedDailySessionResult> {
  assertClock();
  const r2Options = readOptions === undefined ? { maxBytes: 20 * 1024 * 1024, abortSignal: AbortSignal.timeout(60_000) } : readOptions;
  let cacheBody: string | undefined;
  const leg = await loadMacroJpLeg({ get: async (key) => {
    assert.equal(key, macroJpCacheKey(date)); assert.equal(cacheBody, undefined, "同runのcache再GETは禁止");
    const found = await r2GetVersion(key, r2Options); if (found !== null) cacheBody = found.body; return found;
  }, put: async () => { throw new Error("daily session HOLD: 保存JP原本readerのPUTは禁止"); } }, date);
  if (leg === null || cacheBody === undefined) throw new Error("daily session HOLD: 明示同日の保存JP原本がありません");
  const cache = JSON.parse(cacheBody), raw = Buffer.from(cache.n225.bodyBase64, "base64");
  assert.equal(sha(raw), leg.reference.n225.sha256);
  const parsed = parseChartResponse(JSON.parse(raw.toString("utf8")), "^N225");
  const { bars } = guardChartBars(parsed.bars, parsed.meta.regularMarketPrice, "^N225");
  const reference = qualifyDailySessionReference({ bytes: raw, symbol: "^N225", status: cache.n225.status, receivedAt: cache.n225.receivedAt }, bars);
  assert.equal(reference.date, date); assert.equal(reference.observedAt, leg.reference.n225.receivedAt);
  const manifest = JSON.parse(Buffer.from(cache.archive.manifestBase64, "base64").toString("utf8"));
  const pageId = leg.reference.n225.archivePages[0];
  assert.match(pageId, /^[a-f0-9-]{32,36}$/i);
  const page = await notionRequest<{ object: string; id: string; archived: boolean; in_trash: boolean;
    parent: { type: string; database_id: string }; properties: Record<string, { type: string; has_more?: boolean;
      select?: { name: string }; title?: Array<{ type: string; plain_text: string; text: { content: string } }>;
      rich_text?: Array<{ type: string; plain_text: string; text: { content: string } }>;
      files?: Array<{ name: string; type: string; file?: { url: string } }> }> }>("GET", `/pages/${pageId}`, undefined, { singleAttempt: true });
  assert.equal(page.object, "page"); assert.equal(page.id.replaceAll("-", ""), pageId.replaceAll("-", ""));
  assert.equal(page.archived, false); assert.equal(page.in_trash, false); assert.equal(page.parent.type, "database_id");
  assert.match(page.parent.database_id.replaceAll("-", ""), /^[a-f0-9]{32}$/i);
  assert.ok(Object.values(page.properties).every(prop => prop.has_more !== true));
  const nativeText = (name: "Key" | "Metadata", kind: "title" | "rich_text") => {
    const prop = page.properties[name]; assert.equal(prop.type, kind); const parts = prop[kind]; assert.ok(Array.isArray(parts));
    return parts.map(part => { assert.equal(part.type, "text"); assert.equal(part.plain_text, part.text.content); return part.plain_text; }).join("");
  };
  assert.equal(page.properties.Status.type, "select"); assert.equal(page.properties.Status.select?.name, "recorded");
  const metadata = JSON.parse(nativeText("Metadata", "rich_text"));
  assert.equal(metadata.runId, manifest.runId); assert.equal(metadata.stage, "stocks-session"); assert.equal(metadata.expectedDate, date);
  assert.equal(metadata.part, 0); assert.equal(metadata.parts, 1); assert.equal(metadata.captures, 1); assert.equal(metadata.missing, 0);
  const filename = `yahoo-raw-${manifest.runId}-stocks-session-part-0.json.gz`;
  assert.match(manifest.runId, /^[A-Za-z0-9._-]+$/); assert.equal(nativeText("Key", "title"), filename.slice(0, -8));
  const fm = metadata._fileManifest; assert.equal(fm.version, 1); assert.match(fm.inputFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(fm.files.length, 1); const file = fm.files[0];
  assert.equal(file.originalFilename, filename); assert.equal(file.uploadFilename, filename); assert.equal(file.upload, "uploaded");
  assert.match(file.sha256, /^[a-f0-9]{64}$/); assert.ok(Number.isSafeInteger(file.byteLength) && file.byteLength > 0 && file.byteLength <= 20 * 1024 * 1024);
  const files = page.properties.Files; assert.equal(files.type, "files"); assert.equal(files.files?.length, 1); const hosted = files.files[0];
  assert.equal(hosted.name, filename); assert.equal(hosted.type, "file"); assert.equal(typeof hosted.file?.url, "string");
  const gzip = await downloadArchivedFile({ name: filename, url: hosted.file!.url }, "daily session N225保存原本", { maxBytes: file.byteLength });
  assert.equal(gzip.length, file.byteLength); assert.equal(sha(gzip), file.sha256);
  const wrapper = JSON.parse(gunzipSync(gzip, { maxOutputLength: 16 * 1024 * 1024 }).toString("utf8"));
  assert.equal(wrapper.version, 1); assert.equal(wrapper.service, "stock-sync"); assert.equal(wrapper.stage, "stocks-session");
  assert.equal(wrapper.runId, manifest.runId); assert.equal(wrapper.expectedDate, date); assert.equal(wrapper.part, 0); assert.equal(wrapper.parts, 1);
  assert.equal(wrapper.missing.length, 0); assert.equal(wrapper.members.length, 1); const member = wrapper.members[0];
  assert.equal(member.api, "chart"); assert.equal(member.attempt, 0); assert.equal(member.symbol, "^N225"); assert.equal(member.status, 200);
  assert.equal(member.receivedAt, reference.observedAt); assert.equal(member.byteLength, raw.length); assert.equal(member.sha256, reference.rawSha);
  assert.ok(Buffer.from(member.bodyBase64, "base64").equals(raw), "N225物理原本とcache全bytes不一致");
  const outer = new URL(member.url), target = outer.searchParams.has("u") ? new URL(outer.searchParams.get("u")!) : outer;
  assert.ok(target.protocol === "https:" && ["query1.finance.yahoo.com", "query2.finance.yahoo.com"].includes(target.hostname) && target.port === "" && target.username === "" && target.password === "");
  assert.equal(decodeURIComponent(target.pathname), "/v8/finance/chart/^N225"); assert.equal(target.searchParams.get("range"), "1mo"); assert.equal(target.searchParams.get("interval"), "1d");
  // 読取後も同じ明示clock契約を確認。元observedAtを実run clockへ付け替えない。
  assertClock();
  return { reference, custody: { source: "archived-jp-leg", cacheKey: leg.reference.cacheKey, archivePageId: leg.reference.archivePageId,
    manifestSha256: leg.reference.manifestSha256, n225ArchivePageId: pageId, n225Filename: filename, n225GzipSha256: file.sha256 } };
}

/**
 * sourceの10y窓を独立benchmark日と閉場済metaで資格化する。
 * 原SHA/受領clock/URL/全bars/eventsは変更しない。今日の日付へ読み替えない。
 * repairの上限は呼出元の実run日を維持し、より新しい旧行の欠落をHOLDする。
 */
export function qualifyDailySourceRange(
  fresh: DailyResult, capture: YahooRawCapture | undefined, reference: DailySessionReference
): { from: string; to: string } {
  if (!isCalendarDateString(reference.date) || !isStrictIsoUtc(reference.observedAt) ||
      !/^[0-9a-f]{64}$/.test(reference.rawSha) || capture === undefined ||
      !isStrictIsoUtc(capture.receivedAt) || capture.receivedAt !== fresh.proof.observedAt ||
      Date.parse(reference.observedAt) > Date.parse(capture.receivedAt) ||
      reference.date > jstDateSec(Date.parse(reference.observedAt) / 1000) ||
      jstDateSec(Date.parse(reference.observedAt) / 1000) !== jstDateSec(Date.parse(capture.receivedAt) / 1000)) {
    throw new Error("daily session HOLD: benchmark/原本の実受領証跡不一致");
  }
  const range = tenYearRangeForDate(reference.date);
  const outer = new URL(capture.url), target = outer.searchParams.has("u") ? new URL(outer.searchParams.get("u")!) : outer;
  const regular = JSON.parse(new TextDecoder().decode(capture.bytes)).chart?.result?.[0]?.meta?.currentTradingPeriod?.regular;
  if (target.protocol !== "https:" || !["query1.finance.yahoo.com", "query2.finance.yahoo.com"].includes(target.hostname) ||
      target.port !== "" || target.username !== "" || target.password !== "" ||
      decodeURIComponent(target.pathname) !== `/v8/finance/chart/${fresh.proof.symbol}` ||
      target.searchParams.get("range") !== "10y" || target.searchParams.get("interval") !== "1d" ||
      target.searchParams.get("events") !== "split,div" || regular?.timezone !== "JST" || regular?.gmtoffset !== 32400) {
    throw new Error("daily session HOLD: 原本の要求契約/session timezoneが一致しません");
  }
  if (completedDailyFetch(fresh, capture, range, reference) === null) {
    throw new Error("daily session HOLD: 独立benchmark日と閉場済session/全原本行が一致しません");
  }
  return range;
}
