import { layout, h } from "./layout.js";
import { BASE_PATH } from "../../base-path.js";
import type { StockHit } from "../services/order-query.js";
import { publicStockMetaLabel } from "../../../../src/shared/db/public-columns.js";

/**
 * ホーム = 検索フォーム + (検索時) 結果一覧。
 * 結果が無いときは「該当なし」と正直に出す (架空の候補を出さない)。
 */
export function homePage(opts: {
  query: string;
  results: StockHit[] | null;
}): string {
  const { query, results } = opts;

  const form = `
<div class="container">
  <form class="search-form" method="get" action="${BASE_PATH}/">
    <div class="grow">
      <label for="q">銘柄コード / 会社名</label>
      <input id="q" name="q" type="search" inputmode="search" value="${h(query)}"
        placeholder="例: 7011 / 三菱重工 / 建設" autocomplete="off" autofocus
        aria-label="銘柄コードまたは会社名で検索">
    </div>
    <button type="submit">検索</button>
  </form>
  ${
    results === null
      ? `<p class="examples">例: ${[
          ["7011", "三菱重工業"],
          ["7012", "川崎重工業"],
          ["1803", "清水建設"],
          ["6501", "日立製作所"],
        ]
          .map(
            ([c, n]) =>
              `<a href="${BASE_PATH}/?q=${c}">${c} ${h(n)}</a>`
          )
          .join("")}</p>`
      : ""
  }`;

  let resultBlock = "";
  if (results !== null) {
    if (results.length === 0) {
      resultBlock = `
  <div class="section-label">RESULT</div>
  <div class="notice" role="status" aria-live="polite"><strong>「${h(query)}」に一致する上場銘柄は見つかりませんでした。</strong>
  <span class="st">銘柄コード (4 文字。例: 7011 / 130A) または 会社名の一部で検索してください</span></div>`;
    } else {
      const items = results
        .map(
          (s) => `<li><a href="${BASE_PATH}/stock/${s.code}">
        <div class="code">${h(s.code)}</div>
        <div class="nm">${h(s.name)}</div>
        <div class="meta">${h(publicStockMetaLabel([s.market, s.sector]))}</div>
      </a></li>`
        )
        .join("");
      resultBlock = `
  <div class="section-label">RESULT — ${results.length} 件</div>
  <ul class="results">${items}</ul>`;
    }
  }

  const body = `
<div class="hero"><div class="inner">
  <div class="label">005 / YUHO-QUANT</div>
  <h1>有価証券報告書の<br>定量情報を、検索する。</h1>
  <p class="lead">金融庁 EDINET の有価証券報告書から「受注高 / 受注残高」をセグメント別に構造化。会社を選ぶと、最大5年の受注推移をグラフで確認できます。</p>
</div></div>
${form}
${resultBlock}
  <p class="disclaimer">出典: 金融庁 EDINET。本ツールは有報の開示値を機械的に構造化したものです。表の構造を確実に判定できなかった場合は数値を作らず「未対応」と表示します。投資判断は必ず原典(有価証券報告書)をご確認ください。</p>
</div>`;

  return layout("有報定量検索", body, results !== null ? "search" : "home");
}
