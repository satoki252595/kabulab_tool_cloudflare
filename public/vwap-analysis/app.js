"use strict";

// 007 VWAP 分析 — 単一ビュー。
//  ・足(ローソク) = 日足R2の正規OHLCV（寄/引含む・分割調整 adj）。表示範囲は「5分足が在る期間」を上限に制限し、期間指定で絞る。
//  ・VWAP / 価格別出来高 = 5分足(R2・直近〜最大365日)から算出。分割は日足 adj/c 係数で価格・出来高を連続化。
//  ・信用残高(週次) = 第3ペインに重畳。
// ヘッダー(meta)は銘柄情報＋信用残高情報のみ。用語ヘルプ(ルール7)は footer の用語凡例と meta の信用語に付与。

const $ = (id) => document.getElementById(id);

// 全角ASCII→半角・小文字・空白除去（コード/名称検索の正規化）
const norm = (s) =>
  String(s)
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, " ").toLowerCase().trim();

const fmtInt = (n) => Math.round(n).toLocaleString("ja-JP");
const jstDate = (ts) => new Date((ts + 32400) * 1000).toISOString().slice(0, 10);

// ルール7: 投資初心者向け用語ヘルプ。専門用語を点線下線にし、hover/focus/tap で平易な解説を出す。
const GLOSSARY = {
  VWAP: "出来高加重平均価格。その期間に売買が成立した値段を出来高で重みづけして平均した「みんなの平均売買値」。株価がVWAPより上なら買い方が優勢の目安。ここでは5分足から算出。",
  POC: "Point of Control＝その期間で最も出来高が集まった価格帯。多くの人が売買した「板の厚い」値段で、支持線・抵抗線になりやすい。",
  "バリューエリア": "出来高の約7割が集中した価格帯。上端がVAH・下端がVAL。値動きが落ち着きやすい「適正圏」の目安。",
  "価格別出来高": "どの値段でどれだけ売買されたかを、価格帯ごとに横棒で表したもの。横棒が長い価格ほど取引が多い。ここでは5分足から集計。",
  "信用残高": "信用取引(お金や株を借りて行う売買)の未決済分。買って持っている分が買残、売って持っている分が売残。将来の反対売買(返済)の圧力を示す。",
  "買残": "信用取引で「買って」まだ返済していない株数。多いほど将来の売り圧力(返済売り)になりやすい。",
  "売残": "信用取引で「売って」まだ買い戻していない株数。多いほど将来の買い圧力(買い戻し)になりやすい。",
  "信用倍率": "買残÷売残。1倍より大きいと買い建てが多い(将来の売り圧力)、小さいと売り建てが多い(将来の買い圧力)。",
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// 用語ヘルプ付きラベルを返す。variant に "up"(上方向・footer用) / "r"(右寄せ・右端トリガ用) を空白区切りで指定可。
// 体裁は src/shared/term-tip.ts に準拠（点線下線・hover/focus/tap・モバイル対応）。
function tip(term, variant) {
  const text = GLOSSARY[term];
  if (!text) return esc(term);
  const v = variant || "";
  const cls = "tip" + (v.includes("up") ? " tip-up" : "") + (v.includes("r") ? " tip-r" : "");
  return `<span class="${cls}" tabindex="0" role="note" aria-label="${esc(term)}: ${esc(text)}">${esc(term)}<span class="tip-text" role="tooltip">${esc(text)}</span></span>`;
}

let cfg = { apiBase: "", profileBins: 50, valueAreaPercent: 0.7, favorites: [] };
let master = [];                 // [{code,name,seg,nname,ncode}]
let codeToName = new Map();
let curCode = null, curName = "";

let chart, candleSeries, vwapSeries, volSeries, mBuy, mSell;
let currentProfile = null;       // 価格別出来高(5分足)
let profileLines = [];
const show = { vwap: true, profile: true, volume: true, margin: true };
let range = "all";               // 表示期間: "all" | "3mo" | "1mo" | "2wk"

const apiBase = () => cfg.apiBase || "";
// 銘柄ごとに取得済みデータをキャッシュ（期間切替で再フェッチしない）。
let data = null;                 // { code, daily:[...], splits:[...], five:[...], margin:[...], factor:Map, covStart, covEnd, fiveDays, fiveErr, marginErr }

const RANGES = [["2wk", "2週"], ["1mo", "1ヶ月"], ["3mo", "3ヶ月"], ["all", "全期間"]];

// ===================================================================== 計算
function volumeProfile(bars, nbins, vaPct) {
  if (!bars.length) return null;
  let lo = Infinity, hi = -Infinity;
  for (const b of bars) { if (b.l < lo) lo = b.l; if (b.h > hi) hi = b.h; }
  if (hi <= lo) hi = lo + 1;
  const binSize = (hi - lo) / nbins;
  const vols = new Array(nbins).fill(0);
  for (const b of bars) {
    const span = b.h - b.l;
    if (span <= 0) { vols[Math.min(nbins - 1, Math.floor((b.l - lo) / binSize))] += b.v; continue; }
    const first = Math.max(0, Math.floor((b.l - lo) / binSize));
    const last = Math.min(nbins - 1, Math.floor((b.h - lo) / binSize));
    for (let i = first; i <= last; i++) {
      const blo = lo + i * binSize, bhi = blo + binSize;
      const ov = Math.min(b.h, bhi) - Math.max(b.l, blo);
      if (ov > 0) vols[i] += b.v * (ov / span);
    }
  }
  const centers = vols.map((_, i) => +(lo + (i + 0.5) * binSize).toFixed(2));
  let poc = 0; for (let i = 1; i < nbins; i++) if (vols[i] > vols[poc]) poc = i;
  const total = vols.reduce((a, b) => a + b, 0);
  let loI = poc, hiI = poc, acc = vols[poc];
  const target = total * vaPct;
  while (acc < target && (loI > 0 || hiI < nbins - 1)) {
    const below = loI > 0 ? vols[loI - 1] : -1;
    const above = hiI < nbins - 1 ? vols[hiI + 1] : -1;
    if (above >= below) acc += vols[++hiI]; else acc += vols[--loI];
  }
  return {
    binSize: +binSize.toFixed(4),
    bins: centers.map((price, i) => ({ price, volume: Math.round(vols[i]) })),
    poc: centers[poc], vah: centers[hiI], val: centers[loI],
  };
}

// /api/intra({bars}) と /api/chart(Yahoo生) を正準形 {ts,o,h,l,c,v}[] に
function parseYahoo(j) {
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  if (!r || !r.timestamp) return [];
  const q = r.indicators.quote[0];
  const out = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i], v = q.volume[i];
    if (o == null || h == null || l == null || c == null || !v) continue;
    out.push({ ts: r.timestamp[i], o, h, l, c, v });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}
function parseIntra(j) { return j && j.chart ? parseYahoo(j) : (j.bars || []); }

// ===================================================================== chart
function initChart() {
  chart = LightweightCharts.createChart($("chart"), {
    autoSize: true,
    layout: { background: { color: "#ffffff" }, textColor: "#475569", fontSize: 12, attributionLogo: false },
    grid: { vertLines: { color: "#eef2f7" }, horzLines: { color: "#eef2f7" } },
    rightPriceScale: { borderColor: "#e2e8f0" },
    timeScale: { borderColor: "#e2e8f0" },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    localization: { priceFormatter: (p) => fmtInt(p) },
  });
  candleSeries = chart.addCandlestickSeries({
    upColor: "#089981", downColor: "#f23645", wickUpColor: "#089981", wickDownColor: "#f23645",
    borderVisible: false, priceFormat: { type: "price", precision: 0, minMove: 1 } });
  vwapSeries = chart.addLineSeries({
    color: "#2563eb", lineWidth: 2, priceLineVisible: false, lastValueVisible: true, title: "VWAP",
    priceFormat: { type: "price", precision: 0, minMove: 1 } });
  // 信用残高(週次)を中段の別スケール"mgn"へ。買残=紫 / 売残=赤。
  mBuy = chart.addLineSeries({ color: "#7c3aed", lineWidth: 2, priceScaleId: "mgn", priceLineVisible: false, lastValueVisible: false, title: "買残", priceFormat: { type: "volume" } });
  mSell = chart.addLineSeries({ color: "#f23645", lineWidth: 2, priceScaleId: "mgn", priceLineVisible: false, lastValueVisible: false, title: "売残", priceFormat: { type: "volume" } });
  volSeries = chart.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "vol", lastValueVisible: false });
  applyScaleLayout(false);
  new ResizeObserver(resizeOverlay).observe($("chartWrap"));
  requestAnimationFrame(drawLoop);
}
// 信用残高ペインの有無で価格軸の縦配分を切替（無いときは2段に詰める）。
function applyScaleLayout(hasMargin) {
  if (hasMargin) {
    chart.priceScale("right").applyOptions({ scaleMargins: { top: 0.05, bottom: 0.45 } });
    chart.priceScale("mgn").applyOptions({ scaleMargins: { top: 0.57, bottom: 0.22 } });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.80, bottom: 0 } });
  } else {
    chart.priceScale("right").applyOptions({ scaleMargins: { top: 0.05, bottom: 0.25 } });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.80, bottom: 0 } });
  }
}

function resizeOverlay() {
  const c = $("overlay"), r = $("chartWrap").getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  c.width = r.width * dpr; c.height = r.height * dpr;
  c.style.width = r.width + "px"; c.style.height = r.height + "px";
  c.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
}
// 非表示/バックグラウンド時は描画を止める（モバイルのバッテリ消費を抑える）。
function drawLoop() { if (document.visibilityState === "visible") drawProfile(); requestAnimationFrame(drawLoop); }
function drawProfile() {
  const c = $("overlay"), ctx = c.getContext("2d"), w = c.clientWidth, h = c.clientHeight;
  ctx.clearRect(0, 0, w, h);
  if (!show.profile || !currentProfile || !candleSeries) return;
  const prof = currentProfile;
  const maxLen = (w - chart.priceScale("right").width()) * 0.30;
  const maxVol = Math.max(...prof.bins.map((b) => b.volume)) || 1;
  const half = prof.binSize / 2;
  for (const bin of prof.bins) {
    if (bin.volume <= 0) continue;
    const yT = candleSeries.priceToCoordinate(bin.price + half);
    const yB = candleSeries.priceToCoordinate(bin.price - half);
    if (yT == null || yB == null) continue;
    const top = Math.min(yT, yB), bh = Math.max(1, Math.abs(yB - yT) - 1);
    const len = (bin.volume / maxVol) * maxLen;
    const inVA = bin.price >= prof.val && bin.price <= prof.vah;
    const isPOC = Math.abs(bin.price - prof.poc) < 1e-9;
    ctx.fillStyle = isPOC ? "rgba(245,158,11,0.80)" : inVA ? "rgba(37,99,235,0.26)" : "rgba(148,163,184,0.30)";
    ctx.fillRect(0, top, len, bh);
  }
}
function setProfileLines(prof) {
  for (const l of profileLines) candleSeries.removePriceLine(l);
  profileLines = [];
  if (!prof) return;
  const add = (price, color, title, style) => profileLines.push(
    candleSeries.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title }));
  add(prof.poc, "#f59e0b", "POC", LightweightCharts.LineStyle.Solid);
  add(prof.vah, "#94a3b8", "VAH", LightweightCharts.LineStyle.Dashed);
  add(prof.val, "#94a3b8", "VAL", LightweightCharts.LineStyle.Dashed);
}
function applyVisibility() {
  if (!chart) return;
  const has5 = !!(data && data.five && data.five.length);
  const hasM = !!(data && data.margin && data.margin.length);
  if (vwapSeries) vwapSeries.applyOptions({ visible: show.vwap && has5 });
  if (volSeries) volSeries.applyOptions({ visible: show.volume });
  if (mBuy) mBuy.applyOptions({ visible: show.margin && hasM });
  if (mSell) mSell.applyOptions({ visible: show.margin && hasM });
  setProfileLines((show.profile && has5) ? currentProfile : null);
}

// ===================================================================== boot
async function boot() {
  cfg = Object.assign(cfg, await fetch("./config.json", { cache: "no-store" }).then((r) => r.json()).catch(() => ({})));
  const stk = await fetch("./data/stocks.json", { cache: "no-store" }).then((r) => r.json());
  master = stk.stocks.map(([code, name, seg]) => ({ code, name, seg, nname: norm(name), ncode: code.toLowerCase() }));
  for (const m of master) codeToName.set(m.code, m.name);
  buildRangeControl();
  const first = (cfg.favorites || []).find((c) => codeToName.has(c)) || (master[0] && master[0].code);
  if (first) selectCode(first);
  renderSuggest("");
}
function buildRangeControl() {
  $("range").innerHTML = RANGES.map(([v, l]) =>
    `<button class="seg-btn${v === range ? " on" : ""}" data-v="${v}">${l}</button>`).join("");
}

// ===================================================================== search
function searchHits(query) {
  const q = norm(query);
  if (!q) {
    const favs = (cfg.favorites || []).map((c) => master.find((m) => m.code === c)).filter(Boolean);
    return (favs.length ? favs : master.slice(0, 40)).slice(0, 40);
  }
  const list = master.filter((m) => m.ncode.includes(q) || m.nname.includes(q));
  const pref = (m) => (m.ncode.startsWith(q) || m.nname.startsWith(q)) ? 0 : 1;
  list.sort((a, b) => (pref(a) - pref(b)) || a.code.localeCompare(b.code));
  return list.slice(0, 40);
}
let activeIdx = -1;
function renderSuggest(query) {
  const ul = $("suggest"); const hits = searchHits(query); activeIdx = -1;
  ul.innerHTML = hits.length
    ? hits.map((m) => `<li data-code="${m.code}"><span class="code">${m.code}</span><span class="nm">${m.name}</span><span class="seg">${m.seg}</span></li>`).join("")
    : `<li class="empty-hint">該当なし</li>`;
}
function openSuggest() { renderSuggest($("q").value); $("suggest").hidden = false; }
function closeSuggest() { $("suggest").hidden = true; }
function moveActive(d) {
  const items = [...$("suggest").querySelectorAll("li[data-code]")];
  if (!items.length) return;
  items[activeIdx]?.classList.remove("active");
  activeIdx = (activeIdx + d + items.length) % items.length;
  items[activeIdx].classList.add("active");
  items[activeIdx].scrollIntoView({ block: "nearest" });
}
function commitActive() {
  const items = [...$("suggest").querySelectorAll("li[data-code]")];
  const el = items[activeIdx < 0 ? 0 : activeIdx];
  if (el) { selectCode(el.dataset.code); closeSuggest(); $("q").blur(); }
}

// ===================================================================== select / fetch
function selectCode(code) {
  curCode = code; curName = codeToName.get(code) || code;
  $("q").value = `${code}  ${curName}`;
  data = null;
  load(code);
}

function statusEmpty(big, sub) {
  currentProfile = null;
  candleSeries.setData([]); vwapSeries.setData([]); volSeries.setData([]); mBuy.setData([]); mSell.setData([]);
  setProfileLines(null);
  $("meta").innerHTML = `<div class="stat"><span class="k">銘柄</span><span class="name"><span class="c">${curCode}</span>${curName}</span></div>`;
  $("empty").hidden = false;
  $("empty").innerHTML = `<div class="big">${big}</div>${sub ? `<div class="sub">${sub}</div>` : ""}`;
}

async function load(code) {
  statusEmpty("読み込み中…", `${code} のデータを取得しています`);
  // 5分足・日足・信用残高を並列取得。日足が無ければ表示不可、5分足/信用は欠落しても明示して続行(ルール2)。
  const dailyReq = fetch(`${apiBase()}/api/daily?code=${code}`).then((r) => r.json());
  const fiveReq = fetch(`${apiBase()}/api/intra?code=${code}`).then((r) => r.json()).then(parseIntra).then((v) => ({ v })).catch((e) => ({ err: String(e) }));
  const marginReq = fetch(`${apiBase()}/api/margin?code=${code}&n=104`).then((r) => r.json()).then((j) => ({ v: j.weeks || [] })).catch((e) => ({ err: String(e) }));

  let dj, fr, mr;
  try { [dj, fr, mr] = await Promise.all([dailyReq, fiveReq, marginReq]); }
  catch (e) { if (code === curCode) statusEmpty("取得に失敗しました", String(e)); return; }
  if (code !== curCode) return;

  // 無効バー(終値/調整後が非正)は分割係数 f=adj/c を壊すので除外(ルール2: 不正値を黙って使わない)。
  const daily = ((dj && dj.bars) || []).filter((b) => b.c > 0 && b.adj > 0);
  if (!daily.length) { return statusEmpty("日足が未取得です", "平日の取引終了後に自動取込されます（バックフィル待ち）。"); }

  const five = fr.v || [];
  const fiveDates = [...new Set(five.map((b) => jstDate(b.ts)))].sort();
  // 分割調整係数 f=adj/c（日付別）。5分足(生値)を調整後ローソク価格軸へ揃え、分割・併合を連続化する。
  const factor = new Map();
  for (const b of daily) factor.set(b.date, b.c ? b.adj / b.c : 1);

  // 表示範囲の起点 = 5分足の最古日（=「5分足で取得できた範囲」）。5分足が無ければ直近60本の日足を代替範囲に。
  const covStart = fiveDates.length ? fiveDates[0] : (daily.length > 60 ? daily[daily.length - 60].date : daily[0].date);
  const covEnd = daily[daily.length - 1].date;

  data = {
    code, daily, splits: (dj && dj.splits) || [], five, factor,
    margin: mr.v || null, marginErr: mr.err || null,
    fiveDays: fiveDates.length, fiveStart: fiveDates[0] || null, fiveErr: fr.err || null,
    covStart, covEnd,
  };
  $("empty").hidden = true;
  render();
}

// ===================================================================== render
function rangeFrom(key, covStart, toDate) {
  if (key === "all") return covStart;
  const days = { "3mo": 90, "1mo": 30, "2wk": 14 }[key];
  const d = new Date(toDate); d.setDate(d.getDate() - days);
  const f = d.toISOString().slice(0, 10);
  return (covStart && f < covStart) ? covStart : f;
}

function render() {
  if (!data) return;
  const fOf = (d) => (data.factor.has(d) ? data.factor.get(d) : 1);
  // 足・5分足の範囲。covStart(=5分足被覆下限)より前へは広げない(要望1)。
  const from = rangeFrom(range, data.covStart, data.covEnd);
  const latestDaily = data.daily[data.daily.length - 1].date;

  // ---- 足(ローソク) + 出来高: 日足R2(分割調整)。範囲 = [from, covEnd] ----
  const inRange = data.daily.filter((b) => b.date >= from && b.date <= data.covEnd);
  const shown = inRange.length ? inRange : data.daily.slice(-1);
  candleSeries.setData(shown.map((b) => { const f = fOf(b.date); return { time: b.date, open: +(b.o * f).toFixed(2), high: +(b.h * f).toFixed(2), low: +(b.l * f).toFixed(2), close: +b.adj.toFixed(2) }; }));
  volSeries.setData(shown.map((b) => { const f = fOf(b.date); return { time: b.date, value: Math.round(b.v / f), color: b.c >= b.o ? "rgba(8,153,129,0.45)" : "rgba(242,54,69,0.45)" }; }));

  // ---- VWAP + 価格別出来高: 5分足(分割調整)。範囲先頭からの期間アンカー、日足解像度にサンプル ----
  // 分割係数 f=adj/c が無い「古い日付」の5分足は、未調整値を黙って混ぜず除外する(ルール2)。
  // ただし当日(まだ日足が確定していない最新日以降)は調整不要なので f=1 で残す(これは正しい未調整)。
  let excluded5m = 0;
  const within = [];
  for (const b of data.five) {
    const d = jstDate(b.ts);
    if (d < from) continue;
    if (data.factor.has(d) || d >= latestDaily) within.push(b);
    else excluded5m++;
  }
  if (within.length) {
    let pv = 0, vv = 0; const perDay = new Map(); const adjBars = [];
    for (const b of within) {
      const d = jstDate(b.ts), f = data.factor.has(d) ? data.factor.get(d) : 1;
      const p = ((b.h + b.l + b.c) / 3) * f;   // 調整後 典型価格
      const v = b.v / f;                        // 調整後 出来高(現在の株数基準)
      pv += p * v; vv += v;
      perDay.set(d, vv ? +(pv / vv).toFixed(2) : +(b.c * f).toFixed(2));
      adjBars.push({ h: b.h * f, l: b.l * f, c: b.c * f, v });
    }
    const pts = [...perDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([time, value]) => ({ time, value }));
    vwapSeries.setData(pts);
    currentProfile = volumeProfile(adjBars, cfg.profileBins, cfg.valueAreaPercent);
  } else {
    vwapSeries.setData([]); currentProfile = null;
  }

  // ---- 信用残高(週次)。足の範囲は covStart のまま広げず、過渡期(最新信用週が covStart より前)でも
  //      最新週だけ左外側に置いて必ず見せる(時間軸は LightweightCharts が自動で含む)。----
  const allM = data.margin || [];
  let mw = allM.filter((x) => x.week >= from);
  if (!mw.length && range === "all" && allM.length) mw = [allM[allM.length - 1]];
  const hasMargin = mw.length > 0;
  if (hasMargin) {
    mBuy.setData(mw.map((x) => ({ time: x.week, value: x.buy })));
    mSell.setData(mw.map((x) => ({ time: x.week, value: x.sell })));
  } else { mBuy.setData([]); mSell.setData([]); }

  applyScaleLayout(hasMargin && show.margin);
  applyVisibility();
  chart.timeScale().fitContent();

  renderMeta(shown, mw);
  renderFooter(excluded5m);
  updateInfo();
}

// 5分足被覆が浅い過渡期は、VWAP/価格別出来高が直近数日分しか無いことをチャート上で明示(ルール2の精神)。
function updateInfo() {
  const el = $("info"); if (!el) return;
  if (data && data.fiveDays && data.fiveDays < 10) {
    el.hidden = false;
    el.textContent = `VWAP・価格別出来高は直近 ${data.fiveDays} 日分の5分足から算出中（バックフィルで拡大します）`;
  } else { el.hidden = true; }
}

// meta は銘柄情報 + 信用残高情報のみ（要望: それ以外は出さない）。
function renderMeta(shown, mw) {
  const last = shown[shown.length - 1];
  const prev = shown[shown.length - 2] || last;   // 表示範囲は直近の連続日なので [-2] は前営業日
  const close = +(last.adj).toFixed(2);
  const prevClose = +(prev.adj).toFixed(2);
  const chg = close - prevClose;
  const cls = (x) => (x >= 0 ? "up" : "down"), sign = (x) => (x >= 0 ? "+" : "");
  let html = `
    <div class="stat"><span class="k">銘柄</span><span class="name"><span class="c">${curCode}</span>${curName}</span></div>
    <div class="stat"><span class="k">終値（${last.date}）</span><span class="v ${cls(chg)}">${fmtInt(close)} <span style="font-size:13px">${sign(chg)}${fmtInt(chg)}</span></span></div>`;
  if (mw.length) {
    const lm = mw[mw.length - 1];
    const ratio = lm.sell ? (lm.buy / lm.sell).toFixed(2) : "—";
    html += `
    <div class="stat"><span class="k">${tip("買残")}（${lm.week}）</span><span class="v sub" style="color:#7c3aed">${fmtInt(lm.buy)} <span style="font-size:13px">${sign(lm.buy_chg)}${fmtInt(lm.buy_chg)}</span></span></div>
    <div class="stat"><span class="k">${tip("売残")}</span><span class="v down sub">${fmtInt(lm.sell)} <span style="font-size:13px">${sign(lm.sell_chg)}${fmtInt(lm.sell_chg)}</span></span></div>
    <div class="stat"><span class="k">${tip("信用倍率", "r")}</span><span class="v sub">${ratio}</span></div>`;
  } else {
    const note = data.marginErr ? "取得失敗" : "未取得";
    html += `<div class="stat"><span class="k">${tip("信用残高")}</span><span class="v sub">${note}</span></div>`;
  }
  $("meta").innerHTML = html;
}

// footer: データ概況 + 用語凡例（ルール7。語の点線下線をタップで解説・上方向に開く）。出所名は表示しない。
function renderFooter(excluded5m) {
  const cov = data.fiveErr
    ? `5分足: 取得失敗`
    : (data.fiveDays ? `5分足 ${data.fiveDays}日（${data.fiveStart}〜）` : `5分足: 未取得`);
  const exNote = excluded5m ? ` ／ 分割係数欠落 ${excluded5m}本を除外` : "";
  const legend = [tip("VWAP", "up"), tip("POC", "up"), tip("バリューエリア", "up"), tip("価格別出来高", "up"), tip("信用残高", "up r")].join(" ・ ");
  $("updated").innerHTML =
    `<span class="ft-note">全 ${master.length.toLocaleString()} 銘柄（東証全上場） ／ 日足（VWAP・価格別出来高は5分足から算出・分割調整済）${exNote} ／ ${cov} ／ 信用残高 週次</span>` +
    `<span class="ft-legend">用語: ${legend}</span>`;
}

// ===================================================================== events
const q = $("q");
const selLabel = () => (curCode ? `${curCode}  ${codeToName.get(curCode) || ""}` : "");
q.addEventListener("focus", () => { q.value = ""; openSuggest(); });
q.addEventListener("blur", () => setTimeout(() => { closeSuggest(); q.value = selLabel(); }, 120));
q.addEventListener("input", () => renderSuggest(q.value));
q.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") { e.preventDefault(); moveActive(1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); moveActive(-1); }
  else if (e.key === "Enter") { e.preventDefault(); commitActive(); }
  else if (e.key === "Escape") { closeSuggest(); q.blur(); }
});
$("suggest").addEventListener("mousedown", (e) => {
  const li = e.target.closest("li[data-code]");
  if (li) { e.preventDefault(); selectCode(li.dataset.code); closeSuggest(); q.blur(); }
});
document.addEventListener("click", (e) => { if (!$("search").contains(e.target)) closeSuggest(); });
$("range").addEventListener("click", (e) => {
  const b = e.target.closest(".seg-btn"); if (!b) return;
  range = b.dataset.v;
  $("range").querySelectorAll(".seg-btn").forEach((x) => x.classList.toggle("on", x === b));
  if (data) render();
});
for (const btn of document.querySelectorAll(".toggles .toggle")) {
  btn.addEventListener("click", () => {
    const k = btn.dataset.key; show[k] = !show[k];
    btn.classList.toggle("on", show[k]);
    if (k === "margin" && data) applyScaleLayout(show.margin && !!(data.margin && data.margin.length));
    applyVisibility();
  });
}

initChart();
resizeOverlay();
boot().catch((e) => { $("meta").textContent = "読み込みに失敗しました: " + e; });
