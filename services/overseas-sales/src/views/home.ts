import { layout, h } from "./layout.js";
import { BASE_PATH } from "../../base-path.js";
import type { StockHit } from "../services/overseas-query.js";

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
        placeholder="例: 7203 / トヨタ / 6758 / ソニー" autocomplete="off" autofocus
        aria-label="銘柄コードまたは会社名で検索">
    </div>
    <button type="submit">検索</button>
  </form>
  ${
    results === null
      ? `<p class="examples">例: ${[
          ["6758", "ソニーグループ"],
          ["6981", "村田製作所"],
          ["7741", "HOYA"],
          ["6594", "ニデック"],
        ]
          .map(([c, n]) => `<a href="${BASE_PATH}/?q=${c}">${c} ${h(n)}</a>`)
          .join("")}</p>`
      : ""
  }`;

  let resultBlock = "";
  if (results !== null) {
    if (results.length === 0) {
      resultBlock = `
  <div class="section-label">RESULT</div>
  <div class="notice" role="status" aria-live="polite"><strong>「${h(query)}」に一致する上場銘柄は見つかりませんでした。</strong>
  <span class="st">銘柄コード (4 文字。例: 7203 / 130A) または 会社名の一部で検索してください</span></div>`;
    } else {
      const items = results
        .map(
          (s) => `<li><a href="${BASE_PATH}/stock/${s.code}">
        <div class="code">${h(s.code)}</div>
        <div class="nm">${h(s.name)}</div>
        <div class="meta">${h(s.market)}${s.sector ? " / " + h(s.sector) : ""}</div>
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
  <div class="label">008 / OVERSEAS-SALES</div>
  <h1>海外売上高の比率と<br>推移を、検索する。</h1>
  <p class="lead">金融庁 EDINET の有価証券報告書から「海外（地域別）売上高」と「海外売上高比率」を構造化。会社を選ぶと、最大5年の海外売上高・比率・地域別内訳をグラフで確認できます。</p>
</div></div>
${form}
${resultBlock}
  <p class="disclaimer">出典: 金融庁 EDINET。本ツールは有報の地域別売上開示を機械的に構造化したものです。表の構造を確実に判定できなかった場合は数値を作らず「未対応」と表示します。投資判断は必ず原典(有価証券報告書)をご確認ください。</p>
</div>`;

  return layout("海外売上高検索", body, results !== null ? "search" : "home");
}
