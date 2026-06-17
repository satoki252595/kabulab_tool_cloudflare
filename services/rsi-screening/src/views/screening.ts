import { layout, h, tip } from "./layout.js";
import { BASE_PATH } from "../../base-path.js";
import type { ScreeningQuery } from "../validators/screening.js";
import type { ScreeningRow } from "../services/screening-service.js";

/** 数値フォーマット */
function fmt(n: number | null, digits = 2): string {
  if (n === null || n === undefined || !isFinite(n)) return "—";
  return n.toLocaleString("ja-JP", { maximumFractionDigits: digits });
}

/** 時価総額フォーマット (億円単位) */
function fmtMarketCap(n: number | null): string {
  if (n === null) return "—";
  const oku = n / 1e8;
  if (oku >= 10000) return `${(oku / 10000).toFixed(1)}兆円`;
  return `${oku.toFixed(0)}億円`;
}

/** パーセンタイル CSS クラス (数値が低いほど底値) */
function pctBadge(p: number | null): string {
  if (p === null) return "neutral";
  if (p <= 5) return "bad"; // 下位5% (注目度高)
  if (p <= 20) return "good";
  return "neutral";
}

/** トレンドマーク */
function trendMark(t: number | null): { mark: string; cls: string } {
  if (t === 1) return { mark: "↑", cls: "trend-up" };
  if (t === -1) return { mark: "↓", cls: "trend-down" };
  if (t === 0) return { mark: "→", cls: "trend-flat" };
  return { mark: "—", cls: "trend-flat" };
}

/** TTM 営業利益率を %表示 + 良/悪の色分けセルに整形 */
function fmtOpMarginCell(om: number | null): { text: string; cls: string } {
  if (om === null) return { text: "—", cls: "trend-flat" };
  const pct = om * 100;
  const cls = pct >= 10 ? "good" : pct >= 5 ? "trend-up" : pct < 0 ? "bad" : "neutral";
  return { text: pct.toFixed(1) + "%", cls };
}

/** スクリーニングページ */
export function screeningPage(props: { query: ScreeningQuery; results: ScreeningRow[] }): string {
  const { query, results } = props;

  const periodLabel =
    query.period === "min"
      ? "3期間の最小値"
      : query.period === "10"
        ? "短期 2週間"
        : query.period === "40"
          ? "中期 2ヶ月"
          : "長期 半年";

  const sel = (cond: boolean) => (cond ? " selected" : "");

  const limitOptions = [20, 50, 100, 200]
    .map((n) => `<option value="${n}"${sel(query.limit === n)}>${n}</option>`)
    .join("");

  const rowsHtml = results
    .map((r) => {
      const rev = trendMark(r.revenueTrend);
      const om = fmtOpMarginCell(r.operatingMarginTtm);
      return `
        <tr>
          <td><a href="${BASE_PATH}/stocks/${h(r.code)}">${h(r.code)}</a></td>
          <td>${h(r.name)}</td>
          <td class="num">${fmt(r.price, 0)}</td>
          <td class="num">${fmtMarketCap(r.marketCap)}</td>
          <td class="num">${fmt(r.per, 1)}</td>
          <td class="num">${fmt(r.dividendYield, 2)}</td>
          <td class="num">${fmt(r.rsi10, 1)}</td>
          <td class="num ${pctBadge(r.rsi10Percentile)}">${fmt(r.rsi10Percentile, 1)}</td>
          <td class="num">${fmt(r.rsi40, 1)}</td>
          <td class="num ${pctBadge(r.rsi40Percentile)}">${fmt(r.rsi40Percentile, 1)}</td>
          <td class="num">${fmt(r.rsi120, 1)}</td>
          <td class="num ${pctBadge(r.rsi120Percentile)}">${fmt(r.rsi120Percentile, 1)}</td>
          <td class="num ${pctBadge(r.rsiMinPercentile)}"><strong>${fmt(r.rsiMinPercentile, 1)}</strong></td>
          <td class="${rev.cls}">${rev.mark}</td>
          <td class="num ${om.cls}">${om.text}</td>
          <td>${
            r.isBlueChip
              ? '<span class="badge badge-good">優良</span>'
              : '<span class="badge badge-neutral">—</span>'
          }</td>
        </tr>`;
    })
    .join("");

  const tableOrEmpty =
    results.length === 0
      ? `<div class="empty">条件に合致する銘柄が見つかりません</div>`
      : `<div style="overflow-x:auto"><table>
          <thead>
            <tr>
              <th>コード</th><th>銘柄名</th><th class="num">株価</th><th class="num">${tip("marketCap", "時価総額")}</th>
              <th class="num">${tip("per", "PER")}</th><th class="num">${tip("dividend", "配当%")}</th>
              <th class="num">${tip("rsi10", "RSI(10)")}</th><th class="num">${tip("percentile", "%ile")}</th>
              <th class="num">${tip("rsi40", "RSI(40)")}</th><th class="num">${tip("percentile", "%ile")}</th>
              <th class="num">${tip("rsi120", "RSI(120)")}</th><th class="num">${tip("percentile", "%ile")}</th>
              <th class="num">${tip("rsiMin", "最小%")}</th><th>${tip("revenueTrend", "売上")}</th><th class="num">${tip("operatingMarginTtm", "営利率TTM")}</th><th>${tip("blueChip", "優良")}</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table></div>`;

  const body = `
    <div class="container">
      <div class="section-label">001 / SCREENING</div>
      <h2 style="margin:0 0 20px">RSI スクリーニング</h2>
      <form method="get" action="${BASE_PATH}/screening" class="form-row">
        <div class="form-field">
          <label for="period">${tip("rsi", "RSI")} 期間</label>
          <select id="period" name="period">
            <option value="min"${sel(query.period === "min")}>3期間の最小 (底値)</option>
            <option value="10"${sel(query.period === "10")}>短期 2週(10日)</option>
            <option value="40"${sel(query.period === "40")}>中期 2ヶ月(40日)</option>
            <option value="120"${sel(query.period === "120")}>長期 半年(120日)</option>
          </select>
        </div>
        <div class="form-field">
          <label for="percentileMax">${tip("percentile", "パーセンタイル")} 上限 (%)</label>
          <input id="percentileMax" name="percentileMax" type="number" min="0" max="100" step="1" value="${h(String(query.percentileMax))}">
        </div>
        <div class="form-field">
          <label for="blueChip">${tip("blueChip", "優良株")} フィルタ</label>
          <select id="blueChip" name="blueChip">
            <option value="false"${sel(!query.blueChip)}>OFFにする (全銘柄)</option>
            <option value="true"${sel(query.blueChip)}>ONにする (売上↑ × 営利率TTM≥5%)</option>
          </select>
        </div>
        <div class="form-field">
          <label for="sort">並び順</label>
          <select id="sort" name="sort">
            <option value="percentile"${sel(query.sort === "percentile")}>パーセンタイル昇順</option>
            <option value="rsi"${sel(query.sort === "rsi")}>RSI昇順</option>
            <option value="marketCap"${sel(query.sort === "marketCap")}>時価総額降順</option>
          </select>
        </div>
        <div class="form-field">
          <label for="limit">表示件数</label>
          <select id="limit" name="limit">${limitOptions}</select>
        </div>
        <button type="submit">検索</button>
      </form>

      <div style="margin-bottom:16px;color:var(--text-secondary);font-size:13px;display:flex;flex-wrap:wrap;gap:10px;align-items:center">
        <span class="pill">${h(periodLabel)}</span>
        <span class="pill">下位${h(String(query.percentileMax))}%</span>
        <span class="pill">${query.blueChip ? "優良株のみ" : "全銘柄"}</span>
        <span style="font-family:var(--font-mono);font-size:13px;color:var(--text);font-weight:700">
          ${results.length} HITS
        </span>
      </div>

      ${tableOrEmpty}
    </div>
  `;

  return layout("Screening | RSI Screening", body, "screening");
}
