import { layout, h } from "./layout.js";
import { BASE_PATH } from "../../base-path.js";
import { termTip, TERM_TIP_STYLES } from "../../../../src/shared/term-tip.js";
import type { ScreenRow, ScreenOpts } from "../services/overseas-query.js";

/** 円 → 億円 (欠損は「—」。0 で埋めない) */
function oku(yen: number | null): string {
  if (yen === null) return "—";
  return (yen / 1e8).toLocaleString("ja-JP", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}
/**
 * 海外売上高比率を「数値 + 帯バー」で表示。高齢層が数字を読まずとも 0〜100% の
 * 水準を一目で掴めるよう、単色濃淡の帯 (色覚非依存) を数値の下に敷く。
 */
function ratioCell(v: number | null): string {
  if (v === null) return `<span class="muted">—</span>`;
  const w = Math.min(100, Math.max(0, v));
  return `<span class="ratio-cell">${v.toFixed(1)}%<span class="ratio-belt" aria-hidden="true"><span style="width:${w}%"></span></span></span>`;
}
/** 成長率(小数) → 符号付き% + 色。null は「—」 */
function pct(v: number | null): string {
  if (v === null) return `<span class="muted">—</span>`;
  const p = (v * 100).toFixed(1);
  const cls = v > 0 ? "up" : v < 0 ? "down" : "muted";
  return `<span class="${cls}">${v > 0 ? "+" : ""}${p}%</span>`;
}
/** 変化(pp) → 符号付き + 色 */
function pp(v: number | null): string {
  if (v === null) return `<span class="muted">—</span>`;
  const cls = v > 0 ? "up" : v < 0 ? "down" : "muted";
  return `<span class="${cls}">${v > 0 ? "+" : ""}${v.toFixed(1)}pt</span>`;
}

const TIP = {
  "海外売上高比率":
    "海外売上高 ÷ 連結売上高。会社の売上のうち海外（日本以外）が占める割合。高いほど為替や海外景気の影響を受けやすく、内需縮小には強い傾向。",
  "比率の変化":
    "起点の年から直近までで海外売上高比率が何ポイント(pt)増減したか。プラスは海外シフトが進んでいることを示します。",
  "海外売上高 年率":
    "海外売上高の年平均成長率(年率=CAGR)。複数年の伸びを「1年あたり平均何%」にならした値。例: 5年で約2倍なら約 +15%/年。",
  "直近海外売上高(億円)":
    "最新の会計年度の海外売上高(億円)。規模感の確認に使います。比率が高くても規模が小さい場合があるため必ず併せて確認します。",
  "直近連結売上高(億円)": "最新の会計年度の連結売上高(億円)。海外売上高比率の分母です。",
  期間: "集計に使った会計年度の範囲(開始年 → 直近年)。",
  年数: "計算に使ったデータの年数。長いほど傾向の信頼度が高くなります。",
  "#": "海外売上高比率の高い順での順位。",
  "※年欠落":
    "対象期間の途中に地域別売上を開示していない年があります。欠落年を架空値で埋めずに計算しているため、傾向の信頼度はやや下がります。",
} as const;

function th(label: keyof typeof TIP, align: "center" | "right" = "center"): string {
  return termTip(label, TIP[label], align);
}
function flag(label: "※年欠落"): string {
  return `<span class="flag">${termTip(label, TIP[label])}</span>`;
}

export interface ScreeningView {
  opts: ScreenOpts;
  sectors: string[];
  rows: ScreenRow[] | null;
}

export function screeningPage(v: ScreeningView): string {
  const { opts, sectors, rows } = v;

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
    <label for="minOverseasRatioPct">${termTip("海外売上高比率", "海外売上高 ÷ 連結売上高。売上の海外依存度。")}<span class="u">レンジ(%)</span></label>
    <div class="range">
      <input id="minOverseasRatioPct" name="minOverseasRatioPct" type="number" step="1" min="0" max="100" inputmode="numeric" value="${opts.minOverseasRatioPct ?? ""}" placeholder="下限 例 50" aria-label="海外売上高比率 下限(%)">
      <span class="range-sep" aria-hidden="true">〜</span>
      <input id="maxOverseasRatioPct" name="maxOverseasRatioPct" type="number" step="1" min="0" max="100" inputmode="numeric" value="${opts.maxOverseasRatioPct ?? ""}" placeholder="上限 例 100" aria-label="海外売上高比率 上限(%)">
    </div>
  </div>
  <div class="f">
    <label for="minOverseasCagrPct">${termTip("海外売上高", "海外（日本以外）向け売上高の合計。")} ${termTip("年率", "年平均成長率(CAGR)。複数年の伸びを「1年あたり平均何%」にならした値。")}<span class="u">下限(%)</span></label>
    <input id="minOverseasCagrPct" name="minOverseasCagrPct" type="number" step="1" inputmode="numeric" value="${opts.minOverseasCagrPct ?? ""}" placeholder="例 10">
  </div>
  <div class="f">
    <label for="sector">業種</label>
    <select id="sector" name="sector">${sectorOpts}</select>
  </div>
  <div class="fund-sep" role="separator" aria-label="ファンダメンタルズ絞り込み (参考値・結果表には出しません)">
    ファンダ条件 <span>絞り込みのみに使用し結果表には出しません / 参考値: Yahoo Finance (一次データは EDINET 地域別売上。これは外部参照値) / 未入力=無効</span>
  </div>
  <div class="f">
    <label for="minOpMarginPct">${termTip("営業利益率", "本業の儲けが売上高の何%か(TTM)。高いほど稼ぐ力が強い。10%以上で高収益が目安。")}<span class="u">下限(%)</span></label>
    <input id="minOpMarginPct" name="minOpMarginPct" type="number" step="0.1" value="${opts.minOpMarginPct ?? ""}" placeholder="例 10">
  </div>
  <div class="f">
    <label for="minMarketCapOku">${termTip("時価総額", "株価×発行株数。会社全体の市場評価額。小型株を探すなら上限を小さく。")}<span class="u">レンジ(億円)</span></label>
    <div class="range">
      <input id="minMarketCapOku" name="minMarketCapOku" type="number" step="1" min="0" inputmode="numeric" value="${opts.minMarketCapOku ?? ""}" placeholder="下限 例 0" aria-label="時価総額 下限(億円)">
      <span class="range-sep" aria-hidden="true">〜</span>
      <input id="maxMarketCapOku" name="maxMarketCapOku" type="number" step="1" min="0" inputmode="numeric" value="${opts.maxMarketCapOku ?? ""}" placeholder="上限 例 1000" aria-label="時価総額 上限(億円)">
    </div>
  </div>
  <div class="f">
    <label for="maxPer">${termTip("PER", "株価収益率。株価が1株あたり利益の何倍か。低いほど割安。赤字銘柄は対象外。")}<span class="u">上限(倍)</span></label>
    <input id="maxPer" name="maxPer" type="number" step="0.1" min="0" value="${opts.maxPer ?? ""}" placeholder="例 25">
  </div>
  <div class="f">
    <label for="minRoePct">${termTip("ROE", "自己資本利益率。株主資本でどれだけ効率よく稼いだか。10%以上が優良の目安。")}<span class="u">下限(%)</span></label>
    <input id="minRoePct" name="minRoePct" type="number" step="0.1" value="${opts.minRoePct ?? ""}" placeholder="例 8">
  </div>
  <div class="f">
    <label for="minDivYieldPct">${termTip("配当利回り", "1年間の配当金が株価の何%か。3%以上で高配当の目安。")}<span class="u">下限(%)</span></label>
    <input id="minDivYieldPct" name="minDivYieldPct" type="number" step="0.1" min="0" value="${opts.minDivYieldPct ?? ""}" placeholder="例 3">
  </div>
  <button type="submit">スクリーニング</button>
</form>`;

  let result = "";
  if (rows !== null) {
    if (rows.length === 0) {
      result = `<div class="notice" role="status" aria-live="polite"><strong>条件に一致する銘柄はありませんでした。</strong>
      <span class="st">緩和の手立て:<br>
      ・海外売上高比率レンジを広げる (下限が上限を上回っていないか確認)<br>
      ・海外売上高 年率下限を緩める<br>
      ・業種・最低年数を見直す<br>
      <br>ファンダ条件 (営業利益率・時価総額・PER・ROE・配当利回り) 設定時は、共有DBに財務値が無い銘柄も除外されます。<br>
      <b>地域別売上を開示していない(内需)銘柄や、直近比率が算出できない銘柄は除外されます (架空値で埋めない方針)</b>。</span></div>`;
    } else {
      const body = rows
        .map((r, i) => {
          const flags = r.hasYearGap ? flag("※年欠落") : "";
          const fromY = h(r.firstFiscalYearEnd.slice(0, 4));
          const toY = h(r.lastFiscalYearEnd.slice(0, 4));
          return `<tr>
        <td class="num muted">${i + 1}</td>
        <td><a href="${BASE_PATH}/stock/${h(r.code)}" title="${h(r.name)} の海外売上高推移を見る">${h(r.code)}</a></td>
        <td>${h(r.name)}</td>
        <td class="muted">${h(r.sector ?? "")}</td>
        <td class="num strong">${ratioCell(r.latestRatioPct)}${flags}</td>
        <td class="num">${pp(r.ratioChangePp)}</td>
        <td class="num">${pct(r.overseasCagr)}</td>
        <td class="num">${oku(r.latestOverseasYen)}</td>
        <td class="num">${oku(r.latestTotalYen)}</td>
        <td class="num muted">${fromY}→${toY}</td>
        <td class="num">${r.years}</td>
      </tr>`;
        })
        .join("");
      result = `
  <div class="section-label">RESULT — ${rows.length} 件 (海外売上高比率の高い順)</div>
  <p class="disclaimer" style="margin:4px 0 14px">並び替えは「海外売上高比率」の高い順で固定。背景強調は同列に表示します。比率は直近年度ベース。点線の用語にカーソル/タップで説明が出ます。${flag("※年欠落")}=対象期間に欠落年あり。</p>
  <div class="table-wrap"><table>
    <thead><tr>
      <th class="num">${th("#")}</th>
      <th>コード</th><th>会社名</th><th>業種</th>
      <th class="num strong" aria-sort="descending">${th("海外売上高比率")}</th>
      <th class="num">${th("比率の変化")}</th>
      <th class="num">${th("海外売上高 年率")}</th>
      <th class="num">${th("直近海外売上高(億円)")}</th>
      <th class="num">${th("直近連結売上高(億円)", "right")}</th>
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
.screen-form .range{display:flex;align-items:center;gap:8px}
.screen-form .range input{min-width:96px;width:96px}
.screen-form .range-sep{font-family:var(--font-mono);font-size:14px;color:var(--text-muted);font-weight:700}
.screen-form .fund-sep{flex-basis:100%;margin:6px 0 -4px;font-family:var(--font-mono);font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;border-top:1px dashed var(--border-soft);padding-top:12px}
.screen-form .fund-sep span{font-weight:400;text-transform:none;letter-spacing:0;color:var(--text-muted)}
.screen-form label .u{margin-left:3px;color:var(--text-muted);font-weight:600}
table .up{color:var(--success);font-weight:700}
table .down{color:var(--danger);font-weight:700}
table td.strong{font-weight:700;background:var(--bg-soft)}
table th.strong{background:var(--bg-soft)}
.ratio-cell{display:inline-flex;flex-direction:column;align-items:flex-end;gap:4px}
.ratio-belt{display:block;width:62px;height:4px;background:var(--bg);border:1px solid var(--border-soft);border-radius:var(--radius);overflow:hidden}
.ratio-belt>span{display:block;height:100%;background:var(--bg-invert)}
table td a{font-weight:700;text-decoration:underline;text-underline-offset:2px}
.flag{display:inline-block;margin-left:6px;font-family:var(--font-mono);font-size:10px;font-weight:700;color:var(--warning);background:var(--warning-soft);border:1px solid var(--warning);border-radius:var(--radius);padding:1px 5px;letter-spacing:0;text-transform:none;white-space:nowrap}
.disclaimer .flag{margin-left:0;margin-right:4px}
.flag .tip{font-weight:700;border-bottom-color:var(--warning)}
thead th:first-child .tip .tip-text{left:0;transform:none}
thead th:first-child .tip .tip-text::after{left:12px;transform:none}
table th,table td{white-space:nowrap}
${TERM_TIP_STYLES}`;

  const bodyHtml = `
<div class="hero"><div class="inner">
  <div class="label">008 / OVERSEAS-SALES — SCREENING</div>
  <h1>海外売上高比率で<br>銘柄を発掘する</h1>
  <p class="lead">有価証券報告書の地域別売上開示から算出した「海外売上高比率」(会社全体) と海外売上高の成長率で銘柄を絞り込み。データは EDINET 原典を構造化したもので、最低年数に満たない銘柄・直近比率が算出できない銘柄は架空値を作らず除外します。</p>
</div></div>
<style>${styles}</style>
<div class="container">
  ${form}
  ${result}
  <p class="disclaimer">海外売上高比率 = 海外売上高 ÷ 連結売上高 (直近年度)。海外売上高は会社が開示した海外地域行の合計。年率(年平均成長率) = (直近額/起点額)^(1/年数) − 1、起点が0以下や1年以下は「—」で除外します。金額は有報の開示単位を円換算し億円表示。出典: 金融庁 EDINET。</p>
</div>`;

  return layout("海外売上高比率スクリーニング", bodyHtml, "screening");
}
