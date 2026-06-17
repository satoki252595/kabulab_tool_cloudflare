import type { FC } from "hono/jsx";
import ScoreBadge from "./score-badge.js";

type StockCardProps = {
  /** 銘柄コード */
  code: string;
  /** 銘柄名 */
  name: string;
  /** ジャンル名リスト */
  genres: string[];
  /** ファンダメンタルスコア */
  fundamentalScore: number | null;
  /** テクニカルスコア */
  technicalScore: number | null;
  /** 総合スコア */
  totalScore: number | null;
  /** PER */
  per: number | null;
  /** PBR */
  pbr: number | null;
  /** 配当利回り (%) */
  dividendYield: number | null;
  /** 株価（オプション） */
  price?: number | null;
  /** 最低投資額（オプション） */
  minInvestment?: number | null;
  /** 権利確定月リスト（オプション） */
  recordMonths?: number[];
  /** 優待内容サマリー */
  benefitSummary: string;
};

/**
 * 銘柄カードコンポーネント
 * — ガラスモーフィズムカード + ゴールドアクセントのホバーボーダー
 */
const StockCard: FC<StockCardProps> = (props) => {
  const {
    code,
    name,
    genres,
    totalScore,
    per,
    pbr,
    dividendYield,
    price,
    minInvestment,
    recordMonths,
    benefitSummary,
  } = props;

  return (
    <a href={`/stocks/${code}`} style={{ textDecoration: "none", color: "inherit", display: "block" }}>
      <div
        class="card"
        style={{ marginBottom: "14px", position: "relative", overflow: "hidden" }}
      >
        {/* 上部のアクセントライン */}
        <div
          style={{
            position: "absolute",
            top: "0",
            left: "18px",
            right: "18px",
            height: "1px",
            background: "linear-gradient(90deg, transparent, var(--accent-glow), transparent)",
            opacity: "0",
            transition: "opacity 0.3s",
          }}
          class="card-accent-line"
        />

        {/* 1行目：銘柄コード＋名前＋総合スコア */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: "12px",
            marginBottom: "10px",
          }}
        >
          <div style={{ display: "flex", alignItems: "baseline", gap: "10px", minWidth: "0" }}>
            <span
              style={{
                fontFamily: "var(--font-display)",
                fontSize: "0.8125rem",
                color: "var(--accent)",
                fontWeight: "700",
                fontVariantNumeric: "tabular-nums",
                flexShrink: "0",
                letterSpacing: "0.02em",
              }}
            >
              {code}
            </span>
            <span
              style={{
                fontFamily: "var(--font-display)",
                fontSize: "1rem",
                fontWeight: "600",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                letterSpacing: "-0.01em",
              }}
            >
              {name}
            </span>
          </div>
          <ScoreBadge score={totalScore ?? 0} label="" size="sm" />
        </div>

        {/* 2行目：優待内容 */}
        {benefitSummary && (
          <div
            style={{
              fontSize: "0.8125rem",
              color: "var(--text-secondary)",
              lineHeight: "1.55",
              marginBottom: "12px",
              paddingLeft: "12px",
              borderLeft: "2px solid var(--border-accent)",
            }}
          >
            {benefitSummary}
          </div>
        )}

        {/* 3行目：株価・投資額・権利月 */}
        {(price != null || minInvestment != null || (recordMonths && recordMonths.length > 0)) && (
          <div
            style={{
              display: "flex",
              gap: "16px",
              fontSize: "0.75rem",
              color: "var(--text-muted)",
              marginBottom: "12px",
              flexWrap: "wrap",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {price != null && (
              <span>
                株価{" "}
                <strong style={{ color: "var(--text-primary)", fontWeight: "600" }}>
                  ¥{price.toLocaleString()}
                </strong>
              </span>
            )}
            {minInvestment != null && (
              <span>
                投資額{" "}
                <strong style={{ color: "var(--text-primary)", fontWeight: "600" }}>
                  ¥{minInvestment.toLocaleString()}
                </strong>
              </span>
            )}
            {recordMonths && recordMonths.length > 0 && (
              <span>
                権利月{" "}
                <strong style={{ color: "var(--accent)", fontWeight: "600" }}>
                  {recordMonths.map((m) => `${m}月`).join("・")}
                </strong>
              </span>
            )}
          </div>
        )}

        {/* 4行目：財務指標 — ピル型 */}
        <div
          style={{
            display: "flex",
            gap: "8px",
            fontSize: "0.6875rem",
            marginBottom: genres.length > 0 ? "12px" : "0",
            flexWrap: "wrap",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          <span
            style={{
              padding: "3px 10px",
              borderRadius: "var(--radius-full)",
              background: "var(--bg-elevated)",
              border: "1px solid var(--border-subtle)",
              color: "var(--text-secondary)",
            }}
          >
            PER{" "}
            <strong style={{ color: "var(--text-primary)", fontWeight: "600" }}>
              {per != null ? per.toFixed(1) : "—"}
            </strong>
          </span>
          <span
            style={{
              padding: "3px 10px",
              borderRadius: "var(--radius-full)",
              background: "var(--bg-elevated)",
              border: "1px solid var(--border-subtle)",
              color: "var(--text-secondary)",
            }}
          >
            PBR{" "}
            <strong style={{ color: "var(--text-primary)", fontWeight: "600" }}>
              {pbr != null ? pbr.toFixed(2) : "—"}
            </strong>
          </span>
          <span
            style={{
              padding: "3px 10px",
              borderRadius: "var(--radius-full)",
              background: "var(--bg-elevated)",
              border: "1px solid var(--border-subtle)",
              color: "var(--text-secondary)",
            }}
          >
            配当{" "}
            <strong style={{ color: "var(--text-primary)", fontWeight: "600" }}>
              {dividendYield != null ? `${dividendYield.toFixed(2)}%` : "—"}
            </strong>
          </span>
        </div>

        {/* 5行目：ジャンルタグ */}
        {genres.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
            {genres.map((genre) => (
              <span class="tag">{genre}</span>
            ))}
          </div>
        )}
      </div>

      <style>{`
        a:hover .card-accent-line {
          opacity: 1 !important;
        }
      `}</style>
    </a>
  );
};

export default StockCard;
