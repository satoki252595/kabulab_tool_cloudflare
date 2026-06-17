import type { FC, PropsWithChildren } from "hono/jsx";
import { raw } from "hono/html";

/** ベースHTMLレイアウト — Luxury Fintech Terminal テーマ */
const Layout: FC<PropsWithChildren<{ title: string }>> = ({
  title,
  children,
}) => {
  return (
    <>
      {raw("<!DOCTYPE html>")}
      <html lang="ja">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
        <title>{title} | お宝優待</title>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&family=Noto+Sans+JP:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
        <style>{`
          /* ============================================
             Design System — Luxury Fintech Terminal
             ============================================ */
          :root {
            /* Surfaces */
            --bg-base: #06080f;
            --bg-surface: #0e1225;
            --bg-elevated: #151a33;
            --bg-overlay: rgba(14, 18, 37, 0.88);

            /* Borders */
            --border-subtle: rgba(255, 255, 255, 0.05);
            --border-default: rgba(255, 255, 255, 0.08);
            --border-strong: rgba(255, 255, 255, 0.14);
            --border-accent: rgba(232, 168, 56, 0.3);

            /* Text */
            --text-primary: #eef2f7;
            --text-secondary: #8b95a8;
            --text-muted: #5a637a;

            /* Accent — Warm Gold */
            --accent: #e8a838;
            --accent-hover: #d49530;
            --accent-subtle: rgba(232, 168, 56, 0.1);
            --accent-glow: rgba(232, 168, 56, 0.25);

            /* Secondary — Calm Blue */
            --info: #5b8af5;
            --info-subtle: rgba(91, 138, 245, 0.1);

            /* Semantic */
            --success: #34d399;
            --success-subtle: rgba(52, 211, 153, 0.1);
            --warning: #fbbf24;
            --danger: #f87171;

            /* Score */
            --score-high: #34d399;
            --score-mid: #fbbf24;
            --score-low: #fb923c;
            --score-danger: #f87171;

            /* Radius */
            --radius-sm: 8px;
            --radius-md: 14px;
            --radius-lg: 20px;
            --radius-full: 9999px;

            /* Typography */
            --font-display: 'Outfit', 'Noto Sans JP', sans-serif;
            --font-body: 'Noto Sans JP', 'Outfit', sans-serif;
            --font-mono: 'SF Mono', 'Fira Code', monospace;

            /* Effects */
            --glass-bg: rgba(14, 18, 37, 0.55);
            --glass-blur: blur(20px);
            --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.4);
            --shadow-md: 0 4px 16px rgba(0, 0, 0, 0.5);
            --shadow-lg: 0 12px 40px rgba(0, 0, 0, 0.6);
            --shadow-glow: 0 0 24px var(--accent-glow);

            /* Easing */
            --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
            --ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
          }

          /* ============================================
             Reset & Base
             ============================================ */
          *, *::before, *::after {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
          }

          html {
            font-size: 16px;
            -webkit-text-size-adjust: 100%;
            scroll-behavior: smooth;
          }

          body {
            font-family: var(--font-body);
            background-color: var(--bg-base);
            color: var(--text-primary);
            line-height: 1.65;
            min-height: 100vh;
            padding-top: env(safe-area-inset-top);
            padding-bottom: env(safe-area-inset-bottom);
            padding-left: env(safe-area-inset-left);
            padding-right: env(safe-area-inset-right);
            overflow-x: hidden;
          }

          /* 背景テクスチャ — 微細なノイズ + グラデーション */
          body::before {
            content: '';
            position: fixed;
            inset: 0;
            z-index: -2;
            background:
              radial-gradient(ellipse 80% 60% at 50% -20%, rgba(91, 138, 245, 0.08), transparent),
              radial-gradient(ellipse 60% 40% at 80% 100%, rgba(232, 168, 56, 0.05), transparent);
          }
          body::after {
            content: '';
            position: fixed;
            inset: 0;
            z-index: -1;
            opacity: 0.3;
            background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.04'/%3E%3C/svg%3E");
            background-repeat: repeat;
            pointer-events: none;
          }

          /* ============================================
             Links
             ============================================ */
          a {
            color: var(--accent);
            text-decoration: none;
            transition: color 0.25s var(--ease-out);
          }
          a:hover {
            color: var(--accent-hover);
          }

          /* ============================================
             Container
             ============================================ */
          .container {
            width: 100%;
            max-width: 1200px;
            margin: 0 auto;
            padding: 0 16px;
          }
          @media (min-width: 768px) {
            .container { padding: 0 28px; }
          }
          @media (min-width: 1024px) {
            .container { padding: 0 36px; }
          }

          /* ============================================
             Card — ガラスモーフィズム
             ============================================ */
          .card {
            background: var(--glass-bg);
            backdrop-filter: var(--glass-blur);
            -webkit-backdrop-filter: var(--glass-blur);
            border: 1px solid var(--border-default);
            border-radius: var(--radius-md);
            padding: 18px;
            transition:
              border-color 0.3s var(--ease-out),
              box-shadow 0.3s var(--ease-out),
              transform 0.3s var(--ease-out);
          }
          .card:hover {
            border-color: var(--border-strong);
            box-shadow: var(--shadow-md);
            transform: translateY(-2px);
          }
          .card:active {
            transform: translateY(0) scale(0.985);
          }

          /* ============================================
             Buttons
             ============================================ */
          .btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            padding: 10px 22px;
            border-radius: var(--radius-sm);
            border: 1px solid var(--border-default);
            background: var(--bg-elevated);
            color: var(--text-primary);
            font-family: var(--font-display);
            font-size: 0.8125rem;
            font-weight: 500;
            letter-spacing: 0.01em;
            cursor: pointer;
            transition:
              all 0.25s var(--ease-out);
            text-decoration: none;
          }
          .btn:hover {
            background: var(--bg-surface);
            border-color: var(--border-strong);
            color: var(--text-primary);
            box-shadow: var(--shadow-sm);
          }
          .btn:active {
            transform: scale(0.97);
          }
          .btn-primary {
            background: linear-gradient(135deg, var(--accent), #d49530);
            color: #0a0c14;
            border-color: transparent;
            font-weight: 600;
            box-shadow: 0 2px 12px var(--accent-glow);
          }
          .btn-primary:hover {
            background: linear-gradient(135deg, #d49530, #c08528);
            color: #0a0c14;
            box-shadow: 0 4px 20px var(--accent-glow);
          }

          /* ============================================
             Tags
             ============================================ */
          .tag {
            display: inline-block;
            padding: 3px 10px;
            border-radius: var(--radius-full);
            font-size: 0.6875rem;
            font-weight: 600;
            font-family: var(--font-display);
            letter-spacing: 0.02em;
            background: var(--info-subtle);
            color: var(--info);
            border: 1px solid rgba(91, 138, 245, 0.15);
          }

          /* ============================================
             Table
             ============================================ */
          table {
            width: 100%;
            border-collapse: collapse;
          }
          th, td {
            padding: 12px 14px;
            text-align: left;
            border-bottom: 1px solid var(--border-subtle);
          }
          th {
            font-family: var(--font-display);
            font-size: 0.6875rem;
            font-weight: 600;
            color: var(--text-muted);
            text-transform: uppercase;
            letter-spacing: 0.08em;
          }

          /* ============================================
             Filter Panel
             ============================================ */
          .filter-panel {
            margin-bottom: 20px;
            border: 1px solid var(--border-default);
            border-radius: var(--radius-md);
            overflow: hidden;
            background: var(--glass-bg);
            backdrop-filter: var(--glass-blur);
            -webkit-backdrop-filter: var(--glass-blur);
          }
          .filter-panel summary {
            padding: 14px 18px;
            cursor: pointer;
            list-style: none;
            user-select: none;
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-family: var(--font-display);
            font-size: 0.8125rem;
            font-weight: 600;
            color: var(--text-primary);
            transition: background 0.2s;
          }
          .filter-panel summary:hover {
            background: rgba(255,255,255,0.02);
          }
          .filter-panel summary::-webkit-details-marker { display: none; }
          .filter-panel[open] summary {
            border-bottom: 1px solid var(--border-subtle);
          }
          .filter-panel form {
            padding: 18px;
            display: flex;
            flex-direction: column;
            gap: 18px;
          }
          .filter-panel fieldset {
            border: none;
            padding: 0;
          }
          .filter-panel legend {
            font-family: var(--font-display);
            font-size: 0.6875rem;
            font-weight: 600;
            color: var(--text-muted);
            text-transform: uppercase;
            letter-spacing: 0.08em;
            margin-bottom: 10px;
          }
          .filter-grid {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 8px;
          }
          .filter-grid label {
            font-size: 0.8125rem;
            display: flex;
            align-items: center;
            gap: 6px;
            color: var(--text-secondary);
            cursor: pointer;
            padding: 4px 0;
            transition: color 0.2s;
          }
          .filter-grid label:hover {
            color: var(--text-primary);
          }
          .filter-select {
            width: 100%;
            padding: 10px 14px;
            border-radius: var(--radius-sm);
            border: 1px solid var(--border-default);
            background: var(--bg-base);
            color: var(--text-primary);
            font-family: var(--font-body);
            font-size: 0.875rem;
            transition: border-color 0.25s;
            outline: none;
          }
          .filter-select:focus {
            border-color: var(--accent);
            box-shadow: 0 0 0 3px var(--accent-subtle);
          }

          /* ============================================
             Section Card (Details / Accordion)
             ============================================ */
          .section-card {
            border: 1px solid var(--border-default);
            border-radius: var(--radius-md);
            overflow: hidden;
            margin-bottom: 16px;
            background: var(--glass-bg);
            backdrop-filter: var(--glass-blur);
            -webkit-backdrop-filter: var(--glass-blur);
          }
          .section-card summary {
            padding: 18px;
            cursor: pointer;
            list-style: none;
            display: flex;
            justify-content: space-between;
            align-items: center;
            transition: background 0.2s;
          }
          .section-card summary:hover {
            background: rgba(255,255,255,0.02);
          }
          .section-card summary::-webkit-details-marker { display: none; }
          .section-card[open] summary {
            border-bottom: 1px solid var(--border-subtle);
          }
          .section-card .section-body {
            padding: 18px;
          }

          /* ============================================
             Section Nav (Sticky tabs)
             ============================================ */
          .section-nav {
            display: flex;
            overflow-x: auto;
            -webkit-overflow-scrolling: touch;
            scrollbar-width: none;
            border-bottom: 1px solid var(--border-subtle);
            position: sticky;
            top: 60px;
            background: var(--bg-overlay);
            backdrop-filter: var(--glass-blur);
            -webkit-backdrop-filter: var(--glass-blur);
            z-index: 50;
            margin: 0 -16px;
            padding: 0 16px;
          }
          .section-nav::-webkit-scrollbar { display: none; }
          .section-nav a {
            flex-shrink: 0;
            padding: 14px 18px;
            font-family: var(--font-display);
            font-size: 0.8125rem;
            font-weight: 500;
            color: var(--text-muted);
            border-bottom: 2px solid transparent;
            white-space: nowrap;
            text-decoration: none;
            transition: color 0.25s, border-color 0.25s;
          }
          .section-nav a:hover {
            color: var(--text-primary);
            border-bottom-color: var(--border-strong);
          }

          /* ============================================
             Scroll Margin
             ============================================ */
          [id] {
            scroll-margin-top: 130px;
          }

          /* ============================================
             Utilities
             ============================================ */
          .tabular-nums {
            font-variant-numeric: tabular-nums;
          }
          .font-display {
            font-family: var(--font-display);
          }

          /* ============================================
             Animations — ページロード時のスタガー
             ============================================ */
          @keyframes fadeInUp {
            from {
              opacity: 0;
              transform: translateY(20px);
            }
            to {
              opacity: 1;
              transform: translateY(0);
            }
          }
          @keyframes fadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
          }
          @keyframes shimmer {
            0% { background-position: -200% 0; }
            100% { background-position: 200% 0; }
          }
          @keyframes pulseGlow {
            0%, 100% { box-shadow: 0 0 12px var(--accent-glow); }
            50% { box-shadow: 0 0 28px var(--accent-glow); }
          }

          .animate-in {
            animation: fadeInUp 0.6s var(--ease-out) both;
          }
          .animate-in-1 { animation-delay: 0.05s; }
          .animate-in-2 { animation-delay: 0.1s; }
          .animate-in-3 { animation-delay: 0.15s; }
          .animate-in-4 { animation-delay: 0.2s; }
          .animate-in-5 { animation-delay: 0.25s; }
          .animate-in-6 { animation-delay: 0.3s; }

          /* ============================================
             Responsive
             ============================================ */
          @media (min-width: 768px) {
            .filter-grid {
              grid-template-columns: repeat(6, 1fr);
            }
          }
        `}</style>
      </head>
      <body>
        {children}
      </body>
    </html>
    </>
  );
};

export default Layout;
