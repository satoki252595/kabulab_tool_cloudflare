import { Hono } from "hono";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { createMiddleware } from "hono/factory";
import { eq, inArray, count, and, lte, gte, sql } from "drizzle-orm";

// 002 サービス固有の DB スキーマとクライアント
import {
  yutaiGenres,
  stocks,
  yutaiBenefits,
  stockFinancials,
  stockScores,
} from "./src/db/schema.js";
import { createDb, type Database } from "./src/db/client.js";
import { parseStockCode } from "../../src/shared/jpx/stock-code.js";

/**
 * 002 お宝優待 — kabulab portal 配下の /otakara-yutai サブアプリ
 *
 * ルート Hono アプリ (`/src/index.ts`) で
 * `rootApp.route(BASE_PATH, otakaraYutaiApp)` としてマウントされる。
 *
 * - HTML リンク / fetch URL / ナビゲーションは BASE_PATH (=/otakara-yutai) を必ず前置する
 * - Hono のルート定義 (`app.get("/screening")` 等) は親側のマウント時に自動で
 *   /otakara-yutai が付与されるため、サブアプリ内では BASE_PATH を含めない
 * - DB スキーマとクライアントは ./src/db/ から取り込み、scripts/tests と単一 source of truth を共有する
 */
export const BASE_PATH = "/otakara-yutai";
const BP = BASE_PATH;

// ===== Types =====
type AppEnv = {
  Bindings: { DB: D1Database };
  Variables: { db: Database };
};

// ===== DB Middleware =====
const dbMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  c.set("db", createDb(c.env.DB));
  await next();
});

// ===== Error Handler =====
function onError(err: Error, c: any): Response {
  console.error(`[Error] ${err.message}`);
  return c.html(layout("エラー", `<div class="container"><h2>エラーが発生しました</h2><p style="color:#888">予期しないエラーが発生しました。</p><a href="${BP}/" class="back">← ホームに戻る</a></div>`), 500);
}
function onNotFound(c: any): Response {
  return c.html(layout("Not Found", `<div class="container"><h2>ページが見つかりません</h2><p style="color:#888">${c.req.path} は存在しません</p><a href="${BP}/" class="back">← ホームに戻る</a></div>`), 404);
}

// ===== App =====
// strict: false → `/screening` と `/screening/` を同一視する。
// 親アプリ側で trailing slash の有無に依らずマッチさせるために必要。
const app = new Hono<AppEnv>({ strict: false });

// PWA 用静的ファイル (manifest.json / sw.js / icons) は
// ルート repo の public/otakara-yutai/ に配置し、Vercel が直接配信する。
// サブアプリ側のルート定義は不要。

app.use("*", logger());
app.use("*", secureHeaders());
app.use("*", dbMiddleware);

app.onError(onError);
app.notFound(onNotFound);

// NOTE: 旧 /api/cron/sync-monthly エンドポイントは廃止された。
// 日次/月次の統一 cron は root app (/api/cron/sync-{daily,monthly}) に集約している。
// 詳細は src/index.ts / src/cron/{daily,monthly}.ts を参照。

// --- 内部API（スクリーニングページのフィルター用） ---
app.get("/api/screening", async (c) => {
  const db = c.get("db");
  const month = parseInt(c.req.query("month") ?? "0", 10) || 0;
  const genre = c.req.query("genre") ?? "";
  const perMax = parseFloat(c.req.query("perMax") ?? "0") || 0;
  const pbrMax = parseFloat(c.req.query("pbrMax") ?? "0") || 0;
  const yieldMin = parseFloat(c.req.query("yieldMin") ?? "0") || 0;
  const rsiMax = parseFloat(c.req.query("rsiMax") ?? "0") || 0;
  const sort = c.req.query("sort") ?? "total";
  const order = c.req.query("order") ?? "desc";
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") ?? "50", 10) || 50));

  // 母集団は全 JPX ~4,000 だが otakara は優待サービスなので is_yutai=true に限定
  const whereClauses: unknown[] = [eq(stocks.isActive, true), eq(stocks.isYutai, true)];

  // ジャンル/権利月フィルター。
  // 該当 stockId を JS 配列へ展開して inArray に渡すと、件数の多いジャンル
  // (QUOカード/金券/ポイント/その他) で ID 数が D1 のバインド変数上限 (1クエリ
  // 100個) を超えクエリが reject され 500 になる。そのため ID 配列を materialize
  // せず、yutai_benefits を引くサブクエリを inArray に渡す (IN リストが D1 内で
  // 完結し、バインド変数は genreId/month の各1個のみ)。ジャンル∩権利月は
  // 2つの IN を AND で重ねることで表現する。
  if (genre) {
    const genreRow = await db.select({ id: yutaiGenres.id }).from(yutaiGenres)
      .where(eq(yutaiGenres.slug, genre)).limit(1);
    if (genreRow.length === 0) return c.json([]);
    whereClauses.push(inArray(stocks.id,
      db.select({ stockId: yutaiBenefits.stockId }).from(yutaiBenefits)
        .where(eq(yutaiBenefits.genreId, genreRow[0].id))));
  }
  if (month >= 1 && month <= 12) {
    whereClauses.push(inArray(stocks.id,
      db.select({ stockId: yutaiBenefits.stockId }).from(yutaiBenefits)
        .where(eq(yutaiBenefits.recordMonth, month))));
  }
  if (perMax > 0) whereClauses.push(lte(stockFinancials.per, perMax));
  if (pbrMax > 0) whereClauses.push(lte(stockFinancials.pbr, pbrMax));
  if (yieldMin > 0) whereClauses.push(gte(stockFinancials.dividendYield, yieldMin));
  if (rsiMax > 0) whereClauses.push(lte(stockFinancials.rsi14, rsiMax));

  const whereCondition = whereClauses.length > 0 ? and(...(whereClauses as Parameters<typeof and>)) : undefined;

  // ソート列の決定（NULLS LASTでデータありの銘柄を優先）
  const colMap: Record<string, unknown> = {
    total: stockScores.totalScore, fundamental: stockScores.fundamentalScore,
    technical: stockScores.technicalScore, dividend: stockFinancials.dividendYield,
    pbr: stockFinancials.pbr, yutai: stockFinancials.yutaiYield,
  };
  const col = colMap[sort] ?? stockScores.totalScore;
  const sortExpr = order === "asc"
    ? sql`${col} ASC NULLS LAST`
    : sql`${col} DESC NULLS LAST`;

  const rows = await db.select({
    id: stocks.id, code: stocks.code, name: stocks.name, market: stocks.market, sector: stocks.sector,
    price: stockFinancials.price, per: stockFinancials.per, pbr: stockFinancials.pbr,
    dividendYield: stockFinancials.dividendYield, yutaiYield: stockFinancials.yutaiYield, rsi14: stockFinancials.rsi14,
    fundamentalScore: stockScores.fundamentalScore, technicalScore: stockScores.technicalScore,
    totalScore: stockScores.totalScore,
  }).from(stocks)
    .leftJoin(stockScores, eq(stockScores.stockId, stocks.id))
    .leftJoin(stockFinancials, eq(stockFinancials.stockId, stocks.id))
    .where(whereCondition)
    .orderBy(sortExpr)
    .limit(limit * 3);

  // 重複除去（stockFinancials/stockScoresの複数レコードによるJOIN重複を排除）
  const seen = new Set<number>();
  const unique = rows.filter(r => { if (seen.has(r.id)) return false; seen.add(r.id); return true; }).slice(0, limit);

  // 優待情報の取得
  const stockIds = unique.map(r => r.id);
  const benefits = stockIds.length > 0
    ? await db.select({ stockId: yutaiBenefits.stockId, description: yutaiBenefits.description, recordMonth: yutaiBenefits.recordMonth, genreId: yutaiBenefits.genreId })
        .from(yutaiBenefits).where(inArray(yutaiBenefits.stockId, stockIds))
    : [];
  const apiGenres = await db.select({ id: yutaiGenres.id, name: yutaiGenres.name }).from(yutaiGenres);
  const apiGenreMap = new Map(apiGenres.map(g => [g.id, g.name]));

  const result = unique.map(row => {
    const rowBenefits = benefits.filter(b => b.stockId === row.id);
    const months = [...new Set(rowBenefits.map(b => b.recordMonth))].sort((a, b) => a - b);
    const descs = [...new Set(rowBenefits.map(b => b.description))].join(" / ");
    const genreNames = [...new Set(rowBenefits.map(b => apiGenreMap.get(b.genreId)).filter(Boolean))];
    return {
      code: row.code, name: row.name, market: row.market, sector: row.sector,
      price: row.price, per: row.per, pbr: row.pbr, dividendYield: row.dividendYield,
      yutaiYield: row.yutaiYield, rsi14: row.rsi14,
      fundamentalScore: row.fundamentalScore, technicalScore: row.technicalScore, totalScore: row.totalScore,
      benefitMonths: months, benefitSummary: descs, genres: genreNames,
    };
  });

  return c.json(result);
});

// ===== HTML Helpers =====
const CSS = `
:root{
  --bg:#fafafa;--bg-pure:#ffffff;--bg-invert:#0a0a0a;--bg-soft:#f0f0f0;
  --text:#0a0a0a;--text-secondary:#3a3a3a;--text-muted:#737373;--text-invert:#fafafa;
  --border:#0a0a0a;--border-soft:#d4d4d4;
  --accent:#1d4ed8;--accent-hover:#1e3a8a;--accent-soft:#dbeafe;
  --success:#15803d;--success-soft:#dcfce7;
  --warning:#b45309;--warning-soft:#fef3c7;
  --danger:#b91c1c;--danger-soft:#fee2e2;
  --score-high:#15803d;--score-mid:#b45309;--score-low:#c2410c;--score-danger:#b91c1c;
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
a:focus-visible,button:focus-visible,select:focus-visible,input:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
button{font-family:inherit;font-size:inherit}
.container{max-width:720px;margin:0 auto;padding:24px 16px}
@media(min-width:768px){.container{max-width:880px;padding:32px 24px}}
@media(min-width:1024px){.container{max-width:1080px;padding:40px 32px}}

/* === Top header === */
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

/* === Bottom nav (mobile) === */
.bottom-nav{display:none;position:fixed;bottom:0;left:0;right:0;background:var(--bg);border-top:2px solid var(--border);z-index:100;padding-bottom:env(safe-area-inset-bottom,0)}
.bottom-nav a{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;padding:10px 0;min-height:62px;color:var(--text);font-family:var(--font-display);font-size:10px;font-weight:600;text-decoration:none;text-transform:uppercase;letter-spacing:0.06em;border-right:1px solid var(--border-soft)}
.bottom-nav a:last-child{border-right:none}
.bottom-nav a.active{background:var(--bg-invert);color:var(--text-invert)}
.bottom-nav svg{display:block;width:22px;height:22px}
@media(max-width:768px){.desktop-nav{display:none}.bottom-nav{display:flex}body{padding-bottom:80px}.top-header .inner{height:64px}}

/* === Hero === */
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

/* === Section heading === */
h2{font-family:var(--font-display);font-size:28px;font-weight:700;color:var(--text);line-height:1.2;letter-spacing:-0.02em}
h3{font-family:var(--font-display);font-size:20px;font-weight:700;color:var(--text);line-height:1.3;letter-spacing:-0.01em}
.section-label{font-family:var(--font-mono);font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:var(--text-muted);margin-bottom:8px;display:flex;align-items:center;gap:12px}
.section-label::before{content:'';flex:0 0 24px;height:2px;background:var(--text)}

/* === Cards === */
.card{background:var(--bg-pure);border:2px solid var(--border);border-radius:var(--radius);padding:20px;display:block;color:var(--text);text-decoration:none;transition:transform .15s ease-out,box-shadow .15s ease-out;position:relative}
.card:hover,a:hover .card{transform:translate(-3px,-3px);box-shadow:5px 5px 0 0 var(--border);text-decoration:none}
.card h3{font-family:var(--font-display);font-size:18px;font-weight:700;margin-bottom:8px;color:var(--text);letter-spacing:-0.01em}
.card p{font-size:14px;color:var(--text-secondary);line-height:1.6}

/* === Genre/category grid === */
.grid{display:grid;grid-template-columns:1fr;gap:14px;margin-top:20px}
@media(min-width:480px){.grid{grid-template-columns:1fr 1fr}}
@media(min-width:768px){.grid{grid-template-columns:1fr 1fr 1fr;gap:16px}}

/* === Stock card === */
.stock-card{background:var(--bg-pure);border:2px solid var(--border);border-radius:var(--radius);padding:20px;margin-bottom:16px;display:block;color:var(--text);text-decoration:none;transition:transform .15s ease-out,box-shadow .15s ease-out;position:relative}
.stock-card:hover,a:hover .stock-card{transform:translate(-3px,-3px);box-shadow:5px 5px 0 0 var(--border);text-decoration:none}
.stock-header{display:flex;justify-content:space-between;align-items:flex-start;gap:14px;margin-bottom:14px;padding-bottom:14px;border-bottom:1px solid var(--border-soft);flex-wrap:wrap}
.stock-id{display:flex;flex-direction:column;flex:1;min-width:0}
.stock-code{font-family:var(--font-mono);color:var(--text);font-size:22px;font-weight:700;letter-spacing:-0.01em;line-height:1;font-variant-numeric:tabular-nums}
.stock-name{font-family:var(--font-body);font-size:16px;font-weight:600;color:var(--text);display:block;margin-top:8px;line-height:1.4}
.scores{display:flex;gap:8px;margin:14px 0;flex-wrap:wrap}
.score-badge{font-family:var(--font-mono);padding:6px 12px;border-radius:var(--radius);font-size:13px;font-weight:700;border:2px solid;font-variant-numeric:tabular-nums;display:inline-flex;align-items:center;gap:8px;letter-spacing:0.02em}
.score-badge::before{content:'';display:inline-block;width:7px;height:7px;background:currentColor;border-radius:50%;flex-shrink:0}
.score-green{background:var(--success-soft);color:var(--score-high);border-color:var(--score-high)}
.score-yellow{background:var(--warning-soft);color:var(--score-mid);border-color:var(--score-mid)}
.score-orange{background:var(--warning-soft);color:var(--score-low);border-color:var(--score-low)}
.score-red{background:var(--danger-soft);color:var(--score-danger);border-color:var(--score-danger)}
.score-none{background:var(--bg-soft);color:var(--text-muted);border-color:var(--border-soft)}
.metrics{display:flex;gap:6px 18px;font-size:14px;color:var(--text-secondary);margin:12px 0 0;font-variant-numeric:tabular-nums;flex-wrap:wrap}
.metrics span{font-family:var(--font-mono)}
.metrics strong{color:var(--text);font-weight:700;font-family:var(--font-mono)}
.benefit{font-size:15px;color:var(--text);margin-top:14px;padding:12px 14px;background:var(--bg-soft);border-left:3px solid var(--text);line-height:1.65;display:block;overflow:visible}
.tag{display:inline-block;background:var(--bg);color:var(--text);font-family:var(--font-mono);font-size:11px;font-weight:600;padding:4px 10px;border-radius:var(--radius);margin-right:6px;margin-top:6px;border:1.5px solid var(--border);letter-spacing:0.04em;text-transform:uppercase}

/* === Pagination === */
.pagination{display:flex;justify-content:center;align-items:center;gap:6px;margin-top:32px;padding-top:24px;border-top:2px solid var(--border);flex-wrap:wrap}
.pagination a,.pagination span{min-height:var(--tap);min-width:var(--tap);padding:0 16px;font-family:var(--font-mono);font-size:15px;font-weight:600;display:inline-flex;align-items:center;justify-content:center;border:2px solid var(--border);border-radius:var(--radius)}
.pagination a{background:var(--bg);color:var(--text)}
.pagination a:hover{background:var(--bg-invert);color:var(--text-invert);text-decoration:none}
.pagination span{background:var(--bg-invert);color:var(--text-invert)}

/* === Detail score === */
.detail-scores{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin:24px 0}
.detail-score{text-align:left;padding:20px 18px;background:var(--bg-pure);border:2px solid var(--border);border-radius:var(--radius);position:relative}
.detail-score::before{content:'';position:absolute;top:0;left:0;width:32px;height:2px;background:var(--text)}
.detail-score .val{font-family:var(--font-mono);font-size:36px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--text);line-height:1;letter-spacing:-0.02em}
.detail-score .lbl{font-family:var(--font-mono);font-size:10px;color:var(--text-muted);font-weight:600;margin-top:10px;text-transform:uppercase;letter-spacing:0.1em}
@media(max-width:480px){.detail-score{padding:16px 12px}.detail-score .val{font-size:28px}}

/* === Tables === */
table{width:100%;border-collapse:collapse;margin:16px 0;background:var(--bg)}
th,td{padding:14px 16px;text-align:left;border-bottom:1px solid var(--border-soft);font-size:15px;line-height:1.6}
th{font-family:var(--font-mono);color:var(--text-muted);font-weight:600;font-size:11px;background:var(--bg-soft);width:50%;text-transform:uppercase;letter-spacing:0.08em}
td{font-family:var(--font-mono);font-variant-numeric:tabular-nums;font-weight:500;color:var(--text)}
.table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch;border:2px solid var(--border);border-radius:var(--radius)}
.table-wrap table{margin:0}

/* === Benefit card === */
.benefit-card{background:var(--bg-pure);border:2px solid var(--border);border-radius:var(--radius);padding:20px;margin:14px 0;position:relative}
.benefit-card::before{content:'';position:absolute;top:0;left:0;width:48px;height:2px;background:var(--text)}
.benefit-card>div{margin-bottom:8px}
.benefit-card>div:last-child{margin-bottom:0}

/* === Back button === */
.back{display:inline-flex;align-items:center;justify-content:center;min-height:var(--tap);margin:10px 6px 10px 0;color:var(--text);font-family:var(--font-display);font-size:14px;font-weight:600;padding:0 20px;background:var(--bg);border:2px solid var(--border);border-radius:var(--radius);text-decoration:none;text-transform:uppercase;letter-spacing:0.04em;transition:transform .15s,box-shadow .15s}
.back:hover{transform:translate(-2px,-2px);box-shadow:3px 3px 0 0 var(--border);text-decoration:none}

/* === Sort bar === */
.sort-bar{display:flex;gap:8px;margin:20px 0;flex-wrap:wrap}
.sort-bar a{padding:0 18px;min-height:var(--tap);display:inline-flex;align-items:center;border-radius:var(--radius);font-family:var(--font-mono);font-size:13px;font-weight:600;background:var(--bg);border:2px solid var(--border);color:var(--text);text-decoration:none;text-transform:uppercase;letter-spacing:0.04em;transition:transform .15s,box-shadow .15s}
.sort-bar a:hover{transform:translate(-2px,-2px);box-shadow:3px 3px 0 0 var(--border);text-decoration:none}
.sort-bar a.active{background:var(--bg-invert);color:var(--text-invert);border-color:var(--border)}

/* === Tooltip === */
.tip{position:relative;display:inline-block;cursor:help;border-bottom:2px dotted var(--text-muted);font-weight:600}
.tip .tip-text{visibility:hidden;opacity:0;position:absolute;z-index:50;bottom:calc(100% + 8px);left:50%;transform:translateX(-50%);width:max-content;max-width:min(320px,calc(100vw - 32px));background:var(--bg-invert);color:var(--text-invert);font-size:14px;line-height:1.65;padding:14px 16px;border-radius:var(--radius);transition:opacity .15s;pointer-events:none;font-weight:400;border:2px solid var(--border);white-space:normal;text-align:left;word-break:break-word}
.tip .tip-text::after{content:'';position:absolute;top:100%;left:50%;transform:translateX(-50%);border:8px solid transparent;border-top-color:var(--bg-invert)}
.tip:hover .tip-text,.tip:focus .tip-text,.tip:focus-within .tip-text,.tip:active .tip-text{visibility:visible;opacity:1}
@media(max-width:600px){.tip .tip-text{font-size:13px;padding:12px 14px;left:0;transform:none;max-width:min(280px,calc(100vw - 32px))}.tip .tip-text::after{left:22px;transform:none}}

/* === Financial indicator grid === */
.fin-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:16px 0}
@media(min-width:560px){.fin-grid{grid-template-columns:1fr 1fr 1fr}}
@media(min-width:880px){.fin-grid{grid-template-columns:1fr 1fr 1fr 1fr 1fr}}
.fin-cell{background:var(--bg-pure);border:2px solid var(--border);border-radius:var(--radius);padding:14px 14px 12px;position:relative;overflow:visible;min-width:0}
.fin-cell::before{content:'';position:absolute;top:0;left:0;width:24px;height:2px;background:var(--text)}
.fin-label{font-family:var(--font-mono);font-size:10px;color:var(--text-muted);font-weight:600;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:10px;line-height:1.3;min-height:1.3em}
.fin-value{font-family:var(--font-mono);font-size:20px;font-weight:700;color:var(--text);font-variant-numeric:tabular-nums;line-height:1.15;letter-spacing:-0.01em;display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;word-break:break-word}
.fin-tag{font-family:var(--font-mono);font-size:10px;font-weight:700;padding:2px 6px;border-radius:var(--radius);border:1.5px solid;line-height:1.4;text-transform:none;letter-spacing:0}
.fin-tag-good{color:var(--success);border-color:var(--success);background:var(--success-soft)}
.fin-tag-bad{color:var(--danger);border-color:var(--danger);background:var(--danger-soft)}

/* === Benefit groups (grouped by genre/tier/product) === */
.benefit-group{background:var(--bg-pure);border:2px solid var(--border);border-radius:var(--radius);margin:16px 0;position:relative;overflow:hidden}
.benefit-group::before{content:'';position:absolute;top:0;left:0;width:48px;height:2px;background:var(--text)}
.benefit-group-header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:20px 20px 14px;border-bottom:1px solid var(--border-soft);flex-wrap:wrap}
.benefit-group-title{display:flex;flex-direction:column;gap:8px;min-width:0;flex:1}
.benefit-group-name{font-family:var(--font-display);font-size:18px;font-weight:700;color:var(--text);letter-spacing:-0.01em;line-height:1.3}
.benefit-group-months{display:flex;gap:6px;flex-wrap:wrap}
.month-tag{font-family:var(--font-mono);font-size:11px;font-weight:700;color:var(--text);background:var(--bg);border:1.5px solid var(--border);padding:4px 10px;border-radius:var(--radius);letter-spacing:0.04em;text-transform:uppercase}
.benefit-group-link{font-family:var(--font-mono);font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;white-space:nowrap;padding-top:4px}
.benefit-group-link:hover{color:var(--text);text-decoration:underline}
.benefit-tiers{display:flex;flex-direction:column}
.benefit-tier{padding:16px 20px;border-top:1px solid var(--border-soft);display:grid;grid-template-columns:110px 1fr;gap:16px;align-items:start}
.benefit-tier:first-child{border-top:none}
.benefit-tier-label{font-family:var(--font-mono);font-size:14px;font-weight:700;color:var(--text);font-variant-numeric:tabular-nums;padding-top:8px;letter-spacing:0.02em}
.benefit-products{list-style:none;display:flex;flex-direction:column;gap:10px;margin:0;padding:0}
.benefit-product{padding:12px 14px;background:var(--bg-soft);border-left:3px solid var(--text);border-radius:0 var(--radius) var(--radius) 0;font-size:14px;line-height:1.65}
.product-desc{color:var(--text);word-break:break-word}
.product-meta{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px}
.product-value{font-family:var(--font-mono);font-size:11px;font-weight:700;color:var(--text);background:var(--bg-pure);border:1.5px solid var(--border);padding:2px 8px;border-radius:var(--radius);letter-spacing:0.02em}
.product-value-unknown{color:var(--text-muted);border-style:dashed;font-weight:600}
.product-months{font-family:var(--font-mono);font-size:11px;color:var(--text-muted);background:var(--bg-pure);border:1.5px dashed var(--border-soft);padding:2px 8px;border-radius:var(--radius);font-weight:600}
@media(max-width:560px){
  .benefit-tier{grid-template-columns:1fr;gap:10px;padding:14px 16px}
  .benefit-tier-label{padding-top:0;font-size:13px}
  .benefit-group-header{padding:16px 16px 12px}
  .benefit-product{padding:10px 12px;font-size:13px}
}

/* === Guide box === */
.guide{background:var(--bg-pure);border:2px solid var(--border);border-radius:var(--radius);padding:20px;margin:20px 0;font-size:15px;color:var(--text);line-height:1.8;position:relative}
.guide::before{content:'GUIDE';position:absolute;top:-10px;left:16px;background:var(--bg-invert);color:var(--text-invert);font-family:var(--font-mono);font-size:10px;font-weight:700;padding:3px 10px;letter-spacing:0.12em;border-radius:var(--radius)}
.guide strong{color:var(--text);font-weight:700;font-family:var(--font-display)}

/* === List header (common to screening / genre list pages) === */
.list-header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin:8px 0 16px;flex-wrap:wrap}
.list-header h2{flex:1;min-width:0}
.list-count{font-family:var(--font-mono);font-size:14px;color:var(--text-muted);font-weight:600;margin-left:8px;letter-spacing:0.04em}
.list-sort{background:var(--bg);color:var(--text);border:2px solid var(--border);border-radius:var(--radius);padding:0 14px;font-family:var(--font-mono);font-size:13px;font-weight:500;min-width:160px;min-height:var(--tap)}
.list-sort:focus{outline:3px solid var(--accent);outline-offset:0}

/* === Screening toolbar === */
.toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.toolbar select{background:var(--bg);color:var(--text);border:2px solid var(--border);border-radius:var(--radius);padding:0 14px;font-family:var(--font-mono);font-size:14px;font-weight:500;flex:1;min-width:140px;min-height:var(--tap)}
.toolbar select:focus{outline:3px solid var(--accent);outline-offset:0}
.toolbar .filter-toggle{background:var(--bg);color:var(--text);border:2px solid var(--border);border-radius:var(--radius);padding:0 16px;font-family:var(--font-display);font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap;min-height:var(--tap);text-transform:uppercase;letter-spacing:0.04em}
.toolbar .filter-toggle.has-filter{color:var(--text-invert);border-color:var(--border);background:var(--bg-invert)}
.empty-list{text-align:center;color:var(--text-muted);padding:48px 16px;font-family:var(--font-mono);font-size:13px;text-transform:uppercase;letter-spacing:0.1em;border:2px dashed var(--border-soft);border-radius:var(--radius);margin:16px 0}

/* === Filter drawer === */
.filter-drawer{background:var(--bg-pure);border:2px solid var(--border);border-radius:var(--radius);padding:20px;margin-bottom:16px;display:none;position:relative}
.filter-drawer::before{content:'FILTER';position:absolute;top:-10px;left:16px;background:var(--bg-invert);color:var(--text-invert);font-family:var(--font-mono);font-size:10px;font-weight:700;padding:3px 10px;letter-spacing:0.12em;border-radius:var(--radius)}
.filter-drawer.open{display:block}
.filter-row{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px}
.filter-group{display:flex;flex-direction:column;gap:6px}
.filter-group label{font-family:var(--font-mono);font-size:11px;color:var(--text-muted);font-weight:600;text-transform:uppercase;letter-spacing:0.06em}
.filter-group select,.filter-group input{background:var(--bg);color:var(--text);border:2px solid var(--border);border-radius:var(--radius);padding:0 14px;font-family:var(--font-mono);font-size:14px;width:100%;min-height:var(--tap)}
.filter-group .hint{font-size:11px;color:var(--text-muted)}
.filter-actions{display:flex;gap:10px;margin-top:16px}
.filter-actions button,.filter-actions a{flex:1;display:inline-flex;align-items:center;justify-content:center;border-radius:var(--radius);padding:0 18px;font-family:var(--font-display);font-size:14px;font-weight:700;cursor:pointer;min-height:var(--tap);border:2px solid var(--border);text-transform:uppercase;letter-spacing:0.04em;text-decoration:none;transition:transform .15s,box-shadow .15s}
.filter-actions button:hover,.filter-actions a:hover{transform:translate(-2px,-2px);box-shadow:3px 3px 0 0 var(--border);text-decoration:none}
.filter-actions .btn-search{background:var(--bg-invert);color:var(--text-invert)}
.filter-actions .btn-reset{background:var(--bg);color:var(--text)}
@media(max-width:400px){.filter-row{grid-template-columns:1fr}}

/* === Genre tag (list view) === */
.genre-tag{font-family:var(--font-mono);font-size:10px;color:var(--text);background:var(--bg);border:1.5px solid var(--border);padding:3px 10px;border-radius:var(--radius);font-weight:600;text-transform:uppercase;letter-spacing:0.04em;margin-right:4px;display:inline-block}
`;

/** HTMLエスケープ（XSS対策） */
function h(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function layout(title: string, body: string, activePage = ""): string {
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0,viewport-fit=cover"><title>${h(title)} | お宝優待 / KABULAB</title><meta name="description" content="ファンダメンタルズとテクニカルの2つの視点から割安な株主優待銘柄を発見。PBR・PER・RSI・配当利回りでスクリーニング。"><meta name="theme-color" content="#fafafa"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="default"><link rel="manifest" href="${BP}/manifest.json"><link rel="apple-touch-icon" href="${BP}/icon-192.png"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&family=Noto+Sans+JP:wght@400;500;600;700&display=swap" rel="stylesheet"><style>${CSS}</style></head><body><header class="top-header"><div class="inner"><a href="${BP}/" class="brand"><span class="mark"></span><span class="name"><span class="ja">お宝優待</span><span class="en">002 / KABULAB</span></span></a><nav class="desktop-nav"><a href="/" class="portal-back">← KABULAB</a><a href="${BP}/">HOME</a><a href="${BP}/screening">SCREENING</a></nav></div></header>${body}<nav class="bottom-nav"><a href="${BP}/" class="${activePage === "home" ? "active" : ""}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12l9-9 9 9"/><path d="M5 10v10a1 1 0 001 1h3v-6h6v6h3a1 1 0 001-1V10"/></svg><span>HOME</span></a><a href="${BP}/screening" class="${activePage === "screening" ? "active" : ""}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg><span>SCREENING</span></a><a href="/"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg><span>PORTAL</span></a></nav><script>if('serviceWorker' in navigator){navigator.serviceWorker.register('${BP}/sw.js',{scope:'${BP}/'})}
// カード全体が <a> のリスト (genres / screening) 内で用語バルーン (.tip) を
// タップした際、リンク遷移が先行して解説が読めない問題の回避 (ルール7 の
// モバイル「タップで出る」要件)。.tip 上のタップのみ遷移を止め、tabindex=0 の
// focus で :focus バルーンが開く。リンク外の .tip (詳細ページ等) には影響しない。
document.addEventListener('click',function(e){var t=e.target&&e.target.closest?e.target.closest('.tip'):null;if(t&&t.closest('a')){e.preventDefault();e.stopPropagation();t.focus()}},true);</script></body></html>`;
}

function scoreBadge(val: number | null, label: string): string {
  if (val === null) return `<span class="score-badge score-none">${label}: -</span>`;
  const cls = val >= 80 ? "score-green" : val >= 60 ? "score-yellow" : val >= 40 ? "score-orange" : "score-red";
  return `<span class="score-badge ${cls}">${label}: ${val.toFixed(1)}</span>`;
}

function fmt(v: number | null): string { return v !== null ? v.toFixed(2) : "-"; }

/**
 * 用語ツールチップ (ルール7)。`as const` + keyof で tip() のキーを型拘束し、
 * 未知キー (typo) は実行時の空ツールチップではなくビルド時の型エラーで検出する
 * (ルール2: `?? ""` の silent fallback を型で撤去)。
 *
 * export はテスト専用 (tips-literal-safety.test.ts) — screeningJS への埋め込み
 * 制約 (シングルクォート/バックスラッシュ/</script 禁止) をテストで強制する。
 */
export const TIPS = {
  per: "株価収益率。株価が1株あたり利益の何倍かを示します。低いほど割安の目安。一般に15倍以下が割安とされます。",
  pbr: "株価純資産倍率。株価が1株あたり純資産の何倍かを示します。1倍以下は「解散価値以下」で割安の目安。",
  dividend: "配当利回り。株価に対する年間配当金の割合。高いほどお得。3%以上が高配当の目安です。",
  eps: "1株あたり利益。企業が1株でいくら稼いだかを示します。高いほど収益力が強い企業です。",
  bps: "1株あたり純資産。企業の資産を株数で割った値。PBR=株価÷BPSです。",
  roe: "自己資本利益率。株主のお金を使ってどれだけ効率よく利益を出しているかの指標。10%以上が優良企業の目安。",
  rsi: "相対力指数。株の「買われすぎ・売られすぎ」を0〜100で表します。30以下は売られすぎ（割安チャンス）、70以上は買われすぎ。",
  macd: "移動平均の差を使った売買シグナル。MACDがシグナル線を下から上に抜けると買いサイン（ゴールデンクロス）。",
  marketcap: "時価総額。株価×発行済株数で企業の規模を表します。大きいほど安定、小さいほどハイリスク・ハイリターン。",
  total: "総合スコア。ファンダメンタルズ（企業の実力）60%とテクニカル（チャートの動き）40%を組み合わせた独自指標。80以上が最有力。",
  fundamental: "企業の財務データから割安さを評価するスコア。PER・PBR・配当利回り・ROE・優待利回りを総合評価。",
  technical: "株価チャートの動きから割安タイミングを評価するスコア。RSI・移動平均乖離率・MACDを総合評価。",
  yutai: "株主優待。一定株数を保有すると企業から商品券や食事券などがもらえる制度。権利確定月に保有が必要です。",
  yutai_yield: "優待利回り。1年分の株主優待の推定価値が、投資額（株価×最低必要株数）の何%にあたるかを示します。例: 株価1,000円×100株=10万円の投資で年3,000円相当の優待なら3%。優待の金額を推定できない銘柄では「-」になります。",
  recordmonth: "権利確定月。この月末時点で株を保有していると株主優待がもらえます。権利付最終日（月末2営業日前）までに購入が必要。",
  minshares: "最低必要株数。優待をもらうために最低限保有しなければならない株の数。通常100株単位です。",
  value_unknown: "この優待は商品名から金額を機械的に推定できません。自社製品・体験型・割引券・カタログギフトの一部などが該当します。「分からない=ダメ」ではなく、金額換算が難しいので投資判断はご自身で行ってください。",
} as const;

function tip(key: keyof typeof TIPS, label: string): string {
  const text = TIPS[key];
  // role/aria-label は共有 term-tip.ts と同等のスクリーンリーダ対応 (ルール7-4)。
  // バルーン本文は visibility:hidden で SR に読まれないため aria-label に全文を載せる。
  return `<span class="tip" tabindex="0" role="note" aria-label="${label}: ${text}">${label}<span class="tip-text">${text}</span></span>`;
}

/** 優待行（DBから取得された1行） */
type BenefitRow = {
  genre: { name: string; slug: string } | null;
  minShares: number;
  recordMonth: number;
  description: string;
  estimatedValue: number | null;
};

/** 優待をジャンル → 保有段階 → 商品 の3階層にまとめる */
type ProductGroup = {
  description: string;
  estimatedValue: number | null;
  months: number[];
};
type TierGroup = {
  minShares: number;
  products: ProductGroup[];
};
type GenreGroup = {
  genreName: string;
  genreSlug: string | null;
  allMonths: number[];
  tiers: TierGroup[];
};

function groupBenefits(rows: BenefitRow[]): GenreGroup[] {
  const byGenre = new Map<string, { slug: string | null; list: BenefitRow[] }>();
  for (const r of rows) {
    const name = r.genre?.name ?? "その他";
    if (!byGenre.has(name)) byGenre.set(name, { slug: r.genre?.slug ?? null, list: [] });
    byGenre.get(name)!.list.push(r);
  }
  const result: GenreGroup[] = [];
  for (const [genreName, { slug, list }] of byGenre) {
    const monthsSet = new Set<number>();
    const tierMap = new Map<number, Map<string, ProductGroup>>();
    for (const b of list) {
      monthsSet.add(b.recordMonth);
      if (!tierMap.has(b.minShares)) tierMap.set(b.minShares, new Map());
      const productMap = tierMap.get(b.minShares)!;
      const key = b.description;
      if (!productMap.has(key)) {
        productMap.set(key, { description: b.description, estimatedValue: b.estimatedValue, months: [] });
      }
      const p = productMap.get(key)!;
      p.months.push(b.recordMonth);
      // 最大の推定価値を残す（同一商品が月ごとに別値を持つ場合の保険）
      if (b.estimatedValue != null && (p.estimatedValue == null || b.estimatedValue > p.estimatedValue)) {
        p.estimatedValue = b.estimatedValue;
      }
    }
    const tiers: TierGroup[] = [...tierMap.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([minShares, productMap]) => ({
        minShares,
        products: [...productMap.values()].map((p) => ({
          description: p.description,
          estimatedValue: p.estimatedValue,
          months: [...new Set(p.months)].sort((a, b) => a - b),
        })),
      }));
    result.push({
      genreName,
      genreSlug: slug,
      allMonths: [...monthsSet].sort((a, b) => a - b),
      tiers,
    });
  }
  // ジャンル順: 推定合計価値が高い順
  result.sort((a, b) => {
    const av = a.tiers.reduce((s, t) => s + t.products.reduce((x, p) => x + (p.estimatedValue ?? 0), 0), 0);
    const bv = b.tiers.reduce((s, t) => s + t.products.reduce((x, p) => x + (p.estimatedValue ?? 0), 0), 0);
    return bv - av;
  });
  return result;
}

/** 財務指標1セル分のデータ */
type FinCell = {
  label: string;
  value: string;
  tag: { kind: "good" | "bad"; text: string } | null;
};

/** 財務指標で参照するフィールドのみを抜き出した型 */
type FinForGrid = {
  price: number | null;
  per: number | null;
  pbr: number | null;
  dividendYield: number | null;
  yutaiYield: number | null;
  eps: number | null;
  bps: number | null;
  roe: number | null;
  rsi14: number | null;
  macd: number | null;
  marketCap: number | null;
} | null;

/** 財務指標グリッドをHTMLに描画 */
function renderFinGrid(fin: FinForGrid): string {
  const per = fin?.per ?? null;
  const pbr = fin?.pbr ?? null;
  const dividendYield = fin?.dividendYield ?? null;
  const roeRaw = fin?.roe ?? null;
  const roeVal = roeRaw != null ? (roeRaw > 1 ? roeRaw : roeRaw * 100) : null;
  const rsi = fin?.rsi14 ?? null;

  const cells: FinCell[] = [
    { label: "株価", value: fin?.price != null ? fin.price.toLocaleString() + "円" : "-", tag: null },
    {
      label: tip("per", "PER"),
      value: fmt(per),
      tag: per != null ? (per < 15 ? { kind: "good", text: "割安" } : per > 25 ? { kind: "bad", text: "割高" } : null) : null,
    },
    {
      label: tip("pbr", "PBR"),
      value: fmt(pbr),
      tag: pbr != null ? (pbr < 1 ? { kind: "good", text: "割安" } : pbr > 2 ? { kind: "bad", text: "割高" } : null) : null,
    },
    {
      label: tip("dividend", "配当利回り"),
      value: dividendYield != null ? dividendYield.toFixed(2) + "%" : "-",
      tag: dividendYield != null && dividendYield >= 3 ? { kind: "good", text: "高配当" } : null,
    },
    {
      // tag は付けない: 「高優待」と呼べる根拠ある閾値が存在しないため発明しない (ルール1)
      label: tip("yutai_yield", "優待利回り"),
      value: fin?.yutaiYield != null ? fin.yutaiYield.toFixed(2) + "%" : "-",
      tag: null,
    },
    { label: tip("eps", "EPS"), value: fmt(fin?.eps ?? null), tag: null },
    { label: tip("bps", "BPS"), value: fmt(fin?.bps ?? null), tag: null },
    {
      label: tip("marketcap", "時価総額"),
      value: fin?.marketCap != null ? (fin.marketCap / 100000000).toFixed(0) + "億円" : "-",
      tag: null,
    },
    {
      label: tip("roe", "ROE"),
      value: roeVal != null ? roeVal.toFixed(1) + "%" : "-",
      tag: roeVal != null && roeVal >= 10 ? { kind: "good", text: "優良" } : null,
    },
    {
      label: tip("rsi", "RSI(14)"),
      value: fmt(rsi),
      tag: rsi != null ? (rsi < 30 ? { kind: "good", text: "売られすぎ" } : rsi > 70 ? { kind: "bad", text: "買われすぎ" } : null) : null,
    },
    { label: tip("macd", "MACD"), value: fin?.macd != null ? fin.macd.toFixed(1) : "-", tag: null },
  ];

  return `<div class="fin-grid">${cells
    .map(
      (c) => `
    <div class="fin-cell">
      <div class="fin-label">${c.label}</div>
      <div class="fin-value">${c.value}${c.tag ? `<span class="fin-tag fin-tag-${c.tag.kind}">${c.tag.text}</span>` : ""}</div>
    </div>`
    )
    .join("")}</div>`;
}

/** 優待ブロックをHTMLに描画 */
function renderBenefitGroups(groups: GenreGroup[]): string {
  if (groups.length === 0) return `<p style="color:var(--text-muted);margin:16px 0">優待情報がありません</p>`;
  return groups
    .map((g) => {
      const monthsHtml = g.allMonths.map((m) => `<span class="month-tag">${m}月</span>`).join("");
      const tiersHtml = g.tiers
        .map((t) => {
          const productsHtml = t.products
            .map((p) => {
              const isPartial = p.months.length < g.allMonths.length;
              const monthNote = isPartial
                ? `<span class="product-months">${p.months.map((m) => m + "月").join("・")}のみ</span>`
                : "";
              // estimatedValue=null は「金額推定不能」の正直表示 (ルール1/2)。
              // 旧実装はバッジを silent に消して「価値ゼロ」「未取得」「推定不能」
              // を区別できなくしていたため、明示バッジ + バルーンヘルプ
              // (ルール7) で「分からないからこそ慎重に」のトーンを補う。
              const valueNote =
                p.estimatedValue != null
                  ? `<span class="product-value">推定 ${p.estimatedValue.toLocaleString()}円</span>`
                  : `<span class="product-value product-value-unknown">${tip("value_unknown", "金額換算が難しい優待")}</span>`;
              const descHtml = h(p.description).replace(/\n/g, "<br>");
              return `<li class="benefit-product"><div class="product-desc">${descHtml}</div><div class="product-meta">${valueNote}${monthNote}</div></li>`;
            })
            .join("");
          return `
            <div class="benefit-tier">
              <div class="benefit-tier-label">${t.minShares.toLocaleString()}株〜</div>
              <ul class="benefit-products">${productsHtml}</ul>
            </div>`;
        })
        .join("");
      const genreLink = g.genreSlug
        ? `<a href="${BP}/genres/${g.genreSlug}" class="benefit-group-link">同ジャンル一覧 →</a>`
        : "";
      return `
        <div class="benefit-group">
          <div class="benefit-group-header">
            <div class="benefit-group-title">
              <h4 class="benefit-group-name">${h(g.genreName)}</h4>
              <div class="benefit-group-months">${monthsHtml}</div>
            </div>
            ${genreLink}
          </div>
          <div class="benefit-tiers">${tiersHtml}</div>
        </div>`;
    })
    .join("");
}

/** ソートセレクトのoptions HTML（スクリーニング・ジャンルページ共通） */
function sortOptions(current = "total-desc"): string {
  const opts = [
    ["total-desc", "総合スコア ↓"], ["total-asc", "総合スコア ↑"],
    ["fundamental-desc", "ファンダ ↓"], ["fundamental-asc", "ファンダ ↑"],
    ["technical-desc", "テクニカル ↓"], ["technical-asc", "テクニカル ↑"],
    ["dividend-desc", "配当利回り ↓"], ["dividend-asc", "配当利回り ↑"],
    ["yutai-desc", "優待利回り ↓"], ["yutai-asc", "優待利回り ↑"],
    ["pbr-asc", "PBR ↑ (割安順)"], ["pbr-desc", "PBR ↓"],
  ];
  return opts.map(([v, l]) => `<option value="${v}"${v === current ? " selected" : ""}>${l}</option>`).join("");
}

// ===== SSR Pages =====

// GET / — ホームページ
app.get("/", async (c) => {
  const db = c.get("db");
  const genres = await db.select().from(yutaiGenres).orderBy(yutaiGenres.name);
  const [{ count: totalStocks }] = await db.select({ count: count() }).from(stocks).where(eq(stocks.isYutai, true));

  const cards = genres.map(g =>
    `<a href="${BP}/genres/${h(g.slug)}" style="text-decoration:none;color:inherit"><div class="card"><h3>${h(g.name)}</h3><p>${h(g.description || "")}</p></div></a>`
  ).join("");

  return c.html(layout("ホーム", `
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
        ${tip("yutai", "株主優待")}とは、企業の株を持っていると食事券や商品券などがもらえるお得な制度です。
        このサービスでは、${tip("fundamental", "企業の実力（ファンダメンタルズ）")}と${tip("technical", "チャートの動き（テクニカル）")}の2つの視点から、
        <strong>今お買い得な優待銘柄</strong>をスコア付きで紹介しています。
        まずは下のジャンルから選んでみましょう。
      </div>
      <div class="section-label">002 / Browse by Genre</div>
      <h2 style="margin:0 0 4px">ジャンルから探す</h2>
      <div class="grid">${cards}</div>
    </div>
  `, "home"));
});

// GET /genres/:slug — ジャンル別スクリーニング
app.get("/genres/:slug", async (c) => {
  const slug = c.req.param("slug");
  if (!/^[a-z0-9-]+$/.test(slug)) return c.notFound();
  const db = c.get("db");

  const genre = await db.select().from(yutaiGenres).where(eq(yutaiGenres.slug, slug)).limit(1).then(r => r[0]);
  if (!genre) return c.html(layout("Not Found", `<div class="container"><h2>ジャンルが見つかりません</h2><a href="${BP}/" class="back">← ホームに戻る</a></div>`), 404);

  const page = Math.max(1, Math.min(parseInt(c.req.query("page") ?? "1", 10) || 1, 500));
  // ソートは "<列>-<昇降>" の複合値 (sortOptions と同形式)。旧 ?sort=&order= 形式も後方互換で受理。
  const sortRaw = c.req.query("sort") ?? "total-desc";
  let gSort: string, gOrder: string;
  if (sortRaw.includes("-")) { const [col, ord] = sortRaw.split("-"); gSort = col; gOrder = ord; }
  else { gSort = sortRaw; gOrder = c.req.query("order") ?? "desc"; }
  if (!["total", "fundamental", "technical", "dividend", "pbr", "yutai"].includes(gSort)) gSort = "total";
  if (gOrder !== "asc") gOrder = "desc";
  const PAGE_SIZE = 20;

  // 絞り込み条件 (スクリーニングと同一パラメータ)。空 (未入力) は適用しない。
  // ルール2 帰結: 未指定を 0 等で勝手に埋めず「条件なし」として扱う。
  const fMonthRaw = parseInt(c.req.query("month") ?? "", 10);
  const fMonth = fMonthRaw >= 1 && fMonthRaw <= 12 ? fMonthRaw : 0;
  const fPerMax = parseFloat(c.req.query("perMax") ?? "") || 0;
  const fPbrMax = parseFloat(c.req.query("pbrMax") ?? "") || 0;
  const fYieldMin = parseFloat(c.req.query("yieldMin") ?? "") || 0;
  const fRsiMax = parseFloat(c.req.query("rsiMax") ?? "") || 0;
  const activeFilters = [fMonth, fPerMax, fPbrMax, fYieldMin, fRsiMax].filter(v => v > 0).length;

  // WHERE: ジャンル該当 (サブクエリ) + active + 絞り込み。ID 配列を JS 展開せず
  // サブクエリを inArray に渡し D1 のバインド変数上限 (1クエリ100個) を回避する。
  const gWhere: unknown[] = [
    inArray(stocks.id,
      db.select({ stockId: yutaiBenefits.stockId }).from(yutaiBenefits)
        .where(eq(yutaiBenefits.genreId, genre.id))),
    eq(stocks.isActive, true),
  ];
  if (fMonth) gWhere.push(inArray(stocks.id,
    db.select({ stockId: yutaiBenefits.stockId }).from(yutaiBenefits)
      .where(eq(yutaiBenefits.recordMonth, fMonth))));
  if (fPerMax > 0) gWhere.push(lte(stockFinancials.per, fPerMax));
  if (fPbrMax > 0) gWhere.push(lte(stockFinancials.pbr, fPbrMax));
  if (fYieldMin > 0) gWhere.push(gte(stockFinancials.dividendYield, fYieldMin));
  if (fRsiMax > 0) gWhere.push(lte(stockFinancials.rsi14, fRsiMax));
  const gWhereCond = and(...(gWhere as Parameters<typeof and>));

  // 絞り込み後の件数 (= ページ数)。財務列フィルタのため stockFinancials を join し、
  // count(distinct) で行転送なしに正確な件数を得る。
  const cntRow = await db.select({ c: sql<number>`count(distinct ${stocks.id})` }).from(stocks)
    .leftJoin(stockFinancials, eq(stockFinancials.stockId, stocks.id))
    .where(gWhereCond);
  const matchedCount = Number(cntRow[0]?.c ?? 0);

  const totalPages = Math.max(1, Math.ceil(matchedCount / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const offset = (safePage - 1) * PAGE_SIZE;

  // ソート列
  const gColMap: Record<string, unknown> = {
    total: stockScores.totalScore, fundamental: stockScores.fundamentalScore,
    technical: stockScores.technicalScore, dividend: stockFinancials.dividendYield,
    pbr: stockFinancials.pbr, yutai: stockFinancials.yutaiYield,
  };
  const gCol = gColMap[gSort] ?? stockScores.totalScore;
  const gSortExpr = gOrder === "asc" ? sql`${gCol} ASC NULLS LAST` : sql`${gCol} DESC NULLS LAST`;

  const rows = matchedCount === 0 ? [] : await db.select({
    id: stocks.id, code: stocks.code, name: stocks.name,
    fundamentalScore: stockScores.fundamentalScore,
    technicalScore: stockScores.technicalScore,
    totalScore: stockScores.totalScore,
    per: stockFinancials.per, pbr: stockFinancials.pbr,
    dividendYield: stockFinancials.dividendYield,
    yutaiYield: stockFinancials.yutaiYield,
  }).from(stocks)
    .leftJoin(stockScores, eq(stockScores.stockId, stocks.id))
    .leftJoin(stockFinancials, eq(stockFinancials.stockId, stocks.id))
    .where(gWhereCond)
    .orderBy(gSortExpr)
    .limit(PAGE_SIZE * 3).offset(offset);

  // 重複除去
  const gSeen = new Set<number>();
  const gUnique = rows.filter(r => { if (gSeen.has(r.id)) return false; gSeen.add(r.id); return true; }).slice(0, PAGE_SIZE);

  // 優待情報取得
  const pageIds = gUnique.map(r => r.id);
  const benefits = pageIds.length > 0
    ? await db.select({ stockId: yutaiBenefits.stockId, description: yutaiBenefits.description, recordMonth: yutaiBenefits.recordMonth })
        .from(yutaiBenefits).where(inArray(yutaiBenefits.stockId, pageIds))
    : [];

  const cards = gUnique.map(row => {
    const rowBenefits = benefits.filter(b => b.stockId === row.id);
    const months = [...new Set(rowBenefits.map(b => b.recordMonth))].sort((a, b) => a - b);
    const desc = [...new Set(rowBenefits.map(b => b.description))].join(" / ");
    return `
      <a href="${BP}/stocks/${row.code}" style="text-decoration:none;color:inherit">
        <div class="stock-card">
          <div class="stock-header">
            <div class="stock-id"><span class="stock-code">${h(row.code)}</span><span class="stock-name">${h(row.name)}</span></div>
            <div>${months.map(m => `<span class="tag">${m}月</span>`).join("")}</div>
          </div>
          <div class="scores">
            ${scoreBadge(row.totalScore, tip("total", "総合"))}
            ${scoreBadge(row.fundamentalScore, tip("fundamental", "ファンダ"))}
            ${scoreBadge(row.technicalScore, tip("technical", "テクニカル"))}
          </div>
          <div class="metrics">
            <span>${tip("per", "PER")} <strong>${fmt(row.per)}</strong></span>
            <span>${tip("pbr", "PBR")} <strong>${fmt(row.pbr)}</strong></span>
            <span>${tip("dividend", "配当")} <strong>${row.dividendYield !== null ? row.dividendYield.toFixed(2) + "%" : "-"}</strong></span>
            <span>${tip("yutai_yield", "優待")} <strong>${row.yutaiYield !== null ? row.yutaiYield.toFixed(2) + "%" : "-"}</strong></span>
          </div>
          ${desc ? `<div class="benefit">${h(desc.substring(0, 80))}</div>` : ""}
        </div>
      </a>`;
  }).join("");

  // 現在のソート/絞り込みを保持したページネーション URL
  const qs = (p: number) => {
    const parts = [`page=${p}`, `sort=${gSort}-${gOrder}`];
    if (fMonth) parts.push(`month=${fMonth}`);
    if (fPerMax > 0) parts.push(`perMax=${fPerMax}`);
    if (fPbrMax > 0) parts.push(`pbrMax=${fPbrMax}`);
    if (fYieldMin > 0) parts.push(`yieldMin=${fYieldMin}`);
    if (fRsiMax > 0) parts.push(`rsiMax=${fRsiMax}`);
    return `${BP}/genres/${slug}?${parts.join("&")}`;
  };
  let pag = "";
  if (totalPages > 1) {
    pag = `<div class="pagination">`;
    if (safePage > 1) pag += `<a href="${qs(safePage - 1)}">← 前</a>`;
    pag += `<span>${safePage} / ${totalPages}</span>`;
    if (safePage < totalPages) pag += `<a href="${qs(safePage + 1)}">次 →</a>`;
    pag += `</div>`;
  }

  const monthOpts = Array.from({ length: 12 }, (_, i) =>
    `<option value="${i + 1}"${fMonth === i + 1 ? " selected" : ""}>${i + 1}月</option>`).join("");
  const numVal = (v: number) => (v > 0 ? String(v) : "");
  const listBody = cards || `<div class="empty-list">${activeFilters > 0 ? "絞り込み条件に合う銘柄がありません。条件をゆるめてください。" : "該当する銘柄がありません"}</div>`;

  // ジャンル一覧にもスクリーニングと同じ絞り込み条件を併設 (右上の絞り込みトグル
  // + FILTER ドロワー)。フォーム GET 方式でサーバ側適用するため、SSR ページネーション
  // と件数表示を絞り込み後の値で保ちつつ JS 非依存で動く (トグル開閉のみ JS)。
  return c.html(layout(genre.name, `
    <div class="container">
      <a href="${BP}/" class="back">← ホーム</a>
      <form id="genre-filter" method="get" action="${BP}/genres/${slug}">
        <div class="list-header">
          <h2>${h(genre.name)} <span class="list-count">(${matchedCount}銘柄${activeFilters > 0 ? " · 絞り込み中" : ""})</span></h2>
          <div class="toolbar">
            <select name="sort" class="list-sort" onchange="this.form.submit()">${sortOptions(`${gSort}-${gOrder}`)}</select>
            <button type="button" class="filter-toggle${activeFilters > 0 ? " has-filter" : ""}" id="filter-toggle">${activeFilters > 0 ? `絞り込み(${activeFilters})` : "絞り込み"}</button>
          </div>
        </div>
        <div class="filter-drawer${activeFilters > 0 ? " open" : ""}" id="filter-drawer">
          <div class="filter-row">
            <div class="filter-group">
              <label>${tip("recordmonth", "権利月")}</label>
              <select name="month"><option value="">すべて</option>${monthOpts}</select>
            </div>
            <div class="filter-group">
              <label>${tip("dividend", "配当利回り")} 最低%</label>
              <input name="yieldMin" type="number" step="0.1" min="0" inputmode="decimal" placeholder="3.0" value="${numVal(fYieldMin)}">
            </div>
          </div>
          <div class="filter-row">
            <div class="filter-group">
              <label>${tip("pbr", "PBR")} 上限</label>
              <input name="pbrMax" type="number" step="0.1" min="0" inputmode="decimal" placeholder="1.0" value="${numVal(fPbrMax)}">
            </div>
            <div class="filter-group">
              <label>${tip("per", "PER")} 上限</label>
              <input name="perMax" type="number" min="0" inputmode="numeric" placeholder="15" value="${numVal(fPerMax)}">
            </div>
          </div>
          <div class="filter-row">
            <div class="filter-group">
              <label>${tip("rsi", "RSI")} 上限</label>
              <input name="rsiMax" type="number" min="0" max="100" inputmode="numeric" placeholder="30" value="${numVal(fRsiMax)}">
            </div>
            <div class="filter-group"></div>
          </div>
          <div class="filter-actions">
            <a class="btn-reset" href="${BP}/genres/${slug}">リセット</a>
            <button type="submit" class="btn-search">検索</button>
          </div>
        </div>
        ${listBody}${pag}
      </form>
      <script>
        (function(){var t=document.getElementById('filter-toggle'),d=document.getElementById('filter-drawer');if(t&&d){t.addEventListener('click',function(){d.classList.toggle('open')})}})();
      </script>
    </div>
  `));
});

// GET /screening — スワイプスクリーニング
app.get("/screening", async (c) => {
  const db = c.get("db");
  const genres = await db.select({ name: yutaiGenres.name, slug: yutaiGenres.slug }).from(yutaiGenres).orderBy(yutaiGenres.name);

  // スコアが存在する銘柄を優先的に取得（NULLS LAST）
  const rows = await db.select({
    id: stocks.id, code: stocks.code, name: stocks.name,
    price: stockFinancials.price, per: stockFinancials.per, pbr: stockFinancials.pbr,
    dividendYield: stockFinancials.dividendYield, yutaiYield: stockFinancials.yutaiYield,
    rsi14: stockFinancials.rsi14,
    fundamentalScore: stockScores.fundamentalScore, technicalScore: stockScores.technicalScore,
    totalScore: stockScores.totalScore,
  }).from(stocks)
    .leftJoin(stockScores, eq(stockScores.stockId, stocks.id))
    .leftJoin(stockFinancials, eq(stockFinancials.stockId, stocks.id))
    .where(and(eq(stocks.isActive, true), eq(stocks.isYutai, true)))
    .orderBy(sql`${stockScores.totalScore} DESC NULLS LAST`)
    .limit(150);

  // 重複除去
  const initSeen = new Set<number>();
  const initUnique = rows.filter(r => { if (initSeen.has(r.id)) return false; initSeen.add(r.id); return true; }).slice(0, 50);

  const stockIds = initUnique.map(r => r.id);
  const benefits = stockIds.length > 0
    ? await db.select({ stockId: yutaiBenefits.stockId, description: yutaiBenefits.description, recordMonth: yutaiBenefits.recordMonth, genreId: yutaiBenefits.genreId })
        .from(yutaiBenefits).where(inArray(yutaiBenefits.stockId, stockIds))
    : [];
  const allGenres = await db.select({ id: yutaiGenres.id, name: yutaiGenres.name }).from(yutaiGenres);
  const genreMap = new Map(allGenres.map(g => [g.id, g.name]));

  const stocksData = initUnique.map(row => {
    const rowBenefits = benefits.filter(b => b.stockId === row.id);
    const months = [...new Set(rowBenefits.map(b => b.recordMonth))].sort((a, b) => a - b);
    const descs = [...new Set(rowBenefits.map(b => b.description))].join(" / ");
    const genreNames = [...new Set(rowBenefits.map(b => genreMap.get(b.genreId)).filter(Boolean))];
    return {
      code: row.code, name: row.name,
      price: row.price, per: row.per, pbr: row.pbr, dividendYield: row.dividendYield,
      yutaiYield: row.yutaiYield, rsi14: row.rsi14,
      fundamentalScore: row.fundamentalScore, technicalScore: row.technicalScore, totalScore: row.totalScore,
      benefitMonths: months, benefitSummary: descs, genres: genreNames,
    };
  });

  const genreOptions = genres.map(g => `<option value="${g.slug}">${g.name}</option>`).join("");
  const monthOptions = Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}">${i + 1}月</option>`).join("");

  // 注意: screeningJS はサーバ側 template literal。\${tip(...)} の出力 (HTML) を
  // クライアント JS の **シングルクォート文字列内** に埋め込むため、TIPS の
  // 文言にシングルクォート / バックスラッシュ / "</script" を含めないこと
  // (含めると生成 JS が構文破壊される。現行の文言は全て日本語句読点のみで安全)。
  const screeningJS = `
<script>
(function(){
  var stocks = ${JSON.stringify(stocksData).replace(/<\//g, "<\\/")};
  var listView = document.getElementById('list-view');
  var sortSelect = document.getElementById('sort-select');
  var filterToggle = document.getElementById('filter-toggle');
  var filterDrawer = document.getElementById('filter-drawer');

  filterToggle.addEventListener('click', function() {
    filterDrawer.classList.toggle('open');
  });

  function fmtMetric(v) { return v != null ? v.toFixed(2) : '-'; }

  function scoreCls(v) {
    if (v === null) return 'score-none';
    return v >= 80 ? 'score-green' : v >= 60 ? 'score-yellow' : v >= 40 ? 'score-orange' : 'score-red';
  }

  function renderListView() {
    var html = '';
    for (var i = 0; i < stocks.length; i++) {
      var s = stocks[i];
      var months = s.benefitMonths.length > 0 ? s.benefitMonths.map(function(m){return '<span class="tag">'+m+'月</span>'}).join('') : '';
      var genres = s.genres && s.genres.length > 0 ? s.genres.map(function(g){return '<span class="genre-tag">'+g+'</span>'}).join('') : '';
      html += '<a href="${BP}/stocks/' + s.code + '?from=screening" style="text-decoration:none;color:inherit"><div class="stock-card">' +
        '<div class="stock-header"><div class="stock-id"><span class="stock-code">' + s.code + '</span><span class="stock-name">' + s.name + '</span></div><div>' + months + '</div></div>' +
        (genres ? '<div style="margin-bottom:8px">' + genres + '</div>' : '') +
        '<div class="scores">' +
          '<span class="score-badge ' + scoreCls(s.totalScore) + '">' + (s.totalScore != null ? s.totalScore.toFixed(1) : '-') + ' 総合</span>' +
          '<span class="score-badge ' + scoreCls(s.fundamentalScore) + '">' + (s.fundamentalScore != null ? s.fundamentalScore.toFixed(1) : '-') + ' ファンダ</span>' +
          '<span class="score-badge ' + scoreCls(s.technicalScore) + '">' + (s.technicalScore != null ? s.technicalScore.toFixed(1) : '-') + ' テクニカル</span>' +
        '</div>' +
        '<div class="metrics">' +
          '<span>${tip("per", "PER")} <strong>' + fmtMetric(s.per) + '</strong></span>' +
          '<span>${tip("pbr", "PBR")} <strong>' + fmtMetric(s.pbr) + '</strong></span>' +
          '<span>${tip("dividend", "配当")} <strong>' + (s.dividendYield != null ? s.dividendYield.toFixed(2) + '%' : '-') + '</strong></span>' +
          '<span>${tip("yutai_yield", "優待")} <strong>' + (s.yutaiYield != null ? s.yutaiYield.toFixed(2) + '%' : '-') + '</strong></span>' +
        '</div>' +
        (s.benefitSummary ? '<div class="benefit">' + s.benefitSummary.substring(0, 80) + '</div>' : '') +
      '</div></a>';
    }
    listView.innerHTML = html || '<div class="empty-list">該当する銘柄がありません</div>';
  }

  function updateFilterBadge() {
    var count = 0;
    if (document.getElementById('filter-month').value) count++;
    if (document.getElementById('filter-genre').value) count++;
    if (document.getElementById('filter-pbr').value) count++;
    if (document.getElementById('filter-rsi').value) count++;
    if (document.getElementById('filter-per').value) count++;
    if (document.getElementById('filter-yield').value) count++;
    filterToggle.textContent = count > 0 ? '絞り込み(' + count + ')' : '絞り込み';
    filterToggle.classList.toggle('has-filter', count > 0);
  }

  document.getElementById('filter-reset').addEventListener('click', function() {
    document.getElementById('filter-month').value = '';
    document.getElementById('filter-genre').value = '';
    document.getElementById('filter-pbr').value = '';
    document.getElementById('filter-rsi').value = '';
    document.getElementById('filter-per').value = '';
    document.getElementById('filter-yield').value = '';
    updateFilterBadge();
    doSearch();
  });

  function doSearch() {
    var month = document.getElementById('filter-month').value;
    var genre = document.getElementById('filter-genre').value;
    var pbrMax = document.getElementById('filter-pbr').value;
    var rsiMax = document.getElementById('filter-rsi').value;
    var perMax = document.getElementById('filter-per').value;
    var yieldMin = document.getElementById('filter-yield').value;
    var sv = sortSelect.value.split('-');
    var params = [];
    if (month) params.push('month=' + month);
    if (genre) params.push('genre=' + genre);
    if (pbrMax) params.push('pbrMax=' + pbrMax);
    if (rsiMax) params.push('rsiMax=' + rsiMax);
    if (perMax) params.push('perMax=' + perMax);
    if (yieldMin) params.push('yieldMin=' + yieldMin);
    if (sv[0] !== 'total') params.push('sort=' + sv[0]);
    if (sv[1] === 'asc') params.push('order=asc');
    var url = '${BP}/api/screening' + (params.length ? '?' + params.join('&') : '');
    fetch(url).then(function(r){return r.json()}).then(function(data) {
      stocks = data;
      renderListView();
    });
    updateFilterBadge();
  }

  sortSelect.addEventListener('change', doSearch);
  document.getElementById('screening-search').addEventListener('click', doSearch);

  renderListView();
})();
</script>`;

  return c.html(layout("スクリーニング", `
    <div class="container">
      <div class="list-header">
        <h2>スクリーニング</h2>
        <div class="toolbar">
          <select id="sort-select" class="list-sort">${sortOptions()}</select>
          <button class="filter-toggle" id="filter-toggle">絞り込み</button>
        </div>
      </div>
      <div class="filter-drawer" id="filter-drawer">
        <div class="filter-row">
          <div class="filter-group">
            <label>${tip("recordmonth", "権利月")}</label>
            <select id="filter-month"><option value="">すべて</option>${monthOptions}</select>
          </div>
          <div class="filter-group">
            <label>ジャンル</label>
            <select id="filter-genre"><option value="">すべて</option>${genreOptions}</select>
          </div>
        </div>
        <div class="filter-row">
          <div class="filter-group">
            <label>${tip("pbr", "PBR")} 上限</label>
            <input id="filter-pbr" type="number" step="0.1" placeholder="1.0" min="0" inputmode="decimal">
          </div>
          <div class="filter-group">
            <label>${tip("rsi", "RSI")} 上限</label>
            <input id="filter-rsi" type="number" placeholder="30" min="0" max="100" inputmode="numeric">
          </div>
        </div>
        <div class="filter-row">
          <div class="filter-group">
            <label>${tip("per", "PER")} 上限</label>
            <input id="filter-per" type="number" placeholder="15" min="0" inputmode="numeric">
          </div>
          <div class="filter-group">
            <label>${tip("dividend", "配当利回り")} 最低%</label>
            <input id="filter-yield" type="number" step="0.1" placeholder="3.0" min="0" inputmode="decimal">
          </div>
        </div>
        <div class="filter-actions">
          <button class="btn-reset" id="filter-reset">リセット</button>
          <button class="btn-search" id="screening-search">検索</button>
        </div>
      </div>
      <div id="list-view"></div>
    </div>
    ${screeningJS}
  `, "screening"));
});

// GET /stocks/:code — 銘柄詳細
app.get("/stocks/:code", async (c) => {
  // 数字 4 桁 + JPX 英数字コード (例: 130A) を受理して正準形に正規化 (共有ヘルパ)
  const code = parseStockCode(c.req.param("code"));
  if (code === null) return c.html(layout("Not Found", `<div class="container"><h2>不正な銘柄コード</h2></div>`), 400);
  const db = c.get("db");

  // otakara は優待サービス。母集団 ~4,000 のうち is_yutai=true のみ詳細表示する
  const stockData = await db.query.stocks.findFirst({
    where: and(eq(stocks.code, code), eq(stocks.isYutai, true)),
    with: {
      benefits: { with: { genre: true } },
      financials: { orderBy: (f: any, { desc: d }: any) => [d(f.fetchedAt)], limit: 1 },
      scores: { orderBy: (s: any, { desc: d }: any) => [d(s.scoredAt)], limit: 1 },
    },
  });

  if (!stockData) return c.html(layout("Not Found", `<div class="container"><h2>銘柄が見つかりません</h2><a href="${BP}/" class="back">← ホーム</a></div>`), 404);

  const fin = stockData.financials[0] ?? null;
  const score = stockData.scores[0] ?? null;
  const genreSlugs = [...new Set(stockData.benefits.map((b: any) => b.genre?.slug).filter(Boolean))];
  const fromScreening = c.req.query("from") === "screening";

  return c.html(layout(`${stockData.name} (${code})`, `
    <div class="container">
      ${fromScreening
        ? `<a href="${BP}/screening" class="back">← スクリーニングに戻る</a>`
        : `<a href="${BP}/" class="back">← ホーム</a>${genreSlugs.length > 0 ? genreSlugs.map(s => `<a href="${BP}/genres/${s}" class="back">← ジャンルに戻る</a>`).join("") : ""}`
      }
      <h2>${h(stockData.name)} <span style="color:#666">${h(code)}</span></h2>
      <p style="color:#888">${h(stockData.market)}${stockData.sector ? " / " + h(stockData.sector) : ""}</p>

      <div class="detail-scores">
        <div class="detail-score"><div class="val" style="color:${score?.totalScore != null ? (score.totalScore >= 60 ? "var(--score-high)" : "var(--score-mid)") : "var(--text-muted)"}">${score?.totalScore?.toFixed(1) ?? "-"}</div><div class="lbl">${tip("total", "総合スコア")}</div></div>
        <div class="detail-score"><div class="val" style="color:var(--accent)">${score?.fundamentalScore?.toFixed(1) ?? "-"}</div><div class="lbl">${tip("fundamental", "ファンダメンタルズ")}</div></div>
        <div class="detail-score"><div class="val" style="color:var(--text)">${score?.technicalScore?.toFixed(1) ?? "-"}</div><div class="lbl">${tip("technical", "テクニカル")}</div></div>
      </div>
      <div class="guide" style="text-align:center">
        スコア80以上＝かなり割安 / 60以上＝やや割安 / 40以上＝普通 / 40未満＝割高気味
      </div>

      <h3 style="margin-top:24px">財務指標</h3>
      <div class="guide">企業の実力を数字で見るエリアです。用語をタップすると説明が表示されます。</div>
      ${renderFinGrid(fin)}

      <h3 style="margin-top:24px">${tip("yutai", "株主優待")}</h3>
      <div class="guide">${tip("recordmonth", "権利確定月")}の月末に株を保有していると優待がもらえます。${tip("minshares", "最低株数")}以上の保有が必要です。</div>
      ${renderBenefitGroups(groupBenefits(
        stockData.benefits.map((b: any) => ({
          genre: b.genre ? { name: b.genre.name, slug: b.genre.slug } : null,
          minShares: b.minShares,
          recordMonth: b.recordMonth,
          description: b.description,
          estimatedValue: b.estimatedValue,
        }))
      ))}
    </div>
  `));
});

export const otakaraYutaiApp = app;
export default app;
