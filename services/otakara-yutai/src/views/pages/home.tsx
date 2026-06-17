import type { FC } from "hono/jsx";
import Layout from "../layout.js";
import Header from "../components/header.js";
import StockCard from "../components/stock-card.js";

type Genre = {
  id: number;
  name: string;
  slug: string;
  description: string | null;
};

/** ホーム用の銘柄サマリー型 */
type HomeStockItem = {
  code: string;
  name: string;
  genres: string[];
  totalScore: number | null;
  fundamentalScore: number | null;
  technicalScore: number | null;
  per: number | null;
  pbr: number | null;
  dividendYield: number | null;
  price: number | null;
  minInvestment: number | null;
  recordMonths: number[];
  benefitSummary: string;
};

type HomeProps = {
  genres: Genre[];
  currentMonth: number;
  nextMonth: number;
  thisMonthStocks: HomeStockItem[];
  nextMonthStocks: HomeStockItem[];
};

/** 月名を返す */
function monthLabel(m: number): string {
  return `${m}月`;
}

/**
 * ホームページ（トップページ）
 * — ヒーロー、注目銘柄、権利確定月ナビ、ジャンル一覧
 */
const Home: FC<HomeProps> = ({
  genres,
  currentMonth,
  nextMonth,
  thisMonthStocks,
  nextMonthStocks,
}) => {
  return (
    <Layout title="ホーム">
      <Header />

      <style>{`
        /* ヒーロー背景エフェクト */
        .hero {
          position: relative;
          overflow: hidden;
        }
        .hero::before {
          content: '';
          position: absolute;
          top: -40%;
          left: -20%;
          width: 140%;
          height: 180%;
          background:
            radial-gradient(ellipse 40% 50% at 30% 40%, rgba(91, 138, 245, 0.12), transparent 60%),
            radial-gradient(ellipse 35% 40% at 70% 60%, rgba(232, 168, 56, 0.08), transparent 60%);
          pointer-events: none;
          z-index: 0;
        }
        .hero-content {
          position: relative;
          z-index: 1;
        }

        /* 月カードグリッド */
        .month-grid a {
          text-decoration: none;
          color: inherit;
        }

        /* ジャンルカードホバーエフェクト */
        .genre-card {
          position: relative;
          overflow: hidden;
        }
        .genre-card::before {
          content: '';
          position: absolute;
          inset: 0;
          background: linear-gradient(
            135deg,
            rgba(232, 168, 56, 0.06) 0%,
            transparent 50%
          );
          opacity: 0;
          transition: opacity 0.3s;
        }
        .genre-card:hover::before {
          opacity: 1;
        }
      `}</style>

      {/* ヒーローセクション */}
      <section
        class="hero animate-in"
        style={{
          padding: "56px 16px 48px",
          textAlign: "center",
          borderBottom: "1px solid var(--border-subtle)",
        }}
      >
        <div class="container hero-content">
          <div
            style={{
              display: "inline-block",
              padding: "5px 14px",
              borderRadius: "var(--radius-full)",
              background: "var(--accent-subtle)",
              border: "1px solid var(--border-accent)",
              fontSize: "0.75rem",
              fontFamily: "var(--font-display)",
              fontWeight: "600",
              color: "var(--accent)",
              marginBottom: "20px",
              letterSpacing: "0.03em",
            }}
          >
            ファンダメンタルズ × テクニカル分析
          </div>
          <h1
            style={{
              fontFamily: "var(--font-display)",
              fontSize: "clamp(1.75rem, 5vw, 2.5rem)",
              fontWeight: "800",
              marginBottom: "16px",
              lineHeight: "1.2",
              letterSpacing: "-0.03em",
            }}
          >
            割安な
            <span
              style={{
                background: "linear-gradient(135deg, var(--accent), #f0c060)",
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent",
                backgroundClip: "text",
              }}
            >
              お宝優待銘柄
            </span>
            を
            <br />
            スコアで発見する
          </h1>
          <p
            style={{
              fontSize: "0.9375rem",
              color: "var(--text-secondary)",
              maxWidth: "520px",
              margin: "0 auto 28px",
              lineHeight: "1.75",
            }}
          >
            独自スコアリングで優待銘柄を定量評価。
            ジャンル別スクリーニングで、あなたの投資スタイルに合った銘柄を。
          </p>
          <div style={{ display: "flex", gap: "12px", justifyContent: "center", flexWrap: "wrap" }}>
            <a href="/#genres" class="btn btn-primary" style={{ padding: "12px 28px" }}>
              ジャンルから探す
            </a>
            <a href="/#months" class="btn" style={{ padding: "12px 28px" }}>
              権利確定月から探す
            </a>
          </div>
        </div>
      </section>

      {/* 今月/来月の注目優待銘柄 */}
      {(thisMonthStocks.length > 0 || nextMonthStocks.length > 0) && (
        <section style={{ padding: "40px 0" }}>
          <div class="container">
            {/* 今月の注目 */}
            {thisMonthStocks.length > 0 && (
              <div class="animate-in animate-in-1" style={{ marginBottom: "40px" }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: "18px",
                  }}
                >
                  <h2
                    style={{
                      fontFamily: "var(--font-display)",
                      fontSize: "1.125rem",
                      fontWeight: "700",
                      letterSpacing: "-0.01em",
                    }}
                  >
                    <span style={{ color: "var(--accent)" }}>{monthLabel(currentMonth)}</span>
                    {" "}権利確定の注目銘柄
                  </h2>
                  <a
                    href={`/months/${currentMonth}`}
                    style={{
                      fontSize: "0.8125rem",
                      fontFamily: "var(--font-display)",
                      fontWeight: "500",
                    }}
                  >
                    すべて見る →
                  </a>
                </div>
                {thisMonthStocks.map((stock) => (
                  <StockCard
                    code={stock.code}
                    name={stock.name}
                    genres={stock.genres}
                    fundamentalScore={stock.fundamentalScore}
                    technicalScore={stock.technicalScore}
                    totalScore={stock.totalScore}
                    per={stock.per}
                    pbr={stock.pbr}
                    dividendYield={stock.dividendYield}
                    price={stock.price}
                    minInvestment={stock.minInvestment}
                    recordMonths={stock.recordMonths}
                    benefitSummary={stock.benefitSummary}
                  />
                ))}
              </div>
            )}

            {/* 来月の注目 */}
            {nextMonthStocks.length > 0 && (
              <div class="animate-in animate-in-2">
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: "18px",
                  }}
                >
                  <h2
                    style={{
                      fontFamily: "var(--font-display)",
                      fontSize: "1.125rem",
                      fontWeight: "700",
                      letterSpacing: "-0.01em",
                    }}
                  >
                    <span style={{ color: "var(--info)" }}>{monthLabel(nextMonth)}</span>
                    {" "}権利確定の注目銘柄
                  </h2>
                  <a
                    href={`/months/${nextMonth}`}
                    style={{
                      fontSize: "0.8125rem",
                      fontFamily: "var(--font-display)",
                      fontWeight: "500",
                    }}
                  >
                    すべて見る →
                  </a>
                </div>
                {nextMonthStocks.map((stock) => (
                  <StockCard
                    code={stock.code}
                    name={stock.name}
                    genres={stock.genres}
                    fundamentalScore={stock.fundamentalScore}
                    technicalScore={stock.technicalScore}
                    totalScore={stock.totalScore}
                    per={stock.per}
                    pbr={stock.pbr}
                    dividendYield={stock.dividendYield}
                    price={stock.price}
                    minInvestment={stock.minInvestment}
                    recordMonths={stock.recordMonths}
                    benefitSummary={stock.benefitSummary}
                  />
                ))}
              </div>
            )}
          </div>
        </section>
      )}

      {/* 権利確定月から探す */}
      <section id="months" style={{ padding: "40px 0", borderTop: "1px solid var(--border-subtle)" }}>
        <div class="container">
          <h2
            class="animate-in animate-in-3"
            style={{
              fontFamily: "var(--font-display)",
              fontSize: "1.25rem",
              fontWeight: "700",
              marginBottom: "24px",
              letterSpacing: "-0.01em",
            }}
          >
            権利確定月から探す
          </h2>
          <div
            class="month-grid animate-in animate-in-4"
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(4, 1fr)",
              gap: "10px",
            }}
          >
            {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
              <a
                href={`/months/${m}`}
                class="card"
                style={{
                  display: "block",
                  padding: "14px 8px",
                  textAlign: "center",
                  ...(m === currentMonth
                    ? {
                        borderColor: "var(--accent)",
                        background: "var(--accent-subtle)",
                        boxShadow: "0 0 16px var(--accent-glow)",
                      }
                    : m === nextMonth
                      ? {
                          borderColor: "rgba(91, 138, 245, 0.2)",
                          background: "var(--info-subtle)",
                        }
                      : {}),
                }}
              >
                <div
                  style={{
                    fontFamily: "var(--font-display)",
                    fontSize: "1.125rem",
                    fontWeight: "700",
                    color:
                      m === currentMonth
                        ? "var(--accent)"
                        : m === nextMonth
                          ? "var(--info)"
                          : "var(--text-primary)",
                  }}
                >
                  {m}月
                </div>
                {m === currentMonth && (
                  <div
                    style={{
                      fontSize: "0.625rem",
                      fontFamily: "var(--font-display)",
                      fontWeight: "600",
                      color: "var(--accent)",
                      marginTop: "3px",
                      letterSpacing: "0.05em",
                      textTransform: "uppercase",
                    }}
                  >
                    今月
                  </div>
                )}
              </a>
            ))}
          </div>
        </div>
      </section>

      {/* ジャンル一覧 */}
      <section id="genres" style={{ padding: "40px 0 56px", borderTop: "1px solid var(--border-subtle)" }}>
        <div class="container">
          <h2
            class="animate-in animate-in-5"
            style={{
              fontFamily: "var(--font-display)",
              fontSize: "1.25rem",
              fontWeight: "700",
              marginBottom: "24px",
              letterSpacing: "-0.01em",
            }}
          >
            優待ジャンル一覧
          </h2>

          <div
            class="animate-in animate-in-6"
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))",
              gap: "12px",
            }}
          >
            {genres.map((genre) => (
              <a
                href={`/genres/${genre.slug}`}
                class="card genre-card"
                style={{
                  display: "block",
                  textDecoration: "none",
                  color: "inherit",
                  padding: "22px 16px",
                  textAlign: "center",
                }}
              >
                <div
                  style={{
                    fontFamily: "var(--font-display)",
                    fontSize: "0.9375rem",
                    fontWeight: "600",
                    marginBottom: "6px",
                    letterSpacing: "-0.01em",
                  }}
                >
                  {genre.name}
                </div>
                {genre.description && (
                  <div
                    style={{
                      fontSize: "0.75rem",
                      color: "var(--text-muted)",
                      lineHeight: "1.5",
                    }}
                  >
                    {genre.description}
                  </div>
                )}
              </a>
            ))}
          </div>

          {genres.length === 0 && (
            <p style={{ color: "var(--text-muted)", textAlign: "center", padding: "40px 0" }}>
              ジャンルが登録されていません。
            </p>
          )}
        </div>
      </section>
    </Layout>
  );
};

export default Home;
