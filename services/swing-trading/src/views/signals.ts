import { BASE_PATH } from "../../base-path.js";
import { h, fmtNum, layout } from "./layout.js";

export interface SignalRow {
  code: string;
  name: string;
  sector: string | null;
  pattern: string;
  direction: string;
  entryPrice: number;
  stopLoss: number;
  target1: number | null;
  target2: number | null;
  riskRewardRatio: number | null;
  signalStrength: number;
  note: string;
}

export interface SignalsPageProps {
  pattern: string; // "all" | 各パターン
  rows: SignalRow[];
  totalCount: number;
}

const PATTERN_LABELS: Record<string, string> = {
  all: "全パターン",
  breakout_long: "① ブレイクアウト買い",
  breakout_short: "① ブレイクアウト売り",
  pullback_long: "② 押し目買い",
  pullback_short: "② 戻り売り",
  volume_surge: "③ 出来高急増",
  gap_follow: "④ ギャップ追随",
  gap_fade: "④ 窓埋め逆張り",
  post_earnings: "⑥ 決算後初動 (代理)",
};

const PATTERN_ORDER = [
  "all",
  "breakout_long",
  "breakout_short",
  "pullback_long",
  "pullback_short",
  "volume_surge",
  "gap_follow",
  "gap_fade",
  "post_earnings",
];

export function signalsPage(props: SignalsPageProps): string {
  const { pattern, rows, totalCount } = props;

  const chipsHtml = `
    <div class="chip-row">
      ${PATTERN_ORDER.map(
        (p) =>
          `<a class="chip ${pattern === p ? "active" : ""}" href="${BASE_PATH}/signals?pattern=${h(p)}">${h(PATTERN_LABELS[p] ?? p)}</a>`
      ).join("")}
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
              <th>パターン</th>
              <th class="num">エントリー</th>
              <th class="num">ロスカット</th>
              <th class="num">第1利確</th>
              <th class="num">RR</th>
              <th class="num">強度</th>
              <th>メモ</th>
            </tr>
          </thead>
          <tbody>
            ${rows
              .map(
                (r) => `
              <tr>
                <td><a href="${BASE_PATH}/stock/${h(r.code)}">${h(r.code)}</a></td>
                <td>${h(r.name)}</td>
                <td>${h(PATTERN_LABELS[r.pattern] ?? r.pattern)} <span class="badge ${r.direction === "long" ? "badge-good" : "badge-bad"}">${h(r.direction.toUpperCase())}</span></td>
                <td class="num">${fmtNum(r.entryPrice, 0)}</td>
                <td class="num bad">${fmtNum(r.stopLoss, 0)}</td>
                <td class="num good">${fmtNum(r.target1, 0)}</td>
                <td class="num ${r.riskRewardRatio !== null && r.riskRewardRatio >= 2 ? "good" : "neutral"}">${r.riskRewardRatio !== null ? r.riskRewardRatio.toFixed(2) : "—"}</td>
                <td class="num">${fmtNum(r.signalStrength, 0)}</td>
                <td style="font-size:12px">${h(r.note)}</td>
              </tr>
            `
              )
              .join("")}
          </tbody>
        </table>
      </div>
    `
      : `<div class="empty">該当するシグナルはありません</div>`;

  const body = `
<div class="hero">
  <div class="inner">
    <div class="label"><span class="label-text">003 / ENTRY &amp; EXIT SIGNALS</span><span>6 PATTERNS</span></div>
    <h1>パターン別<br>シグナル.</h1>
    <p class="lead">Notion ガイドの 6 実戦パターンを日足ベースで自動検出。
    各行のエントリー / ロスカット / 第 1 利確 / リスクリワード比が事前計算済みです。</p>
  </div>
</div>

<div class="container">
  ${chipsHtml}

  <div class="stats-row">
    <div class="stat-cell">
      <div class="lbl">シグナル数</div>
      <div class="val">${fmtNum(totalCount, 0)}</div>
    </div>
  </div>

  <div class="notice">
    <strong>スコープ外 (分足必須)</strong>: パターン 5 の VWAP 戦略、パターン 3 の当日 14 時急増エントリー、
    ギャップ寄り後 10 時の判定は Yahoo Finance 無料 API では実装できないため除外しています。
  </div>

  ${tableHtml}
</div>
`;
  return layout(`Signals | Swing Trading`, body, "signals");
}
