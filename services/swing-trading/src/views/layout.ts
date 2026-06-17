import { BASE_PATH } from "../../base-path.js";

/**
 * 003 Swing Trading 共通レイアウト
 *
 * 001 rsi-screening の layout.ts を参考にしつつ、独自のナビ
 * (HOME / SCREENING / SIGNALS / RISK) を配置する。
 *
 * JSX は使えないため template literal を返す関数として実装する。
 */

const GLOBAL_STYLES = `
:root{
  --bg:#fafafa;--bg-pure:#ffffff;--bg-invert:#0a0a0a;--bg-soft:#f0f0f0;
  --text:#0a0a0a;--text-secondary:#3a3a3a;--text-muted:#737373;--text-invert:#fafafa;
  --border:#0a0a0a;--border-soft:#d4d4d4;
  --accent:#1d4ed8;--accent-soft:#dbeafe;
  --success:#15803d;--success-soft:#dcfce7;
  --warning:#b45309;--warning-soft:#fef3c7;
  --danger:#b91c1c;--danger-soft:#fee2e2;
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
@media(min-width:768px){.container{max-width:1120px;padding:32px 24px}}

/* === Header === */
.top-header{background:var(--bg);border-bottom:2px solid var(--border);position:sticky;top:0;z-index:10}
.top-header .inner{max-width:1120px;margin:0 auto;padding:0 16px;display:flex;align-items:center;justify-content:space-between;height:72px;gap:16px}
.brand{display:flex;align-items:center;gap:12px;text-decoration:none}
.brand .mark{width:32px;height:32px;background:var(--bg-invert);display:flex;align-items:center;justify-content:center;flex-shrink:0}
.brand .mark::after{content:'';width:14px;height:14px;background:var(--bg)}
.brand .name{display:flex;flex-direction:column;line-height:1}
.brand .ja{font-family:var(--font-display);font-size:20px;font-weight:700;color:var(--text);letter-spacing:-0.02em}
.brand .en{font-family:var(--font-mono);font-size:9px;color:var(--text-muted);letter-spacing:0.18em;text-transform:uppercase;margin-top:4px}
.desktop-nav{display:flex;align-items:center;gap:0}
.desktop-nav a{color:var(--text);font-family:var(--font-display);font-size:13px;font-weight:600;padding:0 16px;display:inline-flex;align-items:center;min-height:var(--tap);text-transform:uppercase;letter-spacing:0.06em;border-left:2px solid var(--border)}
.desktop-nav a:hover{background:var(--bg-invert);color:var(--text-invert);text-decoration:none}
.desktop-nav a.portal-back{border-left:none;border-right:2px solid var(--border);color:var(--text-muted)}
.desktop-nav a.portal-back:hover{color:var(--text-invert);background:var(--bg-invert)}
@media(max-width:900px){.desktop-nav a{padding:0 12px;font-size:12px}}
@media(max-width:768px){.top-header .inner{height:64px}}

/* === Bottom nav (mobile) === */
.bottom-nav{display:none;position:fixed;bottom:0;left:0;right:0;background:var(--bg);border-top:2px solid var(--border);z-index:100;padding-bottom:env(safe-area-inset-bottom,0)}
.bottom-nav a{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;padding:8px 0;min-height:58px;color:var(--text);font-family:var(--font-display);font-size:10px;font-weight:600;text-decoration:none;text-transform:uppercase;letter-spacing:0.04em;border-right:1px solid var(--border-soft)}
.bottom-nav a:last-child{border-right:none}
.bottom-nav a.active{background:var(--bg-invert);color:var(--text-invert)}
.bottom-nav svg{display:block;width:20px;height:20px}
@media(max-width:768px){.desktop-nav{display:none}.bottom-nav{display:flex}body{padding-bottom:72px}}

/* === Hero === */
.hero{padding:40px 16px 28px;background:var(--bg);border-bottom:2px solid var(--border);position:relative;overflow:hidden}
.hero::before{content:'';position:absolute;top:0;left:0;right:0;height:1px;background:repeating-linear-gradient(90deg,var(--border) 0 8px,transparent 8px 16px);opacity:0.2}
.hero .inner{max-width:1120px;margin:0 auto;padding:0 16px;position:relative}
.hero .label{font-family:var(--font-mono);font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:var(--text-muted);margin-bottom:20px;display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap}
.hero .label::before{content:'';flex:0 0 32px;height:2px;background:var(--text)}
.hero .label-text{flex:1}
.hero h1{font-family:var(--font-display);font-size:clamp(32px,6vw,56px);font-weight:700;line-height:1.0;letter-spacing:-0.04em;color:var(--text);margin-bottom:20px}
.hero .lead{font-size:16px;color:var(--text-secondary);max-width:620px;line-height:1.7}
@media(min-width:768px){.hero{padding:56px 24px 40px}}

/* === Section heading === */
h2{font-family:var(--font-display);font-size:26px;font-weight:700;color:var(--text);line-height:1.2;letter-spacing:-0.02em;margin:0 0 16px}
h3{font-family:var(--font-display);font-size:17px;font-weight:700;color:var(--text);line-height:1.3;letter-spacing:-0.01em}
.section-label{font-family:var(--font-mono);font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:var(--text-muted);margin-bottom:8px;display:flex;align-items:center;gap:12px;margin-top:32px}
.section-label::before{content:'';flex:0 0 24px;height:2px;background:var(--text)}

/* === Cards === */
.card{background:var(--bg-pure);border:2px solid var(--border);border-radius:var(--radius);padding:20px;display:block;color:var(--text);text-decoration:none;transition:transform .15s ease-out,box-shadow .15s ease-out;position:relative}
a:hover .card,.card-link:hover .card{transform:translate(-3px,-3px);box-shadow:5px 5px 0 0 var(--border);text-decoration:none}
.card h3{font-family:var(--font-display);font-size:18px;font-weight:700;margin-bottom:8px}
.card p{font-size:14px;color:var(--text-secondary);line-height:1.6}

/* === Tables === */
table{width:100%;border-collapse:collapse;margin:16px 0;background:var(--bg-pure);font-size:13px;border:2px solid var(--border);border-radius:var(--radius);overflow:hidden}
th{background:var(--bg-soft);color:var(--text-muted);padding:12px 10px;text-align:left;font-family:var(--font-mono);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;border-bottom:2px solid var(--border);white-space:nowrap}
td{padding:12px 10px;border-bottom:1px solid var(--border-soft);color:var(--text);font-family:var(--font-mono);font-variant-numeric:tabular-nums;font-size:13px}
tbody tr:last-child td{border-bottom:none}
tbody tr:hover td{background:var(--bg-soft)}
tbody tr a{color:var(--text);text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:2px;font-weight:600}
.num{text-align:right;font-variant-numeric:tabular-nums}
.bad{color:var(--danger);font-weight:600}
.good{color:var(--success);font-weight:600}
.neutral{color:var(--text-muted)}
.table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch;margin:16px -4px}

/* === Big judgment badge === */
.judgment-box{background:var(--bg-pure);border:2px solid var(--border);border-radius:var(--radius);padding:24px;margin-bottom:20px;display:flex;align-items:center;gap:24px;flex-wrap:wrap}
.judgment-letter{font-family:var(--font-display);font-size:96px;font-weight:700;line-height:1;color:var(--text);min-width:120px;text-align:center;padding:12px 8px;border:3px solid var(--border);border-radius:var(--radius);letter-spacing:-0.04em}
.judgment-letter.A{background:var(--success-soft);color:var(--success);border-color:var(--success)}
.judgment-letter.B{background:var(--bg-pure);color:var(--text)}
.judgment-letter.C{background:var(--warning-soft);color:var(--warning);border-color:var(--warning)}
.judgment-letter.D{background:var(--danger-soft);color:var(--danger);border-color:var(--danger)}
.judgment-letter.HOLD{background:var(--bg-soft);color:var(--text-muted);font-size:40px;letter-spacing:0;padding:36px 16px}
.judgment-body{flex:1;min-width:220px}
.judgment-body .label{font-family:var(--font-mono);font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:var(--text-muted);margin-bottom:8px}
.judgment-body .title{font-family:var(--font-display);font-size:22px;font-weight:700;margin-bottom:6px}
.judgment-body .reason{font-size:14px;color:var(--text-secondary);line-height:1.65}

/* === Stats row === */
.stats-row{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;margin-bottom:16px}
.stat-cell{background:var(--bg-pure);border:2px solid var(--border);border-radius:var(--radius);padding:14px 16px}
.stat-cell .lbl{font-family:var(--font-mono);font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:var(--text-muted);margin-bottom:4px}
.stat-cell .val{font-family:var(--font-mono);font-size:22px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--text)}
.stat-cell .val.good{color:var(--success)}
.stat-cell .val.bad{color:var(--danger)}
.stat-cell .sub{font-family:var(--font-mono);font-size:10px;color:var(--text-muted);margin-top:2px}

/* === Badges === */
.badge{display:inline-block;padding:4px 10px;border-radius:var(--radius);font-family:var(--font-mono);font-size:10px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;border:1.5px solid}
.badge-good{background:var(--success-soft);color:var(--success);border-color:var(--success)}
.badge-bad{background:var(--danger-soft);color:var(--danger);border-color:var(--danger)}
.badge-warn{background:var(--warning-soft);color:var(--warning);border-color:var(--warning)}
.badge-neutral{background:var(--bg-soft);color:var(--text-muted);border-color:var(--border-soft)}

/* === Form === */
.form-box{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;align-items:flex-end;margin-bottom:20px;padding:24px;background:var(--bg-pure);border:2px solid var(--border);border-radius:var(--radius);position:relative}
.form-box::before{content:'FORM';position:absolute;top:-10px;left:16px;background:var(--bg-invert);color:var(--text-invert);font-family:var(--font-mono);font-size:10px;font-weight:700;padding:3px 10px;letter-spacing:0.12em;border-radius:var(--radius)}
.form-field{display:flex;flex-direction:column;gap:6px}
.form-field label{font-family:var(--font-mono);font-size:11px;color:var(--text-muted);font-weight:600;text-transform:uppercase;letter-spacing:0.06em}
.form-field input,.form-field select{background:var(--bg);border:2px solid var(--border);color:var(--text);padding:0 14px;border-radius:var(--radius);font-family:var(--font-mono);font-size:15px;min-height:var(--tap);width:100%}
.form-field input:focus,.form-field select:focus{outline:3px solid var(--accent);outline-offset:0}
.form-field .hint{font-family:var(--font-mono);font-size:10px;color:var(--text-muted)}
.form-submit{background:var(--bg-invert);color:var(--text-invert);border:2px solid var(--border);padding:0 24px;border-radius:var(--radius);font-family:var(--font-display);font-size:14px;font-weight:700;cursor:pointer;min-height:var(--tap);text-transform:uppercase;letter-spacing:0.04em;transition:transform .15s,box-shadow .15s;grid-column:1/-1}
.form-submit:hover{transform:translate(-2px,-2px);box-shadow:3px 3px 0 0 var(--border)}

/* === Result box === */
.result-box{background:var(--bg-pure);border:2px solid var(--border);border-radius:var(--radius);padding:24px;margin:16px 0;position:relative}
.result-box::before{content:'RESULT';position:absolute;top:-10px;left:16px;background:var(--success);color:var(--text-invert);font-family:var(--font-mono);font-size:10px;font-weight:700;padding:3px 10px;letter-spacing:0.12em;border-radius:var(--radius)}
.result-shares{font-family:var(--font-mono);font-size:56px;font-weight:700;color:var(--text);line-height:1;margin:12px 0;font-variant-numeric:tabular-nums}
.result-shares .unit{font-size:20px;color:var(--text-muted);margin-left:8px}

/* === Empty state === */
.empty{text-align:center;padding:56px 16px;color:var(--text-muted);font-family:var(--font-mono);font-size:13px;text-transform:uppercase;letter-spacing:0.1em;border:2px dashed var(--border-soft);border-radius:var(--radius);background:var(--bg-pure)}

/* === Notice box === */
.notice{background:var(--warning-soft);border:2px solid var(--warning);border-radius:var(--radius);padding:16px 20px;margin:16px 0;font-size:14px;color:var(--text);line-height:1.6}
.notice strong{color:var(--warning);font-family:var(--font-display);font-weight:700}

/* === Filter/chip === */
.chip-row{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px}
.chip{display:inline-flex;align-items:center;padding:8px 16px;border:2px solid var(--border);border-radius:var(--radius);font-family:var(--font-mono);font-size:12px;font-weight:600;background:var(--bg-pure);color:var(--text);text-decoration:none;text-transform:uppercase;letter-spacing:0.06em;min-height:40px}
.chip.active{background:var(--bg-invert);color:var(--text-invert)}
.chip:hover{text-decoration:none;transform:translate(-2px,-2px);box-shadow:3px 3px 0 0 var(--border)}
`;

/** HTML エスケープ (XSS 対策) */
export function h(s: string | number | null | undefined): string {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 数値フォーマッタ (カンマ区切り + 小数桁数指定) */
export function fmtNum(
  value: number | null | undefined,
  digits = 0,
  suffix = ""
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  return (
    value.toLocaleString("ja-JP", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }) + suffix
  );
}

/** 円単位の金額を適切な単位 (億/万/千円) に丸めて表示 */
export function fmtYen(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  if (value >= 1e8) return (value / 1e8).toFixed(1) + " 億";
  if (value >= 1e4) return (value / 1e4).toFixed(1) + " 万";
  return value.toFixed(0) + " 円";
}

/** 前日比%にクラスを付ける */
export function pctCell(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '<span class="neutral">—</span>';
  }
  const cls = value > 0 ? "good" : value < 0 ? "bad" : "neutral";
  const sign = value > 0 ? "+" : "";
  return `<span class="${cls}">${sign}${value.toFixed(digits)}%</span>`;
}

/**
 * 共通レイアウト
 */
export function layout(title: string, body: string, activeNav?: string): string {
  const navActive = (path: string) => (activeNav === path ? "active" : "");
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0,viewport-fit=cover"><title>${h(title)}</title><meta name="theme-color" content="#fafafa"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&family=Noto+Sans+JP:wght@400;500;600;700&display=swap" rel="stylesheet"><style>${GLOBAL_STYLES}</style></head><body>
<header class="top-header">
  <div class="inner">
    <a href="${BASE_PATH}/" class="brand">
      <span class="mark"></span>
      <span class="name">
        <span class="ja">Swing Trading</span>
        <span class="en">003 / KABULAB</span>
      </span>
    </a>
    <nav class="desktop-nav">
      <a href="/" class="portal-back">← KABULAB</a>
      <a href="${BASE_PATH}/">HOME</a>
      <a href="${BASE_PATH}/screening">SCREENING</a>
      <a href="${BASE_PATH}/signals">SIGNALS</a>
      <a href="${BASE_PATH}/risk">RISK CALC</a>
    </nav>
  </div>
</header>
${body}
<nav class="bottom-nav">
  <a href="${BASE_PATH}/" class="${navActive("home")}">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12l9-9 9 9"/><path d="M5 10v10a1 1 0 001 1h3v-6h6v6h3a1 1 0 001-1V10"/></svg>
    <span>HOME</span>
  </a>
  <a href="${BASE_PATH}/screening" class="${navActive("screening")}">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
    <span>SCREEN</span>
  </a>
  <a href="${BASE_PATH}/signals" class="${navActive("signals")}">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/></svg>
    <span>SIGNAL</span>
  </a>
  <a href="${BASE_PATH}/risk" class="${navActive("risk")}">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
    <span>RISK</span>
  </a>
  <a href="/">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
    <span>PORTAL</span>
  </a>
</nav>
</body></html>`;
}
