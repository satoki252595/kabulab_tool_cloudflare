/**
 * 個別銘柄ページの「海外売上高 / 海外売上高比率」セクション。
 * 受注セクション (stock-detail.ts) の下に並べて、同じ有報から構造化した海外売上を
 * 積み上げ棒 (海外/国内ほか) + 比率の折れ線 (右軸) で可視化する。
 */
import { h } from "./layout.js";
import { termTip, TERM_TIP_STYLES } from "../../../../src/shared/term-tip.js";
import type {
  OverseasTrend,
  OverseasYearPoint,
} from "../services/overseas-query.js";

function oku(yen: number | null): string {
  if (yen === null) return "—";
  return (yen / 1e8).toLocaleString("ja-JP", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}
function pctStr(v: number | null): string {
  return v === null ? "—" : `${v.toFixed(1)}%`;
}

const PARSE_STATUS_LABEL: Record<string, string> = {
  ok_geo_rows: "構造化済 (地域別売上・地域=行)",
  ok_geo_cols: "構造化済 (地域別売上・地域=列)",
  geo_present_unstructured: "未対応 (地域別売上はあるが構造を判定できず)",
  no_overseas_table: "構造化できる海外（地域別）売上の表を確認できず",
  parse_error: "解析エラー (原典要確認)",
};

/** 海外売上高(積み上げ棒) + 海外売上高比率(折れ線・右軸) の SVG。 */
function trendChart(points: OverseasYearPoint[]): string {
  if (points.length === 0) return "";
  const comparable = (p: OverseasYearPoint): p is OverseasYearPoint & { totalYen: number; overseasYen: number } =>
    p.totalYen !== null && p.overseasYen !== null && Number.isFinite(p.totalYen) && Number.isFinite(p.overseasYen) &&
    p.totalYen >= 0 && p.overseasYen >= 0 && p.overseasYen <= p.totalYen &&
    (p.ratioPct === null || (Number.isFinite(p.ratioPct) && p.ratioPct >= 0 && p.ratioPct <= 100));
  const observed = points.filter(comparable);
  if (observed.length === 0) return '<p class="muted">グラフに必要な売上合計と海外売上が未取得か、原典の確認が必要です。取得済みの値は下の表をご確認ください。</p>';
  const W = 720;
  const H = 320;
  const padL = 64;
  const padR = 52;
  const padT = 24;
  const padB = 52;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  // 全て実0円の場合も描画の分母は正にする。金融値は補完しない。
  const maxYen = Math.max(1, ...observed.map((p) => p.totalYen));
  const maxOku = maxYen / 1e8;
  const groupW = innerW / points.length;
  const barW = Math.min(54, groupW * 0.5);

  const gridLines = [0, 0.25, 0.5, 0.75, 1]
    .map((f) => {
      const y = padT + innerH * (1 - f);
      return `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="var(--border-soft)" stroke-width="1"/>
<text x="${padL - 8}" y="${y + 4}" text-anchor="end" font-family="var(--font-mono)" font-size="10" fill="var(--text-muted)">${(maxOku * f).toLocaleString("ja-JP", { maximumFractionDigits: 0 })}</text>
<text x="${W - padR + 8}" y="${y + 4}" text-anchor="start" font-family="var(--font-mono)" font-size="10" fill="var(--text-muted)">${(100 * f).toFixed(0)}%</text>`;
    })
    .join("");

  const pts: Array<{ x: number; ratio: number | null }> = [];
  const bars = points
    .map((p, i) => {
      const cx = padL + groupW * i + groupW / 2;
      const fy = p.fiscalYearEnd.slice(0, 7);
      const label = `<text x="${cx}" y="${H - padB + 20}" text-anchor="middle" font-family="var(--font-mono)" font-size="11" fill="var(--text-secondary)">${h(fy)}</text>`;
      pts.push({ x: cx, ratio: comparable(p) ? p.ratioPct : null });
      if (!comparable(p)) {
        const phW = barW + 6;
        const phY = padT + innerH * 0.6;
        const missing = p.overseasYen === null && p.totalYen === null ? "データなし"
          : p.overseasYen === null ? "海外売上未取得" : p.totalYen === null ? "売上合計未取得" : "原典要確認";
        return `<rect x="${cx - phW / 2}" y="${phY}" width="${phW}" height="${innerH * 0.4}" fill="none" stroke="var(--border-soft)" stroke-width="1.5" stroke-dasharray="4 3"/>
<text x="${cx}" y="${phY + innerH * 0.2 + 4}" text-anchor="middle" font-family="var(--font-mono)" font-size="10" fill="var(--text-muted)">${missing}</text>${label}`;
      }
      const total = p.totalYen;
      const ov = p.overseasYen;
      const x = cx - barW / 2;
      const totalH = (total / maxYen) * innerH;
      const ovH = (ov / maxYen) * innerH;
      const domH = totalH - ovH;
      const yTotalTop = padT + innerH - totalH;
      const ovRect = `<rect x="${x}" y="${padT + innerH - ovH}" width="${barW}" height="${ovH}" fill="var(--bg-invert)" stroke="var(--border)" stroke-width="1.5"><title>海外売上高 ${fy}: ${oku(p.overseasYen)} 億円</title></rect>`;
      const domRect =
        domH > 0.5
          ? `<rect x="${x}" y="${yTotalTop}" width="${barW}" height="${domH}" fill="url(#osHatch)" stroke="var(--border)" stroke-width="1.5"><title>国内ほか ${fy}: ${oku(total - ov)} 億円 / 連結売上高 ${oku(p.totalYen)} 億円</title></rect>`
          : "";
      return domRect + ovRect + label;
    })
    .join("");

  const ratioY = (r: number) => padT + innerH * (1 - r / 100);
  let path = "";
  let prev: { x: number; ratio: number } | null = null;
  const dots: string[] = [];
  for (const pt of pts) {
    if (pt.ratio === null) {
      prev = null;
      continue;
    }
    const y = ratioY(pt.ratio);
    path += prev ? ` L${pt.x},${y}` : `M${pt.x},${y}`;
    dots.push(
      `<circle cx="${pt.x}" cy="${y}" r="4" fill="var(--bg-pure)" stroke="var(--text)" stroke-width="2"><title>海外売上高比率 ${pt.ratio.toFixed(1)}%</title></circle>`
    );
    prev = { x: pt.x, ratio: pt.ratio };
  }
  const ratioLine = path
    ? `<path d="${path}" fill="none" stroke="var(--text)" stroke-width="2.5"/>${dots.join("")}`
    : "";

  const first = points[0].fiscalYearEnd.slice(0, 7);
  const last = points[points.length - 1].fiscalYearEnd.slice(0, 7);

  return `
<div class="chart-wrap">
  <div class="chart-legend">
    <span><i class="sw-overseas"></i>海外売上高</span>
    <span><i class="sw-domestic"></i>国内ほか</span>
    <span><i class="sw-ratio"></i>${termTip("海外売上高比率", "海外売上高 ÷ 連結売上高。右の軸(0〜100%)で読みます。棒は左軸の億円。線が右肩上がりなら海外シフトが進行。")}<small style="margin-left:4px">(右軸)</small></span>
    <span>左軸: 億円 / 右軸: %</span>
  </div>
  <svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" role="img" aria-label="海外売上高(億円)と海外売上高比率(%)の推移 ${h(first)}〜${h(last)}">
    <desc>濃い棒が海外売上高、ハッチングが国内ほかで合わせて連結売上高。折れ線が海外売上高比率(右軸%)。「データなし」は構造化された値がない年度です。開示の有無は原典をご確認ください。</desc>
    <defs><pattern id="osHatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="6" height="6" fill="var(--bg-pure)"/><line x1="0" y1="0" x2="0" y2="6" stroke="var(--border)" stroke-width="2"/>
    </pattern></defs>
    ${gridLines}
    <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + innerH}" stroke="var(--border)" stroke-width="2"/>
    <line x1="${padL}" y1="${padT + innerH}" x2="${W - padR}" y2="${padT + innerH}" stroke="var(--border)" stroke-width="2"/>
    ${bars}
    ${ratioLine}
  </svg>
</div>`;
}

function yearTable(points: OverseasYearPoint[]): string {
  const rows = [...points].reverse();
  const body = rows
    .map((p) => {
      const segRows = p.regions
        .map(
          (s) =>
            `<tr><td class="muted">&#12288;└ ${h(s.name)}</td><td class="num">${oku(s.yen)}</td><td class="num muted">${s.ratioPct !== null ? s.ratioPct.toFixed(1) + "%" : "—"}</td></tr>`
        )
        .join("");
      const cons =
        p.isConsolidated === true ? "連結" : p.isConsolidated === false ? "個別" : "—";
      return `<tr class="total"><td>${h(p.fiscalYearEnd)}<span class="muted"> (${cons})</span></td><td class="num">${oku(p.overseasYen)}</td><td class="num">${pctStr(p.ratioPct)}</td></tr>
      <tr><td class="muted">&#12288;${termTip("連結売上高", "親会社＋子会社を合算した会社全体の売上高。海外売上高比率の分母。")}</td><td class="num muted">${oku(p.totalYen)}</td><td class="num muted">100%</td></tr>${segRows}`;
    })
    .join("");
  return `<table>
  <thead><tr><th>会計期末 / 地域</th><th class="num">${termTip("海外売上高", "海外（日本以外）の顧客向け売上高。億円表示。会社が地域別に開示した海外地域の合計です。")} (億円)</th><th class="num">${termTip("海外売上高比率", "海外売上高 ÷ 連結売上高。会社の売上のうち海外がどれだけを占めるか。")}</th></tr></thead>
  <tbody>${body}</tbody>
</table>`;
}

/** 海外売上高セクションの CSS (受注チャートと別の凡例スウォッチ等)。1ページ1回でよい。 */
export const OVERSEAS_SECTION_STYLES = `
.cross-section-rule{height:0;border-top:2px dashed var(--border-soft);margin:44px 0 0}
.chart-legend i.sw-overseas{background:var(--bg-invert)}
.chart-legend i.sw-domestic{background:var(--bg-pure);background-image:repeating-linear-gradient(45deg,var(--border) 0 2px,transparent 2px 6px)}
.chart-legend i.sw-ratio{background:var(--bg-pure);border-radius:50%;border:2px solid var(--text)}
.omission-proof{overflow-wrap:anywhere}
${TERM_TIP_STYLES}`;

/**
 * 海外売上高セクション本体。overseasTrend が null (= 海外データ無し) や未対応の
 * ときは「データなし/未対応」を正直に表示する (架空値を作らない)。
 */
export function overseasSection(trend: OverseasTrend | null): string {
  const heading = `<div class="section-label">海外売上高 / 海外売上高比率 の推移</div>`;
  if (!trend) {
    return `${heading}<div class="notice"><strong>海外（地域別）売上のデータはありません。</strong></div>`;
  }
  const { points, documents, hasStructuredData } = trend;
  const latestDoc = documents[0];
  const latestStatus = latestDoc?.overseasParseStatus ?? null;
  const omission = latestDoc?.overseasOmission;
  const omissionNotice = omission === undefined || omission === null ? "" :
    `<div class="notice"><strong>${termTip("地域別の外部顧客売上の注記を省略", "会社が原典に明記した注記の省略理由です。海外売上の金額や比率を推計するものではなく、別の売上表の数値・未対応状態とは区別します。")}</strong>
    <details class="omission-proof"><summary>原典の省略理由と出典</summary>
    <p>文書ID: ${h(omission.docId)} / ${termTip("会計期末", "会社の1年間の決算期間が終わる日です。提出日とは異なります。")}: ${h(omission.periodEnd)}</p>
    ${omission.omission.evidence.map((proof) => `<blockquote>${h(proof.quote)}</blockquote>
      <p class="muted">原文の期間: ${h(proof.contextPeriod.startDate)} ～ ${h(proof.contextPeriod.endDate)}</p>`).join("")}
    </details></div>`;

  if (hasStructuredData) {
    const latest = [...points].reverse().find((p) => p.overseasYen !== null);
    const summary = latest
      ? `<div class="latest-stat">
      <div><span class="lbl">最新 ${h(latest.fiscalYearEnd)}</span></div>
      <div><span class="lbl">${termTip("海外売上高", "海外（日本以外）向け売上高の合計。億円表示。")}</span><span class="val">${oku(latest.overseasYen)}<small> 億円</small></span></div>
      <div><span class="lbl">${termTip("海外売上高比率", "海外売上高 ÷ 連結売上高。売上の海外依存度。")}</span><span class="val">${pctStr(latest.ratioPct)}</span></div>
      <div><span class="lbl">${termTip("連結売上高", "親会社＋子会社を合算した会社全体の売上高。海外売上高比率の分母です。")}</span><span class="val">${oku(latest.totalYen)}<small> 億円</small></span></div>
    </div>`
      : "";
    return `${heading}${omissionNotice}${summary}${trendChart(points)}
  <div class="section-label">YEARLY — 最大5年 (地域別内訳付き)</div>
  <div class="table-wrap">${yearTable(points)}</div>`;
  }
  const label =
    latestStatus !== null
      ? (PARSE_STATUS_LABEL[latestStatus] ?? latestStatus)
      : "海外売上の取込はこれからです";
  return `${heading}${omissionNotice}<div class="notice"><strong>海外（地域別）売上の構造化データはありません。</strong>
    <span class="st">${h(label)} — 開示の有無や未対応の理由は原典をご確認ください</span></div>`;
}
