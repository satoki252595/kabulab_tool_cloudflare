/**
 * 高シグナル一覧 — 全銘柄横断で増配/上方修正/自社株買い等の最新開示。
 */
import { BASE_PATH } from "../../base-path.js";
import { layout, h } from "./layout.js";
import { tagChip } from "./tag-chip.js";

interface SignalRow {
  code: string;
  name: string;
  title: string;
  pubdate: string;
  primaryTag: string;
  tdnetId: string;
  documentUrl: string;
}

export function signalsPage(rows: SignalRow[]): string {
  const list =
    rows.length === 0
      ? `<div class="notice"><strong>高シグナル開示がまだありません。</strong><br>バックフィル / 日次取り込み後に表示されます。</div>`
      : `<div class="tl">${rows
          .map(
            (r) => `<div class="tl-row">
        <div class="tl-date">${h(r.pubdate.slice(0, 10))}</div>
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
  <div class="label">006 / HIGH-SIGNAL</div>
  <h1>高シグナル開示</h1>
  <p class="lead">配当政策の変更・増配・減配・上方修正・下方修正・自社株買い・自己株式の消却。投資判断に効きやすい開示だけを全銘柄横断で新しい順に表示します。</p>
</div></section>
<div class="container">
  <div class="section-label">LATEST / ${rows.length}</div>
  ${list}
  <p class="disclaimer">出典: TDnet (yanoshin WebAPI)。タグは表題からの決定論的分類。最終確認は開示原本で。</p>
</div>`;
  return layout("高シグナル開示", body, "signal");
}
