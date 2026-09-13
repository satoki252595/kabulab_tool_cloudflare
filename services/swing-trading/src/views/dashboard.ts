import { BASE_PATH } from "../../base-path.js";
import { h, fmtNum, pctCell, layout } from "./layout.js";

export interface DashboardData {
  macro: {
    date: string;
    judgment: "A" | "B" | "C" | "D" | "HOLD";
    reason: string;
    nikkeiClose: number | null;
    nikkeiPct: number | null;
    vix: number | null;
    sp500Pct: number | null;
    nikkeiVi: number | null;
    futuresGap: number | null;
  } | null;
  topSectors: Array<{
    sector: string;
    pct1d: number;
    stockCount: number;
    rank1d: number;
  }>;
  counts: {
    totalScreened: number;
    passedLong: number;
    passedShort: number;
    totalSignals: number;
  };
  /** 強いブレイクアウト上位 5 件 */
  topBreakouts: Array<{
    code: string;
    name: string;
    pattern: string;
    direction: string;
    signalStrength: number;
    note: string;
  }>;
}

const JUDGMENT_TITLES: Record<string, string> = {
  A: "積極ゾーン",
  B: "通常ゾーン",
  C: "慎重ゾーン",
  D: "見送り",
  HOLD: "判定保留",
};

const PATTERN_LABELS: Record<string, string> = {
  breakout_long: "ブレイクアウト買い",
  breakout_short: "ブレイクアウト売り",
  pullback_long: "押し目買い",
  pullback_short: "戻り売り",
  volume_surge: "出来高急増",
  gap_follow: "ギャップ追随",
  gap_fade: "窓埋め逆張り",
  post_earnings: "決算後初動(代理)",
};

export function dashboardPage(data: DashboardData): string {
  const m = data.macro;

  const judgmentBlock = m
    ? `
      <div class="judgment-box">
        <div class="judgment-letter ${m.judgment}">${h(m.judgment)}</div>
        <div class="judgment-body">
          <div class="label">000 / MACRO JUDGMENT / ${h(m.date)}</div>
          <div class="title">${h(JUDGMENT_TITLES[m.judgment] ?? m.judgment)}</div>
          <div class="reason">${h(m.reason)}</div>
        </div>
      </div>
    `
    : `<div class="notice"><strong>⚠ マクロ判定未取得</strong> — まだ sync が実行されていません。<code>pnpm sync:swing</code> を実行してください</div>`;

  const macroStats = m
    ? `
      <div class="stats-row">
        <div class="stat-cell">
          <div class="lbl">日経平均</div>
          <div class="val">${fmtNum(m.nikkeiClose, 0)}</div>
          <div class="sub">${pctCell(m.nikkeiPct)}</div>
        </div>
        <div class="stat-cell">
          <div class="lbl">日経 VI</div>
          <div class="val">${fmtNum(m.nikkeiVi, 2)}</div>
          <div class="sub">${m.nikkeiVi === null ? "取得不能" : m.nikkeiVi < 25 ? "低ボラ" : m.nikkeiVi < 30 ? "通常" : "高ボラ"}</div>
        </div>
        <div class="stat-cell">
          <div class="lbl">VIX</div>
          <div class="val">${fmtNum(m.vix, 2)}</div>
          <div class="sub">米国ボラ指数</div>
        </div>
        <div class="stat-cell">
          <div class="lbl">S&amp;P500</div>
          <div class="val ${m.sp500Pct !== null && m.sp500Pct >= 0 ? "good" : "bad"}">${pctCell(m.sp500Pct)}</div>
          <div class="sub">前日比</div>
        </div>
        <div class="stat-cell">
          <div class="lbl">先物ギャップ</div>
          <div class="val">${m.futuresGap !== null ? (m.futuresGap >= 0 ? "+" : "") + fmtNum(m.futuresGap, 0) : "—"}</div>
          <div class="sub">日経 225 先物 − 現物</div>
        </div>
      </div>
    `
    : "";

  const sectorsHtml =
    data.topSectors.length > 0
      ? `
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th style="width:48px">#</th>
              <th>業種</th>
              <th class="num">当日騰落率</th>
              <th class="num">銘柄数</th>
            </tr>
          </thead>
          <tbody>
            ${data.topSectors
              .map(
                (s) => `
              <tr>
                <td>${h(s.rank1d)}</td>
                <td>${h(s.sector)}</td>
                <td class="num">${pctCell(s.pct1d)}</td>
                <td class="num">${h(s.stockCount)}</td>
              </tr>
            `
              )
              .join("")}
          </tbody>
        </table>
      </div>
    `
      : `<div class="empty">セクター集計データがありません。sync 後に表示されます</div>`;

  const topBreakoutsHtml =
    data.topBreakouts.length > 0
      ? `
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>コード</th>
              <th>銘柄</th>
              <th>パターン</th>
              <th class="num">強度</th>
              <th>メモ</th>
            </tr>
          </thead>
          <tbody>
            ${data.topBreakouts
              .map(
                (s) => `
              <tr>
                <td><a href="${BASE_PATH}/stock/${h(s.code)}">${h(s.code)}</a></td>
                <td>${h(s.name)}</td>
                <td>${h(PATTERN_LABELS[s.pattern] ?? s.pattern)} <span class="badge ${s.direction === "long" ? "badge-good" : "badge-bad"}">${h(s.direction.toUpperCase())}</span></td>
                <td class="num">${fmtNum(s.signalStrength, 0)}</td>
                <td>${h(s.note)}</td>
              </tr>
            `
              )
              .join("")}
          </tbody>
        </table>
      </div>
    `
      : `<div class="empty">直近のシグナルはありません</div>`;

  const body = `
<div class="hero">
  <div class="inner">
    <div class="label"><span class="label-text">003 / SWING TRADING DASHBOARD</span><span>${h(new Date().getFullYear())}</span></div>
    <h1>今日、<br>短期で取るべきか。</h1>
    <p class="lead">数日〜2週間の短期売買を、マクロ判定・5 条件スクリーニング・6 パターンの定量ルールで自動化。
    毎朝の売買判断を「再現性のある型」に落として、感覚ではなく数値で判断します。</p>
  </div>
</div>

<div class="container">
  <div class="section-label">1. MACRO / 本日の地合い判定</div>
  ${judgmentBlock}
  ${macroStats}

  <div class="stats-row">
    <div class="stat-cell">
      <div class="lbl">スクリーニング通過 (LONG)</div>
      <div class="val good">${fmtNum(data.counts.passedLong, 0)}</div>
      <div class="sub">5 条件中 3 条件 OK</div>
    </div>
    <div class="stat-cell">
      <div class="lbl">スクリーニング通過 (SHORT)</div>
      <div class="val bad">${fmtNum(data.counts.passedShort, 0)}</div>
      <div class="sub">5 条件中 3 条件 OK</div>
    </div>
    <div class="stat-cell">
      <div class="lbl">シグナル総数</div>
      <div class="val">${fmtNum(data.counts.totalSignals, 0)}</div>
      <div class="sub">E&amp;E 6 パターン検出</div>
    </div>
    <div class="stat-cell">
      <div class="lbl">対象銘柄</div>
      <div class="val">${fmtNum(data.counts.totalScreened, 0)}</div>
      <div class="sub">判定済み (上場廃止など日次の対象外の銘柄を含む)</div>
    </div>
  </div>

  <div class="notice">
    <strong>※ ④需給 (信用倍率) と ⑤カタリスト (決算カレンダー)</strong> は Yahoo Finance から取得できないため、
    5 条件のうち ①流動性 / ②ボラ / ③トレンド の 3 条件のみを自動判定しています。
    ④⑤ は各銘柄詳細ページで外部サイトへのリンクから手動確認してください。
  </div>

  <div class="section-label">2. SECTOR / 本日のセクター上位</div>
  ${sectorsHtml}

  <div class="section-label">3. SIGNALS / 強度上位のシグナル</div>
  ${topBreakoutsHtml}
  <p style="font-size:13px;color:var(--text-muted);margin-top:8px"><a href="${BASE_PATH}/signals">→ 全シグナル一覧へ</a></p>

  <div class="section-label">4. QUICK LINKS</div>
  <div class="stats-row">
    <a class="stat-cell card-link" href="${BASE_PATH}/screening" style="text-decoration:none">
      <div class="lbl">SCREENING</div>
      <div class="val">5 条件フィルター</div>
      <div class="sub">マクロ → セクター → 個別</div>
    </a>
    <a class="stat-cell card-link" href="${BASE_PATH}/signals" style="text-decoration:none">
      <div class="lbl">SIGNALS</div>
      <div class="val">E&amp;E 6 パターン</div>
      <div class="sub">ブレイク/押し目/急増/ギャップ</div>
    </a>
    <a class="stat-cell card-link" href="${BASE_PATH}/risk" style="text-decoration:none">
      <div class="lbl">RISK CALC</div>
      <div class="val">2% ルール</div>
      <div class="sub">ポジションサイズ計算機</div>
    </a>
  </div>
</div>
`;
  return layout("Swing Trading | kabulab", body, "home");
}
