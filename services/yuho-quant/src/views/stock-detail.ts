import { layout, h } from "./layout.js";
import { BASE_PATH } from "../../base-path.js";
import { termTip } from "../../../../src/shared/term-tip.js";
import { publicStockMetaLabel } from "../../../../src/shared/db/public-columns.js";
import type { OrderTrend, OrderYearPoint } from "../services/order-query.js";
import type { OverseasTrend } from "../services/overseas-query.js";
import {
  overseasSection,
  OVERSEAS_SECTION_STYLES,
} from "./overseas-section.js";

/** 円 → 億円 表示 (欠損は「—」。0 で埋めない) */
function oku(yen: number | null): string {
  if (yen === null) return "—";
  const v = yen / 1e8;
  return v.toLocaleString("ja-JP", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

const PARSE_STATUS_LABEL: Record<string, string> = {
  ok_pattern_a: "構造化済 (受注高/受注残高セグメント表)",
  ok_pattern_b: "構造化済 (建設業 完成工事表)",
  ok_pattern_c: "構造化済 (設備/建設 完成工事高 区分別表)",
  ok_total_only: "構造化済 (全社合計のみ・セグメント別内訳は対象外)",
  orders_only: "未対応 (受注高のみ・受注残高の開示なし)",
  table_unrecognized: "未対応 (受注表の構造を判定できず)",
  no_order_table: "受注の開示なし",
  parse_error: "解析エラー (原典要確認)",
};

/**
 * 受注高/受注残高の推移 SVG (依存なし・決定論的)。
 *
 * - 全期間スロットを必ず描画し、両値とも欠損の年は「未開示」と明示して
 *   タイムラインの欠落を隠さない (designer 指摘: 欠損年が詰まって誤読される)
 * - 受注残高はハッチング塗り → 白背景でも視認でき、かつ色覚非依存
 */
function trendChart(points: OrderYearPoint[]): string {
  if (points.length === 0) return "";

  const W = 720;
  const H = 300;
  const padL = 64;
  const padR = 16;
  const padT = 20;
  const padB = 52;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const max = Math.max(
    1,
    ...points.flatMap((p) => [p.totalOrdersYen ?? 0, p.totalBacklogYen ?? 0])
  );
  const maxOku = max / 1e8;
  const groupW = innerW / points.length;
  const barW = Math.min(46, groupW / 3);

  const gridLines = [0, 0.25, 0.5, 0.75, 1]
    .map((f) => {
      const y = padT + innerH * (1 - f);
      return `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="var(--border-soft)" stroke-width="1"/>
<text x="${padL - 8}" y="${y + 4}" text-anchor="end" font-family="var(--font-mono)" font-size="10" fill="var(--text-muted)">${(maxOku * f).toLocaleString("ja-JP", { maximumFractionDigits: 0 })}</text>`;
    })
    .join("");

  const bars = points
    .map((p, i) => {
      const cx = padL + groupW * i + groupW / 2;
      const fy = p.fiscalYearEnd.slice(0, 7);
      const label = `<text x="${cx}" y="${H - padB + 20}" text-anchor="middle" font-family="var(--font-mono)" font-size="11" fill="var(--text-secondary)">${h(fy)}</text>`;
      if (p.totalOrdersYen === null && p.totalBacklogYen === null) {
        // 欠損年: 破線の空枠 +「未開示」で「ここに年があった」を明示
        // (タイムラインの穴を詰めて連続データに見せない)
        const phW = barW * 2 + 6;
        const phX = cx - phW / 2;
        const phY = padT + innerH * 0.6;
        return `<rect x="${phX}" y="${phY}" width="${phW}" height="${innerH * 0.4}" fill="none" stroke="var(--border-soft)" stroke-width="1.5" stroke-dasharray="4 3"/>
<text x="${cx}" y="${phY + innerH * 0.2 + 4}" text-anchor="middle" font-family="var(--font-mono)" font-size="10" fill="var(--text-muted)">未開示</text>${label}`;
      }
      const oH = ((p.totalOrdersYen ?? 0) / max) * innerH;
      const bH = ((p.totalBacklogYen ?? 0) / max) * innerH;
      const x1 = cx - barW - 3;
      const x2 = cx + 3;
      const oRect =
        p.totalOrdersYen === null
          ? ""
          : `<rect x="${x1}" y="${padT + innerH - oH}" width="${barW}" height="${oH}" fill="var(--bg-invert)" stroke="var(--border)" stroke-width="1.5"><title>受注高 ${fy}: ${oku(p.totalOrdersYen)} 億円</title></rect>`;
      const bRect =
        p.totalBacklogYen === null
          ? ""
          : `<rect x="${x2}" y="${padT + innerH - bH}" width="${barW}" height="${bH}" fill="url(#yqHatch)" stroke="var(--border)" stroke-width="1.5"><title>受注残高 ${fy}: ${oku(p.totalBacklogYen)} 億円</title></rect>`;
      return oRect + bRect + label;
    })
    .join("");

  const first = points[0].fiscalYearEnd.slice(0, 7);
  const last = points[points.length - 1].fiscalYearEnd.slice(0, 7);

  return `
<div class="chart-wrap">
  <div class="chart-legend">
    <span><i class="sw-orders"></i>受注高</span>
    <span><i class="sw-backlog"></i>受注残高</span>
    <span>単位: 億円</span>
    <span>「未開示」= その年度は受注表が無い</span>
  </div>
  <svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" role="img" aria-label="受注高・受注残高の推移 ${h(first)}〜${h(last)} 単位億円">
    <desc>左の濃いバーが受注高、右のハッチングのバーが受注残高。「未開示」はその年度に受注の開示が無いことを示します。単位は億円。</desc>
    <defs><pattern id="yqHatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="6" height="6" fill="var(--bg-pure)"/><line x1="0" y1="0" x2="0" y2="6" stroke="var(--border)" stroke-width="2"/>
    </pattern></defs>
    ${gridLines}
    <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + innerH}" stroke="var(--border)" stroke-width="2"/>
    <line x1="${padL}" y1="${padT + innerH}" x2="${W - padR}" y2="${padT + innerH}" stroke="var(--border)" stroke-width="2"/>
    ${bars}
  </svg>
</div>`;
}

function yearTable(points: OrderYearPoint[]): string {
  // 新しい年を上に
  const rows = [...points].reverse();
  const body = rows
    .map((p) => {
      const segRows = p.segments
        .map(
          (s) =>
            `<tr><td class="muted">&#12288;└ ${h(s.name)}</td><td class="num">${oku(s.ordersYen)}</td><td class="num">${oku(s.backlogYen)}</td></tr>`
        )
        .join("");
      const cons =
        p.isConsolidated === true
          ? "連結"
          : p.isConsolidated === false
            ? "個別"
            : "—";
      return `<tr class="total"><td>${h(p.fiscalYearEnd)}<span class="muted"> (${cons})</span></td><td class="num">${oku(p.totalOrdersYen)}</td><td class="num">${oku(p.totalBacklogYen)}</td></tr>${segRows}`;
    })
    .join("");
  return `<table>
  <thead><tr><th>会計期末 / セグメント</th><th class="num">受注高 (億円)</th><th class="num">受注残高 (億円)</th></tr></thead>
  <tbody>${body}</tbody>
</table>`;
}

export function stockDetailPage(
  trend: OrderTrend,
  overseasTrend: OverseasTrend | null
): string {
  const { stock, points, documents, hasStructuredData } = trend;

  const latestDoc = documents[0];
  const statusPill = latestDoc
    ? `<span class="pill">${h(PARSE_STATUS_LABEL[latestDoc.parseStatus] ?? latestDoc.parseStatus)}</span>`
    : `<span class="pill">有報未取得</span>`;

  let main: string;
  if (hasStructuredData) {
    // 最新 (= 末尾) で値が取れている年のサマリを冒頭に出す
    const latest = [...points].reverse().find(
      (p) => p.totalOrdersYen !== null || p.totalBacklogYen !== null
    );
    const summary = latest
      ? `<div class="latest-stat">
      <div><span class="lbl">最新 ${h(latest.fiscalYearEnd)}</span></div>
      <div><span class="lbl">${termTip("受注高", "その会計期間に新しく受けた注文の合計金額。将来の売上の種。")}</span><span class="val">${oku(latest.totalOrdersYen)}<small> 億円</small></span></div>
      <div><span class="lbl">${termTip("受注残高", "期末時点で受注済みだがまだ売上になっていない注文の残高。先々の売上の裏付け。")}</span><span class="val">${oku(latest.totalBacklogYen)}<small> 億円</small></span></div>
    </div>`
      : "";
    main = `${summary}${trendChart(points)}
  <div class="section-label">YEARLY — 最大5年 (セグメント内訳付き)</div>
  <div class="table-wrap">${yearTable(points)}</div>`;
  } else if (documents.length === 0) {
    main = `<div class="notice"><strong>この銘柄の有価証券報告書はまだ取り込まれていません。</strong>
    <span class="st">backfill 未実施、または EDINET に対象期間の有報がありません</span></div>`;
  } else {
    main = `<div class="notice"><strong>受注高 / 受注残高 の構造化データはありません。</strong>
    <span class="st">${h(PARSE_STATUS_LABEL[latestDoc.parseStatus] ?? latestDoc.parseStatus)} — 受注生産でない、または開示形式が現行パーサ未対応</span></div>`;
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
  <p class="muted" style="font-family:var(--font-mono);font-size:12px">${h(publicStockMetaLabel([stock.market, stock.sector]))} ${statusPill}</p>

  <div class="section-label">受注高 / 受注残高 の推移</div>
  ${main}

  <div class="cross-section-rule" aria-hidden="true"></div>
  ${overseasSection(overseasTrend)}

  ${docList}
  <p class="disclaimer">数値は有報の開示単位を円換算し億円表示しています。「—」は当該欄が有報で「－」等の非開示=欠損であることを示し、0 ではありません。構造化できなかった有報は数値を作らず結果を「未対応」と明記しています。受注高/受注残高 と 海外売上高 は同じ有報1通から並行して構造化しています。出典: 金融庁 EDINET。</p>
  <style>${OVERSEAS_SECTION_STYLES}</style>
</div>`;

  return layout(`${stock.name} (${stock.code})`, body, "detail");
}
