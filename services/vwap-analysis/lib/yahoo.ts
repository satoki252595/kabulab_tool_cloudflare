// Yahoo Finance 取得（5分足オンデマンド中継 + 日足10年バックフィル）。
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

let cookie = "";
let cookieAt = 0;
async function ensureCookie(): Promise<void> {
  if (cookie && Date.now() - cookieAt < 3_600_000) return;
  try {
    const r = await fetch("https://fc.yahoo.com", { headers: { "User-Agent": UA } });
    const sc = r.headers.get("set-cookie");
    if (sc) { cookie = sc.split(";")[0]; cookieAt = Date.now(); }
  } catch { /* Cookie 無しでも chart は通ることが多い */ }
}

function chartUrl(symbol: string, range: string, interval: string, events = false): string {
  const ev = events ? "&events=split,div" : "";
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?range=${range}&interval=${interval}${ev}`;
}

// 5分足など生レスポンスをそのまま返す（/api/chart 用）。
export async function fetchChartRaw(symbol: string, range: string, interval: string): Promise<Response> {
  await ensureCookie();
  return fetch(chartUrl(symbol, range, interval), {
    headers: { "User-Agent": UA, ...(cookie ? { Cookie: cookie } : {}) },
  });
}

export interface DailyBar { date: string; o: number; h: number; l: number; c: number; v: number; adj: number; }
export interface DailyResult { bars: DailyBar[]; splits: { date: string; ratio: number }[]; }

export const jstDate = (ts: number) => new Date((ts + 32400) * 1000).toISOString().slice(0, 10);

export interface Bar5m { ts: number; o: number; h: number; l: number; c: number; v: number; }

// 5分足を正準形 [{ts,o,h,l,c,v}] で取得（蓄積・フロント共通の内部形式）。
export async function fetchBars5m(symbol: string, range = "5d"): Promise<Bar5m[]> {
  const r = await fetchChartRaw(symbol, range, "5m");
  if (!r.ok) throw new Error(`yahoo ${r.status}`);
  const j: any = await r.json();
  const res = j?.chart?.result?.[0];
  if (!res || !res.timestamp) return [];
  const q = res.indicators.quote[0];
  const out: Bar5m[] = [];
  for (let i = 0; i < res.timestamp.length; i++) {
    const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i], v = q.volume[i];
    if (o == null || h == null || l == null || c == null || !v) continue;
    out.push({ ts: res.timestamp[i], o: +o.toFixed(2), h: +h.toFixed(2), l: +l.toFixed(2), c: +c.toFixed(2), v });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

// 日足（最大10年・分割/配当イベント込み）を取得・整形。
export async function fetchDaily(symbol: string, range = "10y"): Promise<DailyResult> {
  await ensureCookie();
  const r = await fetch(chartUrl(symbol, range, "1d", true), {
    headers: { "User-Agent": UA, ...(cookie ? { Cookie: cookie } : {}) },
  });
  if (!r.ok) throw new Error(`yahoo ${r.status}`);
  const j: any = await r.json();
  const res = j?.chart?.result?.[0];
  if (!res || !res.timestamp) return { bars: [], splits: [] };
  const q = res.indicators.quote[0];
  const adj = res.indicators.adjclose?.[0]?.adjclose || [];
  const bars: DailyBar[] = [];
  for (let i = 0; i < res.timestamp.length; i++) {
    const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i], v = q.volume[i];
    if (o == null || h == null || l == null || c == null) continue;
    bars.push({
      date: jstDate(res.timestamp[i]),
      o: +o.toFixed(2), h: +h.toFixed(2), l: +l.toFixed(2), c: +c.toFixed(2),
      v: v || 0, adj: adj[i] != null ? +adj[i].toFixed(2) : +c.toFixed(2),
    });
  }
  const splits: { date: string; ratio: number }[] = [];
  const ev = res.events?.splits || {};
  for (const k of Object.keys(ev)) {
    const s = ev[k];
    splits.push({ date: jstDate(s.date), ratio: s.numerator / s.denominator });
  }
  return { bars, splits };
}
