import { BASE_PATH } from "../../base-path.js";
import { termTip } from "../../../../src/shared/term-tip.js";
import { h, fmtNum, fmtYen, pctCell, layout } from "./layout.js";

export interface ScreeningRow {
  code: string;
  name: string;
  sector: string | null;
  latestClose: number | null;
  pctChange1d: number | null;
  avgTurnover20d: number | null;
  atrPct: number | null;
  sma5: number | null;
  sma20: number | null;
  volumeRatio: number | null;
  liquidityOk: boolean;
  volatilityOk: boolean;
  trendOk: boolean;
}

export interface ScreeningPageProps {
  direction: "long" | "short";
  rows: ScreeningRow[];
  totalCount: number;
}

function ok(b: boolean, label: string): string {
  return b
    ? `<span class="badge badge-good">${h(label)} OK</span>`
    : `<span class="badge badge-neutral">${h(label)} —</span>`;
}

const DIRECTION_TIP: Record<"long" | "short", string> = {
  long: "値上がりを狙う買い方。安く買って高く売り、その差額を利益にする。例: 1,000円で買った株が1,100円になれば1株あたり100円の利益。",
  short:
    "値下がりを狙う売り方。先に売って後で安く買い戻し、その差額を利益にする。信用取引など借りた株を売る仕組みが必要。",
};

export function screeningPage(props: ScreeningPageProps): string {
  const { direction, rows, totalCount } = props;
  // 総数は route が同一 where の COUNT で数えた全件。表示は先頭 200 件に
  // 限られるので、途切れているときは事実を明記する (F-07)。
  const truncatedNote =
    rows.length < totalCount
      ? `<div class="sub">先頭${fmtNum(rows.length, 0)}件を表示（全${fmtNum(totalCount, 0)}件）</div>`
      : "";
  const chipsHtml = `
    <div class="chip-row">
      <a class="chip ${direction === "long" ? "active" : ""}" href="${BASE_PATH}/screening?direction=long">LONG 候補</a>
      <a class="chip ${direction === "short" ? "active" : ""}" href="${BASE_PATH}/screening?direction=short">SHORT 候補</a>
    </div>
  `;

  const tableHtml =
    rows.length > 0
      ? `
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>コード</th>
                <th>銘柄</th>
                <th>業種</th>
                <th class="num">終値</th>
                <th class="num">前日比</th>
                <th class="num">20日平均<br>売買代金</th>
                <th class="num">ATR%</th>
                <th class="num">出来高倍率</th>
                <th>条件</th>
              </tr>
            </thead>
            <tbody>
              ${rows
                .map(
                  (r) => `
                <tr>
                  <td><a href="${BASE_PATH}/stock/${h(r.code)}">${h(r.code)}</a></td>
                  <td>${h(r.name)}</td>
                  <td>${h(r.sector ?? "—")}</td>
                  <td class="num">${fmtNum(r.latestClose, 0)}</td>
                  <td class="num">${pctCell(r.pctChange1d)}</td>
                  <td class="num">${fmtYen(r.avgTurnover20d)}</td>
                  <td class="num">${fmtNum(r.atrPct, 2, "%")}</td>
                  <td class="num">${fmtNum(r.volumeRatio, 2, "x")}</td>
                  <td>${ok(r.liquidityOk, "①流動")} ${ok(r.volatilityOk, "②ボラ")} ${ok(r.trendOk, "③トレンド")}</td>
                </tr>
              `
                )
                .join("")}
            </tbody>
          </table>
        </div>
      `
      : `<div class="empty">条件通過銘柄はありません (sync 未実行の可能性)</div>`;

  const body = `
<div class="hero">
  <div class="inner">
    <div class="label"><span class="label-text">003 / INDIVIDUAL SCREENING</span><span>5-CONDITION FILTER</span></div>
    <h1>5 条件<br>フィルター.</h1>
    <p class="lead">流動性 × ボラ × トレンド の 3 条件を全て通過した銘柄を一覧表示。
    ④需給と ⑤カタリストは外部サイトで手動確認してください。</p>
  </div>
</div>

<div class="container">
  ${chipsHtml}

  <div class="stats-row">
    <div class="stat-cell">
      <div class="lbl">通過銘柄 (${termTip(direction.toUpperCase(), DIRECTION_TIP[direction])})</div>
      <div class="val">${fmtNum(totalCount, 0)}</div>
      ${truncatedNote}
    </div>
  </div>

  <div class="notice">
    <strong>④ 需給 (信用倍率)</strong> は <a href="https://finance.matsui.co.jp/ranking-credit-unpurchased/index" target="_blank" rel="noopener">松井証券</a> で、
    <strong>⑤ カタリスト (決算カレンダー)</strong> は <a href="https://kabuyoho.jp/calender" target="_blank" rel="noopener">株予報</a> で手動確認を推奨。
  </div>

  <div class="section-label">CANDIDATES / 条件通過銘柄</div>
  ${tableHtml}
</div>
`;
  return layout(`Screening | Swing Trading`, body, "screening");
}
