import type { FC } from "hono/jsx";

/**
 * ヘッダーコンポーネント
 * — フロスティガラス背景、ゴールドアクセントロゴ、CSSのみのモバイルメニュー
 */
const Header: FC = () => {
  return (
    <header>
      <style>{`
        .site-header {
          background: var(--bg-overlay);
          backdrop-filter: var(--glass-blur);
          -webkit-backdrop-filter: var(--glass-blur);
          border-bottom: 1px solid var(--border-subtle);
          position: sticky;
          top: 0;
          z-index: 100;
        }
        .site-header .container {
          display: flex;
          align-items: center;
          justify-content: space-between;
          height: 60px;
        }

        /* ロゴ */
        .site-logo {
          font-family: var(--font-display);
          font-size: 1.25rem;
          font-weight: 800;
          color: var(--text-primary);
          text-decoration: none;
          display: flex;
          align-items: center;
          gap: 10px;
          letter-spacing: -0.02em;
        }
        .site-logo-icon {
          width: 28px;
          height: 28px;
          background: linear-gradient(135deg, var(--accent), #d49530);
          border-radius: 8px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 0.875rem;
          color: #0a0c14;
          box-shadow: 0 2px 8px var(--accent-glow);
        }

        /* ハンバーガーメニュー（CSS only） */
        .menu-toggle {
          display: none;
        }
        .menu-icon {
          display: flex;
          flex-direction: column;
          justify-content: center;
          gap: 5px;
          width: 44px;
          height: 44px;
          padding: 10px;
          cursor: pointer;
          border-radius: var(--radius-sm);
          transition: background 0.2s;
        }
        .menu-icon:hover {
          background: rgba(255,255,255,0.04);
        }
        .menu-icon span {
          display: block;
          width: 100%;
          height: 2px;
          background: var(--text-secondary);
          border-radius: 2px;
          transition: transform 0.3s var(--ease-out), opacity 0.3s;
        }
        .nav-links {
          display: none;
          position: absolute;
          top: 60px;
          left: 0;
          right: 0;
          background: var(--bg-overlay);
          backdrop-filter: var(--glass-blur);
          -webkit-backdrop-filter: var(--glass-blur);
          border-bottom: 1px solid var(--border-subtle);
          padding: 12px 16px;
          flex-direction: column;
          gap: 2px;
        }
        .nav-links a {
          display: block;
          padding: 12px 16px;
          color: var(--text-secondary);
          border-radius: var(--radius-sm);
          font-family: var(--font-display);
          font-size: 0.9375rem;
          font-weight: 500;
          transition: background 0.2s, color 0.2s;
        }
        .nav-links a:hover {
          background: var(--accent-subtle);
          color: var(--accent);
        }
        .nav-search {
          padding: 8px 16px;
        }
        .nav-search-input {
          width: 100%;
          padding: 10px 14px;
          border-radius: var(--radius-sm);
          border: 1px solid var(--border-default);
          background: var(--bg-base);
          color: var(--text-primary);
          font-family: var(--font-body);
          font-size: 0.875rem;
          outline: none;
          transition: border-color 0.25s, box-shadow 0.25s;
        }
        .nav-search-input::placeholder {
          color: var(--text-muted);
        }
        .nav-search-input:focus {
          border-color: var(--accent);
          box-shadow: 0 0 0 3px var(--accent-subtle);
        }
        .menu-toggle:checked ~ .nav-links {
          display: flex;
          animation: fadeIn 0.2s var(--ease-out);
        }
        .menu-toggle:checked ~ .menu-icon span:nth-child(1) {
          transform: translateY(7px) rotate(45deg);
        }
        .menu-toggle:checked ~ .menu-icon span:nth-child(2) {
          opacity: 0;
        }
        .menu-toggle:checked ~ .menu-icon span:nth-child(3) {
          transform: translateY(-7px) rotate(-45deg);
        }

        @media (min-width: 768px) {
          .menu-icon {
            display: none;
          }
          .nav-links {
            display: flex;
            position: static;
            flex-direction: row;
            background: none;
            backdrop-filter: none;
            -webkit-backdrop-filter: none;
            border: none;
            padding: 0;
            gap: 0;
            align-items: center;
          }
          .nav-links a {
            padding: 8px 16px;
            font-size: 0.8125rem;
          }
          .nav-search {
            padding: 0;
            margin-left: 8px;
          }
          .nav-search-input {
            width: 200px;
            padding: 8px 12px;
            font-size: 0.8125rem;
          }
        }
      `}</style>

      <div class="site-header">
        <div class="container">
          <a href="/" class="site-logo">
            <span class="site-logo-icon">&#9670;</span>
            お宝優待
          </a>

          <nav aria-label="メインナビゲーション">
            <input
              type="checkbox"
              id="menu-toggle"
              class="menu-toggle"
              aria-label="メニューを開閉する"
            />
            <label for="menu-toggle" class="menu-icon">
              <span />
              <span />
              <span />
            </label>
            <div class="nav-links">
              <a href="/">ホーム</a>
              <a href="/#months">権利確定月</a>
              <a href="/#genres">ジャンル一覧</a>
              <form method="get" action="/search" class="nav-search">
                <input
                  type="search"
                  name="q"
                  placeholder="銘柄コード・名前で検索"
                  class="nav-search-input"
                />
              </form>
            </div>
          </nav>
        </div>
      </div>
    </header>
  );
};

export default Header;
