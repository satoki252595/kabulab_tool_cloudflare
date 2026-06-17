/**
 * 005 yuho-quant 共通レイアウト — Editorial Swiss Grid。
 *
 * 共通デザイントークンは単一 source of truth である src/shared/design.ts から
 * 取り込み (docs/new-project-template.md §10)、サービス固有スタイルだけを
 * ここに連結する。Vercel が .tsx を bundle しないため template literal で返す。
 */
import { DESIGN_TOKENS, BASE_RESET, FONT_LINKS } from "../../../../src/shared/design.js";
import { BASE_PATH } from "../../base-path.js";

/** HTML エスケープ (XSS 対策) */
export function h(s: string | number | null | undefined): string {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const SERVICE_STYLES = `
.container{max-width:1100px;margin:0 auto;padding:24px 16px}
@media(min-width:768px){.container{padding:32px 24px}}
.top-header{background:var(--bg);border-bottom:2px solid var(--border);position:sticky;top:0;z-index:10}
.top-header .inner{max-width:1100px;margin:0 auto;padding:0 16px;display:flex;align-items:center;justify-content:space-between;height:72px;gap:16px}
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
.bottom-nav a{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;padding:10px 0;min-height:62px;color:var(--text);font-family:var(--font-display);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;border-right:1px solid var(--border-soft)}
.bottom-nav a:last-child{border-right:none}
.bottom-nav a.active{background:var(--bg-invert);color:var(--text-invert)}
@media(max-width:768px){.desktop-nav{display:none}.bottom-nav{display:flex}body{padding-bottom:80px}.top-header .inner{height:64px}}
.hero{padding:48px 16px 36px;background:var(--bg);border-bottom:2px solid var(--border);position:relative;overflow:hidden}
.hero::before{content:'';position:absolute;top:0;left:0;right:0;height:1px;background:repeating-linear-gradient(90deg,var(--border) 0 8px,transparent 8px 16px);opacity:0.2}
.hero .inner{max-width:1100px;margin:0 auto;padding:0 16px}
.hero .label{font-family:var(--font-mono);font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:var(--text-muted);margin-bottom:24px;display:flex;align-items:center;gap:12px}
.hero .label::before{content:'';flex:0 0 32px;height:2px;background:var(--text)}
.hero h1{font-family:var(--font-display);font-size:clamp(32px,6vw,56px);font-weight:700;line-height:1.02;letter-spacing:-0.04em;margin-bottom:20px}
.hero .lead{font-size:17px;color:var(--text-secondary);max-width:620px;line-height:1.7}
.section-label{font-family:var(--font-mono);font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:var(--text-muted);margin:36px 0 8px;display:flex;align-items:center;gap:12px}
.section-label::before{content:'';flex:0 0 24px;height:2px;background:var(--text)}
h2{font-family:var(--font-display);font-size:26px;font-weight:700;letter-spacing:-0.02em;margin-bottom:8px}
h3{font-family:var(--font-display);font-size:18px;font-weight:700;letter-spacing:-0.01em}
.search-form{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;padding:20px;background:var(--bg-pure);border:2px solid var(--border);border-radius:var(--radius);position:relative;margin-top:24px}
.search-form::before{content:'SEARCH';position:absolute;top:-10px;left:16px;background:var(--bg-invert);color:var(--text-invert);font-family:var(--font-mono);font-size:10px;font-weight:700;padding:3px 10px;letter-spacing:0.12em;border-radius:var(--radius)}
.search-form label{font-family:var(--font-mono);font-size:11px;color:var(--text-muted);font-weight:600;text-transform:uppercase;letter-spacing:0.06em;display:block;margin-bottom:6px}
.search-form input{background:var(--bg);border:2px solid var(--border);color:var(--text);padding:0 14px;border-radius:var(--radius);font-family:var(--font-mono);font-size:15px;min-height:var(--tap);width:100%}
.search-form .grow{flex:1;min-width:240px}
button{background:var(--bg-invert);color:var(--text-invert);border:2px solid var(--border);padding:0 26px;border-radius:var(--radius);font-family:var(--font-display);font-size:14px;font-weight:700;cursor:pointer;min-height:var(--tap);text-transform:uppercase;letter-spacing:0.04em;transition:transform .15s,box-shadow .15s}
button:hover{transform:translate(-2px,-2px);box-shadow:3px 3px 0 0 var(--border)}
.examples{margin:14px 0 0;display:flex;flex-wrap:wrap;gap:8px;font-family:var(--font-mono);font-size:11px;color:var(--text-muted);align-items:center}
.examples a{padding:5px 10px;border:1.5px solid var(--border-soft);border-radius:var(--radius);color:var(--text);background:var(--bg-pure)}
.examples a:hover{border-color:var(--border);text-decoration:none;transform:translate(-2px,-2px);box-shadow:3px 3px 0 0 var(--border)}
.results{list-style:none;margin:16px 0;display:grid;grid-template-columns:1fr;gap:12px}
@media(min-width:768px){.results{grid-template-columns:1fr 1fr}}
.results a{display:block;background:var(--bg-pure);border:2px solid var(--border);border-radius:var(--radius);padding:16px 18px;transition:transform .15s,box-shadow .15s}
.results a:hover{transform:translate(-3px,-3px);box-shadow:5px 5px 0 0 var(--border);text-decoration:none}
.results .code{font-family:var(--font-mono);font-weight:700;font-size:13px;color:var(--text-muted);letter-spacing:0.06em}
.results .nm{font-family:var(--font-display);font-size:18px;font-weight:700;margin:4px 0}
.results .meta{font-family:var(--font-mono);font-size:11px;color:var(--text-muted)}
.detail-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:12px;margin-bottom:8px}
.detail-head .code{font-family:var(--font-mono);font-weight:700;color:var(--text-muted)}
.pill{display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border-radius:var(--radius);font-family:var(--font-mono);font-size:11px;font-weight:600;background:var(--bg-pure);color:var(--text);border:1.5px solid var(--border);text-transform:uppercase;letter-spacing:0.06em}
.chart-wrap{background:var(--bg-pure);border:2px solid var(--border);border-radius:var(--radius);padding:20px;margin:16px 0;overflow-x:auto}
.chart-legend{display:flex;gap:20px;flex-wrap:wrap;font-family:var(--font-mono);font-size:11px;color:var(--text-secondary);margin-bottom:8px;text-transform:uppercase;letter-spacing:0.06em}
.chart-legend span{display:inline-flex;align-items:center;gap:6px}
.chart-legend i{width:14px;height:14px;display:inline-block;border:1.5px solid var(--border)}
.chart-legend i.sw-orders{background:var(--bg-invert)}
.chart-legend i.sw-backlog{background:var(--bg-pure);background-image:repeating-linear-gradient(45deg,var(--border) 0 2px,transparent 2px 6px)}
.table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
.latest-stat{display:flex;flex-wrap:wrap;gap:14px;margin:16px 0;padding:16px 18px;background:var(--bg-pure);border:2px solid var(--border);border-radius:var(--radius)}
.latest-stat>div{display:flex;flex-direction:column;gap:4px;padding-right:18px;border-right:1px solid var(--border-soft)}
.latest-stat>div:last-child{border-right:none}
.latest-stat .lbl{font-family:var(--font-mono);font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.08em}
.latest-stat .val{font-family:var(--font-mono);font-size:24px;font-weight:700;font-variant-numeric:tabular-nums}
.latest-stat .val small{font-size:12px;font-weight:400;color:var(--text-muted)}
table{width:100%;border-collapse:collapse;margin:16px 0;background:var(--bg-pure);font-size:13px;border:2px solid var(--border);border-radius:var(--radius);overflow:hidden}
th{background:var(--bg-soft);color:var(--text-muted);padding:11px 10px;text-align:left;font-family:var(--font-mono);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:0.06em;border-bottom:2px solid var(--border)}
td{padding:11px 10px;border-bottom:1px solid var(--border-soft);color:var(--text);font-family:var(--font-mono);font-variant-numeric:tabular-nums}
tbody tr:last-child td{border-bottom:none}
tbody tr:hover td{background:var(--bg-soft)}
.num{text-align:right;font-variant-numeric:tabular-nums}
.muted{color:var(--text-muted)}
tr.total td{font-weight:700;background:var(--bg-soft)}
.notice{border:2px dashed var(--border-soft);border-radius:var(--radius);padding:32px 20px;text-align:center;color:var(--text-secondary);font-size:15px;line-height:1.8;margin:20px 0}
.notice strong{font-family:var(--font-display)}
.notice .st{display:inline-block;margin-top:10px;font-family:var(--font-mono);font-size:11px;color:var(--text-muted);letter-spacing:0.08em}
.footer{margin-top:56px;padding:28px 16px;border-top:2px solid var(--border);background:var(--bg)}
.footer .inner{max-width:1100px;margin:0 auto;padding:0 16px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px;font-family:var(--font-mono);font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em}
.disclaimer{font-family:var(--font-mono);font-size:11px;color:var(--text-muted);line-height:1.7;margin-top:16px}
`;

const NAV_ICON_HOME = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 11l9-8 9 8M5 10v10h14V10"/></svg>`;
const NAV_ICON_SEARCH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/></svg>`;
const NAV_ICON_SCREEN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 5h18M6 12h12M10 19h4"/></svg>`;
const NAV_ICON_PORTAL = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M4 12h16M4 18h16"/></svg>`;

export function layout(
  title: string,
  body: string,
  active: "home" | "search" | "detail" | "screening"
): string {
  return `<!DOCTYPE html><html lang="ja"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0,viewport-fit=cover">
<title>${h(title)} | kabulab 有報定量検索</title>
<meta name="description" content="EDINET の有価証券報告書から受注高・受注残高をセグメント別に構造化し、最大5年の推移を可視化する定量情報検索ツール。">
<meta name="theme-color" content="#fafafa">
${FONT_LINKS}
<style>${DESIGN_TOKENS}\n${BASE_RESET}\n${SERVICE_STYLES}</style>
</head><body>
<header class="top-header"><div class="inner">
  <a href="${BASE_PATH}/" class="brand"><span class="mark"></span><span class="name"><span class="ja">有報定量検索</span><span class="en">005 / KABULAB</span></span></a>
  <nav class="desktop-nav">
    <a href="/" class="portal-back">← KABULAB</a>
    <a href="${BASE_PATH}/">HOME</a>
    <a href="${BASE_PATH}/?focus=1">SEARCH</a>
    <a href="${BASE_PATH}/screening">SCREENING</a>
  </nav>
</div></header>
${body}
<footer class="footer"><div class="inner">
  <div>© ${new Date().getFullYear()} kabulab — 有報定量検索</div>
  <div>Source: 金融庁 EDINET</div>
</div></footer>
<nav class="bottom-nav">
  <a href="${BASE_PATH}/" class="${active === "home" ? "active" : ""}">${NAV_ICON_HOME}HOME</a>
  <a href="${BASE_PATH}/?focus=1" class="${active === "search" ? "active" : ""}">${NAV_ICON_SEARCH}SEARCH</a>
  <a href="${BASE_PATH}/screening" class="${active === "screening" ? "active" : ""}">${NAV_ICON_SCREEN}SCREEN</a>
  <a href="/">${NAV_ICON_PORTAL}PORTAL</a>
</nav>
</body></html>`;
}
