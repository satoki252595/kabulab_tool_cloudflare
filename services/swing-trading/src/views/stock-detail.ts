import { BASE_PATH } from "../../base-path.js";
import { h, fmtNum, fmtYen, pctCell, layout } from "./layout.js";

export interface StockDetailData {
  code: string;
  name: string;
  sector: string | null;
  market: string;
  // 指標
  latestClose: number | null;
  latestDate: string | null;
  pctChange1d: number | null;
  avgTurnover20d: number | null;
  volumeRatio: number | null;
  atr14: number | null;
  atrPct: number | null;
  sma5: number | null;
  sma20: number | null;
  sma60: number | null;
  sma75: number | null;
  rsi14: number | null;
  macd: number | null;
  macdSignal: number | null;
  range20dHigh: number | null;
  range20dLow: number | null;
  fib382: number | null;
  fib500: number | null;
  fib618: number | null;
  trendLong: boolean;
  trendShort: boolean;
  perfectOrderLong: boolean;
  perfectOrderShort: boolean;
  // 5 条件
  liquidityOk: boolean;
  volatilityOk: boolean;
  trendOkLong: boolean;
  trendOkShort: boolean;
  // ファンダ (core から)
  per: number | null;
  pbr: number | null;
  dividendYield: number | null;
  marketCap: number | null;
  // シグナル
  signals: Array<{
    pattern: string;
    direction: string;
    entryPrice: number;
    stopLoss: number;
    target1: number | null;
    target2: number | null;
    riskRewardRatio: number | null;
    signalStrength: number;
    note: string;
  }>;
}

const PATTERN_LABELS: Record<string, string> = {
  breakout_long: "① ブレイクアウト買い",
  breakout_short: "① ブレイクアウト売り",
  pullback_long: "② 押し目買い",
  pullback_short: "② 戻り売り",
  volume_surge: "③ 出来高急増",
  gap_follow: "④ ギャップ追随",
  gap_fade: "④ 窓埋め逆張り",
  post_earnings: "⑥ 決算後初動 (代理)",
};

function cond(b: boolean): string {
  return b ? `<span class="badge badge-good">✓ OK</span>` : `<span class="badge badge-neutral">—</span>`;
}

export function stockDetailPage(data: StockDetailData): string {
  const signalsHtml =
    data.signals.length > 0
      ? `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>パターン</th>
            <th class="num">エントリー</th>
            <th class="num">ロスカット</th>
            <th class="num">第1利確</th>
            <th class="num">第2利確</th>
            <th class="num">RR</th>
            <th class="num">強度</th>
            <th>メモ</th>
          </tr>
        </thead>
        <tbody>
          ${data.signals
            .map(
              (s) => `
            <tr>
              <td>${h(PATTERN_LABELS[s.pattern] ?? s.pattern)} <span class="badge ${s.direction === "long" ? "badge-good" : "badge-bad"}">${h(s.direction.toUpperCase())}</span></td>
              <td class="num">${fmtNum(s.entryPrice, 0)}</td>
              <td class="num bad">${fmtNum(s.stopLoss, 0)}</td>
              <td class="num good">${fmtNum(s.target1, 0)}</td>
              <td class="num good">${fmtNum(s.target2, 0)}</td>
              <td class="num ${s.riskRewardRatio !== null && s.riskRewardRatio >= 2 ? "good" : "neutral"}">${s.riskRewardRatio !== null ? s.riskRewardRatio.toFixed(2) : "—"}</td>
              <td class="num">${fmtNum(s.signalStrength, 0)}</td>
              <td style="font-size:12px">${h(s.note)}</td>
            </tr>
          `
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `
      : `<div class="empty">この銘柄には現在シグナルが出ていません</div>`;

  // リスク計算機プリセット用のクエリパラメータを生成 (シグナルがあれば先頭を使う)
  const firstSignal = data.signals[0];
  const riskPreset = firstSignal
    ? `?entry=${firstSignal.entryPrice}&stop=${firstSignal.stopLoss}${firstSignal.target1 !== null ? `&target=${firstSignal.target1}` : ""}`
    : "";

  const body = `
<div class="hero">
  <div class="inner">
    <div class="label"><span class="label-text">003 / STOCK DETAIL / ${h(data.code)}</span><span>${h(data.latestDate ?? "—")}</span></div>
    <h1>${h(data.name)}</h1>
    <p class="lead">${h(data.sector ?? "未分類")} / ${h(data.market)} / ${h(data.code)}</p>
  </div>
</div>

<div class="container">
  <div class="section-label">PRICE / 最新価格</div>
  <div class="stats-row">
    <div class="stat-cell">
      <div class="lbl">終値</div>
      <div class="val">${fmtNum(data.latestClose, 0)}</div>
      <div class="sub">${pctCell(data.pctChange1d)}</div>
    </div>
    <div class="stat-cell">
      <div class="lbl">20 日売買代金</div>
      <div class="val">${fmtYen(data.avgTurnover20d)}</div>
      <div class="sub">流動性の目安</div>
    </div>
    <div class="stat-cell">
      <div class="lbl">ATR(14) / 株価</div>
      <div class="val">${fmtNum(data.atrPct, 2, "%")}</div>
      <div class="sub">ボラティリティ</div>
    </div>
    <div class="stat-cell">
      <div class="lbl">出来高倍率</div>
      <div class="val">${fmtNum(data.volumeRatio, 2, "x")}</div>
      <div class="sub">20 日平均比</div>
    </div>
  </div>

  <div class="section-label">SCREENING / 5 条件フィルター</div>
  <div class="stats-row">
    <div class="stat-cell">
      <div class="lbl">① 流動性</div>
      <div class="val" style="font-size:16px">${cond(data.liquidityOk)}</div>
      <div class="sub">20日平均 ≧ 10 億</div>
    </div>
    <div class="stat-cell">
      <div class="lbl">② ボラ</div>
      <div class="val" style="font-size:16px">${cond(data.volatilityOk)}</div>
      <div class="sub">ATR% ≧ 2%</div>
    </div>
    <div class="stat-cell">
      <div class="lbl">③ トレンド (LONG)</div>
      <div class="val" style="font-size:16px">${cond(data.trendOkLong)}</div>
      <div class="sub">5MA&gt;20MA 株価&gt;5MA</div>
    </div>
    <div class="stat-cell">
      <div class="lbl">③ トレンド (SHORT)</div>
      <div class="val" style="font-size:16px">${cond(data.trendOkShort)}</div>
      <div class="sub">5MA&lt;20MA 株価&lt;5MA</div>
    </div>
    <div class="stat-cell">
      <div class="lbl">④ 需給</div>
      <div class="val" style="font-size:14px;color:var(--text-muted)">外部未対応</div>
      <div class="sub"><a href="https://finance.matsui.co.jp/ranking-credit-unpurchased/index" target="_blank" rel="noopener">松井証券で確認</a></div>
    </div>
    <div class="stat-cell">
      <div class="lbl">⑤ カタリスト</div>
      <div class="val" style="font-size:14px;color:var(--text-muted)">外部未対応</div>
      <div class="sub"><a href="https://kabuyoho.jp/calender" target="_blank" rel="noopener">株予報で確認</a></div>
    </div>
  </div>

  <div class="section-label">TREND / 移動平均とトレンド</div>
  <div class="stats-row">
    <div class="stat-cell"><div class="lbl">SMA5</div><div class="val">${fmtNum(data.sma5, 0)}</div></div>
    <div class="stat-cell"><div class="lbl">SMA20</div><div class="val">${fmtNum(data.sma20, 0)}</div></div>
    <div class="stat-cell"><div class="lbl">SMA60</div><div class="val">${fmtNum(data.sma60, 0)}</div></div>
    <div class="stat-cell"><div class="lbl">SMA75</div><div class="val">${fmtNum(data.sma75, 0)}</div></div>
    <div class="stat-cell"><div class="lbl">パーフェクトオーダー</div><div class="val" style="font-size:16px">${data.perfectOrderLong ? `<span class="badge badge-good">LONG</span>` : data.perfectOrderShort ? `<span class="badge badge-bad">SHORT</span>` : `<span class="badge badge-neutral">NONE</span>`}</div><div class="sub">5&gt;20&gt;60</div></div>
  </div>

  <div class="section-label">MOMENTUM / モメンタム</div>
  <div class="stats-row">
    <div class="stat-cell"><div class="lbl">RSI(14)</div><div class="val">${fmtNum(data.rsi14, 1)}</div></div>
    <div class="stat-cell"><div class="lbl">MACD</div><div class="val">${fmtNum(data.macd, 2)}</div></div>
    <div class="stat-cell"><div class="lbl">Signal</div><div class="val">${fmtNum(data.macdSignal, 2)}</div></div>
  </div>

  <div class="section-label">RANGE / 20 日レンジ + フィボ</div>
  <div class="stats-row">
    <div class="stat-cell"><div class="lbl">20日高値</div><div class="val">${fmtNum(data.range20dHigh, 0)}</div></div>
    <div class="stat-cell"><div class="lbl">20日安値</div><div class="val">${fmtNum(data.range20dLow, 0)}</div></div>
    <div class="stat-cell"><div class="lbl">Fib 38.2%</div><div class="val">${fmtNum(data.fib382, 0)}</div></div>
    <div class="stat-cell"><div class="lbl">Fib 50%</div><div class="val">${fmtNum(data.fib500, 0)}</div></div>
    <div class="stat-cell"><div class="lbl">Fib 61.8%</div><div class="val">${fmtNum(data.fib618, 0)}</div></div>
  </div>

  <div class="section-label">FUNDAMENTAL / ファンダメンタル (参考)</div>
  <div class="stats-row">
    <div class="stat-cell"><div class="lbl">PER</div><div class="val">${fmtNum(data.per, 1)}</div></div>
    <div class="stat-cell"><div class="lbl">PBR</div><div class="val">${fmtNum(data.pbr, 2)}</div></div>
    <div class="stat-cell"><div class="lbl">配当利回り</div><div class="val">${fmtNum(data.dividendYield, 2, "%")}</div></div>
    <div class="stat-cell"><div class="lbl">時価総額</div><div class="val">${fmtYen(data.marketCap)}</div></div>
  </div>

  <div class="section-label">SIGNALS / 検出されたパターン</div>
  ${signalsHtml}

  <div class="section-label">ACTION / 次のステップ</div>
  <p><a class="chip" href="${BASE_PATH}/risk${riskPreset}">→ リスク計算機 (2% ルール)</a></p>
</div>
`;
  return layout(`${data.code} ${data.name} | Swing Trading`, body, "home");
}

export function stockNotFoundPage(code: string): string {
  const body = `
<div class="container" style="text-align:center;padding:80px 16px">
  <div class="section-label" style="justify-content:center">404 / NOT FOUND</div>
  <h1 style="font-size:48px;margin:16px 0">銘柄が見つかりません</h1>
  <p>コード: ${h(code)}</p>
  <p style="margin-top:24px"><a class="chip" href="${BASE_PATH}/screening">→ スクリーニングに戻る</a></p>
</div>
`;
  return layout(`404 Not Found | Swing Trading`, body);
}
