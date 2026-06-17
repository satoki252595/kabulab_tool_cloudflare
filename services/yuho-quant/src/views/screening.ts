import { layout, h } from "./layout.js";
import { BASE_PATH } from "../../base-path.js";
import { termTip, TERM_TIP_STYLES } from "../../../../src/shared/term-tip.js";
import type { ScreenRow, ScreenOpts } from "../services/order-query.js";

/** 円 → 億円 (欠損は「—」。0 で埋めない) */
function oku(yen: number | null): string {
  if (yen === null) return "—";
  return (yen / 1e8).toLocaleString("ja-JP", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

/** 成長率 (小数) → 符号付き % + 色クラス。null は「—」 */
function pct(v: number | null): string {
  if (v === null) return `<span class="muted">—</span>`;
  const p = (v * 100).toFixed(1);
  const cls = v > 0 ? "up" : v < 0 ? "down" : "muted";
  const sign = v > 0 ? "+" : "";
  return `<span class="${cls}">${sign}${p}%</span>`;
}

/**
 * 列ごとの初心者向けヘルプ文 (バルーン)。専門用語(受注高/受注残高/年率)を
 * その列の意味とあわせて 1 文で噛み砕く。
 * `as const` + keyof で th()/flag() のキーを型拘束し、未知キー (typo) は
 * 実行時の空バルーンではなくビルド時の型エラーで検出する (ルール2 整合)。
 */
const TIP = {
  "受注高 年率":
    "受注高=その会計期間に新しく受けた注文の合計金額(将来の売上の種)。年率=年平均成長率で、複数年の伸びを「1年あたり平均何%」にならした値。例: 5年で約2倍なら約 +15%/年。",
  "受注残高 年率":
    "受注残高=期末時点で受注済みだがまだ売上になっていない注文の残高(先々の売上の裏付け)。受注高(その期の新規受注)とは別物。その年平均成長率(年率)。",
  "直近受注高(億円)":
    "最新の会計年度の受注高(億円)。会社の規模感を確認するために使います。年率は起点が小さいと過大に見えるため、必ずこの規模もあわせて確認します。",
  "直近受注残高(億円)":
    "最新の会計年度末の受注残高(億円)。受注高(新規受注)ではなく、未消化の積み上がり残高です。",
  期間: "集計に使った会計年度の範囲(開始年 → 直近年)。",
  年数:
    "年率の計算に使ったデータの年数。年数が長いほど傾向の信頼度が高くなります。",
  "#": "受注高 年率の高い順での順位。",
  "※起点僅少":
    "年率計算の起点 (最初の年) の受注高が1億円未満。起点が小さいと年率 (年平均成長率) は実態より大きく見えやすいため、必ず「直近受注高(億円)」で規模を確認してください。",
  "※年欠落":
    "対象期間の途中に受注を開示していない年があります。欠落年を架空値で埋めずに計算しているため、傾向の信頼度はやや下がります。",
} as const;

/** 列見出し: 共通の用語バルーン (src/shared/term-tip.ts) を使う。
 *  右端付近の列はバルーンを右寄せして画面外はみ出しを防ぐ。 */
function th(label: keyof typeof TIP, align: "center" | "right" = "center"): string {
  return termTip(label, TIP[label], align);
}

/**
 * 警告フラグチップ (※起点僅少 / ※年欠落)。ルール7: title 属性のみは
 * モバイルで出ないため不可 — termTip をチップの内側に置き、タップ /
 * フォーカスでバルーンが出るようにする (行内・凡例とも同一挙動)。
 */
function flag(label: "※起点僅少" | "※年欠落"): string {
  return `<span class="flag">${termTip(label, TIP[label])}</span>`;
}

export interface ScreeningView {
  opts: ScreenOpts;
  sectors: string[];
  rows: ScreenRow[] | null;
  /** 廃止された旧 URL パラメータが指定された場合の通知 (ルール2: 黙ったフォールバック禁止) */
  deprecated?: string[];
}

export function screeningPage(v: ScreeningView): string {
  const { opts, sectors, rows, deprecated = [] } = v;

  const sectorOpts = ["", ...sectors]
    .map(
      (s) =>
        `<option value="${h(s)}"${s === (opts.sector ?? "") ? " selected" : ""}>${s === "" ? "全業種" : h(s)}</option>`
    )
    .join("");

  const form = `
<form class="screen-form" method="get" action="${BASE_PATH}/screening">
  <div class="f">
    <label for="minYears">最低年数</label>
    <input id="minYears" name="minYears" type="number" min="2" max="5" value="${opts.minYears}">
  </div>
  <div class="f">
    <label for="minOrdersCagrPct">${termTip("受注高", "その会計期間に新しく受けた注文の合計金額。将来の売上の種。EDINET有報の「受注実績」セグメント合計から取得。")} ${termTip("年率", "年平均成長率の略。複数年の伸びを「1年あたり平均何%」にならした値。例: 5年で約2倍なら約 +15%/年。")}<span class="u">下限(%)</span></label>
    <input id="minOrdersCagrPct" name="minOrdersCagrPct" type="number" step="1" inputmode="numeric" value="${opts.minOrdersCagrPct ?? ""}" placeholder="例 10">
  </div>
  <div class="f">
    <label for="minBacklogCagrPct">${termTip("受注残高", "期末時点で受注済みだがまだ売上になっていない注文の残高。先々の売上裏付け。受注高(その期の新規受注)とは別物。")} ${termTip("年率", "年平均成長率の略。複数年の伸びを「1年あたり平均何%」にならした値。")}<span class="u">下限(%)</span></label>
    <input id="minBacklogCagrPct" name="minBacklogCagrPct" type="number" step="1" inputmode="numeric" value="${opts.minBacklogCagrPct ?? ""}" placeholder="例 10">
  </div>
  <div class="f">
    <label for="sector">業種</label>
    <select id="sector" name="sector">${sectorOpts}</select>
  </div>
  <div class="fund-sep" role="separator" aria-label="ファンダメンタルズ絞り込み (参考値・結果表には出しません)">
    ファンダ条件 <span>絞り込みのみに使用し結果表には出しません / 参考値: Yahoo Finance (本サービスの一次データは EDINET 受注。これは外部参照値) / 未入力=無効</span>
  </div>
  <div class="f">
    <label for="minOpMarginPct">${termTip("営業利益率", "本業の儲けが売上高の何%か。直近12ヶ月(TTM)。高いほど稼ぐ力が強い。10%以上で高収益、5%以上で平均以上が目安。")}<span class="u">下限(%)</span></label>
    <input id="minOpMarginPct" name="minOpMarginPct" type="number" step="0.1" value="${opts.minOpMarginPct ?? ""}" placeholder="例 10">
  </div>
  <div class="f">
    <label for="minMarketCapOku">${termTip("時価総額", "株価×発行株数。会社全体を市場がいくらと評価しているかの規模。小型株を探すなら上限を小さく(例: 上限300億)。小型株は成長余地が大きい一方で値動きは大きめ。大型ほど一般に値動きは安定。")}<span class="u">レンジ(億円)</span></label>
    <div class="range">
      <input id="minMarketCapOku" name="minMarketCapOku" type="number" step="1" min="0" inputmode="numeric" value="${opts.minMarketCapOku ?? ""}" placeholder="下限 例 0" aria-label="時価総額 下限(億円)">
      <span class="range-sep" aria-hidden="true">〜</span>
      <input id="maxMarketCapOku" name="maxMarketCapOku" type="number" step="1" min="0" inputmode="numeric" value="${opts.maxMarketCapOku ?? ""}" placeholder="上限 例 300" aria-label="時価総額 上限(億円)">
    </div>
  </div>
  <div class="f">
    <label for="maxPer">${termTip("PER", "株価収益率。株価が1株あたり利益の何倍かを示す割高/割安の目安。低いほど利益に対し株価が安い。赤字(利益マイナス)の銘柄は対象外として除外します。")}<span class="u">上限(倍)</span></label>
    <input id="maxPer" name="maxPer" type="number" step="0.1" min="0" value="${opts.maxPer ?? ""}" placeholder="例 25">
  </div>
  <div class="f">
    <label for="minRoePct">${termTip("ROE", "自己資本利益率。株主のお金でどれだけ効率よく利益を出したか。高いほど資本効率が良い。10%以上が優良企業の目安。")}<span class="u">下限(%)</span></label>
    <input id="minRoePct" name="minRoePct" type="number" step="0.1" value="${opts.minRoePct ?? ""}" placeholder="例 8">
  </div>
  <div class="f">
    <label for="minDivYieldPct">${termTip("配当利回り", "1年間の配当金が株価の何%かを示す。高いほど株価に対し受け取れる配当が多い。3%以上で高配当の目安。")}<span class="u">下限(%)</span></label>
    <input id="minDivYieldPct" name="minDivYieldPct" type="number" step="0.1" min="0" value="${opts.minDivYieldPct ?? ""}" placeholder="例 3">
  </div>
  <button type="submit">スクリーニング</button>
</form>`;

  let result = "";
  if (rows !== null) {
    if (rows.length === 0) {
      result = `<div class="notice" role="status" aria-live="polite"><strong>条件に一致する銘柄はありませんでした。</strong>
      <span class="st">緩和の手立て:<br>
      ・受注高・受注残高の年率下限を緩める<br>
      ・時価総額レンジを広げる (下限が上限を上回っていないか確認)<br>
      ・業種・最低年数を見直す<br>
      <br>ファンダ条件 (営業利益率・時価総額・PER・ROE・配当利回り) 設定時は、共有DBに財務値が無い銘柄も除外されます。<br>
      <b>受注高/受注残高の条件を片方だけ指定した場合、もう片方を開示していない銘柄も「条件未充足」として除外されます (架空値で埋めない方針)</b>。</span></div>`;
    } else {
      const SMALL = 1e8; // 起点 1 億円未満は年率が誇張されやすい
      // 並び替えは UI から選択肢を撤去し「受注高 年率の高い順」固定にした
      // (zod schema 側で metric を "orders" に正規化)。したがって強調列と
      // 警告フラグは常に受注高 年率列に付与する。
      const body = rows
        .map((r, i) => {
          const tinyBase =
            r.firstOrdersYen !== null && r.firstOrdersYen < SMALL;
          const flags =
            (tinyBase ? flag("※起点僅少") : "") +
            (r.hasYearGap ? flag("※年欠落") : "");
          const fromY = h(r.firstFiscalYearEnd.slice(0, 4));
          const toY = h(r.lastFiscalYearEnd.slice(0, 4));
          return `<tr>
        <td class="num muted">${i + 1}</td>
        <td><a href="${BASE_PATH}/stock/${h(r.code)}" title="${h(r.name)} の受注推移を見る">${h(r.code)}</a></td>
        <td>${h(r.name)}</td>
        <td class="muted">${h(r.sector ?? "")}</td>
        <td class="num strong">${pct(r.ordersCagr)}${flags}</td>
        <td class="num">${pct(r.backlogCagr)}</td>
        <td class="num">${oku(r.latestOrdersYen)}</td>
        <td class="num">${oku(r.latestBacklogYen)}</td>
        <td class="num muted">${fromY}→${toY}</td>
        <td class="num">${r.years}</td>
      </tr>`;
        })
        .join("");
      result = `
  <div class="section-label">RESULT — ${rows.length} 件 (受注高 年率の高い順)</div>
  <p class="disclaimer" style="margin:4px 0 14px">並び替えは「受注高 年率」の高い順で固定。背景強調と警告フラグは同列に表示します。起点額が僅少だと年率は過大に見えます。必ず「直近受注高(億円)」で規模を確認してください。${flag("※起点僅少")}=起点1億円未満 / ${flag("※年欠落")}=対象期間に欠落年あり。点線の用語にカーソル/タップで説明が出ます。</p>
  <div class="table-wrap"><table>
    <thead><tr>
      <th class="num">${th("#")}</th>
      <th>コード</th><th>会社名</th><th>業種</th>
      <th class="num strong" aria-sort="descending">${th("受注高 年率")}</th>
      <th class="num">${th("受注残高 年率")}</th>
      <th class="num">${th("直近受注高(億円)")}</th>
      <th class="num">${th("直近受注残高(億円)", "right")}</th>
      <th class="num">${th("期間", "right")}</th>
      <th class="num">${th("年数", "right")}</th>
    </tr></thead>
    <tbody>${body}</tbody>
  </table></div>`;
    }
  }

  const styles = `
.screen-form{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-end;padding:20px;background:var(--bg-pure);border:2px solid var(--border);border-radius:var(--radius);position:relative;margin-top:24px}
.screen-form::before{content:'SCREEN';position:absolute;top:-10px;left:16px;background:var(--bg-invert);color:var(--text-invert);font-family:var(--font-mono);font-size:10px;font-weight:700;padding:3px 10px;letter-spacing:0.12em;border-radius:var(--radius)}
.screen-form .f{display:flex;flex-direction:column;gap:6px}
.screen-form label{font-family:var(--font-mono);font-size:11px;color:var(--text-muted);font-weight:600;text-transform:uppercase;letter-spacing:0.06em}
.screen-form input,.screen-form select{background:var(--bg);border:2px solid var(--border);color:var(--text);padding:0 12px;border-radius:var(--radius);font-family:var(--font-mono);font-size:14px;min-height:var(--tap);min-width:120px}
.notice.notice-warn{border-style:solid;border-color:var(--warning);background:var(--warning-soft);text-align:left;color:var(--text)}
.notice.notice-warn code{font-family:var(--font-mono);font-size:11px;background:var(--bg-pure);border:1px solid var(--border);padding:1px 6px;border-radius:var(--radius)}
.screen-form .range{display:flex;align-items:center;gap:8px}
.screen-form .range input{min-width:96px;width:96px}
.screen-form .range-sep{font-family:var(--font-mono);font-size:14px;color:var(--text-muted);font-weight:700}
.screen-form .fund-sep{flex-basis:100%;margin:6px 0 -4px;font-family:var(--font-mono);font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;border-top:1px dashed var(--border-soft);padding-top:12px}
.screen-form .fund-sep span{font-weight:400;text-transform:none;letter-spacing:0;color:var(--text-muted)}
/* 点線トリガ(用語)と非トリガの単位接尾辞の境界を視覚的に分離し誤読を防ぐ */
.screen-form label .u{margin-left:3px;color:var(--text-muted);font-weight:600}
table .up{color:var(--success);font-weight:700}
table .down{color:var(--danger);font-weight:700}
table td.strong{font-weight:700;background:var(--bg-soft)}
table th.strong{background:var(--bg-soft)}
table td a{font-weight:700;text-decoration:underline;text-underline-offset:2px}
.flag{display:inline-block;margin-left:6px;font-family:var(--font-mono);font-size:10px;font-weight:700;color:var(--warning);background:var(--warning-soft);border:1px solid var(--warning);border-radius:var(--radius);padding:1px 5px;letter-spacing:0;text-transform:none;white-space:nowrap}
.disclaimer .flag{margin-left:0;margin-right:4px}
/* フラグ内の termTip トリガ: チップの組版 (mono 10px bold warning色) を維持しつつ点線のコントラストを確保 */
.flag .tip{font-weight:700;border-bottom-color:var(--warning)}
/* 最左列 (#) のバルーン: 既定の中央寄せだと .table-wrap{overflow-x:auto} の
   左端 (スクロール到達不能側) にはみ出して desktop で先頭が欠けるため左寄せ */
thead th:first-child .tip .tip-text{left:0;transform:none}
thead th:first-child .tip .tip-text::after{left:12px;transform:none}
/* モバイル: 表は .table-wrap(layout.ts: overflow-x:auto + touch慣性) で
   横スクロール。セルは折返さず scroll させる (他サービスと同じ表側方式)。
   見出しの用語バルーンは絶対配置なので nowrap の影響を受けない。 */
table th,table td{white-space:nowrap}
${TERM_TIP_STYLES}`;

  const bodyHtml = `
<div class="hero"><div class="inner">
  <div class="label">005 / YUHO-QUANT — SCREENING</div>
  <h1>受注の<br>成長性スクリーニング</h1>
  <p class="lead">有価証券報告書の「受注高 / 受注残高」(会社全体合計) の年平均成長率 (年率) で銘柄を発掘。受注高と受注残高は同時に独立条件で絞れます。データは EDINET 原典を構造化したもので、最低年数に満たない銘柄は架空値を作らず除外します。</p>
</div></div>
<style>${styles}</style>
<div class="container">
  ${
    deprecated.length === 0
      ? ""
      : `<div class="notice notice-warn" role="alert"><strong>▲ 旧 URL パラメータを検出しました (今回は無視されました)</strong>
    <span class="st">受注高と受注残高を独立条件に分割したため、以下の旧パラメータは廃止されました。ブックマークの差し替えをお願いします:<br>${deprecated.map((d) => `<code>${h(d)}</code>`).join("<br>")}</span></div>`
  }
  ${form}
  ${result}
  <p class="disclaimer">年率 (年平均成長率) = (直近額 / 起点額)^(1/年数) − 1。起点額が 0 以下、または対象年数が1年以下の場合は算出不能として「—」で除外します（0 や架空値で埋めません）。金額は有報の開示単位を円換算し億円表示。会社全体(セグメント合計)ベース。出典: 金融庁 EDINET。</p>
</div>`;

  return layout("受注成長性スクリーニング", bodyHtml, "screening");
}
