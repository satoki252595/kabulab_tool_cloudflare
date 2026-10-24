/** 日本市場の同日引け後原本を、米国引けまで持ち越す。旧日/再取得による補完なし。 */
import { parseChartResponse, type YahooRawCapture } from "../shared/yahoo/client.js";
import { guardChartBars } from "../shared/yahoo/bar-sanity.js";
import { fetchNikkeiVi, parseNikkeiVi } from "../shared/yahoo/nikkei-vi.js";
import { recordPrimaryData, verifyArchivedAttachments } from "../shared/notion-archive/index.js";
import { sha256HexBytes } from "../shared/sha256.js";
import { rootCauseMessage } from "../shared/errors.js";
import { selectConfirmedCloses, type ConfirmedCloses } from "./macro-session.js";

/** Node入口だけが既存R2 helperを注入する。WorkerへAWS SDKをimportしない。 */
export interface MacroJpLegStore {
  get(key: string): Promise<{ body: string; etag: string } | null>;
  put(key: string, body: string, observedVersion: null): Promise<void>;
}
interface CachedRaw {
  status: number;
  receivedAt: string;
  sha256: string;
  bodyBase64: string;
}
interface JpManifest {
  version: 1;
  kind: "macro-jp-leg";
  expectedDate: string;
  runId: string;
  n225: { sha256: string; receivedAt: string; archivePages: string[] };
  vi: { sha256: string | null; receivedAt: string; status: number | null };
  gate: { ok: boolean; reason: string };
}
interface JpCache {
  version: 1;
  expectedDate: string;
  n225: CachedRaw;
  vi: CachedRaw;
  archive: { pageId: string; manifestBase64: string; manifestSha256: string };
}
export interface MacroJpLeg {
  n225: ConfirmedCloses;
  nikkeiVi: number;
  nikkeiViDate: string;
  reference: {
    kind: "archived-jp-leg";
    expectedDate: string;
    cacheKey: string;
    archivePageId: string;
    manifestSha256: string;
    n225: JpManifest["n225"];
    vi: JpManifest["vi"];
  };
}
const CACHE_CAP = 8 * 1024 * 1024;
const MANIFEST_NAME = "macro-jp-manifest.json";
const VI_NAME = "macro-jp-VI.html";
const utf8 = new TextEncoder();
const text = new TextDecoder("utf-8", { fatal: true });
function base64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 8192) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
  return btoa(chunks.join(""));
}
function bytes(value: string): Uint8Array {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("JP leg HOLD: 原本base64不正");
  }
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}
function dateOf(value: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
}
export function macroJpCacheKey(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    throw new Error("JP leg HOLD: 予定日不正");
  }
  return `macro/jp-close/${date}.json`;
}
function clock(value: string, date: string): number {
  const ms = Date.parse(value);
  if (typeof value !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(ms) || dateOf(ms) !== date || ms > Date.now()) throw new Error("JP leg HOLD: 原本実取得日が予定日と不一致");
  return ms;
}
/** 日付だけでなく当期session終了を同じN225原本で証明する。 */
function qualifyN225(date: string, n225: { bytes: Uint8Array; status: number; receivedAt: string }): ConfirmedCloses {
  macroJpCacheKey(date);
  if (n225.status !== 200) throw new Error("JP leg HOLD: 原本HTTP200未確認");
  const observed = clock(n225.receivedAt, date);
  const json = JSON.parse(text.decode(n225.bytes));
  const parsed = parseChartResponse(json, "^N225");
  const { bars } = guardChartBars(parsed.bars, parsed.meta.regularMarketPrice, "^N225");
  const confirmed = selectConfirmedCloses(n225.bytes, bars, "^N225");
  const meta = json?.chart?.result?.[0]?.meta;
  const start = meta?.currentTradingPeriod?.regular?.start;
  const end = meta?.currentTradingPeriod?.regular?.end;
  const rmt = meta?.regularMarketTime;
  if (meta?.exchangeTimezoneName !== "Asia/Tokyo" || ![start, end, rmt].every((v) => typeof v === "number" && Number.isFinite(v)) ||
      dateOf(start * 1000) !== dateOf(end * 1000) || start >= end || dateOf(rmt * 1000) !== date ||
      rmt * 1000 > observed || confirmed.date !== date || confirmed.prev === null) {
    throw new Error("JP leg HOLD: N225の予定日session/前日終値を証明できません");
  }
  const sameSessionEnded = dateOf(start * 1000) === date && rmt >= end && end * 1000 <= observed;
  // Yahooが引け後に次のregular periodへ進めても、helperの同D実bar + 同Dの引け後quote証拠だけを採る。
  // 次期sessionを黙って当期へ付替えない。15:30は現物市場の明示採用条件で、priceの補完ではない。
  const explicitNextSession = dateOf(start * 1000) > date && start * 1000 > observed &&
    rmt * 1000 >= Date.parse(`${date}T15:30:00+09:00`);
  if (!sameSessionEnded && !explicitNextSession) {
    throw new Error("JP leg HOLD: N225の予定日終了または明示次sessionを証明できません");
  }
  return confirmed;
}
export function qualifyMacroJpRaw(date: string, n225: { bytes: Uint8Array; status: number; receivedAt: string }, vi: { bytes: Uint8Array; status: number; receivedAt: string }): Pick<MacroJpLeg, "n225" | "nikkeiVi" | "nikkeiViDate"> {
  const confirmed = qualifyN225(date, n225);
  if (vi.status !== 200) throw new Error("JP leg HOLD: 日経VI HTTP200未確認");
  const snapshot = parseNikkeiVi(text.decode(vi.bytes));
  const viObserved = clock(vi.receivedAt, date);
  const tick = snapshot.latestTimestamp === null ? NaN : Date.parse(snapshot.latestTimestamp);
  // 日経算出要領2025-01-27 + JPX日中オークション15:45。値が古い日中tickなら採用しない。
  // https://indexes.nikkei.co.jp/nkave/archives/file/nikkei_stock_average_volatility_index_guidebook_jp.pdf
  // https://www.jpx.co.jp/derivatives/products/domestic/225options/01.html
  const viClose = Date.parse(`${date}T15:45:00+09:00`);
  if (snapshot.date !== date || !Number.isFinite(tick) || dateOf(tick) !== date || tick < viClose || tick > viObserved || viObserved < viClose || viObserved < clock(n225.receivedAt, date) ||
      !Number.isFinite(snapshot.price) || snapshot.price <= 0) {
    throw new Error("JP leg HOLD: 日経VIの予定日引け後tickを証明できません");
  }
  return { n225: confirmed, nikkeiVi: snapshot.price, nikkeiViDate: snapshot.date };
}
async function verifyRaw(raw: CachedRaw): Promise<Uint8Array> {
  const rawBytes = bytes(raw.bodyBase64);
  if (rawBytes.length === 0 || rawBytes.length > CACHE_CAP || await sha256HexBytes(Uint8Array.from(rawBytes)) !== raw.sha256) {
    throw new Error("JP leg HOLD: キャッシュ原本SHA/サイズ不一致");
  }
  return rawBytes;
}
/** R2内容は信頼せず、原本再parse + 保存済みNotion manifest/VI全bytes照合。 */
async function readBody(body: string, date: string): Promise<MacroJpLeg> {
  if (utf8.encode(body).length > CACHE_CAP) throw new Error("JP leg HOLD: キャッシュ上限超過");
  const cache = JSON.parse(body) as JpCache;
  if (cache.version !== 1 || cache.expectedDate !== date || !cache.archive?.pageId) throw new Error("JP leg HOLD: キャッシュ予定日/版/原本参照不一致");
  const [n225Bytes, viBytes] = await Promise.all([verifyRaw(cache.n225), verifyRaw(cache.vi)]);
  const manifestBytes = bytes(cache.archive.manifestBase64);
  if (await sha256HexBytes(Uint8Array.from(manifestBytes)) !== cache.archive.manifestSha256) throw new Error("JP leg HOLD: manifest SHA不一致");
  const manifest = JSON.parse(text.decode(manifestBytes)) as JpManifest;
  if (manifest.version !== 1 || manifest.kind !== "macro-jp-leg" || manifest.expectedDate !== date || manifest.gate.ok !== true ||
      manifest.n225.sha256 !== cache.n225.sha256 || manifest.vi.sha256 !== cache.vi.sha256 ||
      manifest.n225.receivedAt !== cache.n225.receivedAt || manifest.vi.receivedAt !== cache.vi.receivedAt ||
      manifest.vi.status !== cache.vi.status || !Array.isArray(manifest.n225.archivePages) || manifest.n225.archivePages.length !== 1 ||
      manifest.n225.archivePages.some((page) => typeof page !== "string" || page.length === 0)) {
    throw new Error("JP leg HOLD: 保存manifestと原本来歴が一致しません");
  }
  const qualified = qualifyMacroJpRaw(date, { ...cache.n225, bytes: n225Bytes }, { ...cache.vi, bytes: viBytes });
  await verifyArchivedAttachments(cache.archive.pageId, [
    { filename: MANIFEST_NAME, bytes: manifestBytes }, { filename: VI_NAME, bytes: viBytes },
  ], "JP leg再読");
  return { ...qualified, reference: { kind: "archived-jp-leg", expectedDate: date, cacheKey: macroJpCacheKey(date),
    archivePageId: cache.archive.pageId, manifestSha256: cache.archive.manifestSha256, n225: manifest.n225, vi: manifest.vi } };
}
export async function loadMacroJpLeg(store: MacroJpLegStore, date: string): Promise<MacroJpLeg | null> {
  const found = await store.get(macroJpCacheKey(date));
  return found === null ? null : readBody(found.body, date);
}
/** stocks-session原本は既に全bytes保管済み。追加upstream GETはVI1回だけ。 */
export async function captureMacroJpLeg(args: { date: string; runId: string; n225: YahooRawCapture; n225ArchivePages: string[]; store: MacroJpLegStore; beforeSourceRequest?: () => void }): Promise<{ ok: boolean; reason: string }> {
  const key = macroJpCacheKey(args.date);
  const prior = await args.store.get(key);
  if (prior !== null) {
    await readBody(prior.body, args.date);
    return { ok: true, reason: "同予定日の保存済みJP原本を照合済み（新規VI取得なし）" };
  }
  if (args.n225.symbol !== "^N225" || args.n225ArchivePages.length !== 1 || args.n225ArchivePages.some((id) => !id)) throw new Error("JP leg HOLD: stocks-session物理原本参照がありません");
  const viCapture: { value: { status: number; bytes: Uint8Array } | null } = { value: null };
  let viReceivedAt = new Date().toISOString();
  let reason: string;
  let ok = false;
  try {
    qualifyN225(args.date, args.n225);
    args.beforeSourceRequest?.();
    await fetchNikkeiVi({ beforeRequest: args.beforeSourceRequest,
      onRaw: (raw) => { viCapture.value = raw; viReceivedAt = new Date().toISOString(); } });
    if (viCapture.value === null) throw new Error("日経VI原本captureがありません");
    qualifyMacroJpRaw(args.date, args.n225, { ...viCapture.value, receivedAt: viReceivedAt });
    ok = true;
    reason = "予定日のN225確定sessionとVI引け後tickが一致";
  } catch (error) {
    reason = rootCauseMessage(error);
  }
  const n225Sha = await sha256HexBytes(Uint8Array.from(args.n225.bytes));
  const viRaw = viCapture.value;
  const viSha = viRaw === null ? null : await sha256HexBytes(Uint8Array.from(viRaw.bytes));
  const manifest: JpManifest = { version: 1, kind: "macro-jp-leg", expectedDate: args.date, runId: args.runId,
    n225: { sha256: n225Sha, receivedAt: args.n225.receivedAt, archivePages: [...args.n225ArchivePages] },
    vi: { sha256: viSha, receivedAt: viReceivedAt, status: viRaw === null ? null : viRaw.status }, gate: { ok, reason } };
  const manifestBytes = utf8.encode(JSON.stringify(manifest));
  const files: Array<{ filename: string; bytes: Uint8Array; contentType: string }> = [{ filename: MANIFEST_NAME, bytes: manifestBytes, contentType: "application/json" }];
  if (viRaw !== null) files.push({ filename: VI_NAME, bytes: viRaw.bytes, contentType: "text/html" });
  const archived = await recordPrimaryData({ service: "stock-sync", key: `macro-jp-leg-${args.date}-${args.runId}`,
    source: "JP leg: stocks-session same N225 raw reference + closing Nikkei VI HTML", fetchedAt: viReceivedAt,
    metadata: { expectedDate: args.date, gate: manifest.gate, n225: manifest.n225, vi: manifest.vi }, files, force: false });
  if (archived.outcome !== "recorded" || archived.manifestMatch !== "written" || archived.fileTooLarge) throw new Error("JP leg原本保管が新規確定しません。再送せずSTOP");
  await verifyArchivedAttachments(archived.pageId, files, "JP leg保管");
  if (!ok || viRaw === null || viSha === null) return { ok: false, reason };
  const cache: JpCache = { version: 1, expectedDate: args.date,
    n225: { status: args.n225.status, receivedAt: args.n225.receivedAt, sha256: n225Sha, bodyBase64: base64(args.n225.bytes) },
    vi: { status: viRaw.status, receivedAt: viReceivedAt, sha256: viSha, bodyBase64: base64(viRaw.bytes) },
    archive: { pageId: archived.pageId, manifestBase64: base64(manifestBytes), manifestSha256: await sha256HexBytes(Uint8Array.from(manifestBytes)) } };
  const body = JSON.stringify(cache);
  if (utf8.encode(body).length > CACHE_CAP) throw new Error("JP legキャッシュ上限超過。PUTしません");
  await args.store.put(key, body, null);
  const readback = await args.store.get(key);
  if (readback === null || readback.body !== body) throw new Error("JP leg R2 PUT/readback結果不明。再送せずSTOP");
  return { ok: true, reason };
}
