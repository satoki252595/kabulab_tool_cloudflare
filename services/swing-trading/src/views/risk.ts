import { BASE_PATH } from "../../base-path.js";
import { h, fmtNum, fmtYen, layout } from "./layout.js";
import type { PositionSizeResult } from "../services/risk.js";

export interface RiskPageProps {
  /** フォーム初期値 (URL クエリ or 前回入力の引き継ぎ) */
  preset: {
    accountYen: number;
    riskPct: number;
    entryPrice: number | null;
    stopLoss: number | null;
    target1: number | null;
  };
  /** 計算済み結果 (POST 後のみ渡る) */
  result: PositionSizeResult | null;
  /** バリデーションエラー時のメッセージ */
  error: string | null;
}

export function riskPage(props: RiskPageProps): string {
  const { preset, result, error } = props;

  const resultBlock = result
    ? `
    <div class="result-box">
      <div style="font-family:var(--font-mono);font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:var(--text-muted)">推奨ポジション</div>
      <div class="result-shares">${fmtNum(result.shares, 0)}<span class="unit">株</span></div>
      <div class="stats-row">
        <div class="stat-cell">
          <div class="lbl">最大許容損失</div>
          <div class="val">${fmtYen(result.maxRiskYen)}</div>
          <div class="sub">口座 × リスク%</div>
        </div>
        <div class="stat-cell">
          <div class="lbl">1 株あたりリスク</div>
          <div class="val">${fmtNum(result.riskPerShare, 0)} 円</div>
          <div class="sub">|エントリー − ロスカ|</div>
        </div>
        <div class="stat-cell">
          <div class="lbl">必要ポジション金額</div>
          <div class="val ${result.exceedsAccount ? "bad" : ""}">${fmtYen(result.positionValue)}</div>
          <div class="sub">株数 × エントリー</div>
        </div>
        <div class="stat-cell">
          <div class="lbl">実際のロスカット損失</div>
          <div class="val">${fmtYen(result.actualRiskYen)}</div>
          <div class="sub">株数 × リスク幅</div>
        </div>
        ${
          result.riskRewardRatio !== null
            ? `
          <div class="stat-cell">
            <div class="lbl">リスクリワード比</div>
            <div class="val ${result.riskRewardRatio >= 2 ? "good" : "bad"}">${result.riskRewardRatio.toFixed(2)}</div>
            <div class="sub">1 : ${result.riskRewardRatio.toFixed(2)}</div>
          </div>
        `
            : ""
        }
      </div>
      ${
        result.warnings.length > 0
          ? `
        <div class="notice" style="margin-top:16px">
          <strong>⚠ 注意</strong>
          <ul style="margin:8px 0 0 20px">
            ${result.warnings.map((w) => `<li>${h(w)}</li>`).join("")}
          </ul>
        </div>
      `
          : ""
      }
    </div>
  `
    : "";

  const errorBlock = error
    ? `<div class="notice" style="background:var(--danger-soft);border-color:var(--danger)"><strong>エラー:</strong> ${h(error)}</div>`
    : "";

  const body = `
<div class="hero">
  <div class="inner">
    <div class="label"><span class="label-text">003 / RISK CALCULATOR</span><span>2% RULE</span></div>
    <h1>ポジション<br>サイズ計算.</h1>
    <p class="lead">Notion ガイドの 2% ルールに基づき、口座資金とロスカット幅から最適な株数を算出します。
    1 回のトレードで失う金額を口座の 1〜2% に抑えることで、10 連敗しても 80% 以上の資金が残ります。</p>
  </div>
</div>

<div class="container">
  ${errorBlock}

  <form class="form-box" method="POST" action="${BASE_PATH}/api/risk/calc">
    <div class="form-field">
      <label>口座資金 (円)</label>
      <input type="number" name="accountYen" value="${h(preset.accountYen)}" min="1" step="10000" required />
      <span class="hint">例: 5000000 = 500 万</span>
    </div>
    <div class="form-field">
      <label>1 トレードリスク%</label>
      <select name="riskPct">
        <option value="0.01" ${preset.riskPct === 0.01 ? "selected" : ""}>1%</option>
        <option value="0.015" ${preset.riskPct === 0.015 ? "selected" : ""}>1.5%</option>
        <option value="0.02" ${preset.riskPct === 0.02 ? "selected" : ""}>2% (推奨)</option>
      </select>
      <span class="hint">10 連敗後の残存率: 1%→90%, 2%→82%</span>
    </div>
    <div class="form-field">
      <label>エントリー価格 (円)</label>
      <input type="number" name="entryPrice" value="${preset.entryPrice ?? ""}" min="1" step="1" required />
      <span class="hint">例: 2000</span>
    </div>
    <div class="form-field">
      <label>ロスカット価格 (円)</label>
      <input type="number" name="stopLoss" value="${preset.stopLoss ?? ""}" min="1" step="1" required />
      <span class="hint">例: 1940</span>
    </div>
    <div class="form-field">
      <label>第 1 利確価格 (円)</label>
      <input type="number" name="target1" value="${preset.target1 ?? ""}" min="0" step="1" placeholder="省略可 (RR 計算用)" />
      <span class="hint">RR 1:2 以上を推奨</span>
    </div>
    <button type="submit" class="form-submit">計算する</button>
  </form>

  ${resultBlock}

  <div class="section-label">REFERENCE / 2% ルール</div>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>1 回のリスク</th>
          <th class="num">10 連敗後の残存率</th>
          <th class="num">回復に必要なリターン</th>
        </tr>
      </thead>
      <tbody>
        <tr><td>1%</td><td class="num">90.4%</td><td class="num">10.6%</td></tr>
        <tr><td>2% (推奨)</td><td class="num">81.7%</td><td class="num">22.4%</td></tr>
        <tr><td>5%</td><td class="num">59.9%</td><td class="num">67.0%</td></tr>
        <tr><td>10%</td><td class="num">34.9%</td><td class="num">186.7%</td></tr>
      </tbody>
    </table>
  </div>

  <div class="section-label">PORTFOLIO HEAT / ポートフォリオ上限</div>
  <p>保有中の全ポジションのリスク合計 ÷ 口座資金 = ポートフォリオ・ヒート。<strong>上限 6%</strong>が目安。
  1 トレード 2% リスクなら同時 <strong>3 ポジション</strong>までに抑える。
  同一セクター銘柄は最大 2 銘柄 (セクターリスク分散のため)。</p>
</div>
`;
  return layout(`Risk Calculator | Swing Trading`, body, "risk");
}
