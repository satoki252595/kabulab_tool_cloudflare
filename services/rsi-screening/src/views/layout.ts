import { BASE_PATH } from "../../base-path.js";

/**
 * 共通レイアウト — Editorial Swiss Grid（白黒×ニューブルータリスト）
 *
 * Vercel の `@vercel/node` が `.tsx` をデフォルトで bundle しないため、
 * このサービスのビューはすべて template literal を返す関数として実装する。
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
@media(min-width:768px){.container{max-width:1100px;padding:32px 24px}}

/* === Header === */
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
@media(max-width:768px){.top-header .inner{height:64px}}

/* === Bottom nav (mobile) === */
.bottom-nav{display:none;position:fixed;bottom:0;left:0;right:0;background:var(--bg);border-top:2px solid var(--border);z-index:100;padding-bottom:env(safe-area-inset-bottom,0)}
.bottom-nav a{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;padding:10px 0;min-height:62px;color:var(--text);font-family:var(--font-display);font-size:11px;font-weight:600;text-decoration:none;text-transform:uppercase;letter-spacing:0.06em;border-right:1px solid var(--border-soft)}
.bottom-nav a:last-child{border-right:none}
.bottom-nav a.active{background:var(--bg-invert);color:var(--text-invert)}
.bottom-nav svg{display:block;width:22px;height:22px}
@media(max-width:768px){.desktop-nav{display:none}.bottom-nav{display:flex}body{padding-bottom:80px}}

/* === Hero === */
.hero{padding:48px 16px 36px;background:var(--bg);border-bottom:2px solid var(--border);position:relative;overflow:hidden}
.hero::before{content:'';position:absolute;top:0;left:0;right:0;height:1px;background:repeating-linear-gradient(90deg,var(--border) 0 8px,transparent 8px 16px);opacity:0.2}
.hero .inner{max-width:1100px;margin:0 auto;padding:0 16px;position:relative}
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
h3{font-family:var(--font-display);font-size:18px;font-weight:700;color:var(--text);line-height:1.3;letter-spacing:-0.01em}
.section-label{font-family:var(--font-mono);font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:var(--text-muted);margin-bottom:8px;display:flex;align-items:center;gap:12px}
.section-label::before{content:'';flex:0 0 24px;height:2px;background:var(--text)}

/* === Cards === */
.card{background:var(--bg-pure);border:2px solid var(--border);border-radius:var(--radius);padding:20px;display:block;color:var(--text);text-decoration:none;transition:transform .15s ease-out,box-shadow .15s ease-out;position:relative}
a:hover .card,.card-link:hover .card{transform:translate(-3px,-3px);box-shadow:5px 5px 0 0 var(--border);text-decoration:none}
.card h3{font-family:var(--font-display);font-size:18px;font-weight:700;margin-bottom:8px;color:var(--text);letter-spacing:-0.01em}
.card p{font-size:14px;color:var(--text-secondary);line-height:1.6}

/* === Tables === */
table{width:100%;border-collapse:collapse;margin:16px 0;background:var(--bg-pure);font-size:13px;border:2px solid var(--border);border-radius:var(--radius);overflow:hidden}
th{background:var(--bg-soft);color:var(--text-muted);padding:12px 10px;text-align:left;font-family:var(--font-mono);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;border-bottom:2px solid var(--border)}
td{padding:12px 10px;border-bottom:1px solid var(--border-soft);color:var(--text);font-family:var(--font-mono);font-variant-numeric:tabular-nums}
tbody tr:last-child td{border-bottom:none}
tbody tr:hover td{background:var(--bg-soft)}
tbody tr a{color:var(--text);text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:2px;font-weight:600}
.num{text-align:right;font-variant-numeric:tabular-nums}
.bad{color:var(--danger);font-weight:600}
.good{color:var(--success);font-weight:600}
.neutral{color:var(--text-muted)}

/* === Badges === */
.badge{display:inline-block;padding:4px 10px;border-radius:var(--radius);font-family:var(--font-mono);font-size:10px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;border:1.5px solid}
.badge-good{background:var(--success-soft);color:var(--success);border-color:var(--success)}
.badge-bad{background:var(--danger-soft);color:var(--danger);border-color:var(--danger)}
.badge-neutral{background:var(--bg-soft);color:var(--text-muted);border-color:var(--border-soft)}

/* === Form === */
.form-row{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;margin-bottom:20px;padding:20px;background:var(--bg-pure);border:2px solid var(--border);border-radius:var(--radius);position:relative}
.form-row::before{content:'FILTER';position:absolute;top:-10px;left:16px;background:var(--bg-invert);color:var(--text-invert);font-family:var(--font-mono);font-size:10px;font-weight:700;padding:3px 10px;letter-spacing:0.12em;border-radius:var(--radius)}
.form-field{display:flex;flex-direction:column;gap:6px}
.form-field label{font-family:var(--font-mono);font-size:11px;color:var(--text-muted);font-weight:600;text-transform:uppercase;letter-spacing:0.06em}
.form-field select,.form-field input{background:var(--bg);border:2px solid var(--border);color:var(--text);padding:0 14px;border-radius:var(--radius);font-family:var(--font-mono);font-size:14px;min-height:var(--tap);min-width:140px}
.form-field select:focus,.form-field input:focus{outline:3px solid var(--accent);outline-offset:0}
button{background:var(--bg-invert);color:var(--text-invert);border:2px solid var(--border);padding:0 24px;border-radius:var(--radius);font-family:var(--font-display);font-size:14px;font-weight:700;cursor:pointer;min-height:var(--tap);text-transform:uppercase;letter-spacing:0.04em;transition:transform .15s,box-shadow .15s}
button:hover{transform:translate(-2px,-2px);box-shadow:3px 3px 0 0 var(--border)}

/* === Empty state === */
.empty{text-align:center;padding:64px 16px;color:var(--text-muted);font-family:var(--font-mono);font-size:13px;text-transform:uppercase;letter-spacing:0.1em;border:2px dashed var(--border-soft);border-radius:var(--radius)}

/* === Pill === */
.pill{display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border-radius:var(--radius);font-family:var(--font-mono);font-size:11px;font-weight:600;background:var(--bg-pure);color:var(--text);border:1.5px solid var(--border);text-transform:uppercase;letter-spacing:0.06em}
.pill::before{content:'';width:6px;height:6px;background:var(--text);border-radius:50%}

/* === Trend === */
.trend-up{color:var(--success);font-weight:600}
.trend-down{color:var(--danger);font-weight:600}
.trend-flat{color:var(--text-muted)}

/* === Tooltip (バルーンヘルプ) — 用語にカーソル/タップで説明を表示 === */
.tip{position:relative;display:inline-block;cursor:help;border-bottom:2px dotted var(--text-muted);font-weight:600}
.tip .tip-text{visibility:hidden;opacity:0;position:absolute;z-index:20;bottom:calc(100% + 8px);left:50%;transform:translateX(-50%);width:300px;background:var(--bg-invert);color:var(--text-invert);font-size:13px;line-height:1.65;padding:14px 16px;border-radius:var(--radius);transition:opacity .15s;pointer-events:none;font-weight:400;border:2px solid var(--border);text-align:left;white-space:normal;letter-spacing:0;text-transform:none;font-family:var(--font-body)}
.tip .tip-text::after{content:'';position:absolute;top:100%;left:50%;transform:translateX(-50%);border:8px solid transparent;border-top-color:var(--bg-invert)}
.tip:hover .tip-text,.tip:focus .tip-text,.tip:active .tip-text{visibility:visible;opacity:1}
@media(max-width:600px){.tip .tip-text{width:240px;font-size:12px;left:0;transform:none}.tip .tip-text::after{left:24px;transform:none}}
/* テーブルヘッダ内では下線をやや薄く / 大文字組版を維持 */
th .tip{font-weight:inherit;border-bottom-color:rgba(115,115,115,0.4)}
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

/**
 * 専門用語の説明文辞書
 *
 * `tip(key, label)` でラベル文字列をホバー/タップで説明が出る `<span>` に
 * ラップする。日本株投資が初めての利用者にも意味が伝わるよう、平易な日本語で
 * 数値の目安まで含めて書く。
 */
const TIPS: Record<string, string> = {
  rsi: "相対力指数 (Relative Strength Index)。直近の値動きから「買われすぎ・売られすぎ」を 0〜100 で示す指標。30 以下は売られすぎ (反発の目安)、70 以上は買われすぎ。",
  rsi10: "短期 RSI。直近 10 営業日 (約 2 週間) の値動きで算出した RSI。短期的な売買タイミングの目安になる。",
  rsi40: "中期 RSI。直近 40 営業日 (約 2 ヶ月) の値動きで算出した RSI。中期的な反発の目安。",
  rsi120: "長期 RSI。直近 120 営業日 (約半年) の値動きで算出した RSI。半年単位での底値を捉えやすい。",
  rsiMin: "3 期間 (10 / 40 / 120 日) のうち最も小さいパーセンタイル順位。ひとつでも歴史的な底値圏にあれば値が小さくなる。",
  percentile: "パーセンタイル順位。過去 5 年間の RSI 分布の中で、現在の値が下から何%の位置にあるかを示す。0〜5% は「過去 5 年で最も底値圏」、20% 以下で「割安水準」の目安。",
  blueChip: "優良株フィルタ。売上高が 3 年間で増加基調 かつ 営業利益率 (TTM) が 5% 以上の銘柄に絞り込む。一時的な下落中でも実力のある銘柄を見つけるためのフィルタ。",
  per: "株価収益率 (Price Earnings Ratio)。株価が 1 株あたり利益の何倍かを示す。低いほど割安の目安で、一般に 15 倍以下が割安とされる。",
  pbr: "株価純資産倍率 (Price Book-value Ratio)。株価が 1 株あたり純資産の何倍か。1 倍以下は「解散価値以下」で割安の目安。",
  dividend: "配当利回り。株価に対する年間配当金の割合。3% 以上が高配当の目安。",
  eps: "1 株あたり利益 (Earnings Per Share)。企業が 1 株でいくら稼いだか。高いほど収益力が強い。",
  bps: "1 株あたり純資産 (Book-value Per Share)。企業の純資産を発行株数で割った値。PBR = 株価 ÷ BPS。",
  roe: "自己資本利益率 (Return on Equity)。株主のお金でどれだけ効率よく利益を出しているか。10% 以上が優良企業の目安。",
  roa: "総資産利益率 (Return on Assets)。企業の総資産でどれだけ効率よく利益を出しているか。5% 以上が一つの目安。",
  marketCap: "時価総額。株価 × 発行済株数。企業の規模を表す。大きいほど株価が安定、小さいほど値動きが激しい。",
  operatingMarginTtm: "営業利益率 TTM (trailing 12 months)。直近 12 ヶ月の本業の儲けを売上高で割った値。10% 以上で高収益、5% 以上が平均以上。",
  revenueTrend:
    "売上高トレンド (過去 3 年)。↑ = 増加基調 (5% 以上の成長)、→ = 横ばい、↓ = 減少基調、? = 判定不能。" +
    "判定不能は「3 年分のデータが無い」か、「取得元が連結売上と単体売上を混在させており前年比 2 倍超の段差があるため、成長率を信用できない」場合。",
  fundamental: "ファンダメンタルズ。企業の財務データ (PER / PBR / ROE / 配当利回り 等) から「企業の実力」を評価する分析手法。",
  technical: "テクニカル分析。株価チャートの動き (RSI / MACD / 移動平均 等) から「売買タイミング」を判断する分析手法。本サービスの全指標は分割・併合調整済み終値 (adjclose) を使用しているため、株式分割後も数値が連続します。",
};

/**
 * 用語ラベルをホバー/タップで説明が出る `<span>` にラップする
 *
 * @param key   - TIPS 辞書のキー (該当が無ければ説明は空)
 * @param label - ラベルとして表示する文字列 (HTML エスケープ済みの想定)
 */
export function tip(key: string, label: string): string {
  const text = TIPS[key];
  if (!text) return label;
  return `<span class="tip" tabindex="0">${label}<span class="tip-text">${h(text)}</span></span>`;
}

/**
 * 共通レイアウト — title と本文 HTML、現在のナビ位置を受け取り、
 * 完成した HTML 文字列を返す。
 */
export function layout(title: string, body: string, activeNav?: string): string {
  const navActive = (path: string) => (activeNav === path ? "active" : "");
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0,viewport-fit=cover"><title>${h(title)}</title><meta name="theme-color" content="#fafafa"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&family=Noto+Sans+JP:wght@400;500;600;700&display=swap" rel="stylesheet"><style>${GLOBAL_STYLES}</style></head><body>
<header class="top-header">
  <div class="inner">
    <a href="${BASE_PATH}/" class="brand">
      <span class="mark"></span>
      <span class="name">
        <span class="ja">RSI Screening</span>
        <span class="en">001 / KABULAB</span>
      </span>
    </a>
    <nav class="desktop-nav">
      <a href="/" class="portal-back">← KABULAB</a>
      <a href="${BASE_PATH}/">HOME</a>
      <a href="${BASE_PATH}/screening">SCREENING</a>
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
    <span>SCREENING</span>
  </a>
  <a href="/">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
    <span>PORTAL</span>
  </a>
</nav>
</body></html>`;
}
