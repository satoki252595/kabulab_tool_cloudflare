// 007 VWAP Analysis — 5分足VWAP / 価格別出来高 / 日足10年 / 信用残高
// 配信のみ（Hono サブアプリ）。時系列は R2(c.env.BUCKET)、当日5分足は Yahoo 中継。
// フロント(SPA)は public/vwap-analysis/ を ASSETS が配信。ここは /api/* だけ。
import { Hono } from "hono";
import { fetchYahooChartRaw } from "../../src/shared/yahoo/client.js";
import {
  MARGIN_DAILY_FORMAT,
  selectDailyMarginRows,
  validateDailyMarginSnapshot,
} from "./lib/margin-daily.js";
import type { MarginDailySnapshot } from "./lib/margin-daily.js";

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
  const r = await fetchYahooChartRaw(symbol, c.req.query("range") || "60d", c.req.query("interval") || "5m");
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

// 日次信用残高(R2)を集約。n=直近何営業日ぶん返すか(既定60・上限260=約1年)。
// 日足チャートへ重畳する用途では長期(n=260)を要求する。R2 はバインディング
// 経由(=subrequest にカウントされない)なので、各日ファイルは並列取得して待ち時間を抑える。
// code は 4 文字ティッカーか 5 文字原文コード。旧週次オブジェクトは読まない。
app.get("/api/margin", async (c) => {
  const code = (c.req.query("code") || "").trim().toUpperCase();
  if (!CODE_RE.test(code) && !/^[0-9]{3}[0-9A-Z][0-9]$/.test(code)) {
    return json({ error: "bad code" }, 400);
  }
  const nRaw = c.req.query("n");
  let n = 60;
  if (nRaw !== undefined) {
    const parsed = Number(nRaw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 260) return json({ error: "bad n" }, 400);
    n = parsed;
  }
  // 日次データなので 1 日キャッシュ可。同一銘柄の再オープンで R2 読取を繰り返さない。
  const cached = (o: unknown) =>
    new Response(JSON.stringify(o), { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=86400" } });
  const dl = await c.env.BUCKET.get("margin/dates.json");
  if (!dl) return cached({ code, dates: [], ambiguousDates: [] });
  const dates: string[] = JSON.parse(await dl.text()).slice(-n);
  const rows = await Promise.all(dates.map(async (d) => {
    const o = await c.env.BUCKET.get(`margin/daily/${d}.json`);
    // index に参照日があるのに snapshot が無いのは破損。正常空に落とさず throw する。
    if (!o) throw new Error(`margin snapshot missing for indexed date: ${d}`);
    const snap = JSON.parse(await o.text()) as MarginDailySnapshot;
    if (snap.format !== MARGIN_DAILY_FORMAT) {
      throw new Error(`unknown margin snapshot format: ${snap.format}`);
    }
    // R2 の欠落・破損を空配列で隠さない。Worker-safe 純粋検証を再利用し、
    // 全行形状 + basisDate=index 日付の一致を確認してから selection する。
    validateDailyMarginSnapshot(snap);
    if (snap.basisDate !== d) {
      throw new Error(`margin snapshot date mismatch: index=${d} body=${snap.basisDate}`);
    }
    // 同一ティッカーの複数行 (普通株+種類株等) はどれを使うか決められないため、
    // 値無しで除外日として明示する (先頭行の黙った採用をしない)。
    const sel = selectDailyMarginRows(snap.rows, code);
    if (sel.status === "ambiguous") return { date: d, ambiguous: true as const };
    if (sel.status === "missing") return null;
    return { date: d, publicationDate: snap.publicationDate, ...sel.row };
  }));
  const ambiguousDates = rows.filter((r): r is { date: string; ambiguous: true } => r !== null && "ambiguous" in r).map((r) => r.date);
  return cached({ code, dates: rows.filter((r) => r !== null && !("ambiguous" in r)), ambiguousDates });
});

export default app;
