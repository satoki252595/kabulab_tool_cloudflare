import { layout, h, tip } from "./layout.js";
import { BASE_PATH } from "../../base-path.js";
import type { StockDetail } from "../services/stock-detail-service.js";

function fmt(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !isFinite(n)) return "—";
  return n.toLocaleString("ja-JP", { maximumFractionDigits: digits });
}

function fmtPct(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return `${(n * 100).toFixed(1)}%`;
}

function fmtMarketCap(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  const oku = n / 1e8;
  if (oku >= 10000) return `${(oku / 10000).toFixed(1)}兆円`;
  return `${oku.toFixed(0)}億円`;
}

function trendLabel(t: number | null): { label: string; cls: string } {
  if (t === 1) return { label: "上昇基調", cls: "trend-up" };
  if (t === -1) return { label: "下降基調", cls: "trend-down" };
  if (t === 0) return { label: "横ばい", cls: "trend-flat" };
  return { label: "—", cls: "trend-flat" };
}

/**
 * RSI 値 + パーセンタイルを表示するボックス
 *
 * @param label - 表示ラベル (例: "短期 RSI(10)")
 * @param tipKey - tip() ヘルパに渡すキー (例: "rsi10") — ホバー説明を出す
 */
function rsiBox(label: string, tipKey: string, rsi: number | null, pct: number | null): string {
  const pctColor =
    pct === null
      ? "var(--text-muted)"
      : pct <= 5
        ? "var(--danger)"
        : pct <= 20
          ? "var(--success)"
          : "var(--text-muted)";
  return `
    <div style="background:var(--bg);padding:16px;border-radius:var(--radius);border:2px solid var(--border)">
      <div style="font-family:var(--font-mono);font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.08em;font-weight:600">${tip(tipKey, h(label))}</div>
      <div style="font-family:var(--font-mono);font-size:24px;color:var(--text);font-weight:700;margin-top:8px;font-variant-numeric:tabular-nums">
        ${fmt(rsi, 1)}
      </div>
      <div style="font-family:var(--font-mono);font-size:11px;color:${pctColor};margin-top:4px;font-weight:600">
        BOTTOM ${fmt(pct, 1)}%
      </div>
    </div>`;
}

/**
 * 単一メトリクスを表示するボックス
 *
 * @param label  - 表示ラベル (例: "PER")
 * @param tipKey - tip() ヘルパに渡すキー (例: "per") — 空文字なら tooltip 無し
 * @param value  - 値の文字列
 * @param unit   - 単位 (例: "倍")
 */
function metricBox(label: string, tipKey: string, value: string, unit?: string): string {
  const labelHtml = tipKey ? tip(tipKey, h(label)) : h(label);
  return `
    <div style="background:var(--bg);padding:16px;border-radius:var(--radius);border:2px solid var(--border)">
      <div style="font-family:var(--font-mono);font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.08em;font-weight:600">${labelHtml}</div>
      <div style="font-family:var(--font-mono);font-size:22px;color:var(--text);font-weight:700;margin-top:8px;font-variant-numeric:tabular-nums">
        ${h(value)}${unit ? `<span style="font-size:13px;color:var(--text-muted);margin-left:4px;font-weight:500">${h(unit)}</span>` : ""}
      </div>
    </div>`;
}

/** TTM 営業利益率を %ラベル + 色クラスに整形 */
function fmtOpMarginTtm(om: number | null): { label: string; cls: string } {
  if (om === null) return { label: "—", cls: "trend-flat" };
  const pct = om * 100;
  const cls = pct >= 10 ? "trend-up" : pct >= 5 ? "trend-up" : pct < 0 ? "trend-down" : "trend-flat";
  return { label: pct.toFixed(1) + "%", cls };
}

/** 銘柄詳細ページ */
export function stockDetailPage(props: { detail: StockDetail }): string {
  const { detail } = props;
  const revTrend = trendLabel(detail.rsi?.revenueTrend ?? null);
  const omTtm = fmtOpMarginTtm(detail.rsi?.operatingMarginTtm ?? null);

  const rsiSection = detail.rsi
    ? `
      <div class="card" style="margin-bottom:20px">
        <div class="section-label" style="margin-bottom:12px">001 / RSI PERCENTILE (5Y)</div>
        <h3 style="margin-bottom:16px">${tip("rsi", "RSI")} ${tip("percentile", "パーセンタイル")}</h3>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px">
          ${rsiBox("短期 RSI(10)", "rsi10", detail.rsi.rsi10, detail.rsi.rsi10Percentile)}
          ${rsiBox("中期 RSI(40)", "rsi40", detail.rsi.rsi40, detail.rsi.rsi40Percentile)}
          ${rsiBox("長期 RSI(120)", "rsi120", detail.rsi.rsi120, detail.rsi.rsi120Percentile)}
          <div style="background:var(--bg-invert);color:var(--text-invert);padding:16px;border-radius:var(--radius);border:2px solid var(--border)">
            <div style="font-family:var(--font-mono);font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.08em;font-weight:600">${tip("rsiMin", "MIN PCTILE")}</div>
            <div style="font-family:var(--font-mono);font-size:28px;color:var(--text-invert);font-weight:700;margin-top:8px;font-variant-numeric:tabular-nums">
              ${fmt(detail.rsi.rsiMinPercentile, 1)}
            </div>
            <div style="font-family:var(--font-mono);font-size:10px;color:var(--text-muted);margin-top:4px;text-transform:uppercase;letter-spacing:0.06em">5Y BOTTOM ◯%</div>
          </div>
        </div>
      </div>`
    : "";

  const fundamentalsSection = detail.financials
    ? `
      <div class="card" style="margin-bottom:20px">
        <div class="section-label" style="margin-bottom:12px">002 / FUNDAMENTALS</div>
        <h3 style="margin-bottom:16px">${tip("fundamental", "ファンダメンタルズ")}</h3>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px">
          ${metricBox("株価", "", fmt(detail.financials.price, 0), "円")}
          ${metricBox("時価総額", "marketCap", fmtMarketCap(detail.financials.marketCap))}
          ${metricBox("PER", "per", fmt(detail.financials.per, 1), "倍")}
          ${metricBox("PBR", "pbr", fmt(detail.financials.pbr, 2), "倍")}
          ${metricBox("配当利回り", "dividend", fmt(detail.financials.dividendYield, 2), "%")}
          ${metricBox("ROE", "roe", fmtPct(detail.financials.roe))}
          ${metricBox("ROA", "roa", fmtPct(detail.financials.roa))}
          ${metricBox("営業利益率TTM", "operatingMarginTtm", fmtPct(detail.financials.operatingMargin))}
          ${metricBox("EPS", "eps", fmt(detail.financials.eps, 0), "円")}
        </div>
        <p style="font-family:var(--font-mono);font-size:10px;color:var(--text-muted);margin-top:14px;text-transform:uppercase;letter-spacing:0.06em">
          DATA DATE: ${h(detail.financials.dataDate)}
        </p>
      </div>`
    : "";

  const annualRows = detail.annualFinancials
    .map(
      (f) => `
        <tr>
          <td>${h(String(f.fiscalYear))}</td>
          <td class="num">${fmtMarketCap(f.revenue)}</td>
        </tr>`
    )
    .join("");

  const annualTable =
    detail.annualFinancials.length > 0
      ? `<table>
          <thead>
            <tr>
              <th>年度</th><th class="num">売上高</th>
            </tr>
          </thead>
          <tbody>${annualRows}</tbody>
        </table>`
      : "";

  const body = `
    <div class="container">
      <div style="margin:0 0 24px">
        <a href="${BASE_PATH}/screening" style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.08em;font-weight:600">
          ← BACK TO SCREENING
        </a>
        <h2 style="margin-top:12px;font-size:36px">
          <span style="font-family:var(--font-mono);color:var(--text-muted);font-size:24px;font-weight:700">${h(detail.code)}</span>
          <span>${h(detail.name)}</span>
          ${
            detail.rsi?.isBlueChip
              ? `<span class="badge badge-good" style="margin-left:12px;vertical-align:middle">${tip("blueChip", "BLUE CHIP")}</span>`
              : ""
          }
        </h2>
        <p style="color:var(--text-muted);font-family:var(--font-mono);font-size:11px;text-transform:uppercase;letter-spacing:0.08em;margin-top:8px">
          ${h(detail.market)}${detail.sector ? ` · ${h(detail.sector)}` : ""}
        </p>
      </div>

      ${rsiSection}
      ${fundamentalsSection}

      <div class="card" style="margin-bottom:20px">
        <div class="section-label" style="margin-bottom:12px">003 / GROWTH &amp; PROFITABILITY</div>
        <h3 style="margin-bottom:16px">成長と収益性</h3>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:16px">
          <div>
            <div style="font-family:var(--font-mono);font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.08em;font-weight:600;margin-bottom:6px">${tip("revenueTrend", "REVENUE 3Y TREND")}</div>
            <div class="${revTrend.cls}" style="font-family:var(--font-display);font-size:20px;font-weight:700">${h(revTrend.label)}</div>
          </div>
          <div>
            <div style="font-family:var(--font-mono);font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.08em;font-weight:600;margin-bottom:6px">${tip("operatingMarginTtm", "OP MARGIN (TTM)")}</div>
            <div class="${omTtm.cls}" style="font-family:var(--font-display);font-size:20px;font-weight:700">${h(omTtm.label)}</div>
          </div>
        </div>
        ${annualTable}
      </div>
    </div>
  `;

  return layout(`${detail.code} ${detail.name} | RSI Screening`, body);
}
