import { Hono } from "hono";
import { handle } from "@hono/node-server/vercel";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { count } from "drizzle-orm";

/**
 * Vercel Honoビルダー用エントリポイント
 * `/`へのアクセスはこの関数にルーティングされる。
 */

const yutaiGenres = pgTable("yutai_genres", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  slug: text("slug").notNull().unique(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

const stocks = pgTable("stocks", {
  id: serial("id").primaryKey(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  market: text("market").notNull(),
});

function h(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** 共通CSS — Editorial Swiss Grid テーマ（白黒×ニューブルータリスト） */
const CSS = `
:root{
  --bg:#fafafa;--bg-pure:#ffffff;--bg-invert:#0a0a0a;--bg-soft:#f0f0f0;
  --text:#0a0a0a;--text-secondary:#3a3a3a;--text-muted:#737373;--text-invert:#fafafa;
  --border:#0a0a0a;--border-soft:#d4d4d4;
  --accent:#1d4ed8;--accent-soft:#dbeafe;
  --radius:4px;--tap:48px;
  --font-display:'Space Grotesk','Noto Sans JP',sans-serif;
  --font-body:'Noto Sans JP',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  --font-mono:'JetBrains Mono','SF Mono','Menlo',monospace;
}
*{margin:0;padding:0;box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{font-family:var(--font-body);font-size:17px;background:var(--bg);color:var(--text);line-height:1.75;-webkit-font-smoothing:antialiased}
a{color:var(--text);text-decoration:none}
a:hover{text-decoration:underline;text-decoration-thickness:2px;text-underline-offset:3px}
a:focus-visible,button:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.container{max-width:720px;margin:0 auto;padding:24px 16px}
@media(min-width:768px){.container{max-width:880px;padding:32px 24px}}
@media(min-width:1024px){.container{max-width:1080px;padding:40px 32px}}

.top-header{background:var(--bg);border-bottom:2px solid var(--border);position:sticky;top:0;z-index:10}
.top-header .inner{max-width:1080px;margin:0 auto;padding:0 16px;display:flex;align-items:center;justify-content:space-between;height:72px;gap:16px}
.brand{display:flex;align-items:center;gap:12px;text-decoration:none}
.brand .mark{width:32px;height:32px;background:var(--bg-invert);display:flex;align-items:center;justify-content:center;flex-shrink:0}
.brand .mark::after{content:'';width:14px;height:14px;background:var(--bg)}
.brand .name{display:flex;flex-direction:column;line-height:1}
.brand .ja{font-family:var(--font-display);font-size:20px;font-weight:700;color:var(--text);letter-spacing:-0.02em}
.brand .en{font-family:var(--font-mono);font-size:9px;color:var(--text-muted);letter-spacing:0.18em;text-transform:uppercase;margin-top:4px}
.desktop-nav{display:flex;align-items:center;gap:0}
.desktop-nav a{color:var(--text);font-family:var(--font-display);font-size:14px;font-weight:600;padding:0 18px;display:inline-flex;align-items:center;min-height:var(--tap);text-transform:uppercase;letter-spacing:0.06em;border-left:2px solid var(--border)}
.desktop-nav a:hover{background:var(--bg-invert);color:var(--text-invert);text-decoration:none}
.desktop-nav a.portal-back{border-left:none;border-right:2px solid var(--border);color:var(--text-muted)}
.desktop-nav a.portal-back:hover{color:var(--text-invert);background:var(--bg-invert)}

.bottom-nav{display:none;position:fixed;bottom:0;left:0;right:0;background:var(--bg);border-top:2px solid var(--border);z-index:100;padding-bottom:env(safe-area-inset-bottom,0)}
.bottom-nav a{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;padding:10px 0;min-height:62px;color:var(--text);font-family:var(--font-display);font-size:10px;font-weight:600;text-decoration:none;text-transform:uppercase;letter-spacing:0.06em;border-right:1px solid var(--border-soft)}
.bottom-nav a:last-child{border-right:none}
.bottom-nav a.active{background:var(--bg-invert);color:var(--text-invert)}
.bottom-nav svg{display:block;width:22px;height:22px}
@media(max-width:768px){.desktop-nav{display:none}.bottom-nav{display:flex}body{padding-bottom:80px}.top-header .inner{height:64px}}

.hero{padding:48px 16px 36px;background:var(--bg);border-bottom:2px solid var(--border);position:relative;overflow:hidden}
.hero::before{content:'';position:absolute;top:0;left:0;right:0;height:1px;background:repeating-linear-gradient(90deg,var(--border) 0 8px,transparent 8px 16px);opacity:0.2}
.hero .inner{max-width:1080px;margin:0 auto;padding:0 16px;position:relative}
.hero .label{font-family:var(--font-mono);font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:var(--text-muted);margin-bottom:24px;display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap}
.hero .label::before{content:'';flex:0 0 32px;height:2px;background:var(--text)}
.hero .label-text{flex:1}
.hero h2{font-family:var(--font-display);font-size:clamp(34px,7vw,64px);font-weight:700;line-height:1.0;letter-spacing:-0.04em;color:var(--text);margin-bottom:24px}
.hero .lead{font-size:17px;color:var(--text-secondary);max-width:560px;line-height:1.7}
.hero .stats{display:flex;gap:32px;margin-top:28px;padding-top:24px;border-top:2px solid var(--border);flex-wrap:wrap}
.hero .stat{display:flex;flex-direction:column}
.hero .stat .num{font-family:var(--font-mono);font-size:28px;font-weight:700;color:var(--text);line-height:1;font-variant-numeric:tabular-nums}
.hero .stat .lbl{font-family:var(--font-mono);font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:var(--text-muted);margin-top:6px}
@media(min-width:768px){.hero{padding:72px 24px 56px}}

h2{font-family:var(--font-display);font-size:28px;font-weight:700;color:var(--text);line-height:1.2;letter-spacing:-0.02em}
.section-label{font-family:var(--font-mono);font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:var(--text-muted);margin-bottom:8px;display:flex;align-items:center;gap:12px}
.section-label::before{content:'';flex:0 0 24px;height:2px;background:var(--text)}

.guide{background:var(--bg-pure);border:2px solid var(--border);border-radius:var(--radius);padding:20px;margin:20px 0;font-size:15px;color:var(--text);line-height:1.8;position:relative}
.guide::before{content:'GUIDE';position:absolute;top:-10px;left:16px;background:var(--bg-invert);color:var(--text-invert);font-family:var(--font-mono);font-size:10px;font-weight:700;padding:3px 10px;letter-spacing:0.12em;border-radius:var(--radius)}
.guide strong{color:var(--text);font-weight:700;font-family:var(--font-display)}

.grid{display:grid;grid-template-columns:1fr;gap:14px;margin-top:20px}
@media(min-width:480px){.grid{grid-template-columns:1fr 1fr}}
@media(min-width:768px){.grid{grid-template-columns:1fr 1fr 1fr;gap:16px}}
.card{background:var(--bg-pure);border:2px solid var(--border);border-radius:var(--radius);padding:20px;display:block;color:var(--text);text-decoration:none;transition:transform .15s ease-out,box-shadow .15s ease-out;position:relative}
.card:hover,a:hover .card{transform:translate(-3px,-3px);box-shadow:5px 5px 0 0 var(--border);text-decoration:none}
.card h3{font-family:var(--font-display);font-size:18px;font-weight:700;margin-bottom:8px;color:var(--text);letter-spacing:-0.01em}
.card p{font-size:14px;color:var(--text-secondary);line-height:1.6}

.tip{position:relative;display:inline-block;cursor:help;border-bottom:2px dotted var(--text-muted);font-weight:600}
.tip .tip-text{visibility:hidden;opacity:0;position:absolute;z-index:20;bottom:calc(100% + 8px);left:50%;transform:translateX(-50%);width:280px;background:var(--bg-invert);color:var(--text-invert);font-size:14px;line-height:1.65;padding:14px 16px;border-radius:var(--radius);transition:opacity .15s;pointer-events:none;font-weight:400;border:2px solid var(--border)}
.tip .tip-text::after{content:'';position:absolute;top:100%;left:50%;transform:translateX(-50%);border:8px solid transparent;border-top-color:var(--bg-invert)}
.tip:hover .tip-text,.tip:focus .tip-text,.tip:active .tip-text{visibility:visible;opacity:1}
@media(max-width:600px){.tip .tip-text{width:240px;font-size:13px;left:0;transform:none}.tip .tip-text::after{left:24px;transform:none}}
`;

const HEAD = `<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0,viewport-fit=cover"><title>お宝優待 | KABULAB</title><meta name="description" content="ファンダメンタルズとテクニカルの2つの視点から割安な株主優待銘柄を発見。PBR・PER・RSI・配当利回りでスクリーニング。"><meta name="theme-color" content="#fafafa"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="default"><link rel="manifest" href="/manifest.json"><link rel="apple-touch-icon" href="/icon-192.png"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&family=Noto+Sans+JP:wght@400;500;600;700&display=swap" rel="stylesheet"><style>${CSS}</style>`;

const HEADER = `<header class="top-header"><div class="inner"><a href="/" class="brand"><span class="mark"></span><span class="name"><span class="ja">お宝優待</span><span class="en">002 / KABULAB</span></span></a><nav class="desktop-nav"><a href="https://kabulab.vercel.app/" class="portal-back">← KABULAB</a><a href="/">HOME</a><a href="/screening">SCREENING</a></nav></div></header>`;

const BOTTOM_NAV = `<nav class="bottom-nav"><a href="/" class="active"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12l9-9 9 9"/><path d="M5 10v10a1 1 0 001 1h3v-6h6v6h3a1 1 0 001-1V10"/></svg><span>HOME</span></a><a href="/screening"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg><span>SCREENING</span></a><a href="https://kabulab.vercel.app/"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg><span>PORTAL</span></a></nav>`;

const app = new Hono();

app.get("/", async (c) => {
  try {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) throw new Error("DATABASE_URL is not configured");

    const sql = neon(dbUrl);
    const db = drizzle(sql);

    const genres = await db.select().from(yutaiGenres).orderBy(yutaiGenres.name);
    const [{ count: totalStocks }] = await db.select({ count: count() }).from(stocks);

    const cards = genres.map(g =>
      `<a href="/genres/${h(g.slug)}" style="text-decoration:none"><div class="card"><h3>${h(g.name)}</h3><p>${h(g.description || "")}</p></div></a>`
    ).join("");

    return c.html(`<!DOCTYPE html><html lang="ja"><head>${HEAD}</head><body>
${HEADER}
<div class="hero">
  <div class="inner">
    <div class="label"><span class="label-text">001 / STOCK SCREENING</span><span>${new Date().getFullYear()}</span></div>
    <h2>割安な優待を、<br>データで見つける。</h2>
    <p class="lead">ファンダメンタルズとテクニカルの2つの視点から、独自スコアで割安な株主優待銘柄を発見します。</p>
    <div class="stats">
      <div class="stat"><span class="num">${totalStocks.toLocaleString()}</span><span class="lbl">Stocks</span></div>
      <div class="stat"><span class="num">${genres.length}</span><span class="lbl">Genres</span></div>
    </div>
  </div>
</div>
<div class="container">
  <div class="guide">
    <strong>はじめての方へ</strong><br>
    <span class="tip" tabindex="0">株主優待<span class="tip-text">株主優待とは、一定株数を保有すると企業から商品券や食事券などがもらえる制度。権利確定月に保有が必要です。</span></span>とは、企業の株を持っていると食事券や商品券などがもらえるお得な制度です。
    このサービスでは、企業の実力とチャートの動きの2つの視点から、<strong>今お買い得な優待銘柄</strong>をスコア付きで紹介しています。
    まずは下のジャンルから選んでみましょう。
  </div>
  <div class="section-label">002 / Browse by Genre</div>
  <h2 style="margin:0 0 4px">ジャンルから探す</h2>
  <div class="grid">${cards}</div>
</div>
${BOTTOM_NAV}
<script>if('serviceWorker' in navigator){navigator.serviceWorker.register('/sw.js')}</script>
</body></html>`);
  } catch (e) {
    console.error("[src/index.ts] Home page error:", e);
    return c.html(`<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>お宝優待</title><link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@700&family=JetBrains+Mono&display=swap" rel="stylesheet"></head><body style="background:#fafafa;color:#0a0a0a;font-family:'Space Grotesk',sans-serif;text-align:center;padding:60px 24px;font-size:17px;line-height:1.7"><div style="font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:#737373;margin-bottom:16px">ERROR / 500</div><h1 style="font-size:48px;font-weight:700;letter-spacing:-0.03em;line-height:1">SOMETHING<br>WENT WRONG.</h1><p style="color:#3a3a3a;margin:24px 0 32px;font-family:'Noto Sans JP',sans-serif">データの読み込みに失敗しました。<br>しばらくしてからお試しください。</p><a href="/screening" style="font-family:'Space Grotesk',sans-serif;color:#fafafa;background:#0a0a0a;font-weight:700;font-size:14px;padding:14px 28px;border:2px solid #0a0a0a;border-radius:4px;text-decoration:none;text-transform:uppercase;letter-spacing:0.06em;display:inline-block">→ Screening</a></body></html>`, 500);
  }
});

export default handle(app);
export { app };
