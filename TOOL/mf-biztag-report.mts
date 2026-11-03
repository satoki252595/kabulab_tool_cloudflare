/**
 * 事業タグで見る金の流れ（全タグ編）HTML生成。
 * 入力: TOOL/mf-biztag-heatmap.json (TOOL/mf-biztag-precompute.py の集計結果)
 * 出力: TOOL/biztag-moneyflow.html
 * 実行: pnpm exec tsx TOOL/mf-biztag-report.mts
 * 数値はすべて入力JSONからの機械集計。文章は固定文（実行時LLM生成なし）。
 */
import { readFileSync, writeFileSync } from "node:fs";

interface Row {
  tag: string;
  stocks: number;
  division: string | null;
  turnover_total: number;
  cells: Array<number | null>;
  share_cells: Array<number | null>;
  turnover_cells: number[];
}
interface Division {
  division: string;
  label: string;
  stocks: number;
  tags: number;
  turnover_total: number;
  cells: Array<number | null>;
  share_cells: Array<number | null>;
}
interface FlowRow {
  tag: string;
  stocks: number;
  division: string | null;
  share_recent: number;
  share_prev: number;
  change_pp: number;
  recent_upratio: number | null;
  turnover_recent: number;
}
interface Data {
  periods: string[];
  from: string;
  to: string;
  meta: {
    db_rows: number; judged_rows: number; tagged_stocks: number;
    vocab_version: string; status_counts: Record<string, number>;
  };
  tags_total: number;
  rows: Row[];
  divisions: Division[];
  flow: { recent: string[]; prev: string[]; inflow: FlowRow[]; outflow: FlowRow[] };
  audit: {
    vocab_terms: number;
    assigned_terms: number;
    unused_terms: Array<{ tag: string; division: string }>;
    judged_untagged_stocks: number;
    tags_per_stock: { mean: number; median: number; max: number; histogram: Array<{ n: string; stocks: number }> };
    coverage: {
      market_turnover: number; tagged_turnover: number; tagged_share_of_market: number | null;
      judged_untagged_turnover: number; duplicated_total: number; duplication_factor: number | null;
    };
    concentration: { top10_share: number; tags_for_half: number };
    cooccurrence_top10: Array<{ pair: string[]; stocks: number }>;
  };
}

const d = JSON.parse(readFileSync(new URL("./mf-biztag-heatmap.json", import.meta.url), "utf-8")) as Data;
const generatedAt = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });

const esc = (s: string): string =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const fmtPct = (r: number, digits = 1): string => `${(r * 100).toFixed(digits)}%`;
function fmtYen(v: number): string {
  if (Math.abs(v) >= 1e12) return `${(v / 1e12).toFixed(2)}兆円`;
  if (Math.abs(v) >= 1e8) return `${(v / 1e8).toFixed(0)}億円`;
  return `${Math.round(v).toLocaleString("ja-JP")}円`;
}
const DIV_SHORT: Record<string, string> = { upstream: "川上", downstream: "川下", distribution: "流通" };
const DIV_COLORS: Record<string, string> = { upstream: "#c62828", downstream: "#1565c0", distribution: "#2e7d32" };
const divLabel = (c: string | null): string => (c === null ? "-" : (DIV_SHORT[c] ?? c));

/** シェア指数: 開始4週平均を100とする。基準がほぼ0のタグは床を置く */
function indexCells(r: Row): Array<number | undefined> {
  const first4 = r.share_cells.slice(0, 4).map((c) => c ?? 0);
  const firstAvg = first4.reduce((s, v) => s + v, 0) / 4;
  const nz = r.share_cells.filter((c): c is number => c !== null && c > 0).sort((x, y) => x - y);
  const median = nz.length > 0 ? nz[Math.floor(nz.length / 2)] : 0;
  // 開始4週のシェアが極小 (0.05%未満) のタグは基準が不安定なので期間中央値を100とする
  const base = firstAvg >= 0.0005 ? firstAvg : Math.max(median, 1e-6);
  return r.share_cells.map((c) => (c === null || c <= 0 ? undefined : c / base));
}

/** ヒートマップ。mode=index は log2 発散色 (1.0中心), mode=ratio は 0.5中心 */
function heatmap(args: {
  periods: string[];
  rows: Array<{ name: string; cells: Array<number | undefined>; raw?: Array<number | null> }>;
  mode: "index" | "ratio";
  labelW?: number;
}): string {
  const labelW = args.labelW ?? 300;
  const cellW = Math.max(10, Math.min(26, Math.floor(760 / Math.max(1, args.periods.length))));
  const cellH = 15;
  const W = labelW + cellW * args.periods.length + 8;
  const H = 34 + cellH * args.rows.length + 6;
  const color = (v: number): string => {
    const t = args.mode === "index"
      ? Math.max(-1, Math.min(1, Math.log2(Math.max(v, 1e-9)) / 1.6))
      : Math.max(-1, Math.min(1, (v - 0.5) * 2));
    if (t >= 0) return `rgba(198,40,40,${(0.10 + 0.82 * t).toFixed(2)})`;
    return `rgba(21,101,192,${(0.10 + 0.82 * -t).toFixed(2)})`;
  };
  let g = "";
  const step = Math.max(1, Math.ceil(args.periods.length / 8));
  args.periods.forEach((p, i) => {
    if (i % step === 0 || i === args.periods.length - 1) {
      g += `<text x="${labelW + i * cellW + cellW / 2}" y="14" text-anchor="middle" font-size="9" fill="#555">${esc(p)}</text>`;
    }
  });
  args.rows.forEach((row, ri) => {
    const y = 22 + ri * cellH;
    g += `<text x="${labelW - 6}" y="${y + cellH - 4}" text-anchor="end" font-size="10" fill="#333">${esc(row.name)}</text>`;
    row.cells.forEach((v, ci) => {
      const fill = v === undefined || !Number.isFinite(v) ? "#eee" : color(v);
      const raw = row.raw?.[ci];
      const title = v === undefined || !Number.isFinite(v)
        ? "データなし"
        : args.mode === "index"
          ? `${row.name} ${args.periods[ci]}: 指数${Math.round(v * 100)}（シェア ${raw === null || raw === undefined ? "-" : fmtPct(raw, 2)}）`
          : `${row.name} ${args.periods[ci]}: ${fmtPct(v)}`;
      g += `<rect x="${labelW + ci * cellW}" y="${y}" width="${cellW - 1}" height="${cellH - 1}" fill="${fill}"><title>${esc(title)}</title></rect>`;
    });
  });
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img">${g}</svg>`;
}

interface Series { name: string; color: string; points: Array<number | undefined> }
function lineChart(args: { periods: string[]; series: Series[]; yFormat: (v: number) => string; height?: number; invert?: boolean }): string {
  const W = 920, H = args.height ?? 280;
  const ml = 84, mr = 14, mt = 12, mb = 30;
  const iw = W - ml - mr, ih = H - mt - mb;
  const xs = args.periods;
  const allY = args.series.flatMap((s) => s.points.filter((v): v is number => v !== undefined && Number.isFinite(v)));
  if (allY.length === 0) return `<p class="nodata">データ未取得</p>`;
  let ymin = Math.min(...allY), ymax = Math.max(...allY);
  if (ymin === ymax) { ymin -= 1; ymax += 1; }
  const pad = (ymax - ymin) * 0.06;
  ymin -= pad; ymax += pad;
  const X = (i: number): number => ml + (xs.length <= 1 ? iw / 2 : (i / (xs.length - 1)) * iw);
  const Y = (v: number): number => args.invert
    ? mt + ((v - ymin) / (ymax - ymin)) * ih
    : mt + (1 - (v - ymin) / (ymax - ymin)) * ih;
  let g = "";
  for (let t = 0; t <= 4; t++) {
    const v = ymin + ((ymax - ymin) * t) / 4;
    const y = Y(v);
    g += `<line x1="${ml}" y1="${y}" x2="${W - mr}" y2="${y}" stroke="#ddd"/>`;
    g += `<text x="${ml - 6}" y="${y + 4}" text-anchor="end" font-size="11" fill="#555">${esc(args.yFormat(v))}</text>`;
  }
  const step = Math.max(1, Math.ceil(xs.length / 10));
  xs.forEach((p, i) => {
    if (i % step === 0) {
      const anchor = i === 0 ? "start" : "middle";
      g += `<text x="${X(i)}" y="${H - 8}" text-anchor="${anchor}" font-size="10" fill="#555">${esc(p)}</text>`;
    }
  });
  for (const s of args.series) {
    let dpath = "";
    let pen = false;
    s.points.forEach((v, i) => {
      if (v === undefined || !Number.isFinite(v)) { pen = false; return; }
      dpath += `${pen ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)} `;
      pen = true;
    });
    g += `<path d="${dpath}" fill="none" stroke="${s.color}" stroke-width="2"/>`;
  }
  const legend = args.series.map((s) => `<span class="lg"><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join("");
  return `<div class="legend">${legend}</div><svg viewBox="0 0 ${W} ${H}" width="100%" role="img">${g}</svg>`;
}

function hbar(args: { rows: Array<{ name: string; value: number }>; valueFormat: (v: number) => string; labelW?: number; color?: string }): string {
  const labelW = args.labelW ?? 300, valW = 130, barMaxW = 840 - labelW, rowH = 20;
  const W = labelW + barMaxW + valW;
  const H = rowH * args.rows.length + 8;
  const max = Math.max(1e-9, ...args.rows.map((r) => Math.abs(r.value)));
  let g = "";
  args.rows.forEach((r, i) => {
    const y = 4 + i * rowH;
    const w = (Math.abs(r.value) / max) * barMaxW;
    const color = args.color ?? (r.value < 0 ? "#1565c0" : "#c62828");
    g += `<text x="${labelW - 6}" y="${y + 14}" text-anchor="end" font-size="11" fill="#333">${esc(r.name)}</text>`;
    g += `<rect x="${labelW}" y="${y + 2}" width="${w.toFixed(1)}" height="${rowH - 5}" fill="${color}"/>`;
    g += `<text x="${labelW + w + 6}" y="${y + 14}" font-size="11" fill="#333">${esc(args.valueFormat(r.value))}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img">${g}</svg>`;
}

// ---- 派生指標 ----
const a = d.audit;
const dupTotal = d.rows.reduce((s, r) => s + r.turnover_total, 0);
const recentTotal = d.rows.reduce((s, r) => s + r.turnover_cells.slice(-4).reduce((x, y) => x + y, 0), 0);
const prevTotal = d.rows.reduce((s, r) => s + r.turnover_cells.slice(-8, -4).reduce((x, y) => x + y, 0), 0);
const recentTurnover = (r: Row): number => r.turnover_cells.slice(-4).reduce((x, y) => x + y, 0);
const prevTurnover = (r: Row): number => r.turnover_cells.slice(-8, -4).reduce((x, y) => x + y, 0);
const recentShare = (r: Row): number => (recentTotal > 0 ? recentTurnover(r) / recentTotal : 0);
const prevShare = (r: Row): number => (prevTotal > 0 ? prevTurnover(r) / prevTotal : 0);
const changePpOf = (r: Row): number => (recentShare(r) - prevShare(r)) * 100;
const periodShare = (r: Row): number => (dupTotal > 0 ? r.turnover_total / dupTotal : 0);

/** 週ごとの順位 (全タグ中のシェア順位) */
function weeklyRanks(r: Row): Array<number | undefined> {
  return d.periods.map((_, i) => {
    const v = r.share_cells[i];
    if (v === null) return undefined;
    let rank = 1;
    for (const other of d.rows) {
      const ov = other.share_cells[i];
      if (ov !== null && ov > v) rank++;
    }
    return rank;
  });
}
const PALETTE = ["#1f77b4", "#d62728", "#2ca02c", "#b8860b", "#ff7f0e", "#17becf", "#8c564b", "#c2185b", "#616161", "#9e9d24", "#3949ab", "#00897b"];
const bumpTop = d.rows.filter((r) => r.stocks >= 3).slice(0, 12);
const bump = lineChart({
  periods: d.periods,
  height: 320,
  invert: true,
  yFormat: (v) => `${Math.max(1, Math.round(v))}位`,
  series: bumpTop.map((r, i) => ({
    name: r.tag,
    color: PALETTE[i % PALETTE.length],
    points: weeklyRanks(r),
  })),
});

const divShareChart = lineChart({
  periods: d.periods,
  yFormat: (v) => fmtPct(v, 0),
  series: d.divisions.map((x) => ({
    name: x.label,
    color: DIV_COLORS[x.division] ?? "#666",
    points: x.share_cells.map((c) => (c === null ? undefined : c)),
  })),
});
const divMomentumChart = lineChart({
  periods: d.periods,
  yFormat: (v) => fmtPct(v, 0),
  series: d.divisions.map((x) => ({
    name: x.label,
    color: DIV_COLORS[x.division] ?? "#666",
    points: x.cells.map((c) => (c === null ? undefined : c)),
  })),
});

const fmtPp = (v: number): string => `${v >= 0 ? "+" : ""}${v.toFixed(2)}pt`;
const flowRows = [...d.flow.inflow, ...d.flow.outflow];
const flowBar = hbar({
  rows: flowRows.map((r) => ({ name: `${r.tag}（${divLabel(r.division)}）`, value: r.change_pp })),
  valueFormat: fmtPp,
});
const flowTable =
  `<table><thead><tr><th></th><th>事業タグ</th><th>区分</th><th>銘柄数</th><th>前4週シェア</th><th>直近4週シェア</th><th>差</th><th>直近4週の買い比率</th><th>直近4週売買代金</th></tr></thead><tbody>` +
  flowRows.map((r, i) =>
    `<tr><td>${i < d.flow.inflow.length ? "流入" : "流出"}</td><td>${esc(r.tag)}</td><td>${divLabel(r.division)}</td><td class="num">${r.stocks}</td><td class="num">${fmtPct(r.share_prev, 2)}</td><td class="num">${fmtPct(r.share_recent, 2)}</td><td class="num">${fmtPp(r.change_pp)}</td><td class="num">${r.recent_upratio === null ? "-" : fmtPct(r.recent_upratio)}</td><td class="num">${fmtYen(r.turnover_recent)}</td></tr>`
  ).join("") +
  `</tbody></table>`;

// ---- 区分別ヒートマップ (シェア指数) ----
function divisionHeatmap(div: Division): string {
  const rows = d.rows.filter((r) => r.division === div.division);
  const indexHm = heatmap({
    periods: d.periods,
    mode: "index",
    rows: rows.map((r) => ({ name: `${r.tag}(${r.stocks})`, cells: indexCells(r), raw: r.share_cells })),
  });
  const momentumHm = heatmap({
    periods: d.periods,
    mode: "ratio",
    rows: rows.map((r) => ({
      name: `${r.tag}(${r.stocks})`,
      cells: r.cells.map((c) => (c === null ? undefined : c)),
    })),
  });
  return `<h3>${esc(div.label)}（${rows.length}タグ・${div.stocks}銘柄）</h3>`
    + `<p class="lead">上: シェア指数（開始4週の平均シェアを100とする。開始4週が極小のタグは期間中央値を100。赤=増えた、青=減った。セルに触れると指数と実シェアが出ます）／ 下: 買い比率（上昇日の売買代金の割合。赤=買い優勢、青=売り優勢）。灰色はその週、そのタグの銘柄の売買がなかった週。行は期間売買代金の大きい順。</p>`
    + indexHm + momentumHm;
}

// ---- 検証サマリ ----
const auditRows: Array<[string, string]> = [
  ["対象行数", `${d.meta.db_rows}社分（本文なし ${d.meta.status_counts["本文なし"] ?? 0}社を除き判定済み ${d.meta.judged_rows}社）`],
  ["タグ付き / 無し", `${d.meta.tagged_stocks}社（${fmtPct(d.meta.tagged_stocks / d.meta.judged_rows)}） / ${a.judged_untagged_stocks}社（判定したが該当なし）`],
  ["単語帳の語", `${a.vocab_terms}語（${d.meta.vocab_version}）。実際に付いた ${a.assigned_terms}語、未使用 ${a.unused_terms.length}語`],
  ["未使用の語", a.unused_terms.map((u) => `${u.tag}（${divLabel(u.division)}）`).join("、")],
  ["1銘柄のタグ数", `平均 ${a.tags_per_stock.mean}・中央値 ${a.tags_per_stock.median}・最大 ${a.tags_per_stock.max}`],
  ["売買代金カバレッジ", `タグ付き銘柄で市場の ${a.coverage.tagged_share_of_market === null ? "-" : fmtPct(a.coverage.tagged_share_of_market)}（${fmtYen(a.coverage.tagged_turnover)} / ${fmtYen(a.coverage.market_turnover)}）。判定済み無タグ分は ${fmtYen(a.coverage.judged_untagged_turnover)}`],
  ["重複の度合い", `タグ別合計は実売買代金の ${a.coverage.duplication_factor ?? "-"}倍（複数タグの重複計上）`],
  ["集中度", `上位10タグで ${fmtPct(a.concentration.top10_share)}、半分まで ${a.concentration.tags_for_half}タグ`],
];
const auditTable = `<table><tbody>` + auditRows.map(([k, v]) => `<tr><th style="white-space:nowrap">${esc(k)}</th><td>${esc(v)}</td></tr>`).join("") + `</tbody></table>`;
const histBar = hbar({
  rows: a.tags_per_stock.histogram.map((h) => ({ name: `${h.n}個`, value: h.stocks })),
  valueFormat: (v) => `${v}社`,
  labelW: 80,
  color: "#455a64",
});
const coTable = `<table><thead><tr><th>#</th><th>タグA</th><th>タグB</th><th>両方持つ銘柄</th></tr></thead><tbody>`
  + a.cooccurrence_top10.map((c, i) => `<tr><td>${i + 1}</td><td>${esc(c.pair[0])}</td><td>${esc(c.pair[1])}</td><td class="num">${c.stocks}社</td></tr>`).join("")
  + `</tbody></table>`;

// ---- 全タグ表 (並び替え・絞り込み付き) ----
const allRowsHtml = d.rows.map((r, i) => {
  const ch = changePpOf(r);
  return `<tr data-div="${esc(r.division ?? "")}">`
    + `<td class="num" data-v="${i + 1}">${i + 1}</td>`
    + `<td data-v="${esc(r.tag)}">${esc(r.tag)}</td>`
    + `<td data-v="${esc(r.division ?? "")}">${divLabel(r.division)}</td>`
    + `<td class="num" data-v="${r.stocks}">${r.stocks}</td>`
    + `<td class="num" data-v="${r.turnover_total}">${fmtYen(r.turnover_total)}</td>`
    + `<td class="num" data-v="${periodShare(r)}">${fmtPct(periodShare(r), 2)}</td>`
    + `<td class="num" data-v="${recentShare(r)}">${fmtPct(recentShare(r), 2)}</td>`
    + `<td class="num" data-v="${ch}">${fmtPp(ch)}</td></tr>`;
}).join("");

// ---- 要約の数値 (本文の固定文に差し込む) ----
const upDiv = d.divisions.find((x) => x.division === "upstream");
const downDiv = d.divisions.find((x) => x.division === "downstream");
const divFirstLast = (x?: Division): string => {
  if (!x) return "-";
  const first = x.share_cells.slice(0, 4).filter((c): c is number => c !== null);
  const last = x.share_cells.slice(-4).filter((c): c is number => c !== null);
  const avg = (arr: number[]): number => arr.reduce((s, v) => s + v, 0) / Math.max(1, arr.length);
  return `${fmtPct(avg(first), 0)}→${fmtPct(avg(last), 0)}`;
};
const topIn = d.flow.inflow[0];
const topOut = d.flow.outflow[0];

const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>事業タグで見る金の流れ（全タグ編）</title>
<style>
  body { font-family: "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif; margin: 24px auto; max-width: 980px; padding: 0 16px; color: #222; line-height: 1.65; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  h2 { font-size: 17px; margin-top: 40px; border-bottom: 2px solid #222; padding-bottom: 4px; }
  h3 { font-size: 14px; margin: 20px 0 6px; }
  .sub { color: #555; font-size: 13px; }
  .lead { font-size: 14px; }
  .note { font-size: 12.5px; color: #7a4d00; background: #fff8e1; border: 1px solid #e6cf8a; padding: 8px 10px; }
  .meta { font-size: 11.5px; color: #777; }
  .warn { background: #fdecea; border: 1px solid #e0a49e; padding: 8px 10px; font-size: 12.5px; }
  .kpis { display: flex; flex-wrap: wrap; gap: 10px; margin: 14px 0; }
  .kpi { border: 1px solid #ccc; padding: 10px 14px; min-width: 150px; }
  .kpi .v { font-size: 22px; font-weight: 700; line-height: 1.2; }
  .kpi .k { font-size: 12px; color: #444; }
  nav.toc { font-size: 13.5px; margin: 16px 0; padding: 10px 14px; background: #f5f5f5; }
  nav.toc a { margin-right: 14px; }
  .legend { font-size: 12px; margin: 6px 0; }
  .legend .lg { margin-right: 12px; white-space: nowrap; }
  .legend i { display: inline-block; width: 10px; height: 10px; margin-right: 4px; }
  table { border-collapse: collapse; font-size: 12.5px; margin-top: 10px; width: 100%; }
  th, td { border: 1px solid #ccc; padding: 3px 8px; text-align: left; }
  td.num, th.num { text-align: right; }
  th.sortable { cursor: pointer; background: #f0f0f0; }
  th.sortable:hover { background: #e2e2e2; }
  .controls { margin: 10px 0; font-size: 13px; }
  .controls button { margin-right: 6px; padding: 4px 10px; cursor: pointer; }
  .controls button.on { background: #222; color: #fff; }
  .controls input { padding: 4px 8px; width: 220px; }
  details { margin-top: 12px; }
  summary { cursor: pointer; font-size: 13.5px; }
</style>
</head>
<body>
<h1>事業タグで見る金の流れ（全タグ編）</h1>
<p class="sub">生成: ${esc(generatedAt)} ／ 対象週: ${d.periods[0]}〜${d.periods[d.periods.length - 1]}（${d.periods.length}週）／ 生成スクリプト: TOOL/mf-biztag-report.mts（入力は TOOL/mf-biztag-precompute.py の集計JSON。再実行で同じ結果が得られます）</p>
<p class="warn">非公開・検証用レポートです。事業タグは有報テキストへのAI判定結果であり、公式分類ではありません。数値は取得済みの実データのみから機械集計しています。</p>

<nav class="toc">
  <b>目次:</b>
  <a href="#summary">要約</a>
  <a href="#audit">前提と検証</a>
  <a href="#divisions">川上・川下・流通</a>
  <a href="#flow">資金の出入り</a>
  <a href="#ranks">順位の推移</a>
  <a href="#alltags">全タグマップ</a>
  <a href="#table">全タグ一覧表</a>
  <a href="#method">方法・注意</a>
</nav>

<h2 id="summary">要約</h2>
<div class="kpis">
  <div class="kpi"><div class="v">${a.coverage.tagged_share_of_market === null ? "-" : fmtPct(a.coverage.tagged_share_of_market)}</div><div class="k">タグ付き銘柄の売買代金カバレッジ（対市場）</div></div>
  <div class="kpi"><div class="v">${d.meta.tagged_stocks}社</div><div class="k">タグ付き銘柄（判定済み ${d.meta.judged_rows}社中）</div></div>
  <div class="kpi"><div class="v">${a.assigned_terms} / ${a.vocab_terms}語</div><div class="k">実際に付いたタグ / 単語帳の語</div></div>
  <div class="kpi"><div class="v">${a.coverage.duplication_factor ?? "-"}倍</div><div class="k">タグ別合計の重複（対実売買代金）</div></div>
</div>
<ul>
  <li>区分シェア（開始4週→直近4週の平均）: 川上 ${divFirstLast(upDiv)}、川下 ${divFirstLast(downDiv)}。期間後半にお金の重心が川上から川下へ移っています（<a href="#divisions">区分の図</a>）。</li>
  <li>直近4週の流入トップは ${topIn ? `${esc(topIn.tag)}（${fmtPp(topIn.change_pp)}）` : "-"}、流出トップは ${topOut ? `${esc(topOut.tag)}（${fmtPp(topOut.change_pp)}）` : "-"}です（<a href="#flow">出入りランキング</a>）。</li>
  <li>タグはMECEではありません。1銘柄平均${a.tags_per_stock.mean}タグで、判定済みの${fmtPct(a.judged_untagged_stocks / d.meta.judged_rows)}はタグ無しです。読み方の前提は<a href="#audit">前提と検証</a>を先に読んでください。</li>
</ul>

<h2 id="audit">前提と検証（粒度・何が選ばれて何が選ばれないか）</h2>
<p class="lead">粒度は「事業・製品の単位」です。33業種より細かく、個別製品（型番）より粗い中間層で、全${a.vocab_terms}語あります。語の選定は、公的資料（日本標準産業分類、経済安全保障の特定重要物資、日本成長戦略、METIの産業戦略など）を出典として単語帳に登録されたものだけです。銘柄への付与は、有報の「事業の内容」などにキーワードが実際に現れた候補だけをAIが「その会社自身が今営んでいるか」で判定し、根拠文と一緒に保存しています。</p>
<p class="lead">そのため <b>MECE（漏れなく・重なりなく）ではありません</b>。重なり: 1銘柄に複数タグが付きます。概念同士も重なります。漏れ: 単語帳に無い事業、キーワードが有報文に現れなかった事業、判定で外れた事業にはタグが付きません。「その他」の受け皿もありません。</p>
${auditTable}
<p class="lead">1銘柄あたりのタグ数の分布（タグ付き${d.meta.tagged_stocks}社）:</p>
${histBar}
<p class="lead">よく一緒に出るタグの組（重なりの実例）:</p>
${coTable}

<h2 id="divisions">川上・川下・流通で見る</h2>
<p class="lead">タグを単語帳の区分（川上＝素材・部品・装置、川下＝製品・サービス、流通・サービス）でまとめたものです。上: 区分ごとの売買代金シェア、下: 区分ごとの買い比率（上昇日の売買代金の割合、50%が中立）。</p>
${divShareChart}
${divMomentumChart}
<table><thead><tr><th>区分</th><th>タグ数</th><th>銘柄数</th><th>期間売買代金合計</th></tr></thead><tbody>
${d.divisions.map((x) => `<tr><td>${esc(x.label)}</td><td class="num">${x.tags}</td><td class="num">${x.stocks}</td><td class="num">${fmtYen(x.turnover_total)}</td></tr>`).join("")}
</tbody></table>

<h2 id="flow">資金の出入りランキング</h2>
<p class="lead">直近4週（${d.flow.recent[0]}〜${d.flow.recent[d.flow.recent.length - 1]}）と、その前4週（${d.flow.prev[0]}〜${d.flow.prev[d.flow.prev.length - 1]}）のシェア差です。増えたタグ＝相対的にお金が入ってきたタグです。「直近4週の買い比率」が50%超なら買い優勢、未満なら売り優勢。3銘柄以上のタグが対象です。</p>
${flowBar}
${flowTable}

<h2 id="ranks">順位の推移（売買代金シェア上位12タグ）</h2>
<p class="lead">週ごとに全${d.rows.length}タグの中で何位だったかです。上にあるほど上位。線の交差が「お金の行き先の交代」を表します。</p>
${bump}

<h2 id="alltags">全タグマップ（区分別）</h2>
<p class="lead">実際に付いた全${d.rows.length}タグを区分ごとに表示します。各区分で上段がシェア指数（開始4週=100）、下段が買い比率です。絶対シェアの大きさは<a href="#table">全タグ一覧表</a>の数値で確認してください（色は変化を見るためのものです）。</p>
${d.divisions.map((x) => divisionHeatmap(x)).join("")}

<h2 id="table">全タグ一覧表</h2>
<p class="lead">列見出しをクリックすると並び替えできます。区分ボタンと検索で絞り込めます。</p>
<div class="controls">
  <button data-f="all" class="on">全て</button>
  <button data-f="upstream">川上</button>
  <button data-f="downstream">川下</button>
  <button data-f="distribution">流通</button>
  <input id="q" type="search" placeholder="タグ名で検索">
  <span id="shown"></span>
</div>
<table id="alltags">
<thead><tr>
  <th class="sortable">#</th><th class="sortable">事業タグ</th><th class="sortable">区分</th>
  <th class="sortable num">銘柄数</th><th class="sortable num">期間売買代金</th>
  <th class="sortable num">期間シェア</th><th class="sortable num">直近4週シェア</th><th class="sortable num">シェア差(直近-前)</th>
</tr></thead>
<tbody>${allRowsHtml}</tbody>
</table>

<h2 id="method">方法・注意・出典</h2>
<details open>
<summary>指標の定義と注意（必ず読んでください）</summary>
<ul>
  <li>売買代金 = 日足の終値×出来高（自社D1日足）。上昇日/下落日は前日終値との比較で、同値はどちらにも入れません。</li>
  <li>買い比率 = 上昇日の売買代金 ÷（上昇日＋下落日）。実際の買い越し/売り越し（誰が買ったか）ではありません。</li>
  <li>シェアの分母は「全タグの売買代金合計（重複計上ベース）」です。市場全体の売買代金ではありません。市場カバレッジは「前提と検証」のとおりです。</li>
  <li>シェア指数は開始4週（${d.periods[0]}〜${d.periods[3]}）の平均シェアを100とした相対値です。基準が極小のタグは指数が大きく振れます。</li>
  <li>タグは有報時点の判定で、期間途中の事業変化は反映されません。判定済みでもタグが付かなかった銘柄は含みません。</li>
  <li>表示は日足が全銘柄揃い上下分類が99%を超える2026-W27からです（W25/W26はデータ不足のため除外）。</li>
</ul>
</details>
<p class="meta">出典: Notion「銘柄マスタ（補足）」事業タグ（判定済${d.meta.judged_rows}社中タグ付き${d.meta.tagged_stocks}社）×自社D1日足／区分は単語帳 ${d.meta.vocab_version} の notionColumn／集計: TOOL/mf-biztag-precompute.py、生成: TOOL/mf-biztag-report.mts</p>

<script>
(function () {
  var table = document.getElementById("alltags");
  var tbody = table.tBodies[0];
  var rows = Array.prototype.slice.call(tbody.rows);
  var filter = "all", query = "";
  var shownEl = document.getElementById("shown");
  function apply() {
    var n = 0;
    rows.forEach(function (r) {
      var okDiv = filter === "all" || r.getAttribute("data-div") === filter;
      var okQ = query === "" || r.cells[1].textContent.indexOf(query) >= 0;
      r.style.display = okDiv && okQ ? "" : "none";
      if (okDiv && okQ) n++;
    });
    shownEl.textContent = n + "タグ表示中";
  }
  document.querySelectorAll(".controls button").forEach(function (b) {
    b.addEventListener("click", function () {
      document.querySelectorAll(".controls button").forEach(function (x) { x.classList.remove("on"); });
      b.classList.add("on");
      filter = b.getAttribute("data-f");
      apply();
    });
  });
  document.getElementById("q").addEventListener("input", function (e) {
    query = e.target.value;
    apply();
  });
  var dir = 1, lastCol = -1;
  table.querySelectorAll("th.sortable").forEach(function (th, ci) {
    th.addEventListener("click", function () {
      dir = lastCol === ci ? -dir : 1;
      lastCol = ci;
      rows.sort(function (x, y) {
        var a = x.cells[ci].getAttribute("data-v"), b = y.cells[ci].getAttribute("data-v");
        var na = parseFloat(a), nb = parseFloat(b);
        if (!isNaN(na) && !isNaN(nb) && a !== "" && b !== "") return (na - nb) * dir;
        return String(a).localeCompare(String(b), "ja") * dir;
      });
      rows.forEach(function (r) { tbody.appendChild(r); });
    });
  });
  apply();
})();
</script>
</body>
</html>`;

const outPath = new URL("./biztag-moneyflow.html", import.meta.url);
writeFileSync(outPath, html);
console.log(`wrote TOOL/biztag-moneyflow.html (${html.length} bytes)`);
