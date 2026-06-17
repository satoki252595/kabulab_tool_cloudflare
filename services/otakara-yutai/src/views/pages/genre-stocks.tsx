import type { FC } from "hono/jsx";
import Layout from "../layout.js";
import Header from "../components/header.js";
import StockCard from "../components/stock-card.js";

/** 銘柄表示用データ */
type StockItem = {
  code: string;
  name: string;
  genres: string[];
  fundamentalScore: number | null;
  technicalScore: number | null;
  totalScore: number | null;
  per: number | null;
  pbr: number | null;
  dividendYield: number | null;
  price?: number | null;
  minInvestment?: number | null;
  recordMonths?: number[];
  benefitSummary: string;
};

/** フィルター状態 */
type FilterState = {
  months: number[];
  maxInvestment: number | null;
  minScore: number | null;
};

type GenreStocksProps = {
  /** ジャンル名 */
  genreName: string;
  /** ジャンルslug */
  genreSlug: string;
  /** 銘柄リスト */
  stocks: StockItem[];
  /** 現在のソートキー */
  sort: string;
  /** 現在のページ（1始まり） */
  page: number;
  /** 総ページ数 */
  totalPages: number;
  /** 全銘柄数 */
  totalCount: number;
  /** 現在のフィルター状態 */
  filters?: FilterState;
};

/** ソート選択肢 */
const SORT_OPTIONS = [
  { value: "totalScore", label: "総合スコア" },
  { value: "fundamentalScore", label: "ファンダメンタルズ" },
  { value: "technicalScore", label: "テクニカル" },
] as const;

/** フィルター適用状態かどうか */
function hasActiveFilters(filters?: FilterState): boolean {
  if (!filters) return false;
  return filters.months.length > 0 || filters.maxInvestment !== null || filters.minScore !== null;
}

/** 現在のフィルタをクエリパラメータに変換するヘルパー */
function buildFilterParams(filters?: FilterState): string {
  if (!filters) return "";
  const parts: string[] = [];
  for (const m of filters.months) {
    parts.push(`month=${m}`);
  }
  if (filters.maxInvestment !== null) {
    parts.push(`maxInvestment=${filters.maxInvestment}`);
  }
  if (filters.minScore !== null) {
    parts.push(`minScore=${filters.minScore}`);
  }
  return parts.length > 0 ? "&" + parts.join("&") : "";
}

/**
 * ジャンル別銘柄一覧ページ
 * — 指定ジャンルのスクリーニング結果を表示する
 */
const GenreStocks: FC<GenreStocksProps> = ({
  genreName,
  genreSlug,
  stocks,
  sort,
  page,
  totalPages,
  totalCount,
  filters,
}) => {
  const PAGE_SIZE = 20;
  const startItem = (page - 1) * PAGE_SIZE + 1;
  const endItem = Math.min(page * PAGE_SIZE, totalCount);
  const filterParams = buildFilterParams(filters);
  return (
    <Layout title={`${genreName}の優待銘柄`}>
      <Header />

      <main style={{ padding: "28px 0 56px" }}>
        <div class="container">
          {/* パンくずリスト */}
          <nav
            aria-label="パンくずリスト"
            class="animate-in"
            style={{
              fontSize: "0.8125rem",
              color: "var(--text-muted)",
              marginBottom: "24px",
            }}
          >
            <ol style={{ listStyle: "none", display: "flex", flexWrap: "wrap", gap: "0" }}>
              <li><a href="/">ホーム</a></li>
              <li style={{ margin: "0 8px", color: "var(--text-muted)" }} aria-hidden="true">/</li>
              <li aria-current="page" style={{ color: "var(--text-secondary)" }}>{genreName}</li>
            </ol>
          </nav>

          {/* ページタイトル */}
          <h1
            class="animate-in animate-in-1"
            style={{
              fontFamily: "var(--font-display)",
              fontSize: "1.5rem",
              fontWeight: "700",
              marginBottom: "24px",
              letterSpacing: "-0.02em",
            }}
          >
            {genreName}
            <span
              style={{
                fontSize: "0.8125rem",
                color: "var(--text-muted)",
                fontWeight: "400",
                marginLeft: "14px",
                fontFamily: "var(--font-display)",
              }}
            >
              {totalCount > 0
                ? `${startItem}–${endItem} / ${totalCount}件`
                : "0件"}
            </span>
          </h1>

          {/* ソートコントロール */}
          <div
            class="animate-in animate-in-2"
            style={{
              display: "flex",
              gap: "8px",
              marginBottom: "16px",
              flexWrap: "wrap",
            }}
          >
            {SORT_OPTIONS.map((opt) => (
              <a
                href={`/${genreSlug}?sort=${opt.value}&page=1${filterParams}`}
                class="btn"
                style={{
                  ...(sort === opt.value
                    ? {
                        background: "linear-gradient(135deg, var(--accent), #d49530)",
                        color: "#0a0c14",
                        borderColor: "transparent",
                        fontWeight: "600",
                        boxShadow: "0 2px 12px var(--accent-glow)",
                      }
                    : {}),
                }}
              >
                {opt.label}
              </a>
            ))}
          </div>

          {/* フィルターパネル */}
          <details class="filter-panel animate-in animate-in-3" open={hasActiveFilters(filters) || undefined}>
            <summary>
              <span style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                絞り込み条件
                {hasActiveFilters(filters) && (
                  <span
                    style={{
                      display: "inline-block",
                      padding: "2px 8px",
                      borderRadius: "var(--radius-full)",
                      background: "var(--accent-subtle)",
                      color: "var(--accent)",
                      fontSize: "0.6875rem",
                      fontWeight: "600",
                    }}
                  >
                    適用中
                  </span>
                )}
              </span>
              <span style={{ fontSize: "0.75rem", color: "var(--text-muted)", transition: "transform 0.2s" }}>▾</span>
            </summary>
            <form method="get" action={`/${genreSlug}`}>
              <input type="hidden" name="sort" value={sort} />

              {/* 権利確定月 */}
              <fieldset>
                <legend>権利確定月</legend>
                <div class="filter-grid">
                  {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                    <label>
                      <input
                        type="checkbox"
                        name="month"
                        value={String(m)}
                        checked={filters?.months.includes(m) || undefined}
                      />
                      {m}月
                    </label>
                  ))}
                </div>
              </fieldset>

              {/* 最低投資額上限 */}
              <fieldset>
                <legend>最低投資額</legend>
                <select name="maxInvestment" class="filter-select">
                  <option value="">指定なし</option>
                  <option value="50000" selected={filters?.maxInvestment === 50000 || undefined}>
                    5万円以下
                  </option>
                  <option value="100000" selected={filters?.maxInvestment === 100000 || undefined}>
                    10万円以下
                  </option>
                  <option value="300000" selected={filters?.maxInvestment === 300000 || undefined}>
                    30万円以下
                  </option>
                  <option value="500000" selected={filters?.maxInvestment === 500000 || undefined}>
                    50万円以下
                  </option>
                </select>
              </fieldset>

              {/* 最低スコア */}
              <fieldset>
                <legend>最低総合スコア</legend>
                <select name="minScore" class="filter-select">
                  <option value="">指定なし</option>
                  <option value="50" selected={filters?.minScore === 50 || undefined}>
                    50以上
                  </option>
                  <option value="60" selected={filters?.minScore === 60 || undefined}>
                    60以上
                  </option>
                  <option value="70" selected={filters?.minScore === 70 || undefined}>
                    70以上
                  </option>
                  <option value="80" selected={filters?.minScore === 80 || undefined}>
                    80以上
                  </option>
                </select>
              </fieldset>

              <div style={{ display: "flex", gap: "10px" }}>
                <button type="submit" class="btn btn-primary" style={{ flex: "1" }}>
                  適用
                </button>
                <a
                  href={`/${genreSlug}?sort=${sort}&page=1`}
                  class="btn"
                  style={{ flex: "1", textAlign: "center" }}
                >
                  リセット
                </a>
              </div>
            </form>
          </details>

          {/* 銘柄カードリスト */}
          <div class="animate-in animate-in-4">
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
                price={stock.price}
                minInvestment={stock.minInvestment}
                recordMonths={stock.recordMonths}
                benefitSummary={stock.benefitSummary}
              />
            ))}
          </div>

          {stocks.length === 0 && (
            <div
              class="card"
              style={{
                textAlign: "center",
                padding: "56px 16px",
                color: "var(--text-muted)",
              }}
            >
              該当する銘柄がありません。
            </div>
          )}

          {/* ページネーション */}
          {totalPages > 1 && (() => {
            const pages: (number | "ellipsis")[] = [];
            const addPage = (p: number) => {
              if (!pages.includes(p)) pages.push(p);
            };
            addPage(1);
            if (page - 2 > 2) pages.push("ellipsis");
            for (let i = Math.max(2, page - 2); i <= Math.min(totalPages - 1, page + 2); i++) {
              addPage(i);
            }
            if (page + 2 < totalPages - 1) pages.push("ellipsis");
            if (totalPages > 1) addPage(totalPages);

            return (
              <nav
                aria-label="ページネーション"
                style={{
                  display: "flex",
                  justifyContent: "center",
                  gap: "8px",
                  marginTop: "28px",
                  flexWrap: "wrap",
                }}
              >
                {page > 1 && (
                  <a
                    href={`/${genreSlug}?sort=${sort}&page=${page - 1}${filterParams}`}
                    class="btn"
                  >
                    &laquo; 前へ
                  </a>
                )}

                {pages.map((p, idx) =>
                  p === "ellipsis" ? (
                    <span
                      key={`e${idx}`}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        padding: "0 6px",
                        color: "var(--text-muted)",
                        fontFamily: "var(--font-display)",
                      }}
                    >
                      …
                    </span>
                  ) : (
                    <a
                      href={`/${genreSlug}?sort=${sort}&page=${p}${filterParams}`}
                      class="btn"
                      aria-current={p === page ? "page" : undefined}
                      style={{
                        ...(p === page
                          ? {
                              background: "linear-gradient(135deg, var(--accent), #d49530)",
                              color: "#0a0c14",
                              borderColor: "transparent",
                              fontWeight: "600",
                              boxShadow: "0 2px 12px var(--accent-glow)",
                            }
                          : {}),
                        minWidth: "42px",
                      }}
                    >
                      {p}
                    </a>
                  )
                )}

                {page < totalPages && (
                  <a
                    href={`/${genreSlug}?sort=${sort}&page=${page + 1}${filterParams}`}
                    class="btn"
                  >
                    次へ &raquo;
                  </a>
                )}
              </nav>
            );
          })()}

          {/* 全ジャンルへ戻る */}
          <div style={{ textAlign: "center", marginTop: "36px" }}>
            <a href="/" class="btn">
              &larr; 全ジャンル一覧へ戻る
            </a>
          </div>
        </div>
      </main>
    </Layout>
  );
};

export default GenreStocks;
