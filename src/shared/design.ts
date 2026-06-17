/**
 * kabulab 共通デザイントークン — Editorial Swiss Grid
 *
 * 全プロジェクト共通の CSS 変数 (色・タイポグラフィ・スペーシング) と、
 * 共有する base reset / リンク / コンテナ周りのスタイルをエクスポートする。
 *
 * 各サービスは `${DESIGN_TOKENS}` を CSS の冒頭に埋め込み、その後ろに
 * サービス固有のスタイルを連結する。サービス固有スタイルは
 * 各サービス内に閉じたまま、デザイントークンだけを単一 source of truth から
 * 取り込むことで、配色やフォントの統一が保たれる。
 *
 * 詳細は docs/overview.md の「デザインシステム」セクションを参照。
 */

/** 配色 / フォント / スペーシングなどの :root 変数定義 */
export const DESIGN_TOKENS = `:root{
  --bg:#fafafa;--bg-pure:#ffffff;--bg-invert:#0a0a0a;--bg-soft:#f0f0f0;
  --text:#0a0a0a;--text-secondary:#3a3a3a;--text-muted:#737373;--text-invert:#fafafa;
  --border:#0a0a0a;--border-soft:#d4d4d4;
  --accent:#1d4ed8;--accent-soft:#dbeafe;
  --status-live:#15803d;--status-live-soft:#dcfce7;
  --status-soon:#b45309;--status-soon-soft:#fef3c7;
  --success:#15803d;--success-soft:#dcfce7;
  --warning:#b45309;--warning-soft:#fef3c7;
  --danger:#b91c1c;--danger-soft:#fee2e2;
  --radius:4px;--tap:48px;
  --font-display:'Space Grotesk','Noto Sans JP',sans-serif;
  --font-body:'Noto Sans JP',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  --font-mono:'JetBrains Mono','SF Mono','Menlo',monospace;
}`;

/** Reset + 基本タイポグラフィ + フォーカススタイル + コンテナ */
export const BASE_RESET = `*{margin:0;padding:0;box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{font-family:var(--font-body);font-size:17px;background:var(--bg);color:var(--text);line-height:1.75;-webkit-font-smoothing:antialiased;min-height:100vh}
a{color:var(--text);text-decoration:none}
a:hover{text-decoration:underline;text-decoration-thickness:2px;text-underline-offset:3px}
a:focus-visible,button:focus-visible,select:focus-visible,input:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.container{max-width:720px;margin:0 auto;padding:24px 16px}
@media(min-width:768px){.container{max-width:880px;padding:32px 24px}}
@media(min-width:1024px){.container{max-width:1080px;padding:40px 32px}}`;

/** Google Fonts (Space Grotesk + JetBrains Mono + Noto Sans JP) の `<link>` */
export const FONT_LINKS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&family=Noto+Sans+JP:wght@400;500;600;700&display=swap" rel="stylesheet">`;

/** トークン + base reset を結合したベース CSS。各サービスはこれを冒頭に埋め込む */
export const BASE_CSS = `${DESIGN_TOKENS}\n${BASE_RESET}`;
