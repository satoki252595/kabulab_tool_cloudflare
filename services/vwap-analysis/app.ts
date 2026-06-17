// 007 VWAP Analysis — 5分足VWAP / 価格別出来高 / 日足10年 / 信用残高
// 配信のみ（Hono サブアプリ）。時系列は R2(c.env.BUCKET)、当日5分足は Yahoo 中継。
// フロント(SPA)は public/vwap-analysis/ を ASSETS が配信。ここは /api/* だけ。
import { Hono } from "hono";
import { fetchChartRaw } from "./lib/yahoo.js";

export const BASE_PATH = "/vwap-analysis";

type Bindings = { BUCKET: { get: (key: string) => Promise<{ body: ReadableStream; text: () => Promise<string> } | null> } };
const app = new Hono<{ Bindings: Bindings }>({ strict: false });

const SYMBOL_RE = /^[0-9A-Za-z]{1,6}\.[A-Z]{1,2}$/;
const CODE_RE = /^[0-9A-Za-z]{4}$/;
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
const passthrough = (body: ReadableStream, maxAge: number) =>
  new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${maxAge}` } });

// 当日5分足: Yahoo をその場中継（ライブ・15-20分遅延）
app.get("/api/chart", async (c) => {
  const symbol = (c.req.query("symbol") || "").trim();
  if (!SYMBOL_RE.test(symbol)) return json({ error: "bad symbol" }, 400);
  const r = await fetchChartRaw(symbol, c.req.query("range") || "60d", c.req.query("interval") || "5m");
  return new Response(await r.text(), {
    status: r.status,
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" },
  });
});

// 蓄積5分足(R2・直近約1年・1ファイル)を素通し
app.get("/api/intra", async (c) => {
  const code = (c.req.query("code") || "").trim();
  if (!CODE_RE.test(code)) return json({ error: "bad code" }, 400);
  const o = await c.env.BUCKET.get(`intra/${code}.json`);
  if (!o) return json({ code, bars: [], note: "未蓄積" });
  return passthrough(o.body, 3600);
});

// 日足10年(R2)を素通し
app.get("/api/daily", async (c) => {
  const code = (c.req.query("code") || "").trim();
  if (!CODE_RE.test(code)) return json({ error: "bad code" }, 400);
  const o = await c.env.BUCKET.get(`daily/${code}.json`);
  if (!o) return json({ code, bars: [], note: "未取得（バックフィル待ち）" });
  return passthrough(o.body, 3600);
});

// 週次信用残高(R2)を直近16週ぶん集約
app.get("/api/margin", async (c) => {
  const code = (c.req.query("code") || "").trim();
  if (!CODE_RE.test(code)) return json({ error: "bad code" }, 400);
  const wl = await c.env.BUCKET.get("margin/weeks.json");
  if (!wl) return json({ code, weeks: [] });
  const weeks: string[] = JSON.parse(await wl.text()).slice(-16);
  const out: unknown[] = [];
  for (const w of weeks) {
    const o = await c.env.BUCKET.get(`margin/${w}.json`);
    if (!o) continue;
    const snap = JSON.parse(await o.text());
    const row = (snap.rows || []).find((r: { code: string }) => r.code === code);
    if (row) out.push({ week: w, ...row });
  }
  return json({ code, weeks: out });
});

export default app;
