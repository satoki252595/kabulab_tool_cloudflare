/**
 * moneyflow 可視化レポート生成 (2026-11-01, 非公開・手元確認用)。
 * Notion「資金フロー｜観測ログ」の実データから単体HTML (SVGチャート) を生成する。
 * 値が無い系列は「データ未取得」と明記し、推測で埋めない。
 * 出力: TOOL/moneyflow-report.html (生成物はgit管理外)
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { findBackupChildByTitle } from "../src/shared/notion-archive/archive.js";
import { notionRequest } from "../src/shared/notion-archive/client.js";
import { notionEnv, NotionConfigError } from "../src/shared/notion-archive/env.js";
import { MONEYFLOW_OBS_DB_TITLE, MONEYFLOW_OBS_PROPS } from "../src/shared/notion-archive/moneyflow.js";

interface PageProp {
  type?: string;
  title?: Array<{ plain_text?: string }>;
  rich_text?: Array<{ plain_text?: string }>;
  number?: number | null;
  select?: { name?: string } | null;
  date?: { start?: string | null } | null;
}
interface Page {
  id: string;
  properties?: Record<string, PageProp>;
}
interface QueryRes {
  results: Page[];
  has_more?: boolean;
  next_cursor?: string | null;
}
const plain = (a?: Array<{ plain_text?: string }>): string => (a ?? []).map((p) => p.plain_text ?? "").join("");
const P = MONEYFLOW_OBS_PROPS;

const obsDbId =
  notionEnv.NOTION_MONEYFLOW_OBS_DB_ID() ??
  (await findBackupChildByTitle({
    parentPageId: notionEnv.NOTION_STOCK_INFO_PAGE_ID(),
    title: MONEYFLOW_OBS_DB_TITLE,
    kind: "database",
  }));
if (!obsDbId) throw new Error("obs DB not found");

export interface Obs {
  period: string;
  periodStart: string | null;
  category: string;
  investorCategory: string;
  marketSegment: string;
  tradeType: string;
  value: number;
  unit: string;
}

async function queryFiltered(filter: unknown): Promise<Page[]> {
  const pages: Page[] = [];
  let cursor: string | undefined;
  for (;;) {
    const body: Record<string, unknown> = { page_size: 100, filter };
    if (cursor) body.start_cursor = cursor;
    const res = await notionRequest<QueryRes>("POST", `/databases/${obsDbId}/query`, body);
    pages.push(...res.results);
    if (!res.has_more || !res.next_cursor) break;
    cursor = res.next_cursor;
  }
  return pages;
}

async function fetchIndicator(key: string): Promise<Obs[]> {
  const contains = { property: P.key, title: { contains: `|${key}|` } };
  let rows: Page[];
  try {
    rows = await queryFiltered(contains);
  } catch (e) {
    if (e instanceof NotionConfigError && String(e.message).includes("request_status")) {
      rows = [];
      for (const y of ["2024", "2025", "2026"]) {
        rows.push(...(await queryFiltered({ and: [{ property: P.key, title: { starts_with: y } }, contains] })));
      }
    } else throw e;
  }
  return rows.map((r) => {
    const p = r.properties ?? {};
    return {
      period: plain(p[P.period]?.rich_text),
      periodStart: p[P.periodStart]?.date?.start ?? null,
      category: plain(p[P.category]?.rich_text),
      investorCategory: plain(p[P.investorCategory]?.rich_text),
      marketSegment: plain(p[P.marketSegment]?.rich_text),
      tradeType: plain(p[P.tradeType]?.rich_text),
      value: p[P.value]?.number ?? Number.NaN,
      unit: p[P.unit]?.select?.name ?? "",
    };
  });
}

// ---- 整形ヘルパ ----
const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** 円 → 兆円/億円 表記 */
function fmtYen(v: number): string {
  const sign = v < 0 ? "-" : "";
  const a = Math.abs(v);
  if (a >= 1e12) return `${sign}${(a / 1e12).toFixed(2)}兆円`;
  if (a >= 1e8) return `${sign}${Math.round(a / 1e8).toLocaleString("ja-JP")}億円`;
  if (a >= 1e4) return `${sign}${Math.round(a / 1e4).toLocaleString("ja-JP")}万円`;
  return `${sign}${Math.round(a)}円`;
}
const fmtPct = (r: number, digits = 1): string => `${(r * 100).toFixed(digits)}%`;

/** period をソート可能なキーへ (YYYY-Www / YYYY-MM / YYYY-MM-DD は文字列順で概ね一致) */
const sortPeriods = (ps: Iterable<string>): string[] => [...ps].sort();

/** 期間×区分 → 値 の表を作る */
function pivot(rows: Obs[], catOf: (o: Obs) => string): { periods: string[]; cats: string[]; get: (p: string, c: string) => number | undefined } {
  const periods = sortPeriods(new Set(rows.map((r) => r.period)));
  const cats = [...new Set(rows.map(catOf))];
  const m = new Map<string, number>();
  for (const r of rows) {
    const k = `${r.period}\0${catOf(r)}`;
    m.set(k, (m.get(k) ?? 0) + r.value);
  }
  return { periods, cats, get: (p, c) => m.get(`${p}\0${c}`) };
}

// ---- SVG チャート ----
const PALETTE = ["#1f77b4", "#d62728", "#2ca02c", "#b8860b", "#ff7f0e", "#17becf", "#8c564b", "#c2185b", "#616161", "#9e9d24"];

interface LineSeries {
  name: string;
  color: string;
  points: Array<{ x: string; y: number | undefined }>;
}

/** 折れ線 (欠けた期間は線を繋がない)。yFormat で軸ラベル整形。 */
function lineChart(args: {
  width?: number;
  height?: number;
  periods: string[];
  series: LineSeries[];
  yFormat: (v: number) => string;
  yZero?: boolean;
}): string {
  const W = args.width ?? 920;
  const H = args.height ?? 300;
  const ml = 84, mr = 14, mt = 12, mb = 30;
  const iw = W - ml - mr, ih = H - mt - mb;
  const xs = args.periods;
  const allY = args.series.flatMap((s) => s.points.map((p) => p.y).filter((v): v is number => v !== undefined && Number.isFinite(v)));
  if (allY.length === 0) return `<p class="nodata">データ未取得</p>`;
  let ymin = Math.min(...allY), ymax = Math.max(...allY);
  if (args.yZero) {
    ymin = Math.min(ymin, 0);
    ymax = Math.max(ymax, 0);
  }
  if (ymin === ymax) {
    ymin -= 1;
    ymax += 1;
  }
  const pad = (ymax - ymin) * 0.06;
  ymin -= pad;
  ymax += pad;
  const X = (i: number): number => ml + (xs.length <= 1 ? iw / 2 : (i / (xs.length - 1)) * iw);
  const Y = (v: number): number => mt + (1 - (v - ymin) / (ymax - ymin)) * ih;
  const ticks = 4;
  let g = "";
  for (let t = 0; t <= ticks; t++) {
    const v = ymin + ((ymax - ymin) * t) / ticks;
    const y = Y(v);
    g += `<line x1="${ml}" y1="${y}" x2="${W - mr}" y2="${y}" stroke="#ddd" stroke-width="1"/>`;
    g += `<text x="${ml - 6}" y="${y + 4}" text-anchor="end" font-size="11" fill="#555">${esc(args.yFormat(v))}</text>`;
  }
  if (ymin < 0 && ymax > 0) {
    g += `<line x1="${ml}" y1="${Y(0)}" x2="${W - mr}" y2="${Y(0)}" stroke="#999" stroke-width="1"/>`;
  }
  const step = Math.max(1, Math.ceil(xs.length / 10));
  xs.forEach((p, i) => {
    if (i % step === 0 || i === xs.length - 1) {
      const anchor = i === xs.length - 1 ? "end" : i === 0 ? "start" : "middle";
      g += `<text x="${X(i)}" y="${H - 8}" text-anchor="${anchor}" font-size="10" fill="#555">${esc(p)}</text>`;
    }
  });
  for (const s of args.series) {
    let d = "";
    let pen = false;
    s.points.forEach((p, i) => {
      if (p.y === undefined || !Number.isFinite(p.y)) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${X(i).toFixed(1)},${Y(p.y).toFixed(1)} `;
      pen = true;
    });
    g += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2"/>`;
  }
  const legend = args.series
    .map((s) => `<span class="lg"><i style="background:${s.color}"></i>${esc(s.name)}</span>`)
    .join("");
  return `<div class="legend">${legend}</div><svg viewBox="0 0 ${W} ${H}" width="100%" role="img">${g}</svg>`;
}

/** 縦棒 (正負対応)。categories は期間、series は積み上げ or 単一系列。 */
function barChart(args: {
  width?: number;
  height?: number;
  periods: string[];
  series: LineSeries[];
  yFormat: (v: number) => string;
  stacked?: boolean;
}): string {
  const W = args.width ?? 920;
  const H = args.height ?? 300;
  const ml = 84, mr = 14, mt = 12, mb = 30;
  const iw = W - ml - mr, ih = H - mt - mb;
  const xs = args.periods;
  const pos = new Array(xs.length).fill(0) as number[];
  const neg = new Array(xs.length).fill(0) as number[];
  for (const s of args.series) {
    s.points.forEach((p, i) => {
      if (p.y === undefined || !Number.isFinite(p.y)) return;
      if (args.stacked) {
        if (p.y >= 0) pos[i] += p.y;
        else neg[i] += p.y;
      } else {
        pos[i] = Math.max(pos[i], p.y);
        neg[i] = Math.min(neg[i], p.y);
      }
    });
  }
  let ymax = Math.max(0, ...pos), ymin = Math.min(0, ...neg);
  if (ymin === ymax) {
    ymax += 1;
    ymin -= 1;
  }
  const pad = (ymax - ymin) * 0.06;
  ymax += pad;
  ymin -= pad;
  const Y = (v: number): number => mt + (1 - (v - ymin) / (ymax - ymin)) * ih;
  const bw = Math.max(2, (iw / xs.length) * 0.62);
  const X = (i: number): number => ml + (xs.length <= 1 ? iw / 2 : (i / (xs.length - 1 || 1)) * iw);
  let g = "";
  for (let t = 0; t <= 4; t++) {
    const v = ymin + ((ymax - ymin) * t) / 4;
    const y = Y(v);
    g += `<line x1="${ml}" y1="${y}" x2="${W - mr}" y2="${y}" stroke="#ddd"/>`;
    g += `<text x="${ml - 6}" y="${y + 4}" text-anchor="end" font-size="11" fill="#555">${esc(args.yFormat(v))}</text>`;
  }
  g += `<line x1="${ml}" y1="${Y(0)}" x2="${W - mr}" y2="${Y(0)}" stroke="#999"/>`;
  xs.forEach((_, i) => {
    let upBase = 0, downBase = 0;
    for (const s of args.series) {
      const v = s.points[i]?.y;
      if (v === undefined || !Number.isFinite(v)) continue;
      const x = X(i) - bw / 2;
      if (args.stacked) {
        if (v >= 0) {
          g += `<rect x="${x.toFixed(1)}" y="${Y(upBase + v).toFixed(1)}" width="${bw}" height="${Math.max(0, Y(upBase) - Y(upBase + v)).toFixed(1)}" fill="${s.color}"/>`;
          upBase += v;
        } else {
          g += `<rect x="${x.toFixed(1)}" y="${Y(downBase).toFixed(1)}" width="${bw}" height="${Math.max(0, Y(downBase + v) - Y(downBase)).toFixed(1)}" fill="${s.color}"/>`;
          downBase += v;
        }
      } else {
        const y1 = Y(Math.max(0, v)), y2 = Y(Math.min(0, v));
        g += `<rect x="${x.toFixed(1)}" y="${y1.toFixed(1)}" width="${bw}" height="${Math.max(0, y2 - y1).toFixed(1)}" fill="${s.color}"/>`;
      }
    }
  });
  const step = Math.max(1, Math.ceil(xs.length / 10));
  xs.forEach((p, i) => {
    if (i % step === 0 || i === xs.length - 1) {
      const anchor = i === xs.length - 1 ? "end" : i === 0 ? "start" : "middle";
      g += `<text x="${X(i)}" y="${H - 8}" text-anchor="${anchor}" font-size="10" fill="#555">${esc(p)}</text>`;
    }
  });
  const legend = args.series
    .map((s) => `<span class="lg"><i style="background:${s.color}"></i>${esc(s.name)}</span>`)
    .join("");
  return `<div class="legend">${legend}</div><svg viewBox="0 0 ${W} ${H}" width="100%" role="img">${g}</svg>`;
}

/** ヒートマップ (行=区分, 列=期間, 値=0..1 の比率。50%中心: 強=赤 / 弱=青)。 */
function heatmap(args: {
  periods: string[];
  rows: Array<{ name: string; cells: Array<number | undefined> }>;
  labelW?: number;
  /** sequential: 0→最大値の単色グラデーション (シェア用)。既定は 0.5 中心の発散色 */
  sequential?: boolean;
  valueFmt?: (v: number) => string;
}): string {
  const labelW = args.labelW ?? 150;
  const cellW = Math.max(10, Math.min(26, Math.floor(760 / Math.max(1, args.periods.length))));
  const cellH = 15;
  const W = labelW + cellW * args.periods.length + 8;
  const H = 34 + cellH * args.rows.length + 6;
  const vmax = args.sequential
    ? Math.max(1e-9, ...args.rows.flatMap((r) => r.cells.filter((v): v is number => v !== undefined && Number.isFinite(v))))
    : 1;
  const color = (v: number): string => {
    if (args.sequential) {
      // 平方根スケール: 最大タグに引っ張られて他が潰れないように
      const t = Math.sqrt(Math.max(0, Math.min(1, v / vmax)));
      return `rgba(38,95,160,${(0.06 + 0.88 * t).toFixed(2)})`;
    }
    // 0.5 中心。赤 (買い優勢) ↔ 青 (売り優勢)
    const t = Math.max(-1, Math.min(1, (v - 0.5) * 2));
    if (t >= 0) return `rgba(198,40,40,${(0.12 + 0.78 * t).toFixed(2)})`;
    return `rgba(21,101,192,${(0.12 + 0.78 * -t).toFixed(2)})`;
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
      const title = v === undefined || !Number.isFinite(v) ? "データなし" : `${row.name} ${args.periods[ci]}: ${(args.valueFmt ?? fmtPct)(v)}`;
      g += `<rect x="${labelW + ci * cellW}" y="${y}" width="${cellW - 1}" height="${cellH - 1}" fill="${fill}"><title>${esc(title)}</title></rect>`;
    });
  });
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img">${g}</svg>`;
}

/** 横棒ランキング */
function hbar(args: { rows: Array<{ name: string; value: number; color?: string }>; valueFormat: (v: number) => string; labelW?: number }): string {
  const labelW = args.labelW ?? 150, valW = 130, barMaxW = 840 - labelW, rowH = 20;
  const W = labelW + barMaxW + valW;
  const H = rowH * args.rows.length + 8;
  const max = Math.max(1, ...args.rows.map((r) => Math.abs(r.value)));
  let g = "";
  args.rows.forEach((r, i) => {
    const y = 4 + i * rowH;
    const neg = r.value < 0;
    const w = (Math.abs(r.value) / max) * barMaxW;
    const color = r.color ?? (neg ? "#1565c0" : "#c62828");
    g += `<text x="${labelW - 6}" y="${y + 14}" text-anchor="end" font-size="11" fill="#333">${esc(r.name)}</text>`;
    g += `<rect x="${labelW}" y="${y + 2}" width="${w.toFixed(1)}" height="${rowH - 5}" fill="${color}"/>`;
    g += `<text x="${labelW + w + 6}" y="${y + 14}" font-size="11" fill="#333">${esc(args.valueFormat(r.value))}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img">${g}</svg>`;
}

// ---- セクション構築 ----
function section(title: string, lead: string, body: string, note: string, meta: string): string {
  return `<section><h2>${esc(title)}</h2><p class="lead">${lead}</p>${body}<p class="note">${note}</p><p class="meta">${esc(meta)}</p></section>`;
}
const nodata = (why: string): string => `<p class="nodata">データ未取得（${esc(why)}）</p>`;

console.error("fetching series...");
const [
  shareRows,
  turnoverRows,
  upRows,
  downRows,
  marginBuyRows,
  marginSellRows,
  investorRows,
  mofRows,
  imajRows,
] = await Promise.all([
  fetchIndicator("sector_turnover_share"),
  fetchIndicator("sector_turnover"),
  fetchIndicator("sector_up_turnover"),
  fetchIndicator("sector_down_turnover"),
  fetchIndicator("sector_margin_buy_amount"),
  fetchIndicator("sector_margin_sell_amount"),
  fetchIndicator("jpx_investor_equity_net_flow_value_weekly"),
  fetchIndicator("mof_net_flow_weekly"),
  fetchIndicator("imaj_fund_net_flow"),
]);
console.error(
  `share=${shareRows.length} turnover=${turnoverRows.length} up=${upRows.length} down=${downRows.length} marginBuy=${marginBuyRows.length} investor=${investorRows.length} mof=${mofRows.length} imaj=${imajRows.length}`
);

const sections: string[] = [];

// 1) 業種別売買代金シェア (週次)
{
  const rows = shareRows.filter((r) => r.category !== "未分類");
  if (rows.length === 0) {
    sections.push(
      section(
        "1. どの業種に売買が集中しているか（業種別売買代金シェア・週次）",
        "全業種の売買代金に占める各業種の割合です。シェアが上がっている業種は、相対的に注目と取引が集まっています。",
        nodata("sector_turnover_share の観測がまだありません"),
        "注意: 売買代金は「注目度」の代理指標で、お金の純流入ではありません（取引には必ず同額の売り手がいます）。",
        "出典: 自社D1日足×JPX33業種区分の週次集計（sector_turnover_share）"
      )
    );
  } else {
    const pv = pivot(rows, (r) => r.category);
    const latest = pv.periods[pv.periods.length - 1];
    const prev = pv.periods[pv.periods.length - 2];
    const ranked = pv.cats
      .map((c) => ({ c, v: pv.get(latest, c) ?? 0, d: (pv.get(latest, c) ?? 0) - (prev ? (pv.get(prev, c) ?? 0) : 0) }))
      .sort((a, b) => b.v - a.v);
    const top = ranked.slice(0, 8);
    const chart = lineChart({
      periods: pv.periods,
      series: top.map((t, i) => ({
        name: t.c,
        color: PALETTE[i % PALETTE.length],
        points: pv.periods.map((p) => ({ x: p, y: pv.get(p, t.c) })),
      })),
      yFormat: (v) => fmtPct(v, 0),
    });
    const tableRows = ranked
      .map(
        (r, i) =>
          `<tr><td>${i + 1}</td><td>${esc(r.c)}</td><td class="num">${fmtPct(r.v)}</td><td class="num">${r.d >= 0 ? "+" : ""}${(r.d * 100).toFixed(2)}pt</td></tr>`
      )
      .join("");
    const table = `<table><thead><tr><th>#</th><th>業種</th><th>最新週シェア</th><th>前週差</th></tr></thead><tbody>${tableRows}</tbody></table>`;
    sections.push(
      section(
        "1. どの業種に売買が集中しているか（業種別売買代金シェア・週次）",
        "全業種の売買代金に占める各業種の割合です。折れ線は最新週シェア上位8業種、表は全33業種の最新ランキングです。シェアの上昇は「相対的に取引が活発になった」ことを示します。",
        chart + table,
        "注意: 売買代金は注目度の代理指標で、純流入額ではありません。同じ株の回転売買でも膨らみます。",
        `出典: 自社D1日足×JPX33業種区分（sector_turnover_share）／対象 ${pv.periods[0]}〜${latest}（${pv.periods.length}週・${rows.length}行）`
      )
    );
  }
}

// 2) 買いの勢いヒートマップ up/(up+down)
{
  const up = pivot(upRows.filter((r) => r.category !== "未分類"), (r) => r.category);
  const down = pivot(downRows.filter((r) => r.category !== "未分類"), (r) => r.category);
  const share = pivot(shareRows.filter((r) => r.category !== "未分類"), (r) => r.category);
  if (up.periods.length === 0) {
    sections.push(
      section(
        "2. 買いと売り、どちらの勢いが強いか（業種別・週次ヒートマップ）",
        "上昇日の売買代金 ÷（上昇日＋下落日の売買代金）です。赤が濃いほど「上がった日の取引が多かった」週です。",
        nodata("sector_up_turnover / sector_down_turnover の観測がまだありません"),
        "注意: 銘柄ごとの前日比で分けた売買代金の比率で、資金の純流入そのものではありません。",
        "出典: 自社D1日足×JPX33業種区分（sector_up_turnover / sector_down_turnover）"
      )
    );
  } else {
    const latest = up.periods[up.periods.length - 1];
    const order = [...up.cats].sort((a, b) => (share.get(latest, b) ?? 0) - (share.get(latest, a) ?? 0));
    const hm = heatmap({
      periods: up.periods,
      rows: order.map((c) => ({
        name: c,
        cells: up.periods.map((p) => {
          const u = up.get(p, c);
          const d = down.get(p, c);
          if (u === undefined || d === undefined || u + d <= 0) return undefined;
          return u / (u + d);
        }),
      })),
    });
    sections.push(
      section(
        "2. 買いと売り、どちらの勢いが強いか（業種別・週次ヒートマップ）",
        "セルは「上昇日の売買代金 ÷（上昇日＋下落日の売買代金）」。赤=上がった日の取引が優勢、青=下がった日の取引が優勢です。行は最新週シェア順。色の帯が業種の間でどう移るかを見ると、物色の移り変わりが追えます。",
        hm,
        "注意: 銘柄ごとの前日比で分けた比率で、純流入額ではありません。前日と同値の日・前日データが無い銘柄はどちらにも数えていません。",
        `出典: 自社D1日足×JPX33業種区分／対象 ${up.periods[0]}〜${latest}（${up.periods.length}週）`
      )
    );
  }
}

// 3) 事業タグで見る金の流れ (事前集計 JSON を読む)
{
  interface BiztagRow {
    tag: string;
    stocks: number;
    division: string | null;
    turnover_total: number;
    cells: Array<number | null>;
    share_cells: Array<number | null>;
    turnover_cells: number[];
  }
  interface BiztagDivision {
    division: string;
    label: string;
    stocks: number;
    tags: number;
    turnover_total: number;
    cells: Array<number | null>;
    share_cells: Array<number | null>;
  }
  interface BiztagFlowRow {
    tag: string;
    stocks: number;
    division: string | null;
    share_recent: number;
    share_prev: number;
    change_pp: number;
    recent_upratio: number | null;
    turnover_recent: number;
  }
  interface BiztagData {
    periods: string[];
    from: string;
    to: string;
    meta: {
      db_rows: number; judged_rows: number; tagged_stocks: number; vocab_version: string; unmapped_tags: string[];
      status_counts: Record<string, number>;
    };
    tags_total: number;
    rows: BiztagRow[];
    divisions: BiztagDivision[];
    flow: { recent: string[]; prev: string[]; inflow: BiztagFlowRow[]; outflow: BiztagFlowRow[] };
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
  const biztagPath = new URL("./mf-biztag-heatmap.json", import.meta.url);
  const TITLE3 = "3. 事業タグで見る金の流れ（事業タグ別・週次）";
  const LEAD3 =
    "2. の業種版を、もっと細かい「事業タグ」単位で見ます。事業タグは有価証券報告書の「事業の内容」から付けた「その会社が何を作り・何を売っているか」のラベル（例: メモリ半導体、MLCC）で、業種よりも細かい単位です。「勢い（上がった日にどれだけ売買されたか）」「シェア（全体のうちそのタグがどれだけ売買されたか）」「出入り（直近4週でシェアが増えたか減ったか）」「川上・川下・流通の区分別」の4つの見方で整理します。";
  const DIV_SHORT: Record<string, string> = {
    upstream: "川上",
    downstream: "川下",
    distribution: "流通",
  };
  const divLabel = (code: string | null): string => (code === null ? "-" : (DIV_SHORT[code] ?? code));
  if (!existsSync(biztagPath)) {
    sections.push(
      section(
        TITLE3,
        LEAD3,
        nodata("mf-biztag-heatmap.json がありません（TOOL/mf-biztag-precompute.py を実行してください）"),
        "注意: 1銘柄が複数タグを持つ場合は各タグに重複計上します（タグ同士の合計は市場全体と一致しません）。",
        "出典: Notion「銘柄マスタ（補足）」事業タグ×自社D1日足"
      )
    );
  } else {
    const d = JSON.parse(readFileSync(biztagPath, "utf-8")) as BiztagData;
    const shown = d.rows.filter((r) => r.stocks >= 3).slice(0, 30);
    const rowName = (r: BiztagRow): string => `${r.tag}(${r.stocks})`;

    // a) 買いの勢い (上昇日の売買代金シェア)
    const momentum = heatmap({
      periods: d.periods,
      labelW: 230,
      rows: shown.map((r) => ({
        name: rowName(r),
        cells: r.cells.map((c) => (c === null ? undefined : c)),
      })),
    });

    // b) 売買代金シェア (重複計上ベースの全タグ合計に対する割合)
    const share = heatmap({
      periods: d.periods,
      labelW: 230,
      sequential: true,
      valueFmt: (v) => fmtPct(v, 2),
      rows: shown.map((r) => ({
        name: rowName(r),
        cells: r.share_cells.map((c) => (c === null ? undefined : c)),
      })),
    });

    // c) 資金の出入り (直近4週 vs 前4週のシェア変化)
    const fmtPp = (v: number): string => `${v >= 0 ? "+" : ""}${v.toFixed(2)}pt`;
    const flowRows = [...d.flow.inflow, ...d.flow.outflow];
    const flowBar = hbar({
      rows: flowRows.map((r) => ({ name: `${r.tag}（${divLabel(r.division)}）`, value: r.change_pp })),
      valueFormat: fmtPp,
      labelW: 300,
    });
    const flowTableRows = flowRows
      .map(
        (r, i) =>
          `<tr><td>${i < d.flow.inflow.length ? "流入" : "流出"}</td><td>${esc(r.tag)}</td><td>${divLabel(r.division)}</td><td class="num">${r.stocks}</td><td class="num">${fmtPct(r.share_prev, 2)}</td><td class="num">${fmtPct(r.share_recent, 2)}</td><td class="num">${fmtPp(r.change_pp)}</td><td class="num">${r.recent_upratio === null ? "-" : fmtPct(r.recent_upratio)}</td><td class="num">${fmtYen(r.turnover_recent)}</td></tr>`
      )
      .join("");
    const flowTable =
      `<table><thead><tr><th></th><th>事業タグ</th><th>区分</th><th>銘柄数</th><th>前4週シェア</th><th>直近4週シェア</th><th>差</th><th>直近4週の買い比率</th><th>直近4週売買代金</th></tr></thead><tbody>${flowTableRows}</tbody></table>`;

    // d) 川上・川下・流通の区分別 (単語帳 notionColumn)
    const DIV_COLORS: Record<string, string> = {
      upstream: "#c62828",
      downstream: "#1565c0",
      distribution: "#2e7d32",
    };
    const divShare = lineChart({
      periods: d.periods,
      yFormat: (v) => fmtPct(v, 0),
      series: d.divisions.map((x) => ({
        name: x.label,
        color: DIV_COLORS[x.division] ?? "#666",
        points: x.share_cells.map((c, i) => ({ x: d.periods[i], y: c === null ? undefined : c })),
      })),
    });
    const divMomentum = lineChart({
      periods: d.periods,
      yFormat: (v) => fmtPct(v, 0),
      series: d.divisions.map((x) => ({
        name: x.label,
        color: DIV_COLORS[x.division] ?? "#666",
        points: x.cells.map((c, i) => ({ x: d.periods[i], y: c === null ? undefined : c })),
      })),
    });
    const divLegend = d.divisions
      .map(
        (x) =>
          `<span class="lg"><i style="background:${DIV_COLORS[x.division] ?? "#666"}"></i>${esc(x.label)}（${x.tags}タグ・${x.stocks}銘柄）</span>`
      )
      .join("");
    const divTableRows = d.divisions
      .map(
        (x) =>
          `<tr><td>${esc(x.label)}</td><td class="num">${x.tags}</td><td class="num">${x.stocks}</td><td class="num">${fmtYen(x.turnover_total)}</td></tr>`
      )
      .join("");
    const divTable = `<table><thead><tr><th>区分</th><th>タグ数</th><th>銘柄数</th><th>期間売買代金合計</th></tr></thead><tbody>${divTableRows}</tbody></table>`;

    const tableRows = shown
      .map(
        (r, i) =>
          `<tr><td>${i + 1}</td><td>${esc(r.tag)}</td><td>${divLabel(r.division)}</td><td class="num">${r.stocks}</td><td class="num">${fmtYen(r.turnover_total)}</td></tr>`
      )
      .join("");
    const table = `<table><thead><tr><th>#</th><th>事業タグ</th><th>区分</th><th>銘柄数</th><th>期間売買代金合計</th></tr></thead><tbody>${tableRows}</tbody></table>`;

    const a = d.audit;
    const auditRows: Array<[string, string]> = [
      ["対象の行数（銘柄マスタ（補足））", `${d.meta.db_rows}社分（うち本文なし ${d.meta.status_counts["本文なし"] ?? 0}社）`],
      ["判定済み", `${d.meta.judged_rows}社`],
      ["タグ付き / 判定済みだがタグ無し", `${d.meta.tagged_stocks}社（${fmtPct(d.meta.tagged_stocks / d.meta.judged_rows)}） / ${a.judged_untagged_stocks}社`],
      ["単語帳の語（事業タグの種類）", `${a.vocab_terms}語（単語帳 ${d.meta.vocab_version}）。うち実際に付いたのは ${a.assigned_terms}語、未使用 ${a.unused_terms.length}語`],
      ["未使用の語", a.unused_terms.map((u) => `${u.tag}（${divLabel(u.division)}）`).join("、")],
      ["1銘柄あたりのタグ数", `平均 ${a.tags_per_stock.mean}（タグ付き銘柄）・中央値 ${a.tags_per_stock.median}・最大 ${a.tags_per_stock.max}`],
      ["売買代金カバレッジ", `タグ付き銘柄で市場売買代金の ${a.coverage.tagged_share_of_market === null ? "-" : fmtPct(a.coverage.tagged_share_of_market)}（タグ付き ${fmtYen(a.coverage.tagged_turnover)} / 全市場 ${fmtYen(a.coverage.market_turnover)}）。判定済みだがタグ無しの銘柄分は ${fmtYen(a.coverage.judged_untagged_turnover)}`],
      ["重複の度合い", `タグ別に合計すると実売買代金の ${a.coverage.duplication_factor ?? "-"}倍になる（1銘柄が平均${a.tags_per_stock.mean}タグを持ち、売買代金の大きい銘柄ほどタグが多いため）`],
      ["集中度", `売買代金上位10タグで全体（重複ベース）の ${fmtPct(a.concentration.top10_share)}。半分に達するまで ${a.concentration.tags_for_half}タグ`],
    ];
    const auditTable =
      `<table><tbody>` +
      auditRows.map(([k, v]) => `<tr><th style="white-space:nowrap">${esc(k)}</th><td>${esc(v)}</td></tr>`).join("") +
      `</tbody></table>`;
    const histBar = hbar({
      rows: a.tags_per_stock.histogram.map((h) => ({ name: `${h.n}個`, value: h.stocks, color: "#455a64" })),
      valueFormat: (v) => `${v}社`,
      labelW: 80,
    });
    const coRows = a.cooccurrence_top10
      .map((c, i) => `<tr><td>${i + 1}</td><td>${esc(c.pair[0])}</td><td>${esc(c.pair[1])}</td><td class="num">${c.stocks}社</td></tr>`)
      .join("");
    const coTable = `<table><thead><tr><th>#</th><th>タグA</th><th>タグB</th><th>両方持つ銘柄</th></tr></thead><tbody>${coRows}</tbody></table>`;
    const auditBody =
      `<h3>0. 前提と検証（タグの粒度・何が選ばれて何が選ばれないか）</h3>` +
      `<p class="lead">粒度は「事業・製品の単位」です。33業種より細かく、個別製品（型番）より粗い中間層で、全${a.vocab_terms}語あります。語の選定は、公的資料（日本標準産業分類、経済安全保障の特定重要物資、日本成長戦略、METIの産業戦略など）を出典として単語帳に登録されたものだけです（出典のない語は登録できません）。銘柄への付与は、有報の「事業の内容」などにその語のキーワードが実際に現れた候補だけをAIが「その会社自身が今営んでいるか」で判定し、根拠文と一緒に保存しています。</p>` +
      `<p class="lead">そのため <b>MECE（漏れなく・重なりなく）ではありません</b>。重なり: 1銘柄に複数タグが付きます（下の分布）。概念同士も重なります（例: 半導体テスタ・検査装置と半導体製造装置部品）。漏れ: 単語帳に無い事業、キーワードが有報文に現れなかった事業、判定で「いいえ/要確認」になった事業にはタグが付きません。「その他」という受け皿もありません。お金の流れとしては、タグ付き銘柄が市場売買代金の大半を占めるため全体像は掴めますが、タグ別合計は重複分だけ市場全体より大きくなります。</p>` +
      auditTable +
      `<p class="lead">1銘柄あたりのタグ数の分布（タグ付き${d.meta.tagged_stocks}社）:</p>` +
      histBar +
      `<p class="lead">よく一緒に出るタグの組（重なりの実例）:</p>` +
      coTable;

    const body =
      auditBody +
      `<h3>a. 買いの勢い（その週に「上がった日の売買」がどれだけ占めたか）</h3>` +
      `<p class="lead">赤い週ほど、そのタグの銘柄が上がった日に大きく売買されています（50%が中立）。行は期間合計の売買代金が大きい順の上位30タグ（3銘柄以上、全${d.tags_total}タグ中）。括弧内はタグが付いた銘柄数です。</p>` +
      momentum +
      `<h3>b. 売買代金シェア（お金がどこに集まっているか）</h3>` +
      `<p class="lead">その週の全タグの売買代金合計に対する、そのタグの割合です。濃いほどお金が集まっています。aが赤くなくてもここが濃いタグは「下がりながら大きく売買されている」状態です。</p>` +
      share +
      table +
      `<h3>c. 資金の出入りランキング（直近4週 ${d.flow.recent[0]}〜${d.flow.recent[d.flow.recent.length - 1]} と、その前4週 ${d.flow.prev[0]}〜${d.flow.prev[d.flow.prev.length - 1]} のシェア差）</h3>` +
      `<p class="lead">シェアが増えたタグ＝相対的にお金が入ってきたタグ、減ったタグ＝出ていったタグです。「直近4週の買い比率」は直近4週の上昇日の売買代金の割合（aの4週版）で、50%超なら買い優勢、未満なら売り優勢です。3銘柄以上のタグが対象です。</p>` +
      flowBar +
      flowTable +
      `<h3>d. 川上・川下・流通で見る（サプライチェーンのどこにお金があるか）</h3>` +
      `<p class="lead">タグを単語帳の区分（川上＝素材・部品・装置、川下＝製品・サービス、流通・サービス）でまとめたものです。上は区分ごとの売買代金シェア、下は区分ごとの買い比率です。</p>` +
      `<p class="legend">${divLegend}</p>` +
      divShare +
      divMomentum +
      divTable +
      `<h3>e. 全タグの売買代金シェア（${d.rows.length}タグすべて）</h3>` +
      `<p class="lead">b. と同じシェアを、実際に付いた全${d.rows.length}タグで表示します（期間売買代金の大きい順、銘柄数の条件なし）。銘柄数1〜2のタグは1銘柄の動きそのものなので、解釈に注意してください。</p>` +
      heatmap({
        periods: d.periods,
        labelW: 300,
        sequential: true,
        valueFmt: (v) => fmtPct(v, 2),
        rows: d.rows.map((r) => ({
          name: `${r.tag}(${r.stocks})`,
          cells: r.share_cells.map((c) => (c === null ? undefined : c)),
        })),
      }) +
      `<h3>f. 全タグ一覧（期間シェアと直近4週シェア）</h3>` +
      `<table><thead><tr><th>#</th><th>事業タグ</th><th>区分</th><th>銘柄数</th><th>期間売買代金</th><th>期間シェア</th><th>直近4週シェア</th></tr></thead><tbody>` +
      (() => {
        const dupTotal = d.rows.reduce((s, r) => s + r.turnover_total, 0);
        const recentTotal = d.rows.reduce(
          (s, r) => s + r.turnover_cells.slice(-4).reduce((x, y) => x + y, 0), 0);
        return d.rows.map((r, i) => {
          const recent = r.turnover_cells.slice(-4).reduce((x, y) => x + y, 0);
          return `<tr><td>${i + 1}</td><td>${esc(r.tag)}</td><td>${divLabel(r.division)}</td><td class="num">${r.stocks}</td><td class="num">${fmtYen(r.turnover_total)}</td><td class="num">${fmtPct(r.turnover_total / dupTotal, 2)}</td><td class="num">${recentTotal > 0 ? fmtPct(recent / recentTotal, 2) : "-"}</td></tr>`;
        }).join("");
      })() +
      `</tbody></table>`;

    sections.push(
      section(
        TITLE3,
        LEAD3,
        body,
        "注意: 1銘柄が複数タグを持つ場合は各タグに重複計上します。シェアの分母は「全タグの売買代金合計（重複計上ベース）」で、市場全体の売買代金ではありません。タグは有報時点の判定で、期間途中の事業変化は反映されません。判定済みでもタグが付かなかった銘柄は含みません。銘柄数の少ないタグは1銘柄の値動きで大きく振れます。買い比率は「上昇日の売買代金÷（上昇日＋下落日）」で、実際の買い越し/売り越し（誰が買ったか）ではありません。表示は日足が全銘柄揃い上下分類が99%を超える2026-W27からです（W25は残存バーが40銘柄分しかなく、W26も分類可能82.8%のため出していません）。",
        `出典: Notion「銘柄マスタ（補足）」事業タグ（判定済${d.meta.judged_rows}銘柄中タグ付き${d.meta.tagged_stocks}銘柄）×自社D1日足／区分は単語帳 ${d.meta.vocab_version} の notionColumn／対象 ${d.periods[0]}〜${d.periods[d.periods.length - 1]}（${d.periods.length}週）`
      )
    );
  }
}

// 4) 投資部門別 純買い越し (週次・二市場)
{
  // 二市場のみ。同一部門に合計行(取引種別なし)と内訳行が混在する場合は合計行を優先。
  const base = investorRows.filter((r) => r.marketSegment === "二市場");
  const byCatTrade = new Map<string, Set<string>>();
  for (const r of base) {
    const s = byCatTrade.get(r.investorCategory) ?? new Set<string>();
    s.add(r.tradeType);
    byCatTrade.set(r.investorCategory, s);
  }
  const rows = base.filter((r) => {
    const trades = byCatTrade.get(r.investorCategory);
    return !(trades && trades.has("") && trades.size > 1 && r.tradeType !== "");
  });
  if (rows.length === 0) {
    sections.push(
      section(
        "4. 誰が買って、誰が売っているか（投資部門別・純買い越し/週次）",
        "外国人・個人・信託銀行など投資家タイプ別の「買い越し（+）/売り越し（−）」です。",
        nodata("jpx_investor_equity_net_flow_value_weekly の二市場データがありません"),
        "注意: 部門間の売買は合計すると概ね相殺します（自己勘定等を含む）。",
        "出典: JPX 投資部門別売買状況（株式・週次）"
      )
    );
  } else {
    const pv = pivot(rows, (r) => r.investorCategory);
    const MAJOR = ["海外投資家法人", "個人現金", "個人信用", "信託銀行", "投資信託", "事業法人"];
    const majors = MAJOR.filter((m) => pv.cats.includes(m));
    const oku = (v: number): number => v / 1e8;
    const chart = lineChart({
      periods: pv.periods,
      series: majors.map((m, i) => ({
        name: m,
        color: PALETTE[i % PALETTE.length],
        points: pv.periods.map((p) => {
          const v = pv.get(p, m);
          return { x: p, y: v === undefined ? undefined : oku(v) };
        }),
      })),
      yFormat: (v) => `${Math.round(v).toLocaleString("ja-JP")}億円`,
      yZero: true,
    });
    const latest = pv.periods[pv.periods.length - 1];
    const latestRows = pv.cats
      .map((c) => ({ name: c, value: pv.get(latest, c) ?? 0 }))
      .filter((r) => r.value !== 0)
      .sort((a, b) => b.value - a.value);
    const bars = hbar({ rows: latestRows, valueFormat: (v) => fmtYen(v) });
    sections.push(
      section(
        "4. 誰が買って、誰が売っているか（投資部門別・純買い越し/週次）",
        "投資家タイプ別の買い越し（+）/売り越し（−）です。折れ線は主要6部門の週次推移、横棒は最新週の全部門です。外国人と個人は逆の動きをすることが多いことで知られます。",
        chart + `<h3>最新週（${esc(latest)}）の全部門</h3>` + bars,
        "注意: 二市場（東証・名証）の集計です。全部門を合計すると自己勘定等を含め概ね相殺します。金額は差引（買い−売り）の純額です。",
        `出典: JPX 投資部門別売買状況（株式・週次）／対象 ${pv.periods[0]}〜${latest}（${pv.periods.length}週・${rows.length}行）`
      )
    );
  }
}

// 5) 業種別 信用買い残 (日次)
{
  const rows = marginBuyRows.filter((r) => r.category !== "未分類");
  if (rows.length === 0) {
    sections.push(
      section(
        "5. 信用買いが溜まっている業種（業種別・信用買い残/日次）",
        "信用取引の買い残高が多い業種です。",
        nodata("sector_margin_buy_amount の観測がまだありません"),
        "注意: 残高はある時点のストックで、期間のフローではありません。",
        "出典: JPX 銘柄別信用取引残高（日次）を33業種に集計"
      )
    );
  } else {
    const pv = pivot(rows, (r) => r.category);
    const sellPv = pivot(marginSellRows.filter((r) => r.category !== "未分類"), (r) => r.category);
    const latest = pv.periods[pv.periods.length - 1];
    const ranked = pv.cats
      .map((c) => ({ name: c, value: pv.get(latest, c) ?? 0, sell: sellPv.get(latest, c) ?? 0 }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 14);
    const bars = hbar({ rows: ranked.map((r) => ({ name: r.name, value: r.value })), valueFormat: (v) => fmtYen(v) });
    const top5 = ranked.slice(0, 5);
    const chart = lineChart({
      periods: pv.periods,
      series: top5.map((t, i) => ({
        name: t.name,
        color: PALETTE[i % PALETTE.length],
        points: pv.periods.map((p) => {
          const v = pv.get(p, t.name);
          return { x: p, y: v === undefined ? undefined : v / 1e8 };
        }),
      })),
      yFormat: (v) => `${Math.round(v).toLocaleString("ja-JP")}億円`,
    });
    sections.push(
      section(
        "5. 信用買いが溜まっている業種（業種別・信用買い残/日次）",
        "信用取引で買ったまま決済していない残高（買い残）です。将来の売り圧力（返済売り）の目安になります。横棒は最新日の上位14業種、折れ線は上位5業種の日次推移です。",
        bars + chart,
        "注意: 残高は時点のストックです。増減には新規の信用買いだけでなく返済・株価変動（評価額ベース）も含まれます。また 2026-10-20 は全業種合計が前後日より約3割低い異常値として記録されています（原本スナップショットの被覆が部分だった疑いがあり要調査）。値は保存どおり表示しています。",
        `出典: JPX 銘柄別信用取引残高（日次）×33業種集計／対象 ${pv.periods[0]}〜${latest}（${pv.periods.length}営業日）`
      )
    );
  }
}

// 6) 海外とのお金の流れ (財務省・週次)
{
  const want: Array<{ cat: string; name: string }> = [
    { cat: "対内証券投資 / 株式・投資ファンド持分", name: "対内・株式等" },
    { cat: "対内証券投資 / 中長期債", name: "対内・中長期債" },
    { cat: "対外証券投資 / 株式・投資ファンド持分", name: "対外・株式等" },
    { cat: "対外証券投資 / 中長期債", name: "対外・中長期債" },
  ];
  const pv = pivot(mofRows, (r) => r.category);
  const present = want.filter((w) => pv.cats.includes(w.cat));
  if (present.length === 0) {
    sections.push(
      section(
        "6. 海外とのお金の流れ（対外・対内証券投資/週次）",
        "海外投資家の日本証券の取得−処分（対内）と、日本の投資家の海外証券の取得−処分（対外）です。",
        nodata("mof_net_flow_weekly の対象区分がありません"),
        "注意: 報告ベースの契約額で、確報で改定されることがあります。",
        "出典: 財務省 対外及び対内証券売買契約等の状況（週次）"
      )
    );
  } else {
    const chart = barChart({
      periods: pv.periods,
      series: present.map((w, i) => ({
        name: w.name,
        color: PALETTE[i % PALETTE.length],
        points: pv.periods.map((p) => {
          const v = pv.get(p, w.cat);
          return { x: p, y: v === undefined ? undefined : v / 1e8 };
        }),
      })),
      yFormat: (v) => `${Math.round(v).toLocaleString("ja-JP")}億円`,
      stacked: true,
    });
    sections.push(
      section(
        "6. 海外とのお金の流れ（対外・対内証券投資/週次）",
        "「対内」は海外投資家が日本の証券を買った純額、「対外」は日本の投資家が海外証券を買った純額です。真のネットフローに最も近い統計の一つです。",
        chart,
        "注意: 報告者ベースの契約金額です。株式等には投資ファンド持分を含みます。",
        `出典: 財務省 対外及び対内証券売買契約等の状況（週次）／対象 ${pv.periods[0]}〜${pv.periods[pv.periods.length - 1]}（${pv.periods.length}週）`
      )
    );
  }
}

// 7) 投信への資金流入出 (月次)
{
  const want = ["株式投信(除ETF)", "株式投信(ETF)", "公社債投信"];
  const pv = pivot(imajRows, (r) => r.category);
  const present = want.filter((w) => pv.cats.includes(w));
  if (present.length === 0) {
    sections.push(
      section(
        "7. 投資信託へのお金の出入り（設定−解約/月次）",
        "投信に新たに入ったお金（設定）から出たお金（解約）を引いた純増減です。",
        nodata("imaj_fund_net_flow の対象区分がありません"),
        "注意: 純資産総額の増減とは別物です（運用益を含みません）。",
        "出典: 資産運用業協会 公募投信の資産増減状況（月次）"
      )
    );
  } else {
    const chart = barChart({
      periods: pv.periods,
      series: present.map((w, i) => ({
        name: w,
        color: PALETTE[i % PALETTE.length],
        points: pv.periods.map((p) => {
          const v = pv.get(p, w);
          return { x: p, y: v === undefined ? undefined : v / 1e8 };
        }),
      })),
      yFormat: (v) => `${Math.round(v).toLocaleString("ja-JP")}億円`,
      stacked: true,
    });
    sections.push(
      section(
        "7. 投資信託へのお金の出入り（設定−解約/月次）",
        "投信に新たに入ったお金から解約で出たお金を引いた純増減です。プラスの月は個人・機関のお金が投信経由で市場に入っています。",
        chart,
        "注意: 純資産総額の増減（運用の損益を含む）とは別物です。ここでは資金の出入りだけを見ています。",
        `出典: 資産運用業協会 公募投信の資産増減状況（月次）／対象 ${pv.periods[0]}〜${pv.periods[pv.periods.length - 1]}（${pv.periods.length}か月）`
      )
    );
  }
}

const generatedAt = new Date().toISOString();
const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>お金の流れレポート（moneyflow 可視化・非公開）</title>
<style>
  body { font-family: "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif; margin: 24px auto; max-width: 980px; padding: 0 16px; color: #222; line-height: 1.6; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  h2 { font-size: 17px; margin-top: 36px; border-bottom: 2px solid #222; padding-bottom: 4px; }
  h3 { font-size: 14px; margin: 18px 0 6px; }
  .sub { color: #555; font-size: 13px; }
  .lead { font-size: 14px; }
  .note { font-size: 12.5px; color: #7a4d00; background: #fff8e1; border: 1px solid #e6cf8a; padding: 8px 10px; }
  .meta { font-size: 11.5px; color: #777; }
  .nodata { color: #888; border: 1px dashed #bbb; padding: 12px; }
  .legend { font-size: 12px; margin: 6px 0; }
  .legend .lg { margin-right: 12px; white-space: nowrap; }
  .legend i { display: inline-block; width: 10px; height: 10px; margin-right: 4px; }
  table { border-collapse: collapse; font-size: 12.5px; margin-top: 10px; width: 100%; }
  th, td { border: 1px solid #ccc; padding: 3px 8px; text-align: left; }
  td.num, th.num { text-align: right; }
  .warn { background: #fdecea; border: 1px solid #e0a49e; padding: 8px 10px; font-size: 12.5px; }
</style>
</head>
<body>
<h1>お金の流れレポート</h1>
<p class="sub">生成: ${esc(generatedAt)} ／ データ: Notion「資金フロー｜観測ログ」＋事業タグ節は「銘柄マスタ（補足）」×D1日足の事前集計（取得済みの実データのみ。欠けは欠けとして表示）</p>
<p class="warn">非公開・検証用レポートです。収録データには利用条件が personal-only / 要確認 のものを含むため、公開ページへの転載はしないでください。各指標の「何を測っているか・測っていないか」は各節の注意書きと指標定義が正です。</p>
${sections.join("\n")}
</body>
</html>`;

writeFileSync(new URL("./moneyflow-report.html", import.meta.url), html);
console.error("wrote TOOL/moneyflow-report.html");
