import { BASE_PATH } from "../../base-path.js";
import { layout, h, fmtPct, fmtSignedPct, tip } from "./layout.js";
import type { CapmResult, BetaEstimate } from "../services/capm.js";
import { STOCK_CODE_HTML_PATTERN, STOCK_CODE_ERROR } from "../../../../src/shared/jpx/stock-code.js";

export interface CapmStockContext {
  code: string;
  name: string;
  currentPrice: number | null;
  marketCap: number | null;
}

export interface CapmPageProps {
  preset: {
    code?: string;
    mode: "auto" | "manual";
    /**
     * β (市場感応度)。null = 未入力 (auto モードでも β 推定が走る前)。
     * **CLAUDE.md ルール1**: 「β=1.0」のような根拠不明デフォルトは入れない。
     * View 側で null のときは input value="" で空欄表示。
     */
    beta: number | null;
    /** Rf (%)。日本国債10年利回りの近似 0.5% を初期値 (UIに根拠記載)。 */
    riskFreeRatePct: number;
    /** Rm (%)。TOPIX 長期平均 ≈ 6% を初期値 (UIに根拠記載)。 */
    marketReturnPct: number;
  };
  stockContext: CapmStockContext | null;
  betaEstimate: BetaEstimate | null;
  capmResult: CapmResult | null;
  betaUnavailableReason: string | null;
  error: string | null;
}

export function capmPage(props: CapmPageProps): string {
  const p = props.preset;
  const ctx = props.stockContext;

  const stockBlock = ctx
    ? `<div class="stock-context">
         <span class="code">${h(ctx.code)}</span>
         <span class="name">${h(ctx.name)}</span>
         <span class="meta">現在株価: ${ctx.currentPrice !== null ? Math.round(ctx.currentPrice).toLocaleString("ja-JP") + " 円" : "—"}</span>
       </div>`
    : "";

  const errorBlock = props.error
    ? `<div class="notice"><strong>入力エラー</strong> — ${h(props.error)}</div>`
    : "";

  // === 初心者向けガイド ===
  const guideBlock = `
<div class="guide">
  <p><strong>はじめての方へ</strong></p>
  <p>銘柄コードを入力すると、その銘柄の<strong>${tip("β (ベータ)", "市場全体が1%動いたとき、その銘柄が何%動くかの感応度。β=1 なら市場と同じ動き、β=1.5 なら市場の1.5倍荒く動く、β<1 なら市場より穏やか。")}</strong>を過去の値動きから自動で計算し、<strong>${tip("期待リターン", "「この銘柄に投資するなら、年率これくらいのリターンを期待するのが合理的」という値。実際のリターンがこれを超え続ける銘柄は良い銘柄と評価できる。")}</strong>を算出します。</p>
  <p>計算結果は DCF 計算機の「要求リターン k」にもそのまま使えます。</p>
</div>
`;

  const formBlock = `
<form class="form-box" data-label="INPUT" method="POST" action="${BASE_PATH}/api/capm/calc">
  <div class="form-field span-full">
    <label>${tip("銘柄コード", "東証の証券コード。数字4桁 (例: 7203 トヨタ自動車) と、2024年以降の新規上場銘柄に付く英字入りコード (例: 130A) の両方に対応。")}</label>
    <input type="text" name="code" value="${h(p.code ?? "")}" placeholder="例: 7203 / 130A" pattern="${STOCK_CODE_HTML_PATTERN}" maxlength="4" autocapitalize="characters" title="${h(STOCK_CODE_ERROR)}">
    <span class="hint">入力すると過去の値動きから β を自動推定します。${p.code ? `<a href="${BASE_PATH}/capm">クリア</a>` : `例: <a href="${BASE_PATH}/capm?code=7203">7203 トヨタ</a> <a href="${BASE_PATH}/capm?code=9983">9983 ファストリ</a> <a href="${BASE_PATH}/capm?code=9432">9432 NTT</a>`}</span>
  </div>

  <details class="advanced span-full">
    <summary>詳細設定 (デフォルトのままで OK)</summary>
    <div class="advanced-body">
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px">
        <div class="form-field">
          <label>${tip("計算モード", "auto = 過去日足から OLS 回帰で β を自動推定。manual = β を自分で入力 (β がわかっている場合)。")}</label>
          <select name="mode" id="capm-mode-select">
            <option value="auto" ${p.mode === "auto" ? "selected" : ""}>auto (β 自動推定・推奨)</option>
            <option value="manual" ${p.mode === "manual" ? "selected" : ""}>manual (β 手動入力)</option>
          </select>
        </div>
        <div class="form-field">
          <label>${tip("手動 β", "manual モード時のみ使用。-5〜+5 の範囲で入力。一般株は 0.5〜1.5 程度。auto モードを推奨。")}</label>
          <input type="number" step="0.01" name="beta" id="capm-beta-input"
                 value="${p.beta !== null && Number.isFinite(p.beta) ? h(p.beta) : ""}"
                 placeholder="${p.mode === "manual" ? "β を入力" : "auto モード中"}"
                 min="-5" max="5"
                 ${p.mode === "auto" ? "disabled" : ""}>
        </div>
        <div class="form-field">
          <label>${tip("リスクフリーレート Rf (%)", "リスクゼロで得られる年率リターン。日本では10年国債利回りを使うのが標準 (現在約 0.5〜1.5%)。")}</label>
          <input type="number" step="0.05" name="riskFreeRatePct" value="${h(p.riskFreeRatePct)}" required min="-5" max="20">
        </div>
        <div class="form-field">
          <label>${tip("市場期待リターン Rm (%)", "市場全体に投資した場合に期待される年率リターン。日本では TOPIX 長期平均の約 6% を使うことが多い。")}</label>
          <input type="number" step="0.1" name="marketReturnPct" value="${h(p.marketReturnPct)}" required min="-50" max="50">
        </div>
      </div>
    </div>
  </details>

  <button type="submit" class="form-submit">期待リターンを計算</button>
</form>
<script>
  // CAPM モード切替に応じて β 入力欄を有効/無効化 (no-framework, vanilla)
  // DOMContentLoaded で待つことで、将来 layout 構造が変わっても安定動作する。
  document.addEventListener("DOMContentLoaded", function () {
    var sel = document.getElementById("capm-mode-select");
    var beta = document.getElementById("capm-beta-input");
    if (!sel || !beta) return;
    sel.addEventListener("change", function () {
      var manual = sel.value === "manual";
      beta.disabled = !manual;
      beta.placeholder = manual ? "β を入力" : "auto モード中";
    });
  });
</script>
`;

  // === Beta info block ===
  let betaInfoBlock = "";
  if (p.mode === "auto") {
    if (props.betaEstimate) {
      const b = props.betaEstimate;
      betaInfoBlock = `
<div class="result-box">
  <div class="result-sub">${tip("β (自動推定)", "過去の日次リターンを「銘柄 = α + β × 市場 + 誤差」で最小二乗回帰した傾き。β=1 が市場と同じ動き。")}</div>
  <div class="result-headline">${b.beta.toFixed(3)}<span class="unit">β</span></div>
  <div class="stats-row">
    <div class="stat-cell">
      <div class="lbl">${tip("α (アルファ)", "回帰式の切片の年率化値。プラスなら CAPM 期待を超えるパフォーマンス、マイナスなら下回るパフォーマンス。ただし、未認識リスクの可能性もあり。")}</div>
      <div class="val ${b.alphaAnnualized > 0 ? "good" : b.alphaAnnualized < 0 ? "bad" : ""}">${fmtSignedPct(b.alphaAnnualized, 2)}</div>
      <div class="sub">年率</div>
    </div>
    <div class="stat-cell">
      <div class="lbl">${tip("R² (決定係数)", "市場動向がこの銘柄の動きを何%説明できるか (0〜1)。0.5 以上なら CAPM が比較的フィット、0.1 未満だと β の推定精度が低い。")}</div>
      <div class="val accent">${b.rSquared.toFixed(3)}</div>
      <div class="sub">フィット度</div>
    </div>
    <div class="stat-cell">
      <div class="lbl">${tip("相関係数", "銘柄と市場の動きの連動度合い (-1〜+1)。1 に近いほど市場と同方向、0 で無関係、-1 で逆方向。")}</div>
      <div class="val">${b.correlation.toFixed(3)}</div>
    </div>
    <div class="stat-cell">
      <div class="lbl">サンプル数</div>
      <div class="val">${b.sampleSize}</div>
      <div class="sub">営業日</div>
    </div>
    <div class="stat-cell">
      <div class="lbl">${tip("銘柄ボラ (年率)", "この銘柄の値動きの激しさ。標準偏差を年率換算したもの。")}</div>
      <div class="val">${fmtPct(b.stockVolAnnualized, 1)}</div>
    </div>
    <div class="stat-cell">
      <div class="lbl">市場ボラ (年率)</div>
      <div class="val">${fmtPct(b.marketVolAnnualized, 1)}</div>
    </div>
  </div>
</div>
`;
    } else if (props.betaUnavailableReason) {
      betaInfoBlock = `<div class="notice"><strong>β を自動推定できません</strong> — ${h(props.betaUnavailableReason)}</div>`;
    }
  }

  // === CAPM result ===
  let capmResultBlock = "";
  if (props.capmResult) {
    const r = props.capmResult;
    capmResultBlock = `
<div class="result-box">
  <div class="result-sub">${tip("期待リターン (CAPM)", "この銘柄に投資する際、合理的に求めるべき年率リターン。実績がこれを超えると α (アルファ) が出ていると評価できる。")}</div>
  <div class="result-headline">${(r.expectedReturn * 100).toFixed(2)}<span class="unit">%/年</span></div>
  <div class="stats-row">
    <div class="stat-cell">
      <div class="lbl">リスクフリーレート R<sub>f</sub></div>
      <div class="val">${(p.riskFreeRatePct).toFixed(2)}%</div>
    </div>
    <div class="stat-cell">
      <div class="lbl">${tip("市場リスクプレミアム", "市場リターン Rm から無リスク Rf を引いた値。市場全体のリスクを取ることで上乗せ期待できる年率。")}</div>
      <div class="val">${(r.marketRiskPremium * 100).toFixed(2)}%</div>
    </div>
    <div class="stat-cell">
      <div class="lbl">${tip("β × MRP", "β とマーケットリスクプレミアムの積。この銘柄固有のリスクプレミアム。")}</div>
      <div class="val accent">${(r.riskPremium * 100).toFixed(2)}%</div>
    </div>
  </div>
  <p style="font-size:13px;color:var(--text-secondary);margin-top:12px">
    この値は DCF 計算機の「要求リターン k」にも使えます。
  </p>
</div>
`;
  }

  const formulaBlock = `
<details class="advanced">
  <summary>計算式の解説 (もっと詳しく知りたい人向け)</summary>
  <div class="advanced-body">
    <div class="formula-box">
      <p class="desc"><strong>CAPM (Capital Asset Pricing Model)</strong></p>
      <div class="eq">E[R<sub>i</sub>] = R<sub>f</sub> + β<sub>i</sub> × (E[R<sub>m</sub>] − R<sub>f</sub>)</div>
      <ul>
        <li><strong>β</strong>: ${tip("ベータ", "市場が1%動いたとき、この銘柄が何%動くかの感応度")}</li>
        <li><strong>R<sub>f</sub></strong>: ${tip("無リスク金利", "10年国債利回り 等のリスクゼロで得られる利回り")}</li>
        <li><strong>E[R<sub>m</sub>]</strong>: ${tip("市場期待リターン", "TOPIX 等のマーケット全体に期待する年率リターン")}</li>
      </ul>
      <p class="desc" style="margin-top:12px">β は ${tip("OLS 線形回帰", "Ordinary Least Squares: 最小二乗法。回帰直線と各データ点の誤差の平方和を最小化する手法。")} で推定: <code>r<sub>i</sub> = α + β × r<sub>m</sub> + ε</code> の傾き。
      R² が低いと CAPM の前提 (体系的リスクのみで説明可能) が崩れているため、結果を慎重に扱う。</p>
    </div>
  </div>
</details>
`;

  const body = `
<div class="hero">
  <div class="inner">
    <div class="label"><span class="label-text">004 / CAPM</span><span>PORTFOLIO</span></div>
    <h1>CAPM<br>期待リターン.</h1>
    <p class="lead">市場感応度 ${tip("β", "市場が1%動いたとき銘柄が何%動くかの指標")} とリスクフリーレートから「合理的に要求すべき年率リターン」を算出。β は過去の値動きから自動で計算します。</p>
  </div>
</div>

<div class="container">
  ${guideBlock}
  ${stockBlock}
  ${errorBlock}
  ${formBlock}
  ${betaInfoBlock}
  ${capmResultBlock}
  ${formulaBlock}
</div>
`;
  return layout("CAPM 計算機 | 004 KABULAB", body, "capm");
}
