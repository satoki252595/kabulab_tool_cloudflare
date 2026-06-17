/**
 * 006 ir-catalog 共通レイアウト — Editorial Swiss Grid。
 *
 * 共通デザイントークンは単一 source of truth である src/shared/design.ts から
 * 取り込み (docs/new-project-template.md §10)、サービス固有スタイルだけを
 * ここに連結する。Vercel が .tsx を bundle しないため template literal で返す。
 * 用語バルーンは共通 term-tip (ルール7) を使う。
 */
import {
  DESIGN_TOKENS,
  BASE_RESET,
  FONT_LINKS,
} from "../../../../src/shared/design.js";
import { TERM_TIP_STYLES } from "../../../../src/shared/term-tip.js";
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
.bottom-nav svg{width:20px;height:20px}
@media(max-width:768px){.desktop-nav{display:none}.bottom-nav{display:flex}body{padding-bottom:80px}.top-header .inner{height:64px}.tl-month-h{top:64px}.tl-row{flex-direction:column;gap:6px}.tl-date{flex:none;padding-top:0}.signals .row{flex-direction:column;gap:6px}.signals .date,.signals .mark{flex:none;padding-top:0}}
.hero{padding:48px 16px 36px;background:var(--bg);border-bottom:2px solid var(--border);position:relative;overflow:hidden}
.hero::before{content:'';position:absolute;top:0;left:0;right:0;height:1px;background:repeating-linear-gradient(90deg,var(--border) 0 8px,transparent 8px 16px);opacity:0.2}
.hero .inner{max-width:1100px;margin:0 auto;padding:0 16px}
.hero .label{font-family:var(--font-mono);font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:var(--text-muted);margin-bottom:24px;display:flex;align-items:center;gap:12px}
.hero .label::before{content:'';flex:0 0 32px;height:2px;background:var(--text)}
.hero h1{font-family:var(--font-display);font-size:clamp(30px,6vw,52px);font-weight:700;line-height:1.04;letter-spacing:-0.04em;margin-bottom:18px}
.hero .lead{font-size:16px;color:var(--text-secondary);max-width:660px;line-height:1.7}
.section-label{font-family:var(--font-mono);font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:var(--text-muted);margin:36px 0 8px;display:flex;align-items:center;gap:12px}
.section-label::before{content:'';flex:0 0 24px;height:2px;background:var(--text)}
h2{font-family:var(--font-display);font-size:24px;font-weight:700;letter-spacing:-0.02em;margin-bottom:8px}
h3{font-family:var(--font-display);font-size:17px;font-weight:700;letter-spacing:-0.01em}
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
.bc-link{font-family:var(--font-mono);font-size:12px;color:var(--text-muted);border:1.5px solid var(--border-soft);border-radius:var(--radius);padding:4px 10px;display:inline-flex;align-items:center;gap:6px}
.bc-link:hover{border-color:var(--border);text-decoration:none;color:var(--text);transform:translate(-2px,-2px);box-shadow:3px 3px 0 0 var(--border)}
.legend{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0 4px}
.chip{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:var(--radius);font-family:var(--font-mono);font-size:11px;font-weight:700;border:2px solid;letter-spacing:0.02em}
.chip .dot{width:8px;height:8px;border-radius:50%;background:currentColor;flex:0 0 8px}
.chip.unclassified{border-color:var(--border-soft);color:var(--text-muted);background:var(--bg-soft)}
/* overflow:hidden は付けない (ルール7: タグの初心者バルーンが下方向に
   開くため、最終行で切れてしまう)。角丸は子要素の端で表現する。 */
.tl{margin:18px 0;border:2px solid var(--border);border-radius:var(--radius);background:var(--bg-pure)}
.tl-month{border-bottom:1px solid var(--border-soft)}
.tl-month:last-child{border-bottom:none}
.tl-month:first-child .tl-month-h{border-top-left-radius:var(--radius);border-top-right-radius:var(--radius)}
.tl-month:last-child .tl-row:last-child{border-bottom-left-radius:var(--radius);border-bottom-right-radius:var(--radius)}
.tl-month-h{font-family:var(--font-mono);font-size:12px;font-weight:700;color:var(--text-muted);background:var(--bg-soft);padding:8px 14px;letter-spacing:0.08em;border-bottom:1px solid var(--border-soft);position:sticky;top:72px;z-index:5}
/* 株主視点センチメント色。classify.ts の「上方修正/増配」緑・「下方修正」赤の
   チップ色と完全一致させ、タグチップとシグナル装飾の視覚を統一する
   (個別の hex を散らさず変数化 — Editorial Swiss Grid の配色トークン原則) */
:root{
  --sentiment-pos:#1a7f37;
  --sentiment-pos-soft:#e6f4ea;
  --sentiment-neg:#b42318;
  --sentiment-neg-soft:#fde8e6;
  /* PDF 推定 (確定ではないので彩度を落として "暫定感" を出す) */
  --sentiment-pdf-pos:#5fa37e;
  --sentiment-pdf-neg:#c97a72;
  --sentiment-mixed:#9a3412;
}
.tl-row{display:flex;gap:12px;padding:12px 14px;border-bottom:1px solid var(--border-soft);align-items:flex-start;border-left:3px solid transparent}
.tl-row:last-child{border-bottom:none}
.tl-row--pos{border-left-color:var(--sentiment-pos);background:linear-gradient(to right,color-mix(in srgb,var(--sentiment-pos-soft) 20%,transparent),transparent 240px)}
.tl-row--neg{border-left-color:var(--sentiment-neg);background:linear-gradient(to right,color-mix(in srgb,var(--sentiment-neg-soft) 20%,transparent),transparent 240px)}
.tl-row--pos:hover{background:linear-gradient(to right,color-mix(in srgb,var(--sentiment-pos-soft) 40%,transparent),var(--bg-soft))}
.tl-row--neg:hover{background:linear-gradient(to right,color-mix(in srgb,var(--sentiment-neg-soft) 40%,transparent),var(--bg-soft))}
/* PDF 推定行 (title 中立 + PDF pos/neg): dashed 左ボーダーで「推定」を視覚表現 */
.tl-row--pdf-pos{border-left:3px dashed var(--sentiment-pdf-pos)}
.tl-row--pdf-neg{border-left:3px dashed var(--sentiment-pdf-neg)}
.tl-row--pdf-pos:hover{background:linear-gradient(to right,color-mix(in srgb,var(--sentiment-pdf-pos) 12%,transparent),var(--bg-soft))}
.tl-row--pdf-neg:hover{background:linear-gradient(to right,color-mix(in srgb,var(--sentiment-pdf-neg) 12%,transparent),var(--bg-soft))}
/* title と PDF が矛盾: dotted 装飾 + mixed 色 (どちらも信頼するな = 本文確認推奨) */
.tl-row--mixed{border-left:3px dotted var(--sentiment-mixed)}
.tl-row--mixed:hover{background:linear-gradient(to right,color-mix(in srgb,var(--sentiment-mixed) 10%,transparent),var(--bg-soft))}
/* チップ内の用語トリガのタップ縦領域を 24px 以上に (WCAG 2.5.8 / ルール7) */
.chip .tip{padding-block:5px;margin-block:-5px}
.tl-row:hover{background:var(--bg-soft)}
/* シグナル時系列 (横軸=日付の SVG マップ。JS 不要・ホバーでツールチップ) */
.signal-timeline{display:block;width:100%;height:auto;margin:10px 0 4px;border:2px solid var(--border);border-radius:var(--radius);background:var(--bg-pure);padding:6px 0}
.signal-timeline .axis{stroke:var(--border-soft);stroke-width:1}
.signal-timeline .axis-lbl{font-family:var(--font-mono);font-size:10px;font-weight:700;fill:var(--text-muted)}
.signal-timeline .tk line{stroke:var(--border-soft);stroke-width:1}
.signal-timeline .tk text{font-family:var(--font-mono);font-size:9px;fill:var(--text-muted)}
.signal-timeline .today{stroke:var(--text-muted);stroke-width:1;stroke-dasharray:2,2;opacity:.7}
.signal-timeline .today-lbl{font-family:var(--font-mono);font-size:8px;fill:var(--text-muted);letter-spacing:0.05em}
.signal-timeline .lg-lbl{font-family:var(--font-mono);font-size:9px;fill:var(--text-muted)}
.signal-timeline circle{cursor:pointer;transition:r .12s}
.signal-timeline a:hover circle,.signal-timeline a:focus circle{r:7}
/* モバイル: dot を少し大きくしてタップ目標 (WCAG 2.5.5) を確保 */
@media(max-width:768px){.signal-timeline circle{r:6}.signal-timeline a:hover circle,.signal-timeline a:focus circle{r:8}}
/* シグナルハイライト (ポジ/ネガのみを期間内まとめ表示) */
.signal-bar{display:flex;flex-wrap:wrap;gap:10px;margin:12px 0 4px}
.signal-bar .sb{display:inline-flex;align-items:baseline;gap:8px;padding:8px 14px;border:2px solid var(--border);border-radius:var(--radius);background:var(--bg-pure);font-family:var(--font-mono)}
.signal-bar .sb--pos{border-color:var(--sentiment-pos);color:var(--sentiment-pos)}
.signal-bar .sb--neg{border-color:var(--sentiment-neg);color:var(--sentiment-neg)}
.signal-bar .sb--pdf-pos{border-color:var(--sentiment-pdf-pos);border-style:dashed;color:var(--sentiment-pdf-pos)}
.signal-bar .sb--pdf-neg{border-color:var(--sentiment-pdf-neg);border-style:dashed;color:var(--sentiment-pdf-neg)}
.signal-bar .sb .num{font-size:22px;font-weight:700;font-variant-numeric:tabular-nums}
.signal-bar .sb .lab{font-size:11px;letter-spacing:0.08em;text-transform:uppercase}
/* 中立注記は flex-basis:100% で必ず改行 (集計バーの主従関係を保つ) */
.signal-bar .sb--neutral{flex-basis:100%;color:var(--text-muted);font-size:12px;margin-top:2px}
.signals{margin:14px 0;border:2px solid var(--border);border-radius:var(--radius);background:var(--bg-pure);overflow:hidden}
.signals .row{display:flex;gap:12px;padding:12px 14px;border-bottom:1px solid var(--border-soft);align-items:flex-start;border-left:3px solid transparent}
.signals .row:last-child{border-bottom:none}
.signals .row--pos{border-left-color:var(--sentiment-pos);background:linear-gradient(to right,color-mix(in srgb,var(--sentiment-pos-soft) 20%,transparent),transparent 240px)}
.signals .row--neg{border-left-color:var(--sentiment-neg);background:linear-gradient(to right,color-mix(in srgb,var(--sentiment-neg-soft) 20%,transparent),transparent 240px)}
.signals .row--pos:hover{background:linear-gradient(to right,color-mix(in srgb,var(--sentiment-pos-soft) 40%,transparent),var(--bg-soft))}
.signals .row--neg:hover{background:linear-gradient(to right,color-mix(in srgb,var(--sentiment-neg-soft) 40%,transparent),var(--bg-soft))}
/* PDF 単独/合算行: 左ボーダーを dashed に変えて「確定 vs 推定」の差を表現 */
.signals .row--pdf{border-left-style:dashed}
.signals .row--both{border-left-width:5px}
.signals .mark{font-family:var(--font-mono);font-weight:700;font-size:14px;flex:0 0 28px;text-align:center;padding-top:2px;font-variant-numeric:tabular-nums}
.signals .mark--pos{color:var(--sentiment-pos)}
.signals .mark--neg{color:var(--sentiment-neg)}
/* シグナル行内の source バッジ (TITLE / PDF / TITLE+PDF) */
.signals .src{display:inline-block;padding:2px 6px;font-family:var(--font-mono);font-size:10px;font-weight:600;letter-spacing:0.06em;border:1px solid var(--border-soft);border-radius:3px;color:var(--text-muted);background:var(--bg)}
.signals .src--title{color:var(--text);border-color:var(--border)}
.signals .src--pdf{color:var(--sentiment-pdf-pos);border-color:var(--sentiment-pdf-pos);border-style:dashed}
.signals .src--both{color:var(--sentiment-pos);border-color:var(--sentiment-pos)}
.signals .date{font-family:var(--font-mono);font-size:12px;color:var(--text-muted);flex:0 0 84px;padding-top:3px;font-variant-numeric:tabular-nums}
.signals .body{flex:1;min-width:0}
.signals .tags{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px}
.signals .title{font-size:14px;line-height:1.55;color:var(--text)}
.signals .title a{color:var(--text);text-decoration:underline;text-underline-offset:2px;text-decoration-color:var(--border-soft)}
.signals .title a:hover{text-decoration-color:var(--text)}
.tl-date{font-family:var(--font-mono);font-size:12px;color:var(--text-muted);flex:0 0 84px;padding-top:3px;font-variant-numeric:tabular-nums}
.tl-body{flex:1;min-width:0}
.tl-tags{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px}
.tl-title{font-size:14px;line-height:1.55;color:var(--text)}
.tl-title a{color:var(--text);text-decoration:underline;text-underline-offset:2px;text-decoration-color:var(--border-soft)}
.tl-title a:hover{text-decoration-color:var(--text)}
.statbar{display:flex;flex-wrap:wrap;gap:14px;margin:16px 0;padding:16px 18px;background:var(--bg-pure);border:2px solid var(--border);border-radius:var(--radius)}
.statbar>div{display:flex;flex-direction:column;gap:4px;padding-right:18px;border-right:1px solid var(--border-soft)}
.statbar>div:last-child{border-right:none}
.statbar .lbl{font-family:var(--font-mono);font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.08em}
.statbar .val{font-family:var(--font-mono);font-size:22px;font-weight:700;font-variant-numeric:tabular-nums}
.statbar .val small{font-size:12px;font-weight:400;color:var(--text-muted)}
.notice{border:2px dashed var(--border-soft);border-radius:var(--radius);padding:32px 20px;text-align:center;color:var(--text-secondary);font-size:15px;line-height:1.8;margin:20px 0}
.notice strong{font-family:var(--font-display)}
.period-nav{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0 0;font-family:var(--font-mono);font-size:11px}
.period-nav a{padding:5px 12px;border:1.5px solid var(--border-soft);border-radius:var(--radius);color:var(--text);background:var(--bg-pure);text-transform:uppercase;letter-spacing:0.06em}
.period-nav a.on{background:var(--bg-invert);color:var(--text-invert);border-color:var(--border)}
.period-nav a:hover{text-decoration:none;border-color:var(--border)}
.footer{margin-top:56px;padding:28px 16px;border-top:2px solid var(--border);background:var(--bg)}
.footer .inner{max-width:1100px;margin:0 auto;padding:0 16px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px;font-family:var(--font-mono);font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em}
.disclaimer{font-family:var(--font-mono);font-size:11px;color:var(--text-muted);line-height:1.7;margin-top:16px}
`;

const NAV_ICON_HOME = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 11l9-8 9 8M5 10v10h14V10"/></svg>`;
const NAV_ICON_SEARCH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/></svg>`;
const NAV_ICON_SIGNAL = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 17l6-6 4 4 8-8M21 7v6M21 7h-6"/></svg>`;
const NAV_ICON_PORTAL = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M4 12h16M4 18h16"/></svg>`;

export function layout(
  title: string,
  body: string,
  active: "home" | "search" | "signal" | "detail"
): string {
  return `<!DOCTYPE html><html lang="ja"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0,viewport-fit=cover">
<title>${h(title)} | kabulab IRカタログ</title>
<meta name="description" content="東証上場の個別株の適時開示(IR)を全量取得し、増配・上方修正・自社株買い・配当政策の変更などをタグで色分けして銘柄ごとに時系列マッピングするツール。出典: TDnet。">
<meta name="theme-color" content="#fafafa">
${FONT_LINKS}
<style>${DESIGN_TOKENS}\n${BASE_RESET}\n${SERVICE_STYLES}\n${TERM_TIP_STYLES}</style>
</head><body>
<header class="top-header"><div class="inner">
  <a href="${BASE_PATH}/" class="brand"><span class="mark"></span><span class="name"><span class="ja">IRカタログ</span><span class="en">006 / KABULAB</span></span></a>
  <nav class="desktop-nav">
    <a href="/" class="portal-back">← KABULAB</a>
    <a href="${BASE_PATH}/">HOME</a>
    <a href="${BASE_PATH}/?focus=1">SEARCH</a>
    <a href="${BASE_PATH}/signals">SIGNALS</a>
  </nav>
</div></header>
${body}
<footer class="footer"><div class="inner">
  <div>© ${new Date().getFullYear()} kabulab — IRカタログ</div>
  <div>Source: TDnet (yanoshin WebAPI)</div>
</div></footer>
<nav class="bottom-nav">
  <a href="${BASE_PATH}/" class="${active === "home" ? "active" : ""}">${NAV_ICON_HOME}HOME</a>
  <a href="${BASE_PATH}/?focus=1" class="${active === "search" ? "active" : ""}">${NAV_ICON_SEARCH}SEARCH</a>
  <a href="${BASE_PATH}/signals" class="${active === "signal" ? "active" : ""}">${NAV_ICON_SIGNAL}SIGNALS</a>
  <a href="/">${NAV_ICON_PORTAL}PORTAL</a>
</nav>
</body></html>`;
}
