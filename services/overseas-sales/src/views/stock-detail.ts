import { layout, h } from "./layout.js";
import { BASE_PATH } from "../../base-path.js";
import { termTip, TERM_TIP_STYLES } from "../../../../src/shared/term-tip.js";
import type { OverseasTrend, OverseasYearPoint } from "../services/overseas-query.js";

/** 円 → 億円 表示 (欠損は「—」。0 で埋めない) */
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
  no_overseas_table: "海外（地域別）売上の開示なし",
  parse_error: "解析エラー (原典要確認)",
};

/**
 * 海外売上高(億円) の積み上げ棒 + 海外売上高比率の折れ線 (依存なし・決定論的)。
 * - 棒 = 連結売上高。下=海外売上高(濃い塗り)、上=国内ほか(ハッチング)で total まで。
 * - 折れ線 = 海外売上高比率 (右軸 0-100%)。色覚非依存 (塗り分け + 線 + マーカ)。
 * - 全期間スロットを描画し、欠損年は「未開示」と明示してタイムラインの穴を隠さない。
 */
function trendChart(points: OverseasYearPoint[]): string {
  if (points.length === 0) return "";
  const W = 720;
  const H = 320;
  const padL = 64;
  const padR = 52;
  const padT = 24;
  const padB = 52;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const maxYen = Math.max(
    1,
    ...points.map((p) => p.totalYen ?? p.overseasYen ?? 0)
  );
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
      pts.push({ x: cx, ratio: p.ratioPct });
      if (p.overseasYen === null && p.totalYen === null) {
        const phW = barW + 6;
        const phY = padT + innerH * 0.6;
        return `<rect x="${cx - phW / 2}" y="${phY}" width="${phW}" height="${innerH * 0.4}" fill="none" stroke="var(--border-soft)" stroke-width="1.5" stroke-dasharray="4 3"/>
<text x="${cx}" y="${phY + innerH * 0.2 + 4}" text-anchor="middle" font-family="var(--font-mono)" font-size="10" fill="var(--text-muted)">未開示</text>${label}`;
      }
      const total = p.totalYen ?? p.overseasYen ?? 0;
      const ov = p.overseasYen ?? 0;
      const x = cx - barW / 2;
      const totalH = (total / maxYen) * innerH;
      const ovH = (ov / maxYen) * innerH;
      const domH = Math.max(0, totalH - ovH);
      const yTotalTop = padT + innerH - totalH;
      const ovRect = `<rect x="${x}" y="${padT + innerH - ovH}" width="${barW}" height="${ovH}" fill="var(--bg-invert)" stroke="var(--border)" stroke-width="1.5"><title>海外売上高 ${fy}: ${oku(p.overseasYen)} 億円</title></rect>`;
      const domRect =
        domH > 0.5
          ? `<rect x="${x}" y="${yTotalTop}" width="${barW}" height="${domH}" fill="url(#osHatch)" stroke="var(--border)" stroke-width="1.5"><title>国内ほか ${fy}: ${oku(total - ov)} 億円 / 連結売上高 ${oku(p.totalYen)} 億円</title></rect>`
          : "";
      return domRect + ovRect + label;
    })
    .join("");

  // 比率の折れ線 (欠損は線を切る)
  const ratioY = (r: number) => padT + innerH * (1 - Math.min(100, r) / 100);
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
    ? `<path d="${path}" fill="none" stroke="var(--text)" stroke-width="2.5" stroke-dasharray="1 0"/>${dots.join("")}`
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
    <desc>濃い棒が海外売上高、ハッチングが国内ほかで合わせて連結売上高。折れ線が海外売上高比率(右軸%)。「未開示」はその年度に地域別売上の開示が無いことを示します。</desc>
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
      <tr><td class="muted">&#12288;連結売上高</td><td class="num muted">${oku(p.totalYen)}</td><td class="num muted">100%</td></tr>${segRows}`;
    })
    .join("");
  return `<table>
  <thead><tr><th>会計期末 / 地域</th><th class="num">${termTip("海外売上高", "海外（日本以外）の顧客向け売上高。億円表示。会社が地域別に開示した海外地域の合計です。")} (億円)</th><th class="num">${termTip("海外売上高比率", "海外売上高 ÷ 連結売上高。会社の売上のうち海外がどれだけを占めるかを表します。高いほど為替や海外景気の影響を受けやすい一方、内需縮小に強い面があります。")}</th></tr></thead>
  <tbody>${body}</tbody>
</table>`;
}

export function stockDetailPage(trend: OverseasTrend): string {
  const { stock, points, documents, hasStructuredData } = trend;

  const latestDoc = documents[0];
  const statusPill = latestDoc
    ? `<span class="pill">${h(PARSE_STATUS_LABEL[latestDoc.parseStatus] ?? latestDoc.parseStatus)}</span>`
    : `<span class="pill">有報未取得</span>`;

  let main: string;
  if (hasStructuredData) {
    const latest = [...points].reverse().find((p) => p.overseasYen !== null);
    const summary = latest
      ? `<div class="latest-stat">
      <div><span class="lbl">最新 ${h(latest.fiscalYearEnd)}</span></div>
      <div><span class="lbl">${termTip("海外売上高", "海外（日本以外）向け売上高の合計。億円表示。")}</span><span class="val">${oku(latest.overseasYen)}<small> 億円</small></span></div>
      <div><span class="lbl">${termTip("海外売上高比率", "海外売上高 ÷ 連結売上高。売上の海外依存度。")}</span><span class="val">${pctStr(latest.ratioPct)}</span></div>
      <div><span class="lbl">${termTip("連結売上高", "会社とその子会社をまとめた売上高の合計。海外売上高比率の分母です。")}</span><span class="val">${oku(latest.totalYen)}<small> 億円</small></span></div>
    </div>`
      : "";
    main = `${summary}${trendChart(points)}
  <div class="section-label">YEARLY — 最大5年 (地域別内訳付き)</div>
  <div class="table-wrap">${yearTable(points)}</div>`;
  } else if (documents.length === 0) {
    main = `<div class="notice"><strong>この銘柄の有価証券報告書はまだ取り込まれていません。</strong>
    <span class="st">取込未実施、または EDINET に対象期間の有報がありません</span></div>`;
  } else {
    main = `<div class="notice"><strong>海外（地域別）売上高の構造化データはありません。</strong>
    <span class="st">${h(PARSE_STATUS_LABEL[latestDoc.parseStatus] ?? latestDoc.parseStatus)} — 海外売上の開示が無い(内需企業)、または開示形式が現行パーサ未対応</span></div>`;
  }

  const docList = documents.length
    ? `<div class="section-label">SOURCE — 取り込んだ有報</div>
  <div class="table-wrap"><table><thead><tr><th>会計期末</th><th>種別</th><th>提出日</th><th>EDINET docID</th><th>構造化結果</th></tr></thead><tbody>
  ${documents
    .map(
      (d) =>
        `<tr><td>${h(d.periodEnd)}</td><td>${d.docTypeCode === "130" ? "訂正有報" : "有報"}</td><td>${h(d.submittedAt.toISOString().slice(0, 10))}</td><td class="muted">${h(d.docId)}</td><td>${h(PARSE_STATUS_LABEL[d.parseStatus] ?? d.parseStatus)}</td></tr>`
    )
    .join("")}
  </tbody></table></div>`
    : "";

  const body = `
<div class="container">
  <p style="margin:8px 0"><a href="${BASE_PATH}/?q=${encodeURIComponent(stock.code)}">← 検索に戻る</a></p>
  <div class="detail-head">
    <span class="code">${h(stock.code)}</span>
    <h2>${h(stock.name)}</h2>
  </div>
  <p class="muted" style="font-family:var(--font-mono);font-size:12px">${h(stock.market)}${stock.sector ? " / " + h(stock.sector) : ""} ${statusPill}</p>

  <div class="section-label">海外売上高 / 海外売上高比率 の推移</div>
  ${main}
  ${docList}
  <p class="disclaimer">数値は有報の地域別売上開示を円換算し億円表示しています。海外売上高は会社が開示した海外地域行の合計で、「その他の収益」など地域に按分されない分は海外に含めません。「—」は当該欄が有報で非開示=欠損であることを示し、0 ではありません。構造化できなかった有報は数値を作らず「未対応」と明記しています。出典: 金融庁 EDINET。</p>
  <style>${TERM_TIP_STYLES}</style>
</div>`;

  return layout(`${stock.name} (${stock.code})`, body, "detail");
}
