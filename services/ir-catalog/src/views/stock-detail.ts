/**
 * 銘柄詳細 — IR 発表タイミングのタグ色分けタイムライン (月グループ)。
 * 専門用語タグには初心者バルーン (ルール7)。銘柄名は buffett-code リンク。
 *
 * 投資家視点のセンチメント (ポジ/ネガ) は `sentiment.ts` の決定論的マッピング
 * に基づき、UI 上で「シグナルハイライト」セクション + 個別行の左ボーダー色で
 * 可視化する。中立タグ (配当政策の変更 / 業績予想の修正 等 = 方向不明) は
 * 装飾せず、原本 PDF で確認を促す (ルール1: 方向を捏造しない)。
 */
import { BASE_PATH } from "../../base-path.js";
import { layout, h } from "./layout.js";
import { tagChip, tagChips } from "./tag-chip.js";
import { buffettCodeUrl } from "../services/classify.js";
import {
  NEGATIVE_TAG_LIST,
  POSITIVE_TAG_LIST,
  rowSentiments,
} from "../services/sentiment.js";
import { termTip } from "../../../../src/shared/term-tip.js";
import type { StockTimeline, DisclosureRow } from "../services/query.js";

const PERIODS: Array<{ months: number; label: string }> = [
  { months: 12, label: "1年" },
  { months: 24, label: "2年" },
  { months: 60, label: "5年" },
  { months: 1200, label: "全期間" },
];

function ym(iso: string): string {
  return iso.slice(0, 7);
}
function ymLabel(s: string): string {
  return `${s.slice(0, 4)}年${s.slice(5, 7)}月`;
}

function groupByMonth(rows: DisclosureRow[]): Array<[string, DisclosureRow[]]> {
  const map = new Map<string, DisclosureRow[]>();
  for (const r of rows) {
    const k = ym(r.pubdate);
    const arr = map.get(k);
    if (arr) arr.push(r);
    else map.set(k, [r]);
  }
  // rows は pubdate desc 済み → 月キーも新しい順で挿入される
  return [...map.entries()];
}

function tagQs(tag: string | null): string {
  return tag ? `&tag=${encodeURIComponent(tag)}` : "";
}

function periodNav(code: string, current: number, tag: string | null): string {
  return `<div class="period-nav">${PERIODS.map(
    (p) =>
      `<a class="${p.months === current ? "on" : ""}" href="${BASE_PATH}/stock/${h(
        code
      )}?months=${p.months}${tagQs(tag)}">${p.label}</a>`
  ).join("")}</div>`;
}

/** クリックでそのタグだけに絞り込む内訳チップ */
function summaryLink(
  code: string,
  months: number,
  key: string,
  inner: string,
  active: boolean
): string {
  const qTag = key === "_unclassified" ? "_unclassified" : key;
  const href = active
    ? `${BASE_PATH}/stock/${h(code)}?months=${months}`
    : `${BASE_PATH}/stock/${h(code)}?months=${months}&tag=${encodeURIComponent(
        qTag
      )}`;
  return `<a href="${href}" aria-pressed="${active ? "true" : "false"}" style="text-decoration:none;display:inline-flex;align-items:center;gap:4px${
    active ? ";outline:2px solid var(--border);outline-offset:2px;border-radius:var(--radius)" : ""
  }" title="${active ? "絞り込み解除" : "このタグだけ表示"}">${inner}</a>`;
}

export function stockDetailPage(t: StockTimeline): string {
  const bc = buffettCodeUrl(t.code);
  const periodLabel =
    PERIODS.find((p) => p.months === t.months)?.label ?? `${t.months}か月`;

  const tagSummary = Object.entries(t.tagCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([key, n]) => {
      const active = t.activeTag === key;
      const inner =
        key === "_unclassified"
          ? `<span class="chip unclassified"><span class="dot"></span>未分類</span><span class="meta" style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted)">${n}</span>`
          : `${tagChip(
              key
            )}<span class="meta" style="margin-left:-2px;font-family:var(--font-mono);font-size:11px;color:var(--text-muted)">${n}</span>`;
      return summaryLink(t.code, t.months, key, inner, active);
    })
    .join("");

  const filterBanner =
    t.activeTag !== null
      ? `<div style="margin:6px 0 0;font-family:var(--font-mono);font-size:12px;color:var(--text-secondary)">「${h(
          t.activeTag === "_unclassified" ? "未分類" : t.activeTag
        )}」で絞り込み中 (${t.disclosures.length}/${t.periodTotal}件) · <a href="${BASE_PATH}/stock/${h(
          t.code
        )}?months=${t.months}">絞り込み解除</a></div>`
      : "";

  const emptyMsg =
    t.activeTag !== null
      ? `<div class="notice"><strong>${periodLabel}内に「${h(
          t.activeTag === "_unclassified" ? "未分類" : t.activeTag
        )}」の開示はありません。</strong><br>
         <a href="${BASE_PATH}/stock/${h(t.code)}?months=${
          t.months
        }">絞り込みを解除</a>するか、期間を広げてください。</div>`
      : `<div class="notice"><strong>${periodLabel}に取り込まれた適時開示はありません。</strong><br>
         期間を「全期間」に広げるか、バックフィルの取り込み状況をご確認ください。</div>`;

  /**
   * 行装飾の優先順位 + SR 補助ラベル:
   *   1. title-based pos/neg → 確定装飾 (tl-row--pos/neg)
   *   2. PDF-based pos/neg (title 中立) → 弱装飾 (tl-row--pdf-pos/neg)
   *   3. title と PDF が矛盾 → tl-row--mixed (dotted border) + 「要本文確認」
   *   4. それ以外 → 装飾なし
   */
  interface RowDecoration {
    cls: string;
    /** SR 用 aria-label。装飾なし行は空文字 */
    label: string;
  }
  const rowDecoration = (r: DisclosureRow): RowDecoration => {
    const ts = rowSentiments(r.tags);
    const titlePos = ts.has("positive");
    const titleNeg = ts.has("negative");
    const pdfPos = r.pdfSentiment === "positive";
    const pdfNeg = r.pdfSentiment === "negative";
    if (titlePos && titleNeg)
      return { cls: " tl-row--mixed", label: "タイトル内に正負が混在 — 本文確認推奨" };
    if ((titlePos && pdfNeg) || (titleNeg && pdfPos))
      return { cls: " tl-row--mixed", label: "タイトルと PDF 推定が矛盾 — 本文確認推奨" };
    if (titlePos) return { cls: " tl-row--pos", label: "タイトルから株主に有利な方向を確定" };
    if (titleNeg) return { cls: " tl-row--neg", label: "タイトルから株主に不利な方向を確定" };
    if (pdfPos) return { cls: " tl-row--pdf-pos", label: "PDF 本文から株主に有利と推定 (確定ではない)" };
    if (pdfNeg) return { cls: " tl-row--pdf-neg", label: "PDF 本文から株主に不利と推定 (確定ではない)" };
    return { cls: "", label: "" };
  };

  const timeline =
    t.disclosures.length === 0
      ? emptyMsg
      : `<div class="tl">${groupByMonth(t.disclosures)
          .map(
            ([mk, rows]) => `<div class="tl-month">
        <div class="tl-month-h">${ymLabel(mk)} · ${rows.length}件</div>
        ${rows
          .map((r) => {
            const dec = rowDecoration(r);
            const ariaAttr = dec.label ? ` role="group" aria-label="${dec.label}"` : "";
            return `<div class="tl-row${dec.cls}"${ariaAttr}>
          <div class="tl-date">${h(r.pubdate.slice(0, 10))}</div>
          <div class="tl-body">
            <div class="tl-tags">${tagChips(r.tags)}</div>
            <div class="tl-title"><a href="${BASE_PATH}/file/${h(
              r.tdnetId
            )}" rel="noopener noreferrer" target="_blank">${h(
              r.title
            )}</a></div>
          </div>
        </div>`;
          })
          .join("")}
      </div>`
          )
          .join("")}</div>`;

  /**
   * シグナルハイライト: 期間内 (絞り込み適用後) の方向確定/推定行を抽出。
   * title 判定 (確定) と PDF 判定 (推定) を同じリストに混ぜ、source 付きで返す。
   * 中立行は出さない。0 件は notice で正直に出す (ルール2)。
   */
  type SignalKind = "pos" | "neg" | "mixed";
  type SignalSource = "title" | "pdf" | "both";
  interface SignalRow {
    r: DisclosureRow;
    kind: SignalKind;
    source: SignalSource;
  }
  const signalRows: SignalRow[] = t.disclosures
    .map<SignalRow | null>((r) => {
      const ts = rowSentiments(r.tags);
      const titlePos = ts.has("positive");
      const titleNeg = ts.has("negative");
      const pdfPos = r.pdfSentiment === "positive";
      const pdfNeg = r.pdfSentiment === "negative";
      const isPos = titlePos || pdfPos;
      const isNeg = titleNeg || pdfNeg;
      if (!isPos && !isNeg) return null;
      const hasTitle = titlePos || titleNeg;
      const hasPdf = pdfPos || pdfNeg;
      const source: SignalSource = hasTitle && hasPdf ? "both" : hasTitle ? "title" : "pdf";
      // pos と neg が併存する場合 (title-pos + pdf-neg 等) は mixed
      const kind: SignalKind = isPos && isNeg ? "mixed" : isPos ? "pos" : "neg";
      return { r, kind, source };
    })
    .filter((x): x is SignalRow => x !== null);

  const posTip = termTip(
    "ポジ",
    `株主視点でポジティブとして数えたタグ: ${POSITIVE_TAG_LIST.join(" / ")}。表題に方向 (増配・上方修正など) が明示された開示のみ。`
  );
  const negTip = termTip(
    "ネガ",
    `株主視点でネガティブとして数えたタグ: ${NEGATIVE_TAG_LIST.join(" / ")}。表題に方向 (減配・下方修正など) が明示された開示のみ。`
  );
  const pdfPosTip = termTip(
    "PDF推定 +",
    "業績予想の修正・配当(決定・予想)・特別損益・配当政策の変更・エクイティファイナンス・自己株式の処分 を対象に、PDF 本文を OSS 軽量実装 (数値ルール + 東北大『日本語評価極性辞書』) で解析した結果のうち positive 判定。AI API は不使用 (利用料 0)。"
  );
  const pdfNegTip = termTip(
    "PDF推定 −",
    "上記と同じ PDF 解析で negative と判定された件数 (本文の数値比較や極性語彙の集計で方向を推定)。AI API は不使用。"
  );

  // 集計は「期間内・タグ絞り込み前」固定 (= statbar 的役割)。下の signals 一覧は
  // タグ絞り込みが効くため、絞り込み中は数字と一覧件数が食い違う可能性がある旨を明示。
  const sentimentScope = t.activeTag !== null
    ? "※ 集計は期間内のタグ絞り込み前。下のハイライト一覧はタグ絞り込み適用後の件数。"
    : "※ 集計は期間内 (全タグ)。タイトル判定は方向が表題に明示された開示のみ。PDF 推定は方向不明タグの本文を OSS 解析した推定値で、最終確認は原本 PDF で。";

  const sentimentBar = `<div class="signal-bar">
    <div class="sb sb--pos"><span class="num">${t.sentimentCounts.positive}</span><span class="lab">${posTip}</span></div>
    <div class="sb sb--neg"><span class="num">${t.sentimentCounts.negative}</span><span class="lab">${negTip}</span></div>
    <div class="sb sb--pdf-pos"><span class="num">${t.pdfSentimentCounts.positive}</span><span class="lab">${pdfPosTip}</span></div>
    <div class="sb sb--pdf-neg"><span class="num">${t.pdfSentimentCounts.negative}</span><span class="lab">${pdfNegTip}</span></div>
    <span class="sb--neutral">${sentimentScope}</span>
  </div>`;

  /**
   * 横軸シグナルタイムライン (SVG, JS 不要)。
   *
   * - 横軸: t.since 〜 今日 (linear)
   * - Y: ポジは中央線上、ネガは下、mixed は中央
   * - マーカー: title 確定=塗り潰し / PDF推定=中抜き dashed / TITLE+PDF=外輪付き
   * - ホバー = SVG <title> でツールチップ、クリック = /file/<tdnetId>
   * - viewBox + preserveAspectRatio="xMidYMid meet" でレスポンシブ
   * - 0 件のときは空文字 (notice はもう少し下の signalsSection で出す)
   */
  const signalTimeline = (() => {
    if (signalRows.length === 0) return "";
    const sinceMs = new Date(t.since).getTime();
    const untilMs = new Date().getTime();
    const span = Math.max(1, untilMs - sinceMs);
    const WIDTH = 1200;
    const HEIGHT = 90;
    const PAD_X = 14;
    const CENTER_Y = HEIGHT / 2 - 8;
    const OFFSET = 14;
    const DOT_R = 5;

    // dot 描画順は pubdate 昇順にして「新しい開示が最前面 = ホバー優先」を
    // 担保 (元 signalRows は disclosures = desc(pubdate) を引き継いでおり、
    // 同日重なり時に最古行が最前面となり tooltip 取り違えを起こすため)。
    const dots = [...signalRows]
      .sort(
        (a, b) =>
          new Date(a.r.pubdate).getTime() - new Date(b.r.pubdate).getTime()
      )
      .map(({ r, kind, source }) => {
        const ms = new Date(r.pubdate).getTime();
        const x = ((ms - sinceMs) / span) * (WIDTH - PAD_X * 2) + PAD_X;
        const y =
          kind === "pos"
            ? CENTER_Y - OFFSET
            : kind === "neg"
              ? CENTER_Y + OFFSET
              : CENTER_Y;
        const colorVar =
          kind === "pos"
            ? "var(--sentiment-pos)"
            : kind === "neg"
              ? "var(--sentiment-neg)"
              : "var(--sentiment-mixed)";
        const filled = source !== "pdf";
        const fill = filled ? colorVar : "var(--bg-pure)";
        const strokeW = source === "both" ? 2.5 : filled ? 0.5 : 1.5;
        const dash = source === "pdf" ? '3,2' : "";
        const sourceLabel =
          source === "title"
            ? "TITLE"
            : source === "pdf"
              ? "PDF推定"
              : "TITLE+PDF";
        const markText = kind === "pos" ? "+" : kind === "neg" ? "−" : "±";
        const tip = `${r.pubdate.slice(0, 10)} ${markText} [${sourceLabel}] ${r.title}`;
        return `<a href="${BASE_PATH}/file/${h(r.tdnetId)}" target="_blank" rel="noopener noreferrer"><circle cx="${x.toFixed(2)}" cy="${y}" r="${DOT_R}" fill="${fill}" stroke="${colorVar}" stroke-width="${strokeW}"${dash ? ` stroke-dasharray="${dash}"` : ""}><title>${h(tip)}</title></circle></a>`;
      })
      .join("");

    // 月境界の tick + 年/月ラベル (12 ヶ月以下は毎月、それ以上は年単位)
    const months = Math.ceil(t.months);
    const tickEveryMonths = months <= 12 ? 1 : months <= 36 ? 3 : 12;
    const tickStart = new Date(sinceMs);
    tickStart.setUTCDate(1);
    const ticks: string[] = [];
    for (
      let d = new Date(tickStart);
      d.getTime() <= untilMs;
      d.setUTCMonth(d.getUTCMonth() + tickEveryMonths)
    ) {
      const ms = d.getTime();
      if (ms < sinceMs) continue;
      const x = ((ms - sinceMs) / span) * (WIDTH - PAD_X * 2) + PAD_X;
      const label =
        tickEveryMonths >= 12
          ? `${d.getUTCFullYear()}`
          : `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      ticks.push(
        `<g class="tk"><line x1="${x.toFixed(2)}" y1="${HEIGHT - 22}" x2="${x.toFixed(2)}" y2="${HEIGHT - 16}"/><text x="${x.toFixed(2)}" y="${HEIGHT - 4}" text-anchor="middle">${label}</text></g>`
      );
    }

    // 「今日」マーカー: 右端の縦点線で時系列の起点 (= 直近) を明示する
    const todayX = WIDTH - PAD_X;
    const todayMark = `<line class="today" x1="${todayX}" y1="6" x2="${todayX}" y2="${HEIGHT - 22}"/><text class="today-lbl" x="${todayX - 3}" y="14" text-anchor="end">today</text>`;

    // 凡例ミニ表示: 4 種マーカー (title pos / pdf pos / both / mixed) を右上に
    // 並べて、ホバー前に dot の意味を読み解けるようにする (ルール7 整合)。
    // 横長 SVG なので右上 X=WIDTH-280 起点で 4 個分・各 70px ピッチ。
    const legendItems: Array<{ x: number; render: string; label: string }> = [
      {
        x: WIDTH - 280,
        render: `<circle cx="${WIDTH - 280}" cy="14" r="4" fill="var(--sentiment-pos)" stroke="var(--sentiment-pos)" stroke-width="0.5"/>`,
        label: "確定+",
      },
      {
        x: WIDTH - 220,
        render: `<circle cx="${WIDTH - 220}" cy="14" r="4" fill="var(--bg-pure)" stroke="var(--sentiment-pos)" stroke-width="1.5" stroke-dasharray="3,2"/>`,
        label: "PDF+",
      },
      {
        x: WIDTH - 160,
        render: `<circle cx="${WIDTH - 160}" cy="14" r="4" fill="var(--sentiment-pos)" stroke="var(--sentiment-pos)" stroke-width="2.5"/>`,
        label: "両方+",
      },
      {
        x: WIDTH - 100,
        render: `<circle cx="${WIDTH - 100}" cy="14" r="4" fill="var(--sentiment-mixed)" stroke="var(--sentiment-mixed)" stroke-width="0.5"/>`,
        label: "矛盾",
      },
    ];
    const legend = legendItems
      .map(
        (l) =>
          `${l.render}<text class="lg-lbl" x="${l.x + 7}" y="17">${l.label}</text>`
      )
      .join("");

    return `<svg class="signal-timeline" viewBox="0 0 ${WIDTH} ${HEIGHT}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="ポジ/ネガ シグナル時系列 (横軸=日付、上=ポジ、下=ネガ、中央=混在)。各点をクリックで原本 PDF が開きます">
      <line class="axis" x1="${PAD_X}" y1="${CENTER_Y}" x2="${WIDTH - PAD_X}" y2="${CENTER_Y}"/>
      <text class="axis-lbl" x="${PAD_X - 4}" y="${CENTER_Y - OFFSET + 4}" text-anchor="end">+</text>
      <text class="axis-lbl" x="${PAD_X - 4}" y="${CENTER_Y + OFFSET + 4}" text-anchor="end">−</text>
      ${todayMark}
      ${legend}
      ${ticks.join("")}
      ${dots}
    </svg>`;
  })();

  const signalsSection =
    signalRows.length === 0
      ? `<div class="notice"><strong>${periodLabel}に方向が明示/推定されたシグナル開示はありません。</strong><br>タイトル判定 (上方修正・増配・自社株買い・自己株式の消却 など) + PDF 推定 (業績予想の修正・配当予想 ほか) が対象です。${
          t.activeTag !== null ? "タグ絞り込みを解除すると増える可能性があります。" : "期間を広げると現れる場合があります。"
        }</div>`
      : `<div class="signals">${signalRows
          .map(({ r, kind, source }) => {
            const sourceMod =
              source === "pdf" ? " row--pdf" : source === "both" ? " row--both" : "";
            const cls =
              kind === "pos"
                ? `row row--pos${sourceMod}`
                : kind === "neg"
                  ? `row row--neg${sourceMod}`
                  : "row";
            const markCls =
              kind === "pos" ? "mark mark--pos" : kind === "neg" ? "mark mark--neg" : "mark";
            const markText = kind === "pos" ? "+" : kind === "neg" ? "−" : "±";
            // SR は行全体に group role + 日本語ラベルでまとめ読みする
            const sourceLabel =
              source === "title"
                ? "タイトル判定"
                : source === "pdf"
                  ? "PDF推定"
                  : "タイトル+PDF両方";
            const groupLabel =
              kind === "pos"
                ? `株主に有利な方向のシグナル開示 (${sourceLabel})`
                : kind === "neg"
                  ? `株主に不利な方向のシグナル開示 (${sourceLabel})`
                  : `正負の両方を含むシグナル開示 (${sourceLabel})`;
            // source バッジ (タイトル確定 vs PDF 推定 を視覚的に区別)
            const sourceBadge =
              source === "pdf"
                ? '<span class="src src--pdf" title="PDF 本文から推定 (OSS 数値ルール + 極性辞書)">PDF</span>'
                : source === "both"
                  ? '<span class="src src--both" title="タイトル判定と PDF 推定が一致">TITLE+PDF</span>'
                  : '<span class="src src--title" title="タイトルから方向確定">TITLE</span>';
            return `<div class="${cls}" role="group" aria-label="${groupLabel}">
          <div class="${markCls}" aria-hidden="true">${markText}</div>
          <div class="date">${h(r.pubdate.slice(0, 10))}</div>
          <div class="body">
            <div class="tags">${tagChips(r.tags)}${sourceBadge}</div>
            <div class="title"><a href="${BASE_PATH}/file/${h(
              r.tdnetId
            )}" rel="noopener noreferrer" target="_blank">${h(r.title)}</a></div>
          </div>
        </div>`;
          })
          .join("")}</div>`;

  const body = `
<div class="container">
  <p style="margin-bottom:14px"><a href="${BASE_PATH}/" style="font-family:var(--font-mono);font-size:12px;color:var(--text-muted)">← 検索に戻る</a></p>
  <div class="detail-head">
    <span class="code">${h(t.code)} · ${h(t.market)}</span>
    <h2 style="margin:0">${h(t.name)}</h2>
    <a class="bc-link" href="${h(
      bc
    )}" rel="noopener noreferrer" target="_blank">buffett-code で見る ↗</a>
  </div>
  <div class="statbar">
    <div><span class="lbl">表示期間</span><span class="val">${h(
      periodLabel
    )}</span></div>
    <div><span class="lbl">期間内 開示</span><span class="val">${
      t.activeTag !== null
        ? `${t.disclosures.length}<small> / ${t.periodTotal}</small>`
        : t.periodTotal
    }</span></div>
    <div><span class="lbl">全期間 開示</span><span class="val">${
      t.totalAllTime
    }</span></div>
    <div><span class="lbl">起点</span><span class="val" style="font-size:15px">${h(
      t.since
    )}〜</span></div>
  </div>
  ${periodNav(t.code, t.months, t.activeTag)}
  <div class="section-label">SIGNALS / 期間内のポジ・ネガ集計</div>
  ${sentimentBar}
  ${signalTimeline ? `<div class="section-label">SIGNAL TIMELINE / 横軸時系列マッピング (上=ポジ・下=ネガ・点クリックで PDF)</div>${signalTimeline}` : ""}
  <div class="section-label">SIGNAL HIGHLIGHTS / 方向が明示された開示だけ (新しい順)</div>
  ${signalsSection}
  <div class="section-label">TAGS / 期間内の内訳 (クリックで絞り込み)</div>
  <div class="legend">${tagSummary || '<span class="meta">—</span>'}</div>
  ${filterBanner}
  <div class="section-label">TIMELINE / 全発表タイミング (新しい順・行の左色がポジ/ネガ)</div>
  ${timeline}
  <p class="disclaimer">出典: TDnet (yanoshin WebAPI)。タグは開示表題からの決定論的分類で、内容の最終確認は各開示の原本 (PDF) で行ってください。「未分類」は推測でタグを付けていない開示です。ポジ/ネガ (TITLE) は表題に方向が明示された開示のみが対象。PDF 推定は kabulab 内 OSS 実装 (数値テーブル抽出 + 東北大学 乾・岡崎研究室『日本語評価極性辞書』; Kobayashi et al. 2005 / Higashiyama et al. 2009) を用いており、AI API 等の外部生成 AI は使用していません (利用料 0)。最終判断は必ず PDF 本文でご確認ください。</p>
</div>`;

  return layout(`${t.code} ${t.name} — IRタイムライン`, body, "detail");
}
