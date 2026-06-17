import { BASE_PATH } from "../../base-path.js";
import { layout, h, fmtPct, tip } from "./layout.js";
import type { GordonResult, TwoStageDcfResult } from "../services/dcf.js";
import { STOCK_CODE_HTML_PATTERN, STOCK_CODE_ERROR } from "../../../../src/shared/jpx/stock-code.js";

export interface StockContext {
  code: string;
  name: string;
  currentPrice: number | null;
  dividendYield: number | null;
  /** 来期予想配当の自動推定 (price × dividendYield) — null の場合 */
  estimatedDividend: number | null;
  /** 配当 CAGR (任意。年度売上だけでは推定できないので null になる場合多い) */
  estimatedGrowth: number | null;
  /**
   * 無配銘柄かどうか。
   * - true  = Yahoo の dividendYield が null/0 で配当データなし。Gordon DCF 不適切
   * - false = 配当データあり (自動推定値で計算可能)
   */
  isNonDividend: boolean;
}

export interface DcfPageProps {
  preset: {
    code?: string;
    mode: "gordon" | "two-stage";
    /**
     * 来期予想配当 (円/株)。null = 銘柄未指定 or 無配・データなしで未取得。
     * **デフォルト値で勝手に埋めない (CLAUDE.md ルール1)**: 銘柄プリフィル時に
     * Yahoo 由来の実値が取れたときだけ設定し、それ以外は null のまま。
     * View 側は null/0 のときフォーム input を空欄にし、ユーザーに手動入力を促す。
     */
    expectedDividend: number | null;
    /** true なら expectedDividend は Yahoo 自動補完値 (label 横に「自動」バッジ表示) */
    expectedDividendAutoFilled?: boolean;
    /** 要求リターン (%)。CAPM 算出値が無いときのフォーム再表示用初期値 7%。 */
    requiredReturnPct: number;
    /** 配当成長率 (%)。会社中計が無いときのフォーム再表示用初期値 3%。 */
    growthRatePct: number;
    highGrowthYears: number;
    terminalGrowthPct: number;
  };
  stockContext: StockContext | null;
  gordonResult: GordonResult | null;
  twoStageResult: TwoStageDcfResult | null;
  currentPrice: number | null;
  /** エラー (validator 失敗・計算失敗・データ取得失敗) — 赤系 notice で表示 */
  error: string | null;
  /**
   * 情報通知 (silent override や仕様による補正の説明) — 青系 notice で表示。
   * 例: 「銘柄コード指定時に Yahoo 推定配当で expectedDividend を上書きした」
   */
  infoNotice?: string | null;
}

/** 5 桁未満は小数 1 桁、それ以上は整数で円表示 */
function fmtPrice(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (value >= 1000) return Math.round(value).toLocaleString("ja-JP");
  return value.toFixed(1);
}

export function dcfPage(props: DcfPageProps): string {
  const p = props.preset;
  const ctx = props.stockContext;

  const stockBlock = ctx
    ? `<div class="stock-context">
         <span class="code">${h(ctx.code)}</span>
         <span class="name">${h(ctx.name)}</span>
         <span class="meta">現在株価: ${fmtPrice(ctx.currentPrice)} 円</span>
         <span class="meta">配当利回り: ${ctx.isNonDividend ? "<strong>無配</strong>" : fmtPct(ctx.dividendYield, 2)}</span>
         ${ctx.estimatedDividend !== null ? `<span class="meta">推定来期配当: ${fmtPrice(ctx.estimatedDividend)} 円</span>` : ""}
       </div>`
    : "";

  // 無配銘柄警告 (Gordon DCF は配当が前提のため原理的に適用不可)
  const nonDividendWarning =
    ctx && ctx.isNonDividend
      ? `<div class="notice"><strong>⚠ 無配銘柄</strong> — この銘柄は配当を出していないため、配当割引モデル(Gordon DCF)では理論株価を計算できません。
       Yahoo Finance のデータ取得時点で配当利回りが取れていない、もしくは 0% の銘柄です。
       <br>もし「将来配当を出すと想定して試算したい」場合は、下のフォームで <strong>${tip("来期予想配当", "1株あたりの予想年間配当金額。会社の IR や四季報の予想を参考に入力。無配銘柄では将来配当を仮定する必要があり、計算結果は仮置きの試算値になる点に注意。")}</strong>を手動入力してください。
       本来 ${tip("FCF (フリーキャッシュフロー)", "営業 CF から投資 CF を引いた残り。配当ではなく FCF を割り引く DCF モデルが無配株では一般的だが、本ツールでは未実装。")} ベースの DCF や PER 比較等、別の評価手法を併用するのが標準です。
       </div>`
      : "";

  // エラー (validator 失敗・計算失敗) は赤系の notice
  const errorBlock = props.error
    ? `<div class="notice notice--error"><span class="title-badge">ERROR</span><strong>入力エラー</strong> ${h(props.error)}</div>`
    : "";

  // 情報通知 (上書き発生時等) は青系の info notice
  const infoBlock = props.infoNotice
    ? `<div class="notice notice--info"><span class="title-badge">INFO</span>${h(props.infoNotice)}</div>`
    : "";

  // === 初心者向けガイド ===
  const guideBlock = `
<div class="guide">
  <p><strong>はじめての方へ</strong></p>
  <p>銘柄コード (例: 7203 = トヨタ) を入力すると、その会社の${tip("配当利回り", "1株あたりの年間配当 ÷ 株価。現在の株価で買うと年何%もらえるかの利回り。")}や予想配当を自動で取得し、<strong>${tip("理論株価", "「将来この銘柄が生み出す配当を、今の時点での価値に割り引いて合計した金額」。Gordon モデルでは P = 来期配当 ÷ (要求リターン − 配当成長率)。")}</strong>を計算します。</p>
  <p>現在の株価と比べて<strong>${tip("割安度", "(理論株価 − 現在株価) ÷ 現在株価。プラスなら現在価格が理論値より安く割安、マイナスなら割高。")}</strong>を判定。詳細設定は基本「自動」で構いません。</p>
</div>
`;

  // === フォーム — 銘柄コード以外は <details> に格納 ===
  const formBlock = `
<form class="form-box" data-label="INPUT" method="POST" action="${BASE_PATH}/api/dcf/calc">
  <div class="form-field span-full">
    <label>${tip("銘柄コード", "東証の証券コード。数字4桁 (例: 7203 = トヨタ自動車) と、2024年以降の新規上場銘柄に付く英字入りコード (例: 130A) の両方に対応。")}</label>
    <input type="text" name="code" value="${h(p.code ?? "")}" placeholder="例: 7203 / 130A" pattern="${STOCK_CODE_HTML_PATTERN}" maxlength="4" autocapitalize="characters" title="${h(STOCK_CODE_ERROR)}">
    <span class="hint">銘柄を変えると配当が自動で更新されます。${p.code ? `<a href="${BASE_PATH}/dcf">クリア</a>` : `例: <a href="${BASE_PATH}/dcf?code=7203">7203 トヨタ</a> <a href="${BASE_PATH}/dcf?code=8058">8058 三菱商事</a> <a href="${BASE_PATH}/dcf?code=9432">9432 NTT</a>`}</span>
  </div>

  <details class="advanced span-full" ${ctx && ctx.isNonDividend ? "open" : ""}>
    <summary>詳細設定 ${ctx && ctx.isNonDividend ? "(無配銘柄)" : "(デフォルトのままで OK)"}</summary>
    <div class="advanced-body">
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px">
        <div class="form-field">
          <label>${tip("計算モード", "Gordon (1段階) は配当が永続的に一定率で成長する想定。2段階 DCF は最初の N 年は高成長 → その後安定成長と分けて計算する応用版。")}</label>
          <select name="mode">
            <option value="gordon" ${p.mode === "gordon" ? "selected" : ""}>Gordon (シンプル・推奨)</option>
            <option value="two-stage" ${p.mode === "two-stage" ? "selected" : ""}>2段階 DCF (応用)</option>
          </select>
        </div>
        <div class="form-field">
          <label>${tip("来期予想配当 (円/株)", "1株あたりの予想年間配当金額。銘柄コードを入れると Yahoo 由来の TTM (過去12ヶ月実績) ベースの推定値を自動入力。会社IRの予想と異なる場合があります。")}${p.expectedDividendAutoFilled ? '<span class="auto-badge">自動</span>' : ""}</label>
          <input type="number" step="0.01" name="expectedDividend"
                 value="${p.expectedDividend !== null && p.expectedDividend > 0 ? h(p.expectedDividend) : ""}"
                 placeholder="${ctx ? (ctx.isNonDividend ? "無配銘柄: 想定配当を手動入力" : "") : "銘柄コード入力時は自動取得"}"
                 min="0.01">
          <span class="hint">銘柄コード指定時は Yahoo 推定値で自動補完。code 空時のみ手動入力必須。</span>
        </div>
        <div class="form-field">
          <label>${tip("要求リターン k (%)", "投資家がこの銘柄に求める年率リターン。CAPM で算出した期待リターンを使うのが標準。デフォルト 7% は東証平均の感覚値。")}</label>
          <input type="number" step="0.1" name="requiredReturnPct" value="${h(p.requiredReturnPct)}" required min="0.1" max="30">
        </div>
        <div class="form-field">
          <label>${tip(p.mode === "two-stage" ? "高成長期 g (%)" : "配当成長率 g (%)", "年率の配当成長率。デフォルト 3% は日本株平均的な水準。k > g (要求リターン > 成長率) でないと計算不能。")}</label>
          <input type="number" step="0.1" name="growthRatePct" value="${h(p.growthRatePct)}" required min="-10" max="20">
        </div>
        <div class="form-field" style="${p.mode === "two-stage" ? "" : "display:none"}">
          <label>高成長期年数</label>
          <input type="number" step="1" name="highGrowthYears" value="${h(p.highGrowthYears)}" min="1" max="30">
        </div>
        <div class="form-field" style="${p.mode === "two-stage" ? "" : "display:none"}">
          <label>${tip("安定期 g_terminal (%)", "高成長期 N 年が終わった後の永続成長率。長期 GDP 成長率程度 (1-3%) が一般的。")}</label>
          <input type="number" step="0.1" name="terminalGrowthPct" value="${h(p.terminalGrowthPct)}" min="-5" max="10">
        </div>
      </div>
    </div>
  </details>

  <button type="submit" class="form-submit">理論株価を計算</button>
</form>
`;

  // === Result ===
  let resultBlock = "";
  if (p.mode === "gordon" && props.gordonResult) {
    const r = props.gordonResult;
    const cur = props.currentPrice;
    const margin = cur !== null && cur > 0 ? (r.intrinsicValue - cur) / cur : null;
    const status =
      margin === null ? "neutral" : margin > 0.1 ? "good" : margin < -0.1 ? "bad" : "neutral";
    const statusLabel =
      margin === null
        ? "比較不能"
        : margin > 0.1
        ? "割安 (理論値が現在株価を10%以上上回る)"
        : margin < -0.1
        ? "割高 (理論値が現在株価を10%以上下回る)"
        : "概ねフェア";

    resultBlock = `
<div class="result-box">
  <div class="result-sub">${tip("理論株価 (Gordon Model)", "P = D₁ ÷ (k − g) で算出した1株あたりの理論価格。実際の市場価格と比較して割安/割高を判断する。")}</div>
  <div class="result-headline">${fmtPrice(r.intrinsicValue)}<span class="unit">円/株</span></div>
  <div class="stats-row">
    <div class="stat-cell">
      <div class="lbl">現在株価</div>
      <div class="val">${fmtPrice(cur)}</div>
      <div class="sub">${cur === null ? "未取得" : "Yahoo Finance"}</div>
    </div>
    <div class="stat-cell">
      <div class="lbl">${tip("割安度", "(理論株価 − 現在株価) ÷ 現在株価。+10% 以上で割安、-10% 以下で割高と判定。")}</div>
      <div class="val ${status}">${margin === null ? "—" : ((margin > 0 ? "+" : "") + (margin * 100).toFixed(1) + "%")}</div>
      <div class="sub">理論 vs 株価</div>
    </div>
    <div class="stat-cell">
      <div class="lbl">${tip("k - g スプレッド", "要求リターンと成長率の差。この値が小さいほど分母が小さくなり、わずかな前提変動で理論株価が大きく動く (不安定)。")}</div>
      <div class="val accent">${((p.requiredReturnPct - p.growthRatePct)).toFixed(2)}%</div>
      <div class="sub">小さいと不安定</div>
    </div>
  </div>
  <div style="margin-top:12px"><span class="badge badge-${status === "good" ? "good" : status === "bad" ? "bad" : "neutral"}">${h(statusLabel)}</span></div>
</div>

${renderSensitivity(r, p.requiredReturnPct, p.growthRatePct)}
`;
  } else if (p.mode === "two-stage" && props.twoStageResult) {
    const r = props.twoStageResult;
    const cur = props.currentPrice;
    const margin = cur !== null && cur > 0 ? (r.intrinsicValue - cur) / cur : null;
    const status =
      margin === null ? "neutral" : margin > 0.1 ? "good" : margin < -0.1 ? "bad" : "neutral";

    const yearRows = r.yearlyDividends
      .map(
        (d, i) => `
      <tr>
        <td>Year ${i + 1}</td>
        <td class="num">${fmtPrice(d)}</td>
        <td class="num">${fmtPrice(r.yearlyPV[i])}</td>
      </tr>`
      )
      .join("");

    resultBlock = `
<div class="result-box">
  <div class="result-sub">理論株価 (2段階 DCF)</div>
  <div class="result-headline">${fmtPrice(r.intrinsicValue)}<span class="unit">円/株</span></div>
  <div class="stats-row">
    <div class="stat-cell">
      <div class="lbl">現在株価</div>
      <div class="val">${fmtPrice(cur)}</div>
    </div>
    <div class="stat-cell">
      <div class="lbl">${tip("割安度", "(理論株価 − 現在株価) ÷ 現在株価。プラスなら割安、マイナスなら割高。")}</div>
      <div class="val ${status}">${margin === null ? "—" : ((margin > 0 ? "+" : "") + (margin * 100).toFixed(1) + "%")}</div>
    </div>
    <div class="stat-cell">
      <div class="lbl">${tip("ターミナルバリュー", "Year N 末時点で計算した「以降ずっとこの価値が続く」永続価値。Gordon で算出。")}</div>
      <div class="val">${fmtPrice(r.terminalValue)}</div>
      <div class="sub">PV換算: ${fmtPrice(r.terminalPV)}</div>
    </div>
  </div>
  <div class="table-wrap">
    <table>
      <thead><tr><th>期</th><th class="num">予想配当 (円)</th><th class="num">現在価値 (円)</th></tr></thead>
      <tbody>${yearRows}
        <tr style="background:var(--bg-soft)"><td><strong>合計 (高成長期 PV)</strong></td><td></td><td class="num"><strong>${fmtPrice(r.yearlyPV.reduce((a, b) => a + b, 0))}</strong></td></tr>
        <tr><td><strong>+ ターミナル PV</strong></td><td></td><td class="num"><strong>${fmtPrice(r.terminalPV)}</strong></td></tr>
        <tr style="background:var(--accent-soft)"><td><strong>= 理論株価</strong></td><td></td><td class="num"><strong>${fmtPrice(r.intrinsicValue)}</strong></td></tr>
      </tbody>
    </table>
  </div>
</div>
`;
  }

  // === Formula box (詳細を見たい人向け、初期は折りたたみ) ===
  const formulaBlock = `
<details class="advanced">
  <summary>計算式の解説 (もっと詳しく知りたい人向け)</summary>
  <div class="advanced-body">
    <div class="formula-box">
      <p class="desc"><strong>Gordon 成長モデル</strong></p>
      <div class="eq">P = D₁ / (k − g)</div>
      <ul>
        <li><strong>P</strong>: ${tip("理論株価", "今この銘柄を買う価値があると考えられる価格")}</li>
        <li><strong>D₁</strong>: ${tip("来期予想配当", "1株あたりの来期予想配当金 (円)")}</li>
        <li><strong>k</strong>: ${tip("要求リターン", "投資家が求める年率リターン。CAPM で算出することが多い")}</li>
        <li><strong>g</strong>: ${tip("配当成長率", "配当の年率成長率。長期的に持続可能な水準を使う")}</li>
      </ul>
      <p class="desc" style="margin-top:12px">必ず <code>k &gt; g</code> である必要があります (k ≤ g だと無限大になる)。スプレッドが小さいほど結果は不安定なので、感応度マトリクスで揺らぎを確認してください。</p>
    </div>

    <div class="formula-box">
      <p class="desc"><strong>2段階 DCF</strong> — 高成長期 N 年 → 安定期 (Gordon)</p>
      <div class="eq">P = Σ<sub>t=1..N</sub> [ D₁(1+g₁)<sup>t-1</sup> / (1+k)<sup>t</sup> ] + TV / (1+k)<sup>N</sup></div>
      <div class="eq">TV = D<sub>N+1</sub> / (k − g_terminal)</div>
      <p class="desc" style="margin-top:12px">高成長期と安定期で別の成長率を使うことで、Gordon の「永続成長」前提を緩和できます。スタートアップ株や高成長セクターの評価に向きます。</p>
    </div>
  </div>
</details>
`;

  const body = `
<div class="hero">
  <div class="inner">
    <div class="label"><span class="label-text">004 / DCF</span><span>PRICING</span></div>
    <h1>DCF 法<br>理論株価.</h1>
    <p class="lead">${tip("DCF 法", "Discounted Cash Flow Method。将来生み出すキャッシュフロー (本ツールでは配当) を「今の価値」に割り引いて合計した金額をその株式の本質的価値とみなす評価手法。")}で、銘柄が持つ「本来の価値」を計算します。難しい数式は自動でやるので、銘柄コードを入れて計算ボタンを押すだけ。</p>
  </div>
</div>

<div class="container">
  ${guideBlock}
  ${stockBlock}
  ${nonDividendWarning}
  ${errorBlock}
  ${infoBlock}
  ${formBlock}
  ${resultBlock}
  ${formulaBlock}
</div>
`;
  return layout("DCF 計算機 | 004 KABULAB", body, "dcf");
}

/** 感応度マトリクス HTML 生成 (現在の k,g セルにハイライト) */
function renderSensitivity(r: GordonResult, currentKpct: number, currentGpct: number): string {
  const ks = r.sensitivity.requiredReturns;
  const gs = r.sensitivity.growthRates;
  const ksPct = ks.map((v) => Math.round(v * 1e4) / 100);
  const gsPct = gs.map((v) => Math.round(v * 1e4) / 100);

  const closestIdx = (arr: number[], target: number) => {
    let best = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < arr.length; i++) {
      const d = Math.abs(arr[i] - target);
      if (d < bestDiff) {
        bestDiff = d;
        best = i;
      }
    }
    return best;
  };
  const curKi = closestIdx(ksPct, currentKpct);
  const curGi = closestIdx(gsPct, currentGpct);

  const headerCells = ksPct.map((k) => `<th class="axis-x">k=${k.toFixed(2)}%</th>`).join("");
  const bodyRows = gs
    .map((_, gIdx) => {
      const cells = r.sensitivity.values[gIdx]
        .map((v, kIdx) => {
          if (v === null) return `<td class="cell-na">—</td>`;
          const cls = gIdx === curGi && kIdx === curKi ? "cell cell-current" : "cell";
          return `<td class="${cls}">${fmtPrice(v)}</td>`;
        })
        .join("");
      return `<tr><th class="axis-y">g=${gsPct[gIdx].toFixed(2)}%</th>${cells}</tr>`;
    })
    .join("");

  return `
<div class="section-label">004 / SENSITIVITY MATRIX</div>
<h2>${tip("感応度マトリクス", "前提を少し変えたら理論株価がどれくらい動くかの表。値の振れ幅が大きいほど、その前提に依存しすぎていて結果を鵜呑みにできない、という意味。")}</h2>
<p style="color:var(--text-secondary);font-size:14px;margin-bottom:12px">k と g を ±2% の範囲で動かしたときの理論株価です。<strong>青ハイライト</strong>が現在の入力に最も近いセル。表内の値の振れ幅が大きいほど、結果が前提に依存していることを意味します。</p>
<div class="table-wrap">
<table class="sensitivity">
  <thead>
    <tr><th class="corner">P (円)</th>${headerCells}</tr>
  </thead>
  <tbody>${bodyRows}</tbody>
</table>
</div>
`;
}
