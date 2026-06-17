import type { FC } from "hono/jsx";
import Layout from "../layout.js";
import Header from "../components/header.js";
import StockCard from "../components/stock-card.js";

/** 検索結果の銘柄型 */
type SearchStockItem = {
  code: string;
  name: string;
  genres: string[];
  fundamentalScore: number | null;
  technicalScore: number | null;
  totalScore: number | null;
  per: number | null;
  pbr: number | null;
  dividendYield: number | null;
  benefitSummary: string;
};

type SearchResultsProps = {
  /** 検索クエリ */
  query: string;
  /** 検索結果 */
  stocks: SearchStockItem[];
};

/**
 * 検索結果ページ
 * — 銘柄コードまたは銘柄名で検索した結果を表示する
 */
const SearchResults: FC<SearchResultsProps> = ({ query, stocks }) => {
  return (
    <Layout title={query ? `「${query}」の検索結果` : "銘柄検索"}>
      <Header />

      <main style={{ padding: "28px 0 56px" }}>
        <div class="container">
          {/* 検索フォーム */}
          <form
            method="get"
            action="/search"
            class="animate-in"
            style={{ marginBottom: "28px" }}
          >
            <div
              style={{
                display: "flex",
                gap: "10px",
              }}
            >
              <input
                type="search"
                name="q"
                value={query}
                placeholder="銘柄コード（例: 2914 / 130A）または銘柄名"
                style={{
                  flex: "1",
                  padding: "12px 18px",
                  borderRadius: "var(--radius-sm)",
                  border: "1px solid var(--border-default)",
                  background: "var(--bg-surface)",
                  color: "var(--text-primary)",
                  fontFamily: "var(--font-body)",
                  fontSize: "0.9375rem",
                  outline: "none",
                  transition: "border-color 0.25s, box-shadow 0.25s",
                }}
              />
              <button type="submit" class="btn btn-primary" style={{ padding: "12px 24px" }}>
                検索
              </button>
            </div>
            <style>{`
              input[type="search"]:focus {
                border-color: var(--accent) !important;
                box-shadow: 0 0 0 3px var(--accent-subtle) !important;
              }
              input[type="search"]::placeholder {
                color: var(--text-muted);
              }
            `}</style>
          </form>

          {/* 結果 */}
          {query && (
            <h1
              class="animate-in animate-in-1"
              style={{
                fontFamily: "var(--font-display)",
                fontSize: "1.25rem",
                fontWeight: "700",
                marginBottom: "20px",
                letterSpacing: "-0.01em",
              }}
            >
              「{query}」の検索結果
              <span
                style={{
                  fontSize: "0.8125rem",
                  color: "var(--text-muted)",
                  fontWeight: "400",
                  marginLeft: "14px",
                  fontFamily: "var(--font-display)",
                }}
              >
                {stocks.length}件
              </span>
            </h1>
          )}

          {!query && (
            <div
              class="card animate-in animate-in-1"
              style={{
                textAlign: "center",
                padding: "56px 16px",
                color: "var(--text-muted)",
              }}
            >
              <div
                style={{
                  fontFamily: "var(--font-display)",
                  fontSize: "1rem",
                  fontWeight: "500",
                  marginBottom: "8px",
                  color: "var(--text-secondary)",
                }}
              >
                銘柄を検索
              </div>
              <div style={{ fontSize: "0.8125rem" }}>
                銘柄コードまたは銘柄名を入力して検索してください。
              </div>
            </div>
          )}

          {query && stocks.length === 0 && (
            <div
              class="card animate-in animate-in-1"
              style={{
                textAlign: "center",
                padding: "56px 16px",
                color: "var(--text-muted)",
              }}
            >
              <div
                style={{
                  fontFamily: "var(--font-display)",
                  fontSize: "1rem",
                  fontWeight: "500",
                  marginBottom: "12px",
                  color: "var(--text-secondary)",
                }}
              >
                該当する銘柄が見つかりません
              </div>
              <div style={{ fontSize: "0.8125rem", marginBottom: "20px" }}>
                「{query}」に一致する銘柄コード・銘柄名はありませんでした。
              </div>
              <a href="/" class="btn">
                ホームへ戻る
              </a>
            </div>
          )}

          <div class="animate-in animate-in-2">
            {stocks.map((stock) => (
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
                benefitSummary={stock.benefitSummary}
              />
            ))}
          </div>

          {/* 戻るリンク */}
          {stocks.length > 0 && (
            <div style={{ textAlign: "center", marginTop: "28px" }}>
              <a href="/" class="btn">
                &larr; ホームへ戻る
              </a>
            </div>
          )}
        </div>
      </main>
    </Layout>
  );
};

export default SearchResults;
