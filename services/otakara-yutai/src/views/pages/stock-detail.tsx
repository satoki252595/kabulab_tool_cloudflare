import type { FC } from "hono/jsx";
import Layout from "../layout.js";
import Header from "../components/header.js";
import ScoreBadge from "../components/score-badge.js";

/** 優待情報 */
type BenefitInfo = {
  genreName: string;
  genreSlug: string;
  /** 公開表示に使うのは short_summary だけ。出典サイトの掲載文は持ち込まない。 */
  shortSummary: string | null;
  minShares: number;
  recordMonth: number;
  estimatedValue: number | null;
};

type StockDetailProps = {
  /** 銘柄コード */
  code: string;
  /** 銘柄名 */
  name: string;
  /** 市場 */
  market: string;
  /** セクター */
  sector: string | null;
  /** ファンダメンタルスコア */
  fundamentalScore: number | null;
  /** テクニカルスコア */
  technicalScore: number | null;
  /** 総合スコア */
  totalScore: number | null;
  /** 株価 */
  price: number | null;
  /** PER */
  per: number | null;
  /** PBR */
  pbr: number | null;
  /** 配当利回り */
  dividendYield: number | null;
  /** EPS */
  eps: number | null;
  /** BPS */
  bps: number | null;
  /** 時価総額 */
  marketCap: number | null;
  /** 移動平均5日 */
  ma5: number | null;
  /** 移動平均25日 */
  ma25: number | null;
  /** 移動平均75日 */
  ma75: number | null;
  /** RSI(14) */
  rsi14: number | null;
  /** ROE */
  roe: number | null;
  /** ROA */
  roa: number | null;
  /** MACD */
  macd: number | null;
  /** MACDシグナル */
  macdSignal: number | null;
  /** 優待利回り */
  yutaiYield: number | null;
  /** データ取得日時 */
  dataFetchedAt: string | null;
  /** スコア算出日時 */
  scoreScoredAt: string | null;
  /** スコア内訳（個別指標スコア） */
  scoreDetails: {
    perScore: number;
    pbrScore: number;
    dividendYieldScore: number;
    roeScore: number;
    yutaiYieldScore: number;
    maDeviationScore: number;
    rsiScore: number;
    macdScore: number;
  } | null;
  /** 優待情報リスト */
  benefits: BenefitInfo[];
};

/** 数値フォーマット */
function fmt(v: number | null, decimals = 2): string {
  if (v == null) return "—";
  return v.toLocaleString("ja-JP", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** 時価総額フォーマット（億円） */
function fmtMarketCap(v: number | null): string {
  if (v == null) return "—";
  const oku = v / 100_000_000;
  if (oku >= 10000) return `${(oku / 10000).toFixed(1)}兆円`;
  return `${Math.round(oku).toLocaleString()}億円`;
}

/** CSSバーチャートの幅を計算 */
function barWidth(score: number | null): string {
  if (score == null) return "0%";
  return `${Math.max(0, Math.min(100, score))}%`;
}

/** スコアバーの色 */
function barColor(score: number): string {
  if (score >= 80) return "var(--score-high)";
  if (score >= 60) return "var(--score-mid)";
  if (score >= 40) return "var(--score-low)";
  return "var(--score-danger)";
}

/** スコアバーのグロー */
function barGlow(score: number): string {
  if (score >= 80) return "rgba(52, 211, 153, 0.2)";
  if (score >= 60) return "rgba(251, 191, 36, 0.15)";
  if (score >= 40) return "rgba(251, 146, 60, 0.15)";
  return "rgba(248, 113, 113, 0.15)";
}

/**
 * 銘柄詳細ページ
 * — スコアの内訳、財務指標、優待情報を表示する
 */
const StockDetail: FC<StockDetailProps> = (props) => {
  const {
    code,
    name,
    market,
    sector,
    fundamentalScore,
    technicalScore,
    totalScore,
    price,
    per,
    pbr,
    dividendYield,
    eps,
    bps,
    marketCap,
    ma5,
    ma25,
    ma75,
    rsi14,
    roe,
    roa,
    macd,
    macdSignal,
    yutaiYield,
    dataFetchedAt,
    scoreScoredAt,
    scoreDetails,
    benefits,
  } = props;

  /** スコアバー行 */
  const ScoreBar: FC<{ label: string; score: number | null }> = ({
    label,
    score,
  }) => {
    const s = score ?? 0;
    return (
      <div style={{ marginBottom: "14px" }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: "0.8125rem",
            marginBottom: "6px",
          }}
        >
          <span style={{ color: "var(--text-secondary)", fontFamily: "var(--font-display)", fontWeight: "500" }}>
            {label}
          </span>
          <span
            style={{
              color: barColor(s),
              fontFamily: "var(--font-display)",
              fontWeight: "700",
              fontSize: "0.8125rem",
            }}
          >
            {score != null ? Math.round(s) : "—"}
          </span>
        </div>
        <div
          style={{
            height: "6px",
            background: "var(--border-subtle)",
            borderRadius: "var(--radius-full)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",
              width: barWidth(score),
              background: `linear-gradient(90deg, ${barColor(s)}, ${barColor(s)}dd)`,
              borderRadius: "var(--radius-full)",
              boxShadow: `0 0 8px ${barGlow(s)}`,
              transition: "width 0.6s var(--ease-out)",
            }}
          />
        </div>
      </div>
    );
  };

  /** 戻り先のジャンルslug（最初の優待ジャンル） */
  const backGenre = benefits.length > 0 ? benefits[0] : null;

  return (
    <Layout title={`${code} ${name}`}>
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
              {backGenre && (
                <>
                  <li style={{ margin: "0 8px", color: "var(--text-muted)" }} aria-hidden="true">/</li>
                  <li>
                    <a href={`/genres/${backGenre.genreSlug}`}>
                      {backGenre.genreName}
                    </a>
                  </li>
                </>
              )}
              <li style={{ margin: "0 8px", color: "var(--text-muted)" }} aria-hidden="true">/</li>
              <li aria-current="page" style={{ color: "var(--text-secondary)" }}>
                {code} {name}
              </li>
            </ol>
          </nav>

          {/* 銘柄ヘッダー */}
          <div class="animate-in animate-in-1" style={{ marginBottom: "28px" }}>
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: "14px",
                marginBottom: "8px",
                flexWrap: "wrap",
              }}
            >
              <span
                style={{
                  fontFamily: "var(--font-display)",
                  fontSize: "1rem",
                  color: "var(--accent)",
                  fontWeight: "700",
                  fontVariantNumeric: "tabular-nums",
                  letterSpacing: "0.02em",
                }}
              >
                {code}
              </span>
              <h1
                style={{
                  fontFamily: "var(--font-display)",
                  fontSize: "1.5rem",
                  fontWeight: "700",
                  letterSpacing: "-0.02em",
                }}
              >
                {name}
              </h1>
            </div>
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
              <span
                style={{
                  padding: "3px 10px",
                  borderRadius: "var(--radius-full)",
                  background: "var(--bg-elevated)",
                  border: "1px solid var(--border-subtle)",
                  fontSize: "0.75rem",
                  fontFamily: "var(--font-display)",
                  fontWeight: "500",
                  color: "var(--text-secondary)",
                }}
              >
                {market}
              </span>
              {sector && (
                <span
                  style={{
                    padding: "3px 10px",
                    borderRadius: "var(--radius-full)",
                    background: "var(--bg-elevated)",
                    border: "1px solid var(--border-subtle)",
                    fontSize: "0.75rem",
                    fontFamily: "var(--font-display)",
                    fontWeight: "500",
                    color: "var(--text-secondary)",
                  }}
                >
                  {sector}
                </span>
              )}
              {price != null && (
                <span
                  style={{
                    fontSize: "1.125rem",
                    fontFamily: "var(--font-display)",
                    fontWeight: "700",
                    color: "var(--text-primary)",
                    fontVariantNumeric: "tabular-nums",
                    marginLeft: "4px",
                  }}
                >
                  ¥{price.toLocaleString()}
                </span>
              )}
            </div>
            {/* データ更新日 */}
            {(dataFetchedAt || scoreScoredAt) && (
              <div
                style={{
                  fontSize: "0.6875rem",
                  color: "var(--text-muted)",
                  marginTop: "10px",
                  fontFamily: "var(--font-display)",
                }}
              >
                {dataFetchedAt && (
                  <span>
                    データ更新: {new Date(dataFetchedAt).toLocaleDateString("ja-JP")}
                  </span>
                )}
                {dataFetchedAt && scoreScoredAt && (
                  <span style={{ margin: "0 8px", color: "var(--border-strong)" }}>|</span>
                )}
                {scoreScoredAt && (
                  <span>
                    スコア算出: {new Date(scoreScoredAt).toLocaleDateString("ja-JP")}
                  </span>
                )}
              </div>
            )}
          </div>

          {/* セクションナビ */}
          <nav class="section-nav animate-in animate-in-2" aria-label="ページ内ナビゲーション">
            <a href="#score">スコア</a>
            <a href="#financial">財務</a>
            <a href="#technical">テクニカル</a>
            <a href="#benefits">優待</a>
          </nav>

          {/* 総合利回りハイライト */}
          {(dividendYield != null || yutaiYield != null) && (
            <div
              class="card animate-in animate-in-3"
              style={{
                marginBottom: "18px",
                marginTop: "18px",
                textAlign: "center",
                padding: "24px 18px",
                background: "linear-gradient(135deg, rgba(232,168,56,0.06), rgba(52,211,153,0.04))",
                borderColor: "var(--border-accent)",
              }}
            >
              <div
                style={{
                  fontSize: "0.6875rem",
                  fontFamily: "var(--font-display)",
                  fontWeight: "600",
                  color: "var(--text-muted)",
                  marginBottom: "10px",
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                }}
              >
                総合利回り（配当＋優待）
              </div>
              <div
                style={{
                  fontSize: "1.75rem",
                  fontFamily: "var(--font-display)",
                  fontWeight: "800",
                  background: "linear-gradient(135deg, var(--accent), var(--success))",
                  WebkitBackgroundClip: "text",
                  WebkitTextFillColor: "transparent",
                  backgroundClip: "text",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {((dividendYield ?? 0) + (yutaiYield ?? 0)).toFixed(2)}%
              </div>
              <div
                style={{
                  fontSize: "0.75rem",
                  color: "var(--text-muted)",
                  marginTop: "6px",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                配当 {fmt(dividendYield)}% ＋ 優待 {fmt(yutaiYield)}%
              </div>
            </div>
          )}

          {/* スコアセクション */}
          <section id="score" class="card animate-in animate-in-4" style={{ marginBottom: "18px" }}>
            <h2
              style={{
                fontFamily: "var(--font-display)",
                fontSize: "0.6875rem",
                fontWeight: "600",
                color: "var(--text-muted)",
                textTransform: "uppercase" as const,
                letterSpacing: "0.08em",
                marginBottom: "20px",
              }}
            >
              スコア
            </h2>

            {/* バッジ表示 */}
            <div
              style={{
                display: "flex",
                justifyContent: "center",
                gap: "28px",
                marginBottom: "24px",
              }}
            >
              <ScoreBadge
                score={totalScore ?? 0}
                label="総合"
                size="lg"
              />
              <ScoreBadge
                score={fundamentalScore ?? 0}
                label="ファンダメンタルズ"
                size="md"
              />
              <ScoreBadge
                score={technicalScore ?? 0}
                label="テクニカル"
                size="md"
              />
            </div>

            {/* スコア内訳バーチャート */}
            {scoreDetails && (
              <div>
                <div
                  style={{
                    fontFamily: "var(--font-display)",
                    fontSize: "0.6875rem",
                    color: "var(--text-muted)",
                    fontWeight: "600",
                    marginBottom: "12px",
                    textTransform: "uppercase" as const,
                    letterSpacing: "0.08em",
                  }}
                >
                  ファンダメンタルズ内訳
                </div>
                <ScoreBar label="PER" score={scoreDetails.perScore} />
                <ScoreBar label="PBR" score={scoreDetails.pbrScore} />
                <ScoreBar label="配当利回り" score={scoreDetails.dividendYieldScore} />
                <ScoreBar label="ROE" score={scoreDetails.roeScore} />
                <ScoreBar label="優待利回り" score={scoreDetails.yutaiYieldScore} />

                <div
                  style={{
                    fontFamily: "var(--font-display)",
                    fontSize: "0.6875rem",
                    color: "var(--text-muted)",
                    fontWeight: "600",
                    margin: "20px 0 12px",
                    textTransform: "uppercase" as const,
                    letterSpacing: "0.08em",
                  }}
                >
                  テクニカル内訳
                </div>
                <ScoreBar label="MA乖離率" score={scoreDetails.maDeviationScore} />
                <ScoreBar label="RSI" score={scoreDetails.rsiScore} />
                <ScoreBar label="MACD" score={scoreDetails.macdScore} />
              </div>
            )}
          </section>

          {/* 財務指標テーブル（折りたたみ） */}
          <details id="financial" class="section-card animate-in animate-in-5">
            <summary>
              <span
                style={{
                  fontFamily: "var(--font-display)",
                  fontSize: "0.6875rem",
                  fontWeight: "600",
                  color: "var(--text-muted)",
                  textTransform: "uppercase" as const,
                  letterSpacing: "0.08em",
                }}
              >
                財務指標
              </span>
              <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>▾</span>
            </summary>
            <div class="section-body" style={{ overflowX: "auto" }}>
            <table>
              <tbody>
                <tr>
                  <td style={{ color: "var(--text-secondary)" }}>PER</td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: "600" }}>
                    {fmt(per, 1)}倍
                  </td>
                </tr>
                <tr>
                  <td style={{ color: "var(--text-secondary)" }}>PBR</td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: "600" }}>
                    {fmt(pbr)}倍
                  </td>
                </tr>
                <tr>
                  <td style={{ color: "var(--text-secondary)" }}>配当利回り</td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: "600" }}>
                    {fmt(dividendYield)}%
                  </td>
                </tr>
                <tr>
                  <td style={{ color: "var(--text-secondary)" }}>EPS</td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: "600" }}>
                    {fmt(eps, 1)}
                  </td>
                </tr>
                <tr>
                  <td style={{ color: "var(--text-secondary)" }}>BPS</td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: "600" }}>
                    {fmt(bps, 1)}
                  </td>
                </tr>
                <tr>
                  <td style={{ color: "var(--text-secondary)" }}>ROE</td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: "600" }}>
                    {roe != null ? `${(roe > 1 ? roe : roe * 100).toFixed(1)}%` : "—"}
                  </td>
                </tr>
                <tr>
                  <td style={{ color: "var(--text-secondary)" }}>ROA</td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: "600" }}>
                    {roa != null ? `${(roa > 1 ? roa : roa * 100).toFixed(1)}%` : "—"}
                  </td>
                </tr>
                <tr>
                  <td style={{ color: "var(--text-secondary)" }}>優待利回り</td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: "600", color: "var(--accent)" }}>
                    {fmt(yutaiYield)}%
                  </td>
                </tr>
                <tr>
                  <td style={{ color: "var(--text-secondary)" }}>時価総額</td>
                  <td style={{ textAlign: "right", fontWeight: "600" }}>{fmtMarketCap(marketCap)}</td>
                </tr>
              </tbody>
            </table>
            </div>
          </details>

          {/* テクニカル指標テーブル（折りたたみ） */}
          <details id="technical" class="section-card">
            <summary>
              <span
                style={{
                  fontFamily: "var(--font-display)",
                  fontSize: "0.6875rem",
                  fontWeight: "600",
                  color: "var(--text-muted)",
                  textTransform: "uppercase" as const,
                  letterSpacing: "0.08em",
                }}
              >
                テクニカル指標
              </span>
              <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>▾</span>
            </summary>
            <div class="section-body" style={{ overflowX: "auto" }}>
            <table>
              <tbody>
                <tr>
                  <td style={{ color: "var(--text-secondary)" }}>移動平均（5日）</td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: "600" }}>
                    {ma5 != null ? `¥${ma5.toLocaleString()}` : "—"}
                  </td>
                </tr>
                <tr>
                  <td style={{ color: "var(--text-secondary)" }}>移動平均（25日）</td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: "600" }}>
                    {ma25 != null ? `¥${ma25.toLocaleString()}` : "—"}
                  </td>
                </tr>
                <tr>
                  <td style={{ color: "var(--text-secondary)" }}>移動平均（75日）</td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: "600" }}>
                    {ma75 != null ? `¥${ma75.toLocaleString()}` : "—"}
                  </td>
                </tr>
                <tr>
                  <td style={{ color: "var(--text-secondary)" }}>RSI（14）</td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: "600" }}>
                    {rsi14 != null ? fmt(rsi14, 1) : "—"}
                  </td>
                </tr>
                <tr>
                  <td style={{ color: "var(--text-secondary)" }}>MA25乖離率</td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: "600" }}>
                    {price != null && ma25 != null && ma25 !== 0
                      ? `${(((price - ma25) / ma25) * 100).toFixed(1)}%`
                      : "—"}
                  </td>
                </tr>
                <tr>
                  <td style={{ color: "var(--text-secondary)" }}>MACD</td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: "600" }}>
                    {macd != null ? fmt(macd, 2) : "—"}
                  </td>
                </tr>
                <tr>
                  <td style={{ color: "var(--text-secondary)" }}>MACDシグナル</td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: "600" }}>
                    {macdSignal != null ? fmt(macdSignal, 2) : "—"}
                  </td>
                </tr>
              </tbody>
            </table>
            </div>
          </details>

          {/* 優待情報 */}
          <section id="benefits" class="card" style={{ marginBottom: "18px" }}>
            <h2
              style={{
                fontFamily: "var(--font-display)",
                fontSize: "0.6875rem",
                fontWeight: "600",
                color: "var(--text-muted)",
                textTransform: "uppercase" as const,
                letterSpacing: "0.08em",
                marginBottom: "20px",
              }}
            >
              株主優待情報
            </h2>

            {benefits.length === 0 ? (
              <p style={{ color: "var(--text-muted)" }}>優待情報がありません。</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
                {benefits.map((b) => (
                  <div
                    style={{
                      borderLeft: "3px solid var(--accent)",
                      paddingLeft: "16px",
                      position: "relative",
                    }}
                  >
                    {/* ゴールドのグロー効果 */}
                    <div
                      style={{
                        position: "absolute",
                        left: "-2px",
                        top: "0",
                        bottom: "0",
                        width: "3px",
                        background: "var(--accent)",
                        boxShadow: "0 0 8px var(--accent-glow)",
                        borderRadius: "2px",
                      }}
                    />
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "10px",
                        marginBottom: "8px",
                      }}
                    >
                      <a
                        href={`/genres/${b.genreSlug}`}
                        class="tag"
                        style={{ textDecoration: "none" }}
                      >
                        {b.genreName}
                      </a>
                      <span
                        style={{
                          fontSize: "0.75rem",
                          fontFamily: "var(--font-display)",
                          fontWeight: "500",
                          color: "var(--text-muted)",
                        }}
                      >
                        {b.recordMonth}月権利確定
                      </span>
                    </div>
                    {b.shortSummary && (
                      <p
                        style={{
                          fontFamily: "var(--font-display)",
                          fontSize: "0.9375rem",
                          fontWeight: "600",
                          lineHeight: "1.5",
                          marginBottom: "8px",
                          color: "var(--text-primary)",
                        }}
                      >
                        {b.shortSummary}
                      </p>
                    )}
                    <p
                      style={{
                        fontSize: "0.8125rem",
                        lineHeight: "1.65",
                        marginBottom: "10px",
                        color: "var(--text-secondary)",
                        whiteSpace: "pre-wrap",
                      }}
                    >
                      {b.shortSummary ?? ""}
                    </p>
                    <dl
                      style={{
                        fontSize: "0.75rem",
                        display: "grid",
                        gridTemplateColumns: "1fr 1fr",
                        gap: "8px 16px",
                        margin: "0",
                        fontVariantNumeric: "tabular-nums",
                        padding: "12px",
                        borderRadius: "var(--radius-sm)",
                        background: "var(--bg-elevated)",
                        border: "1px solid var(--border-subtle)",
                      }}
                    >
                      <dt style={{ color: "var(--text-muted)" }}>最低株数</dt>
                      <dd style={{ color: "var(--text-primary)", fontWeight: "600", textAlign: "right", margin: "0" }}>
                        {b.minShares.toLocaleString()}株
                      </dd>
                      {price != null && (
                        <>
                          <dt style={{ color: "var(--text-muted)" }}>必要投資額</dt>
                          <dd style={{ color: "var(--text-primary)", fontWeight: "600", textAlign: "right", margin: "0" }}>
                            ¥{(price * b.minShares).toLocaleString()}
                          </dd>
                        </>
                      )}
                      {b.estimatedValue != null && (
                        <>
                          <dt style={{ color: "var(--text-muted)" }}>推定価値</dt>
                          <dd style={{ color: "var(--text-primary)", fontWeight: "600", textAlign: "right", margin: "0" }}>
                            ¥{b.estimatedValue.toLocaleString()}
                          </dd>
                        </>
                      )}
                      {b.estimatedValue != null && price != null && price > 0 && (
                        <>
                          <dt style={{ color: "var(--text-muted)" }}>優待利回り</dt>
                          <dd style={{ color: "var(--accent)", fontWeight: "700", textAlign: "right", margin: "0" }}>
                            {((b.estimatedValue / (price * b.minShares)) * 100).toFixed(2)}%
                          </dd>
                        </>
                      )}
                    </dl>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* 戻るリンク */}
          <div
            style={{
              display: "flex",
              gap: "12px",
              marginTop: "28px",
              flexWrap: "wrap",
            }}
          >
            {backGenre && (
              <a href={`/genres/${backGenre.genreSlug}`} class="btn">
                &larr; {backGenre.genreName}一覧へ戻る
              </a>
            )}
            <a href="/" class="btn">
              &larr; ホームへ戻る
            </a>
          </div>
        </div>
      </main>
    </Layout>
  );
};

export default StockDetail;
