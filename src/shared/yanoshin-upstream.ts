/**
 * やのしん TDnet フィードが「いまも更新しているか」。
 *
 * 閾値と期待値は yanoshin-upstream-freshness.json が正。Python の
 * collectors/yanoshin_upstream.py と同じファイルを読む。
 * 暦は src/shared/market-calendar.ts の JPX 公式休業日（土日・祝日・年末休業）。
 * 未収録年は推測せず停止する。
 */
import { marketClosure } from "./market-calendar.js";
import spec from "./yanoshin-upstream-freshness.json";

const JST_MS = 9 * 3600 * 1000;

function requiredInt(value: unknown, key: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`やのしん鮮度定義 ${key} が整数でありません`);
  }
  return value;
}

const WATCH_OPEN_HOUR = requiredInt(spec.watchOpenHourJst, "watchOpenHourJst");
const WATCH_CLOSE_HOUR = requiredInt(spec.watchCloseHourJst, "watchCloseHourJst");
const MAX_WATCH_SILENCE_SECONDS = requiredInt(spec.maxWatchSilenceSeconds, "maxWatchSilenceSeconds");
if (WATCH_OPEN_HOUR < 0 || WATCH_CLOSE_HOUR > 24 || WATCH_OPEN_HOUR >= WATCH_CLOSE_HOUR) {
  throw new Error("やのしん鮮度定義の監視窓が不正です");
}
if (MAX_WATCH_SILENCE_SECONDS <= 0) {
  throw new Error("やのしん鮮度定義の許容沈黙が不正です");
}

export type YanoshinJudgementName = "fresh" | "upstream_stopped";

export interface YanoshinUpstreamJudgement {
  newestPubdate: string | null;
  elapsedWatchSeconds: number | null;
  judgement: YanoshinJudgementName;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** epoch を JST 壁時計の YYYY-MM-DD と時分秒へ。日本に夏時間は無い。 */
function jstParts(ms: number): { ymd: string; hour: number; minute: number; second: number } {
  const wall = new Date(ms + JST_MS);
  return {
    ymd: `${wall.getUTCFullYear()}-${pad(wall.getUTCMonth() + 1)}-${pad(wall.getUTCDate())}`,
    hour: wall.getUTCHours(),
    minute: wall.getUTCMinutes(),
    second: wall.getUTCSeconds(),
  };
}

export function formatJstIso(ms: number): string {
  const wall = new Date(ms + JST_MS);
  return (
    `${wall.getUTCFullYear()}-${pad(wall.getUTCMonth() + 1)}-${pad(wall.getUTCDate())}` +
    `T${pad(wall.getUTCHours())}:${pad(wall.getUTCMinutes())}:${pad(wall.getUTCSeconds())}+09:00`
  );
}

function jstStamp(ymd: string, hour: number, minute: number, second: number): number {
  const [y, m, d] = ymd.split("-").map((part) => Number(part));
  if (!y || !m || !d) throw new Error(`やのしん鮮度判定の日付が不正です: ${ymd}`);
  return Date.UTC(y, m - 1, d, hour, minute, second) - JST_MS;
}

function addDays(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

function isJpxSessionDay(ymd: string): boolean {
  return marketClosure("JPX", ymd) === null;
}

/**
 * newest から now まで、JPX セッション日の [open, close) に入る秒。
 * 未来の pubdate は 0。呼び出し側は pubdate 欠落を別に扱う。
 */
export function elapsedWatchSeconds(newest: Date, now: Date): number {
  const newestMs = newest.getTime();
  const nowMs = now.getTime();
  if (!Number.isFinite(newestMs) || !Number.isFinite(nowMs)) {
    throw new Error("やのしん鮮度判定の時刻が不正です");
  }
  if (newestMs > nowMs) return 0;
  const endYmd = jstParts(nowMs).ymd;
  let total = 0;
  for (let ymd = jstParts(newestMs).ymd; ymd <= endYmd; ymd = addDays(ymd, 1)) {
    if (!isJpxSessionDay(ymd)) continue;
    const open = jstStamp(ymd, WATCH_OPEN_HOUR, 0, 0);
    const close = jstStamp(ymd, WATCH_CLOSE_HOUR, 0, 0);
    const start = Math.max(newestMs, open);
    const end = Math.min(nowMs, close);
    if (end > start) total += Math.floor((end - start) / 1000);
  }
  return total;
}

export function judgeYanoshinUpstream(newest: Date | null, now: Date): YanoshinUpstreamJudgement {
  if (now.getTime() !== now.getTime()) throw new Error("やのしん鮮度判定の現在時刻が不正です");
  if (newest === null) {
    return { newestPubdate: null, elapsedWatchSeconds: null, judgement: "upstream_stopped" };
  }
  const elapsed = elapsedWatchSeconds(newest, now);
  return {
    newestPubdate: formatJstIso(newest.getTime()),
    elapsedWatchSeconds: elapsed,
    judgement: elapsed > MAX_WATCH_SILENCE_SECONDS ? "upstream_stopped" : "fresh",
  };
}

export function formatYanoshinUpstreamLog(judgement: YanoshinUpstreamJudgement): string {
  const newest = judgement.newestPubdate ?? "none";
  const elapsed = judgement.elapsedWatchSeconds === null ? "none" : String(judgement.elapsedWatchSeconds);
  return `yanoshin_upstream newest_pubdate=${newest} elapsed_watch_seconds=${elapsed} judgement=${judgement.judgement}`;
}

/** "YYYY-MM-DD HH:MM:SS"（JST）の最大。1 件も無ければ null。形式が壊れていれば停止。 */
export function newestPubdateOfItems(items: readonly { pubdate: string }[]): Date | null {
  let best: number | null = null;
  for (const item of items) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(item.pubdate.trim());
    if (!m) throw new Error(`やのしん pubdate の形式が不正: "${item.pubdate}"`);
    const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])) - JST_MS;
    if (!Number.isFinite(ms)) throw new Error(`やのしん pubdate の時刻が不正: "${item.pubdate}"`);
    if (best === null || ms > best) best = ms;
  }
  return best === null ? null : new Date(best);
}
