/**
 * ホーム — 銘柄検索 + 最近の高シグナル開示 + タグ凡例。
 * ヒット 0 件は「該当なし」を正直に表示する (架空候補を作らない・ルール1)。
 */
import { BASE_PATH } from "../../base-path.js";
import { layout, h } from "./layout.js";
import { publicStockMetaLabel } from "../../../../src/shared/db/public-columns.js";
import { tagChip } from "./tag-chip.js";
import { TAGS } from "../services/classify.js";
import type { StockHit } from "../services/query.js";

interface RecentRow {
  code: string;
  name: string;
  title: string;
  pubdate: string;
  primaryTag: string;
  tdnetId: string;
  documentUrl: string;
}

function fmtDate(iso: string): string {
  return iso.slice(0, 10);
}

function legend(): string {
  // 高シグナルを先頭に、全タグの凡例 (各々バルーンヘルプ付き)
  const items = TAGS.map((d) => tagChip(d.label)).join("");
  return `<div class="legend">${items}</div>`;
}

function resultsBlock(query: string, results: StockHit[] | null): string {
  if (results === null) return "";
  if (results.length === 0) {
    return `<div class="container"><div class="notice">
      <strong>「${h(query)}」に一致する銘柄は見つかりませんでした。</strong><br>
      証券コード (4 文字。例: 7011 / 130A) または会社名の一部で検索してください。開示が1件も無い銘柄は表示されません。
    </div></div>`;
  }
  const cards = results
    .map(
      (r) => `<a href="${BASE_PATH}/stock/${h(r.code)}">
      <span class="code">${h(publicStockMetaLabel([r.code, r.market], " · "))}</span>
      <div class="nm">${h(r.name)}</div>
      <span class="meta">開示 ${r.disclosureCount} 件${
        r.latestPubdate ? ` · 最新 ${fmtDate(r.latestPubdate)}` : ""
      }</span>
    </a>`
    )
    .join("");
  return `<div class="container">
    <div class="section-label">RESULTS / ${results.length}</div>
    <ul class="results">${cards}</ul>
  </div>`;
}

export function homePage(params: {
  query: string;
  results: StockHit[] | null;
  recent: RecentRow[];
}): string {
  const { query, results, recent } = params;
  const focusJs = `<script>const i=document.getElementById('q');if(i){i.focus();i.select();}</script>`;

  const recentBlock =
    recent.length === 0
      ? `<div class="notice">まだ高シグナル開示の取り込みがありません。バックフィル実行後に表示されます。</div>`
      : `<div class="tl">${recent
          .map(
            (r) => `<div class="tl-row">
        <div class="tl-date">${fmtDate(r.pubdate)}</div>
        <div class="tl-body">
          <div class="tl-tags">${tagChip(r.primaryTag)}</div>
          <div class="tl-title"><a href="${BASE_PATH}/stock/${h(
            r.code
          )}">${h(r.code)} ${h(r.name)}</a> — <a href="${BASE_PATH}/file/${h(
            r.tdnetId
          )}" rel="noopener noreferrer" target="_blank">${h(
            r.title
          )}</a></div>
        </div>
      </div>`
          )
          .join("")}</div>`;

  const body = `
<section class="hero"><div class="inner">
  <div class="label">006 / TDNET IR CATALOG</div>
  <h1>適時開示を、<br>意味で色分けする。</h1>
  <p class="lead">東証上場の個別株の適時開示(IR)を全量取得し、増配・上方修正・自社株買い・配当政策の変更などをタグで色分け。銘柄ごとに発表タイミングを時系列でマッピングします。数値・分類は推測で埋めず、当てはまらない開示は「未分類」と正直に出します。</p>
  <form class="search-form" method="get" action="${BASE_PATH}/">
    <div class="grow">
      <label for="q">銘柄検索 (証券コード / 会社名)</label>
      <input id="q" name="q" type="text" inputmode="search" autocomplete="off"
        placeholder="例: 7203 / トヨタ" value="${h(query)}">
    </div>
    <button type="submit">検索</button>
  </form>
  <div class="examples"><span>例:</span>
    <a href="${BASE_PATH}/?q=7203">7203 トヨタ</a>
    <a href="${BASE_PATH}/?q=6758">6758 ソニーG</a>
    <a href="${BASE_PATH}/?q=9432">9432 NTT</a>
    <a href="${BASE_PATH}/signals">高シグナル一覧 →</a>
  </div>
</div></section>
${resultsBlock(query, results)}
<div class="container">
  <div class="section-label">TAGS / 色分け凡例</div>
  <p style="color:var(--text-secondary);font-size:14px;line-height:1.7;margin-bottom:4px">タグ名にマウス/タップで初心者向けの説明が出ます。</p>
  ${legend()}
  <div class="section-label">RECENT / 最近の高シグナル開示</div>
  ${recentBlock}
  <p class="disclaimer">本サービスは TDnet (yanoshin WebAPI) の適時開示一覧を出典とし、表題からの決定論的分類のみを行います。投資判断は必ず各社の開示原本 (PDF) を確認してください。分類は表題ベースのため、内容の最終確認は原本で行う必要があります。</p>
</div>
${results === null ? focusJs : ""}`;

  return layout(query ? `${query} の検索結果` : "ホーム", body, "home");
}
