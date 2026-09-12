import { BASE_PATH } from "../../base-path.js";
import { layout, h, tip } from "./layout.js";
import type { BsResult, Greeks } from "../services/black-scholes.js";
import { STOCK_CODE_HTML_PATTERN, STOCK_CODE_ERROR } from "../../../../src/shared/jpx/stock-code.js";

export interface BsStockContext {
  code: string;
  name: string;
  currentPrice: number | null;
  /** 過去日足から推定したヒストリカルボラ (年率小数) */
  historicalVolatility: number | null;
  /**
   * σ の算出に使った日次リターンの本数。
   *
   * **出さないと嘘になる**。日足の出所を `finmath_daily_ohlcv` (2y = 514 本) から
   * `swing_daily_ohlcv` (保持 90 営業日 = avg 89.3 本) へ振り替えたので、
   * 同じ銘柄でも σ の数値が変わる。ユーザには「値が変わった」としてしか
   * 見えないため、何本で算出したのかを添える。
   */
  volSampleSize: number | null;
  /** 価格断面の基準日 'YYYY-MM-DD' (core_stock_financials.data_date) */
  priceAsOf: string | null;
  /** 日足系列の最新日付 'YYYY-MM-DD'。系列が空なら null */
  seriesAsOf: string | null;
}

export interface BsPageProps {
  preset: {
    code?: string;
    /**
     * 株価 S (円)。null = 銘柄プリフィルしていない (ダミー値を入れない)。
     * **CLAUDE.md ルール1**: spot=1000 のような根拠不明値は禁止。
     * 銘柄コードを入れた場合のみ D1 の断面の株価を実値で入れる。
     */
    spot: number | null;
    /** 行使価格 K (円)。null = 未入力 (ATM 想定なら spot と同値、ITM/OTM はユーザー指定)。 */
    strike: number | null;
    /** 断面からの自動補完フラグ — true なら label 横に「自動」バッジ表示 */
    spotAutoFilled?: boolean;
    strikeAutoFilled?: boolean;
    volAutoFilled?: boolean;
    /** 残存日数。3 ヶ月 (90日) は標準的なオプション期間。会計コンセプトとしての目安値で OK。 */
    daysToExpiry: number;
    /** Rf (%)。日本国債10年利回り近似 0.5% を初期値 (UIに根拠記載)。 */
    riskFreeRatePct: number;
    /**
     * ボラティリティ σ (%/年)。null = 銘柄未指定 (ダミー値 30 等を入れない)。
     * 銘柄プリフィル時はヒストリカル σ (実値) を入れる。
     */
    volatilityPct: number | null;
    marketPrice?: number;
    ivType?: "call" | "put";
  };
  stockContext: BsStockContext | null;
  result: BsResult | null;
  impliedVolatility: number | null;
  ivUnavailableReason: string | null;
  error: string | null;
  /** 情報通知 (自動補完・プリフィル失敗の理由など) — 青系 notice で表示 */
  infoNotice?: string | null;
}

function fmtCurrency(value: number): string {
  if (Math.abs(value) >= 1000) return Math.round(value).toLocaleString("ja-JP");
  return value.toFixed(2);
}

export function bsPage(props: BsPageProps): string {
  const p = props.preset;
  const ctx = props.stockContext;

  const stockBlock = ctx
    ? `<div class="stock-context">
         <span class="code">${h(ctx.code)}</span>
         <span class="name">${h(ctx.name)}</span>
         <span class="meta">現在株価: ${ctx.currentPrice !== null ? Math.round(ctx.currentPrice).toLocaleString("ja-JP") + " 円" : "—"}</span>
         ${ctx.priceAsOf !== null ? `<span class="meta">株価 as of: ${h(ctx.priceAsOf)}</span>` : ""}
         ${ctx.historicalVolatility !== null ? `<span class="meta">ヒストリカルボラ: ${(ctx.historicalVolatility * 100).toFixed(1)}%</span>` : ""}
         ${
           // as_of だけでは「短い系列で計算した」ことが伝わらない。
           // 日足の出所を 2y の Yahoo キャッシュから保持 90 営業日の
           // swing_daily_ohlcv へ振り替えた結果、σ の数値そのものが変わる。
           ctx.volSampleSize !== null
             ? `<span class="meta">σ サンプル: ${ctx.volSampleSize} 本${ctx.seriesAsOf !== null ? ` (〜${h(ctx.seriesAsOf)})` : ""}</span>`
             : `<span class="meta">σ サンプル: 不足 (20 本未満)</span>`
         }
       </div>`
    : "";

  const errorBlock = props.error
    ? `<div class="notice notice--error"><span class="title-badge">ERROR</span><strong>入力エラー</strong> ${h(props.error)}</div>`
    : "";

  const infoBlock = props.infoNotice
    ? `<div class="notice notice--info"><span class="title-badge">INFO</span>${h(props.infoNotice)}</div>`
    : "";

  // === 初心者向けガイド ===
  const guideBlock = `
<div class="guide">
  <p><strong>はじめての方へ</strong></p>
  <p>銘柄コードを入れると<strong>${tip("株価", "現在の株価 S。日次同期が取得した株価断面から自動入力します。")}</strong>と<strong>${tip("ボラティリティ", "値動きの激しさ。過去の日足から自動計算した実績値 (ヒストリカル σ) を初期値に。")}</strong>を自動入力します。あとは知りたい<strong>${tip("行使価格", "オプションを行使するときの「ストライク」。例: 株価 8,000 円のコール 8,500 円なら、8,500 円で買う権利を意味する。")}</strong>と<strong>${tip("残存日数", "オプションの満期までのカレンダー日数。30日, 90日 などが定番。")}</strong>を入れて計算ボタンを押すだけ。</p>
  <p>計算結果は <strong>${tip("コール", "「ある価格で買う権利」。株価上昇で価値が上がる。例: 8,000 円コール = 満期時に株価が 8,000 円を超えていれば 差額だけ利益。")}</strong> と <strong>${tip("プット", "「ある価格で売る権利」。株価下落で価値が上がる。下落リスクヘッジに使う。")}</strong> 両方の理論価格と、5つの ${tip("感応度 (Greeks)", "オプション価格が S・σ・時間・金利の変化にどれだけ反応するかの指標 5 つ。")} です。</p>
</div>
`;

  const formBlock = `
<form class="form-box" data-label="INPUT" method="POST" action="${BASE_PATH}/api/black-scholes/calc">
  <div class="form-field span-full">
    <label>${tip("銘柄コード", "東証の証券コード。数字4桁 (例: 7974 任天堂) と、2024年以降の新規上場銘柄に付く英字入りコード (例: 130A) の両方に対応。S とヒストリカル σ を自動取得します。")}</label>
    <input type="text" name="code" value="${h(p.code ?? "")}" placeholder="例: 7974 / 130A" pattern="${STOCK_CODE_HTML_PATTERN}" maxlength="4" autocapitalize="characters" title="${h(STOCK_CODE_ERROR)}">
    <span class="hint">指定すると株価とボラティリティが自動で埋まります。${p.code ? `<a href="${BASE_PATH}/black-scholes">クリア</a>` : `例: <a href="${BASE_PATH}/black-scholes?code=7974">7974 任天堂</a> <a href="${BASE_PATH}/black-scholes?code=9984">9984 SBG</a> <a href="${BASE_PATH}/black-scholes?code=8035">8035 東京エレクトロン</a>`}</span>
  </div>

  <div class="form-field">
    <label>${tip("行使価格 K (円)", "オプションを行使するときのストライク価格。銘柄コード入力時は現在株価 (ATM) を初期値に。ITM/OTM を試したい場合は手動で変更してください。")}${p.strikeAutoFilled ? '<span class="auto-badge">自動 ATM</span>' : ""}</label>
    <input type="number" step="0.5" name="strike"
           value="${p.strike !== null && p.strike > 0 ? h(p.strike) : ""}"
           placeholder="${ctx ? "現在株価が入ります" : "銘柄コード入力時は自動 ATM"}"
           min="0.01">
    <span class="hint">空 + 銘柄コード指定時は ATM (= 現在株価) で計算</span>
  </div>
  <div class="form-field">
    <label>${tip("残存日数", "満期までのカレンダー日数。例: 1ヶ月=30日, 3ヶ月=90日。")}</label>
    <input type="number" step="1" name="daysToExpiry" value="${h(p.daysToExpiry)}" required min="1" max="1825">
  </div>

  <details class="advanced span-full" ${!ctx ? "open" : ""}>
    <summary>詳細設定 ${!ctx ? "(株価/ボラを手動入力)" : "(自動入力済 — 上書きしたい場合のみ)"}</summary>
    <div class="advanced-body">
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px">
        <div class="form-field">
          <label>${tip("株価 S (円)", "現在の株価。銘柄コードを入れると日次同期の株価断面から自動入力されます。")}${p.spotAutoFilled ? '<span class="auto-badge">自動</span>' : ""}</label>
          <input type="number" step="0.5" name="spot"
                 value="${p.spot !== null && p.spot > 0 ? h(p.spot) : ""}"
                 placeholder="${ctx ? "" : "銘柄コード入力時は自動取得"}"
                 min="0.01">
        </div>
        <div class="form-field">
          <label>${tip("ボラティリティ σ (%/年)", "年率の値動きの激しさ。銘柄コード入力時は過去日足から計算した実績ボラ (ヒストリカル σ) が入ります。30% なら年率 30% で動く。")}${p.volAutoFilled ? '<span class="auto-badge">自動</span>' : ""}</label>
          <input type="number" step="0.5" name="volatilityPct"
                 value="${p.volatilityPct !== null && p.volatilityPct > 0 ? h(p.volatilityPct) : ""}"
                 placeholder="${ctx ? "" : "銘柄コード入力時は自動計算"}"
                 min="0.01" max="500">
        </div>
        <div class="form-field">
          <label>${tip("リスクフリーレート r (%)", "リスクゼロの年率金利。日本では 10 年国債利回り 0.5〜1.5% 程度。")}</label>
          <input type="number" step="0.05" name="riskFreeRatePct" value="${h(p.riskFreeRatePct)}" required min="-5" max="20">
        </div>
        <div class="form-field">
          <label>${tip("オプション市場価格 (任意)", "市場で観測されたオプション価格を入れると IV (インプライドボラ) を逆算します。")}</label>
          <input type="number" step="0.5" name="marketPrice" value="${h(p.marketPrice ?? "")}" min="0" placeholder="(IV 逆算したい時のみ)">
        </div>
        <div class="form-field">
          <label>IV 計算対象 (call/put)</label>
          <select name="ivType">
            <option value="call" ${p.ivType !== "put" ? "selected" : ""}>Call</option>
            <option value="put" ${p.ivType === "put" ? "selected" : ""}>Put</option>
          </select>
        </div>
      </div>
    </div>
  </details>

  <button type="submit" class="form-submit">理論価格と Greeks を計算</button>
</form>
`;

  let resultBlock = "";
  if (props.result) {
    const r = props.result;
    resultBlock = `
<div class="result-box">
  <div class="result-sub">理論価格 (Black-Scholes)</div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;margin:8px 0 14px">
    <div>
      <div style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted);letter-spacing:0.1em">${tip("CALL", "「株価が上がれば得する権利」。買う権利の価格。")}</div>
      <div class="result-headline" style="font-size:36px">${fmtCurrency(r.callPrice)}<span class="unit">円</span></div>
    </div>
    <div>
      <div style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted);letter-spacing:0.1em">${tip("PUT", "「株価が下がれば得する権利」。売る権利の価格。")}</div>
      <div class="result-headline" style="font-size:36px">${fmtCurrency(r.putPrice)}<span class="unit">円</span></div>
    </div>
  </div>
  <div class="stats-row">
    <div class="stat-cell">
      <div class="lbl">${tip("d₁", "BS 式の中で出てくる中間値。N(d₁) はおおむね Δ (Delta) を意味する。")}</div>
      <div class="val">${r.d1.toFixed(4)}</div>
    </div>
    <div class="stat-cell">
      <div class="lbl">${tip("d₂", "d₂ = d₁ − σ√T。N(d₂) は満期時に行使価格を超える確率に近い意味を持つ。")}</div>
      <div class="val">${r.d2.toFixed(4)}</div>
    </div>
    <div class="stat-cell">
      <div class="lbl">${tip("パリティ残差", "プット-コール・パリティ C − P = S − K·e^(−rT) の検算。理論的に 0 になる (計算機の正しさの自己確認)。")}</div>
      <div class="val ${Math.abs(r.parityResidual) < 1e-6 ? "good" : "bad"}">${r.parityResidual.toExponential(2)}</div>
      <div class="sub">理論的に 0</div>
    </div>
  </div>
</div>

<div class="section-label">004 / GREEKS — CALL</div>
${renderGreeks(r.callGreeks, "call")}

<div class="section-label">004 / GREEKS — PUT</div>
${renderGreeks(r.putGreeks, "put")}
`;
  }

  let ivBlock = "";
  if (props.impliedVolatility !== null) {
    const inputVol = p.volatilityPct;
    const ivPct = props.impliedVolatility * 100;
    // 入力ボラとの差は input が null の場合は「比較不能」と明示 (ルール2: 黙ってデフォルト値を入れない)
    const diffLine =
      inputVol !== null && Number.isFinite(inputVol)
        ? `入力ボラ ${inputVol.toFixed(1)}% との差: <strong>${((ivPct - inputVol) > 0 ? "+" : "") + (ivPct - inputVol).toFixed(2)}%</strong> — 市場が予想する将来ボラ vs ヒストリカルボラの乖離。`
        : `入力ボラとの差: 比較不能 (入力ボラが未設定)`;
    ivBlock = `
<div class="result-box" style="background:var(--accent-soft);border-color:var(--accent)">
  <div class="result-sub" style="color:var(--accent)">${tip("Implied Volatility", "市場のオプション価格から逆算した「市場が予想する将来ボラ」。ヒストリカルボラ (過去) との差で市場の期待を読み取れる。")}</div>
  <div class="result-headline" style="color:var(--accent)">${ivPct.toFixed(2)}<span class="unit">%/年</span></div>
  <p style="font-size:13px;color:var(--text-secondary);margin-top:8px">${diffLine}</p>
</div>
`;
  } else if (props.ivUnavailableReason) {
    ivBlock = `<div class="notice"><strong>IV を逆算できません</strong> — ${h(props.ivUnavailableReason)}</div>`;
  }

  const formulaBlock = `
<details class="advanced">
  <summary>計算式の解説 (もっと詳しく知りたい人向け)</summary>
  <div class="advanced-body">
    <div class="formula-box">
      <p class="desc"><strong>Black-Scholes-Merton 式</strong> (ヨーロピアン、無配当)</p>
      <div class="eq">C = S · N(d₁) − K · e<sup>−rT</sup> · N(d₂)</div>
      <div class="eq">P = K · e<sup>−rT</sup> · N(−d₂) − S · N(−d₁)</div>
      <div class="eq">d₁ = [ ln(S/K) + (r + σ²/2) · T ] / (σ · √T)</div>
      <div class="eq">d₂ = d₁ − σ · √T</div>
      <ul>
        <li><strong>S</strong>: 現在の株価 / <strong>K</strong>: 行使価格 / <strong>T</strong>: 残存年数</li>
        <li><strong>r</strong>: リスクフリーレート / <strong>σ</strong>: 年率ボラティリティ</li>
        <li><strong>N(x)</strong>: 標準正規分布の累積分布関数</li>
      </ul>
      <p class="desc" style="margin-top:12px">
        重要なメッセージは「コールは <em>現物株Δ単位＋無リスク資産の借入</em> で複製でき、その複製コストが理論価格になる」こと。
        本実装は配当落ち補正なし (q=0)。配当銘柄では実勢価格と乖離する点に注意。
      </p>
    </div>

    <div class="formula-box">
      <p class="desc"><strong>5 つの感応度 (Greeks)</strong></p>
      <ul>
        <li><strong>Δ (Delta)</strong>: 株価1円変化に対する価格変化</li>
        <li><strong>Γ (Gamma)</strong>: Δ自体の変化率 (凸性)</li>
        <li><strong>ν (Vega)</strong>: ボラ1%変化に対する価格変化</li>
        <li><strong>Θ (Theta)</strong>: 1日経過に対する価格変化 (時間減衰)</li>
        <li><strong>ρ (Rho)</strong>: 金利1%変化に対する価格変化</li>
      </ul>
    </div>
  </div>
</details>
`;

  const body = `
<div class="hero">
  <div class="inner">
    <div class="label"><span class="label-text">004 / BLACK-SCHOLES</span><span>DERIVATIVES</span></div>
    <h1>Black-Scholes<br>オプション価格.</h1>
    <p class="lead">ヨーロピアン式の${tip("コール/プット", "コール = 買う権利、プット = 売る権利。それぞれ満期日まで保有でき、満期時に行使するか決められる。")}価格と 5 つの ${tip("Greeks", "Δ Γ ν Θ ρ。価格が株価・ボラ・時間・金利の変化にどう反応するかの感応度。")} を一括算出。市場価格を入れれば ${tip("IV", "Implied Volatility = 市場価格から逆算した将来ボラ予想。")} を逆算できます。</p>
  </div>
</div>

<div class="container">
  ${guideBlock}
  ${stockBlock}
  ${errorBlock}
  ${infoBlock}
  ${formBlock}
  ${resultBlock}
  ${ivBlock}
  ${formulaBlock}
</div>
`;
  return layout("Black-Scholes 計算機 | 004 KABULAB", body, "bs");
}

function renderGreeks(g: Greeks, kind: "call" | "put"): string {
  const deltaDesc =
    kind === "call"
      ? "コール: 0〜1 の範囲。ATM 近辺で約 0.5。"
      : "プット: -1〜0 の範囲。ATM 近辺で約 -0.5。";
  return `<div class="greeks-grid">
  <div class="greek-cell">
    <div class="symbol">Δ</div>
    <div class="name">${tip("Delta", `株価が 1 円動いたときのオプション価格の変化量。${deltaDesc}`)}</div>
    <div class="val">${g.delta.toFixed(4)}</div>
    <div class="desc">株価1円変化</div>
  </div>
  <div class="greek-cell">
    <div class="symbol">Γ</div>
    <div class="name">${tip("Gamma", "Δ 自体の変化率。Δ の傾き。ATM で最大になり、ITM/OTM で小さくなる。")}</div>
    <div class="val">${g.gamma.toExponential(2)}</div>
    <div class="desc">Δの変化率</div>
  </div>
  <div class="greek-cell">
    <div class="symbol">ν</div>
    <div class="name">${tip("Vega", "ボラティリティが 1% 動いたときの価格変化 (円)。「ボラを売買する」戦略の核心指標。")}</div>
    <div class="val">${g.vega.toFixed(4)}</div>
    <div class="desc">ボラ1%変化</div>
  </div>
  <div class="greek-cell">
    <div class="symbol">Θ</div>
    <div class="name">${tip("Theta", "1日経過したときの価格減少 (円)。時間減衰。コール・プット買い手にはマイナス、売り手にはプラス。")}</div>
    <div class="val">${g.theta.toFixed(4)}</div>
    <div class="desc">1日経過</div>
  </div>
  <div class="greek-cell">
    <div class="symbol">ρ</div>
    <div class="name">${tip("Rho", "金利が 1% 動いたときの価格変化 (円)。長期オプションほど影響が大きい。短期オプションでは小さい。")}</div>
    <div class="val">${g.rho.toFixed(4)}</div>
    <div class="desc">金利1%変化</div>
  </div>
</div>`;
}
