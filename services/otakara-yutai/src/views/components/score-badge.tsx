import type { FC } from "hono/jsx";

/** スコアに応じた色を返す */
function scoreColor(score: number): string {
  if (score >= 80) return "var(--score-high)";
  if (score >= 60) return "var(--score-mid)";
  if (score >= 40) return "var(--score-low)";
  return "var(--score-danger)";
}

/** スコアに応じたグロー色を返す */
function scoreGlow(score: number): string {
  if (score >= 80) return "rgba(52, 211, 153, 0.3)";
  if (score >= 60) return "rgba(251, 191, 36, 0.25)";
  if (score >= 40) return "rgba(251, 146, 60, 0.25)";
  return "rgba(248, 113, 113, 0.25)";
}

type ScoreBadgeProps = {
  /** スコア値（0-100） */
  score: number;
  /** バッジ下のラベル */
  label: string;
  /** バッジサイズ — "sm" | "md" | "lg" */
  size?: "sm" | "md" | "lg";
};

/**
 * スコアバッジコンポーネント
 * — SVGベースのプログレスリング + グロー効果
 */
const ScoreBadge: FC<ScoreBadgeProps> = ({ score, label, size = "md" }) => {
  const rounded = Math.round(score);
  const color = scoreColor(rounded);
  const glow = scoreGlow(rounded);

  const sizes = {
    sm: { outer: 38, stroke: 3, font: "0.75rem", labelFont: "0.625rem", gap: "3px" },
    md: { outer: 52, stroke: 3.5, font: "1rem", labelFont: "0.6875rem", gap: "5px" },
    lg: { outer: 72, stroke: 4, font: "1.5rem", labelFont: "0.6875rem", gap: "6px" },
  };

  const s = sizes[size];
  const radius = (s.outer - s.stroke * 2) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (rounded / 100) * circumference;
  const center = s.outer / 2;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: s.gap,
      }}
    >
      <div
        role="meter"
        aria-valuenow={rounded}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label ? `${label}: ${rounded}点` : `${rounded}点`}
        style={{
          position: "relative",
          width: `${s.outer}px`,
          height: `${s.outer}px`,
          filter: `drop-shadow(0 0 8px ${glow})`,
        }}
      >
        {/* SVGリング */}
        <svg
          width={s.outer}
          height={s.outer}
          viewBox={`0 0 ${s.outer} ${s.outer}`}
          style={{ transform: "rotate(-90deg)" }}
        >
          {/* 背景リング */}
          <circle
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke="var(--border-default)"
            stroke-width={s.stroke}
          />
          {/* プログレスリング */}
          <circle
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke={color}
            stroke-width={s.stroke}
            stroke-linecap="round"
            stroke-dasharray={circumference}
            stroke-dashoffset={offset}
            style={{ transition: "stroke-dashoffset 0.6s var(--ease-out)" }}
          />
        </svg>
        {/* 中央スコア値 */}
        <div
          style={{
            position: "absolute",
            inset: "0",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: "var(--font-display)",
            fontWeight: "700",
            fontSize: s.font,
            color: color,
            lineHeight: "1",
          }}
        >
          {rounded}
        </div>
      </div>
      {label && (
        <span
          style={{
            fontFamily: "var(--font-display)",
            fontSize: s.labelFont,
            fontWeight: "500",
            color: "var(--text-muted)",
            whiteSpace: "nowrap",
            letterSpacing: "0.02em",
          }}
        >
          {label}
        </span>
      )}
    </div>
  );
};

export default ScoreBadge;
