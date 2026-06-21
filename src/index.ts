import { Hono } from "hono";
import {
  otakaraYutaiApp,
  BASE_PATH as OTAKARA_BASE_PATH,
} from "../services/otakara-yutai/app.js";
import {
  rsiScreeningApp,
  BASE_PATH as RSI_BASE_PATH,
} from "../services/rsi-screening/app.js";
import {
  swingTradingApp,
  BASE_PATH as SWING_BASE_PATH,
} from "../services/swing-trading/app.js";
import {
  financialMathApp,
  BASE_PATH as FM_BASE_PATH,
} from "../services/financial-math/app.js";
import {
  yuhoQuantApp,
  BASE_PATH as YQ_BASE_PATH,
} from "../services/yuho-quant/app.js";
import {
  irCatalogApp,
  BASE_PATH as IRC_BASE_PATH,
} from "../services/ir-catalog/app.js";
import vwapAnalysisApp, {
  BASE_PATH as VWAP_BASE_PATH,
} from "../services/vwap-analysis/app.js";
import { ingestProxyRoute } from "./routes/ingest-proxy.js";
import { DESIGN_TOKENS, BASE_RESET, FONT_LINKS } from "./shared/design.js";

/**
 * kabulab — 日本株投資ツールの統合ポータル
 *
 * ルート (`/`) はポータルのホーム画面。配下に各サービスが
 * Hono サブアプリとしてマウントされる。
 *
 *   /                     → ポータル (このファイル)
 *   /otakara-yutai/*      → 002 お宝優待 (services/otakara-yutai/app.ts)
 *   /rsi-screening/*      → 001 RSI Screening (services/rsi-screening/app.ts)
 *
 * 新サービスを追加する手順は docs/new-project-template.md を参照。
 */

function h(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** ポータル固有の追加スタイル — base reset 後に連結する */
const PORTAL_STYLES = `
/* === Top header === */
.top-header{background:var(--bg);border-bottom:2px solid var(--border);position:sticky;top:0;z-index:10}
.top-header .inner{max-width:1080px;margin:0 auto;padding:0 16px;display:flex;align-items:center;justify-content:space-between;height:72px;gap:16px}
.brand{display:flex;align-items:center;gap:12px;text-decoration:none}
.brand .mark{width:32px;height:32px;background:var(--bg-invert);display:flex;align-items:center;justify-content:center;flex-shrink:0}
.brand .mark::after{content:'';width:14px;height:14px;background:var(--bg)}
.brand .name{display:flex;flex-direction:column;line-height:1}
.brand .ja{font-family:var(--font-display);font-size:20px;font-weight:700;color:var(--text);letter-spacing:-0.02em}
.brand .en{font-family:var(--font-mono);font-size:9px;color:var(--text-muted);letter-spacing:0.18em;text-transform:uppercase;margin-top:4px}
.header-meta{font-family:var(--font-mono);font-size:11px;color:var(--text-muted);letter-spacing:0.12em;text-transform:uppercase}
@media(max-width:480px){.header-meta{display:none}.top-header .inner{height:64px}}

/* === Hero === */
.hero{padding:56px 16px 40px;background:var(--bg);border-bottom:2px solid var(--border);position:relative;overflow:hidden}
.hero::before{content:'';position:absolute;top:0;left:0;right:0;height:1px;background:repeating-linear-gradient(90deg,var(--border) 0 8px,transparent 8px 16px);opacity:0.2}
.hero .inner{max-width:1080px;margin:0 auto;padding:0 16px;position:relative}
.hero .label{font-family:var(--font-mono);font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:var(--text-muted);margin-bottom:24px;display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap}
.hero .label::before{content:'';flex:0 0 32px;height:2px;background:var(--text)}
.hero .label-text{flex:1}
.hero h2{font-family:var(--font-display);font-size:clamp(38px,8vw,82px);font-weight:700;line-height:0.95;letter-spacing:-0.04em;color:var(--text);margin-bottom:24px}
.hero .lead{font-size:17px;color:var(--text-secondary);max-width:600px;line-height:1.7}
.hero .stats{display:flex;gap:32px;margin-top:32px;padding-top:24px;border-top:2px solid var(--border);flex-wrap:wrap}
.hero .stat{display:flex;flex-direction:column}
.hero .stat .num{font-family:var(--font-mono);font-size:28px;font-weight:700;color:var(--text);line-height:1;font-variant-numeric:tabular-nums}
.hero .stat .lbl{font-family:var(--font-mono);font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:var(--text-muted);margin-top:6px}
@media(min-width:768px){.hero{padding:80px 24px 60px}}

/* === Section === */
.section-label{font-family:var(--font-mono);font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:var(--text-muted);margin-bottom:8px;display:flex;align-items:center;gap:12px}
.section-label::before{content:'';flex:0 0 24px;height:2px;background:var(--text)}
h2{font-family:var(--font-display);font-size:32px;font-weight:700;color:var(--text);line-height:1.2;letter-spacing:-0.02em;margin:0 0 24px}
@media(min-width:768px){h2{font-size:40px}}

/* === Service grid === */
.service-grid{display:grid;grid-template-columns:1fr;gap:18px;margin-top:24px}
@media(min-width:768px){.service-grid{grid-template-columns:1fr 1fr;gap:20px}}

.service-card{background:var(--bg-pure);border:2px solid var(--border);border-radius:var(--radius);padding:0;display:flex;flex-direction:column;color:var(--text);text-decoration:none;transition:transform .15s ease-out,box-shadow .15s ease-out;position:relative;overflow:hidden}
.service-card:hover{transform:translate(-4px,-4px);box-shadow:6px 6px 0 0 var(--border);text-decoration:none}
.service-card.coming-soon{cursor:not-allowed;opacity:0.55}
.service-card.coming-soon:hover{transform:none;box-shadow:none}

.service-card .head{display:flex;justify-content:space-between;align-items:flex-start;padding:20px 22px 16px;border-bottom:2px solid var(--border);gap:16px}
.service-card .num{font-family:var(--font-mono);font-size:12px;font-weight:700;color:var(--text-muted);letter-spacing:0.1em}
.service-card .status{font-family:var(--font-mono);font-size:10px;font-weight:700;padding:4px 10px;border-radius:var(--radius);letter-spacing:0.1em;text-transform:uppercase;border:1.5px solid;display:inline-flex;align-items:center;gap:6px;flex-shrink:0}
.service-card .status::before{content:'';width:6px;height:6px;background:currentColor;border-radius:50%}
.service-card .status.live{color:var(--status-live);background:var(--status-live-soft);border-color:var(--status-live)}
.service-card .status.soon{color:var(--status-soon);background:var(--status-soon-soft);border-color:var(--status-soon)}

.service-card .body{padding:24px 22px 22px;flex:1;display:flex;flex-direction:column}
.service-card h3{font-family:var(--font-display);font-size:28px;font-weight:700;color:var(--text);letter-spacing:-0.02em;line-height:1.15;margin-bottom:6px}
.service-card .subtitle{font-family:var(--font-mono);font-size:11px;color:var(--text-muted);letter-spacing:0.08em;text-transform:uppercase;margin-bottom:18px}
.service-card .desc{font-size:15px;color:var(--text-secondary);line-height:1.7;margin-bottom:24px;flex:1}

.service-card .features{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:24px}
.service-card .feature{font-family:var(--font-mono);font-size:10px;font-weight:600;padding:4px 10px;background:var(--bg-soft);border:1.5px solid var(--border-soft);color:var(--text);border-radius:var(--radius);letter-spacing:0.04em;text-transform:uppercase}

.service-card .cta{display:inline-flex;align-items:center;justify-content:space-between;padding:14px 18px;background:var(--bg-invert);color:var(--text-invert);font-family:var(--font-display);font-size:14px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;border-radius:var(--radius);border:2px solid var(--border);min-height:var(--tap);gap:12px}
.service-card .cta .arrow{font-family:var(--font-mono);font-size:18px;font-weight:400;line-height:1}
.service-card.coming-soon .cta{background:var(--bg-soft);color:var(--text-muted);border-color:var(--border-soft)}

/* === About box === */
.about{background:var(--bg-pure);border:2px solid var(--border);border-radius:var(--radius);padding:24px;margin:32px 0;font-size:15px;color:var(--text);line-height:1.8;position:relative}
.about::before{content:'ABOUT';position:absolute;top:-10px;left:16px;background:var(--bg-invert);color:var(--text-invert);font-family:var(--font-mono);font-size:10px;font-weight:700;padding:3px 10px;letter-spacing:0.12em;border-radius:var(--radius)}
.about strong{color:var(--text);font-weight:700;font-family:var(--font-display)}
.about p+p{margin-top:14px}

/* === Footer === */
.footer{margin-top:64px;padding:32px 16px;border-top:2px solid var(--border);background:var(--bg)}
.footer .inner{max-width:1080px;margin:0 auto;padding:0 16px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:16px}
.footer .meta{font-family:var(--font-mono);font-size:11px;color:var(--text-muted);letter-spacing:0.08em;text-transform:uppercase}
.footer .links{display:flex;gap:24px;flex-wrap:wrap}
.footer .links a{font-family:var(--font-display);font-size:13px;font-weight:600;color:var(--text);text-transform:uppercase;letter-spacing:0.04em}
`;

const PORTAL_CSS = `${DESIGN_TOKENS}\n${BASE_RESET}\n${PORTAL_STYLES}`;

const HEAD = `<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0,viewport-fit=cover"><title>kabulab | 日本株投資ツール統合ポータル</title><meta name="description" content="kabulab は日本株投資を支援するツール群の統合ポータル。RSI スクリーニング、お宝優待、テクニカル分析など、データドリブンな投資判断ツールを提供します。"><meta name="theme-color" content="#fafafa"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="default">${FONT_LINKS}<style>${PORTAL_CSS}</style>`;

const HEADER = `<header class="top-header"><div class="inner"><a href="/" class="brand"><span class="mark"></span><span class="name"><span class="ja">kabulab</span><span class="en">JAPAN STOCK / TOOLKIT</span></span></a><div class="header-meta">EST. 2026</div></div></header>`;

const FOOTER = `<footer class="footer"><div class="inner"><div class="meta">© ${new Date().getFullYear()} kabulab — Japan Stock Toolkit</div><div class="links"><a href="/">Home</a><a href="${RSI_BASE_PATH}/">RSI Screening</a><a href="${OTAKARA_BASE_PATH}/">お宝優待</a></div></div></footer>`;

/** サービス一覧の型定義 */
type Service = {
  num: string;
  slug: string;
  title: string;
  subtitle: string;
  desc: string;
  features: string[];
  url: string | null;
  status: "live" | "soon";
};

const SERVICES: Service[] = [
  {
    num: "001",
    slug: "rsi-screening",
    title: "RSI Screening",
    subtitle: "底値圏の優良株を発見",
    desc:
      "過去5年間の RSI（10日 / 40日 / 120日）パーセンタイルで「今が5年で何%の底値水準か」を定量化。営業利益率と売上高の上昇トレンドで優良株のみを抽出します。",
    features: ["RSI Percentile", "Blue-Chip Filter", "5Y History"],
    url: `${RSI_BASE_PATH}/`,
    status: "soon",
  },
  {
    num: "002",
    slug: "otakara-yutai",
    title: "お宝優待",
    subtitle: "割安な株主優待を発見",
    desc:
      "全上場銘柄の株主優待を分類・スクリーニング。ファンダメンタルズ60% + テクニカル40% の独自スコアで、割安な優待銘柄を自動ランク付けします。",
    features: ["Fundamental", "Technical", "Yutai Score"],
    url: `${OTAKARA_BASE_PATH}/`,
    status: "live",
  },
  {
    num: "003",
    slug: "swing-trading",
    title: "Swing Trading",
    subtitle: "数日〜2週間の短期売買を定量化",
    desc:
      "マクロ判定 (A/B/C/D) + 5 条件スクリーニング + E&E 6 パターン判定 + 2% ルール計算機を日足ベースで自動化。毎朝の売買ルールを再現性のある型に落とす短期売買支援ツール。",
    features: ["Macro A/B/C/D", "5-Filter", "E&E Patterns", "Risk Calc"],
    url: `${SWING_BASE_PATH}/`,
    status: "soon",
  },
  {
    num: "004",
    slug: "financial-math",
    title: "金融数学",
    subtitle: "DCF / CAPM / EMH / Black-Scholes",
    desc:
      "金融数学の四大理論 (DCF Gordon・CAPM β推定・EMH アノマリースクリーニング・Black-Scholes Greeks) を東証実銘柄のデータと結合した分析ツール群。理論株価から派生商品価格まで一気通貫で算出。",
    features: ["DCF Gordon", "CAPM β-OLS", "EMH Anomaly", "BS Greeks"],
    url: `${FM_BASE_PATH}/`,
    status: "live",
  },
  {
    num: "005",
    slug: "yuho-quant",
    title: "有報定量検索",
    subtitle: "受注高・受注残高の推移を可視化",
    desc:
      "金融庁 EDINET の有価証券報告書から「受注高 / 受注残高」をセグメント別 + 全社合計で構造化。会社を検索すると最大5年の受注推移をグラフで確認できます。構造を判定できない開示は数値を作らず「未対応」と明示します。",
    features: ["EDINET", "受注高/残高", "セグメント別", "5Y Trend"],
    url: `${YQ_BASE_PATH}/`,
    status: "live",
  },
  {
    num: "006",
    slug: "ir-catalog",
    title: "IRカタログ",
    subtitle: "適時開示を意味で色分け",
    desc:
      "東証上場の個別株の適時開示(IR)を TDnet から全量取得し、増配・上方修正・自社株買い・配当政策の変更などをタグで色分け。銘柄ごとに発表タイミングを時系列でマッピングします。表題から決定論的に分類し、当てはまらない開示は「未分類」と正直に表示します。",
    features: ["TDnet 全量", "タグ色分け", "発表タイムライン", "高シグナル"],
    url: `${IRC_BASE_PATH}/`,
    status: "live",
  },
  {
    num: "007",
    slug: "vwap-analysis",
    title: "VWAP / 価格別出来高",
    subtitle: "5分足VWAP・日足10年・信用残高",
    desc:
      "全上場銘柄を4桁/英数字コードまたは銘柄名で検索し、5分足のVWAPと価格別出来高(POC/バリューエリア)、日足10年(分割・併合調整)、週次の信用残高(買残/売残/信用倍率)を多時間軸で表示。5分足は蓄積(R2)＋当日ライブ、過去日は高速表示します。",
    features: ["5分足VWAP", "価格別出来高", "日足10年", "週次信用残高"],
    url: `${VWAP_BASE_PATH}/`,
    status: "live",
  },
];

/**
 * `strict: false` を指定して `/foo` と `/foo/` を同一視する。
 * Hono の `app.route("/otakara-yutai", subapp)` は通常 `/otakara-yutai` だけを
 * sub-app の `/` に解決するため、ブラウザが追加する trailing slash で 404 になる。
 */
const app = new Hono({ strict: false });

app.get("/", (c) => {
  const liveCount = SERVICES.filter((s) => s.status === "live").length;
  const totalCount = SERVICES.length;

  const cards = SERVICES.map((s) => {
    const isLive = s.status === "live" && s.url !== null;
    const featureTags = s.features
      .map((f) => `<span class="feature">${h(f)}</span>`)
      .join("");
    const inner = `
      <div class="head">
        <span class="num">${h(s.num)} / ${h(s.slug.toUpperCase())}</span>
        <span class="status ${s.status}">${s.status === "live" ? "Live" : "Soon"}</span>
      </div>
      <div class="body">
        <h3>${h(s.title)}</h3>
        <div class="subtitle">${h(s.subtitle)}</div>
        <p class="desc">${h(s.desc)}</p>
        <div class="features">${featureTags}</div>
        <span class="cta">${isLive ? "Open Service" : "Coming Soon"}<span class="arrow">${isLive ? "↗" : "—"}</span></span>
      </div>
    `;
    if (isLive && s.url) {
      // 同一オリジン（先頭が `/`）の場合は同一タブで遷移、外部 URL は新規タブ
      const isInternal = s.url.startsWith("/");
      const targetAttr = isInternal ? "" : ` target="_blank" rel="noopener"`;
      return `<a href="${h(s.url)}"${targetAttr} class="service-card">${inner}</a>`;
    }
    return `<div class="service-card coming-soon">${inner}</div>`;
  }).join("");

  return c.html(`<!DOCTYPE html><html lang="ja"><head>${HEAD}</head><body>
${HEADER}
<div class="hero">
  <div class="inner">
    <div class="label"><span class="label-text">000 / PORTAL</span><span>${new Date().getFullYear()}</span></div>
    <h2>株を、もっと<br>賢く、面白く。</h2>
    <p class="lead">kabulab は日本株投資を支援するツール群の統合ポータルです。データドリブンなスクリーニングで、あなたの投資判断をサポートします。</p>
    <div class="stats">
      <div class="stat"><span class="num">${liveCount}</span><span class="lbl">Live Services</span></div>
      <div class="stat"><span class="num">${totalCount}</span><span class="lbl">Total Services</span></div>
    </div>
  </div>
</div>
<div class="container">
  <div class="section-label">001 / Services</div>
  <h2>提供サービス</h2>
  <div class="service-grid">${cards}</div>

  <div class="about">
    <p><strong>kabulab について</strong></p>
    <p>kabulab は日本株投資を支援するツール群の統合ブランドです。各サービスは独立して動作しますが、共通の Cloudflare D1 データベースを使い、銘柄マスタ・株価・財務データを共有しています。</p>
    <p>すべてのサービスは Hono + TypeScript + Drizzle ORM で構築され、Cloudflare Workers 上で稼働しています。</p>
  </div>
</div>
${FOOTER}
</body></html>`);
});


// === サブサービスのマウント ===
// 001 RSI Screening — /rsi-screening/* 配下
app.route(RSI_BASE_PATH, rsiScreeningApp);
// 002 お宝優待 — /otakara-yutai/* 配下
app.route(OTAKARA_BASE_PATH, otakaraYutaiApp);
// 003 Swing Trading — /swing-trading/* 配下
app.route(SWING_BASE_PATH, swingTradingApp);
// 004 金融数学 — /financial-math/* 配下
app.route(FM_BASE_PATH, financialMathApp);
// 005 有報定量検索 — /yuho-quant/* 配下
app.route(YQ_BASE_PATH, yuhoQuantApp);
// 006 IRカタログ — /ir-catalog/* 配下
app.route(IRC_BASE_PATH, irCatalogApp);
// 007 VWAP Analysis — /vwap-analysis/* 配下
app.route(VWAP_BASE_PATH, vwapAnalysisApp);

// 取込プロキシ — Node(GitHub Actions)からの Yahoo 取得をエッジ経由にする認証ルート
// (/api/ingest/yahoo, CRON_SECRET)。Workers Paid を使わない取込運用の要。
app.route("/api/ingest", ingestProxyRoute);

export default app;
