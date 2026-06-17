import { BASE_PATH } from "../../base-path.js";
import { layout, tip } from "./layout.js";

/**
 * 004 Financial Math トップページ — 4 機能ハブ (初心者向けバルーンヘルプ付き)
 */
export function homePage(): string {
  const body = `
<div class="hero">
  <div class="inner">
    <div class="label"><span class="label-text">004 / FINANCIAL MATH</span><span>金融工学</span></div>
    <h1>金融数学を、<br>株分析に効かせる。</h1>
    <p class="lead">難しい数式は自動で計算。あなたは銘柄コード (例: 7011 / 130A) を入れるだけで、その銘柄の「本来の価値」「合理的な期待リターン」「オプション価格」がわかります。</p>
  </div>
</div>

<div class="container">

  <div class="guide">
    <p><strong>はじめての方へ</strong></p>
    <p>このツール群では、教科書に出てくる金融数学の代表的な 4 つの理論を、<strong>東証の実銘柄データと組み合わせて</strong> 使えるようにしています。</p>
    <p>各ツールで <strong>銘柄コード (数字4桁、または 130A のような英字入りコード)</strong> を入れると、その会社のデータが自動で取り込まれて計算されます。専門用語には<span class="tip" tabindex="0">点線</span>がついていて、マウスを乗せると意味が出ます ← こんなふうに。</p>
  </div>

  <div class="section-label">004 / TOOLS</div>
  <h2>ツール一覧</h2>

  <div class="hub-grid">
    <a href="${BASE_PATH}/dcf" class="hub-card">
      <div class="head">
        <span class="num">004 / TOOL · 01</span>
        <span class="badge badge-accent">PRICING</span>
      </div>
      <div class="body">
        <h3>DCF 法</h3>
        <div class="subtitle">本来の株価を計算</div>
        <p class="desc">将来配当の現在価値から「この銘柄の本来あるべき値段」を算出。現在の市場価格と比べて<strong>割安/割高</strong>がわかります。</p>
        <span class="cta">理論株価を計算<span class="arrow">↗</span></span>
      </div>
    </a>

    <a href="${BASE_PATH}/capm" class="hub-card">
      <div class="head">
        <span class="num">004 / TOOL · 02</span>
        <span class="badge badge-accent">PORTFOLIO</span>
      </div>
      <div class="body">
        <h3>CAPM</h3>
        <div class="subtitle">期待リターンを計算</div>
        <p class="desc">市場と比べたこの銘柄の<strong>値動きの荒さ (β)</strong>から、合理的に期待できる年率リターンを計算。DCF の「要求リターン」にも使えます。</p>
        <span class="cta">期待リターンを計算<span class="arrow">↗</span></span>
      </div>
    </a>

    <a href="${BASE_PATH}/emh" class="hub-card">
      <div class="head">
        <span class="num">004 / TOOL · 03</span>
        <span class="badge badge-accent">ANOMALY</span>
      </div>
      <div class="body">
        <h3>EMH アノマリー</h3>
        <div class="subtitle">市場の歪みを探す</div>
        <p class="desc">学術的に実証された<strong>「市場の歪み」</strong>(モメンタム / 小型株 / 低ボラ) で銘柄をランキング表示。次に来そうな銘柄探しに。</p>
        <span class="cta">アノマリーを探す<span class="arrow">↗</span></span>
      </div>
    </a>

    <a href="${BASE_PATH}/black-scholes" class="hub-card">
      <div class="head">
        <span class="num">004 / TOOL · 04</span>
        <span class="badge badge-accent">DERIVATIVES</span>
      </div>
      <div class="body">
        <h3>Black-Scholes</h3>
        <div class="subtitle">オプション価格を計算</div>
        <p class="desc">オプション (買う/売る権利) の理論価格と感応度を計算。市場価格を入れると<strong>市場が予想する将来ボラ</strong>も逆算できます。</p>
        <span class="cta">オプション価格を計算<span class="arrow">↗</span></span>
      </div>
    </a>
  </div>

  <div class="section-label">004 / ABOUT</div>
  <h2>このツール群の背景</h2>
  <div class="formula-box">
    <p class="desc">
      4 つの理論は別々のテーマに見えますが、根っこに同じ前提があります — <strong>${tip("無裁定条件", "No-Arbitrage Condition: 「リスクなしに確実な利益を得る機会は存在しない」というルール。価格差があれば瞬時に裁定取引で揃うため、すべての金融理論の出発点になっている。")}</strong>。
      これを土台に、それぞれ別の角度から金融商品の値段や収益性を定量化します。
    </p>
    <ul>
      <li><strong>${tip("DCF", "Discounted Cash Flow Method: 将来のキャッシュフローを現在価値に割り引いて合計し本質的価値を求める手法。")}</strong>: 将来配当の現在価値で価格を決める</li>
      <li><strong>${tip("CAPM", "Capital Asset Pricing Model: 個別株の期待リターンは「無リスク金利 + β × 市場プレミアム」で説明できるというモデル。")}</strong>: β とマーケットプレミアムで合理的期待リターンを決める</li>
      <li><strong>${tip("EMH", "Efficient Market Hypothesis: 効率的市場仮説。「市場は情報を瞬時に織り込む」というファマの仮説。ただし PEAD / モメンタム / 小型株効果 / 低ボラなどのアノマリーが実証されている。")}</strong>: 市場は概ね効率的だが、構造的なアノマリーは存在する</li>
      <li><strong>${tip("Black-Scholes", "オプション価格の決定版モデル。「コールは現物株Δ単位＋無リスク資産の借入で複製でき、その複製コストが理論価格になる」が要点。")}</strong>: 株のΔ複製でオプション価格を決める</li>
    </ul>
  </div>

  <div class="notice">
    <strong>注意</strong>: 本ツールが返す数値は <em>すべて理論値・参考指標</em> です。投資判断は自己責任で。要求リターン・成長率・ボラティリティなどの入力前提が変わると結果も大きく変わるため、感応度分析を必ず併用してください。
  </div>
</div>
`;

  return layout("金融数学 | 004 KABULAB", body, "home");
}
