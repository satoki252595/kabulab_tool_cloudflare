"use strict";

const $ = (id) => document.getElementById(id);

// 全角ASCII→半角・小文字・空白除去（コード/名称検索の正規化）
const norm = (s) =>
  String(s)
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, " ").toLowerCase().trim();

const fmtInt = (n) => Math.round(n).toLocaleString("ja-JP");
const jstTime = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false });
const jstDateTime = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false });
const jstDate = (ts) => new Date((ts + 32400) * 1000).toISOString().slice(0, 10);

let chart, candleSeries, vwapSeries, volSeries;
let profileLines = [];
let currentProfile = null;
const show = { vwap: true, profile: true, volume: true };

let cfg = { apiBase: "", liveRange: "5d", liveAuto: true, liveRefreshSec: 90, profileBins: 50, valueAreaPercent: 0.7, compositeWindows: [5, 20, 60], favorites: [] };
let master = [];                 // [{code,name,seg,nname,ncode}]
let codeToName = new Map();
let curCode = null, curName = "";
let period = "day";              // "day" | "c<N>"
let dataset = null;              // 5分足: { code, dates:[...], byDay:Map(date->bars) }

let view = "intra";              // "intra" | "daily" | "margin"
let dailyData = null;            // 日足: { code, bars, splits }
let marginData = null;           // 信用: { code, weeks:[...] }
let drange = "3y";               // 日足の表示期間
let dchart, dCandle, dVol;       // 日足チャート(遅延生成)
let mchart, mBuy, mSell;         // 信用残高チャート(遅延生成)
const apiBase = () => cfg.apiBase || "";
const intraCache = new Map();    // code -> dataset（メモリキャッシュ・当日は含めない）
let liveTimer = null;            // 当日ライブ自動更新タイマー
const todayKey = () => jstDate(Math.floor(Date.now() / 1000));

// ===================================================================== 計算
function addVwap(bars) {
  let pv = 0, vv = 0;
  for (const b of bars) {
    const tp = (b.h + b.l + b.c) / 3;
    pv += tp * b.v; vv += b.v;
    b.vwap = vv ? +(pv / vv).toFixed(2) : b.c;
  }
  return bars;
}

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

// ===================================================================== chart
function initChart() {
  chart = LightweightCharts.createChart($("chart"), {
    layout: { background: { color: "#ffffff" }, textColor: "#475569", fontSize: 12, attributionLogo: false },
    grid: { vertLines: { color: "#eef2f7" }, horzLines: { color: "#eef2f7" } },
    rightPriceScale: { borderColor: "#e2e8f0" },
    timeScale: { borderColor: "#e2e8f0", timeVisible: true, secondsVisible: false,
      tickMarkFormatter: (t) => jstTime.format(t * 1000) },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    localization: { timeFormatter: (t) => jstDateTime.format(t * 1000), priceFormatter: (p) => fmtInt(p) },
  });
  candleSeries = chart.addCandlestickSeries({
    upColor: "#089981", downColor: "#f23645", wickUpColor: "#089981", wickDownColor: "#f23645",
    borderVisible: false, priceFormat: { type: "price", precision: 0, minMove: 1 } });
  vwapSeries = chart.addLineSeries({
    color: "#2563eb", lineWidth: 2, priceLineVisible: false, lastValueVisible: true, title: "VWAP",
    priceFormat: { type: "price", precision: 0, minMove: 1 } });
  volSeries = chart.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "vol", lastValueVisible: false });
  chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  new ResizeObserver(resizeOverlay).observe($("chartWrap"));
  requestAnimationFrame(drawLoop);
}

function resizeOverlay() {
  const c = $("overlay"), r = $("chartWrap").getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  c.width = r.width * dpr; c.height = r.height * dpr;
  c.style.width = r.width + "px"; c.style.height = r.height + "px";
  c.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
}
function drawLoop() { drawProfile(); requestAnimationFrame(drawLoop); }
function drawProfile() {
  const c = $("overlay"), ctx = c.getContext("2d"), w = c.clientWidth, h = c.clientHeight;
  ctx.clearRect(0, 0, w, h);
  if (view !== "intra" || !currentProfile || !candleSeries || !show.profile) return;
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
  if (vwapSeries) vwapSeries.applyOptions({ visible: show.vwap });
  if (volSeries) volSeries.applyOptions({ visible: show.volume });
  setProfileLines(show.profile ? currentProfile : null);
}

// ===================================================================== boot
async function boot() {
  cfg = Object.assign(cfg, await fetch("./config.json", { cache: "no-store" }).then((r) => r.json()).catch(() => ({})));
  const stk = await fetch("./data/stocks.json", { cache: "no-store" }).then((r) => r.json());
  master = stk.stocks.map(([code, name, seg]) =>
    ({ code, name, seg, nname: norm(name), ncode: code.toLowerCase() }));
  for (const m of master) codeToName.set(m.code, m.name);
  buildPeriodControl();
  $("updated").textContent =
    `全 ${master.length.toLocaleString()} 銘柄（東証全上場） ／ 5分足=蓄積(R2)+当日ライブ・日足10年・週次信用残高（Yahoo Finance / JPX）`;
  const first = (cfg.favorites || []).find((c) => codeToName.has(c)) || (master[0] && master[0].code);
  if (first) selectCode(first);
  renderSuggest("");
}

// ===================================================================== search
function searchHits(query) {
  const q = norm(query);
  let list;
  if (!q) {
    const favs = (cfg.favorites || []).map((c) => master.find((m) => m.code === c)).filter(Boolean);
    list = favs.length ? favs : master.slice(0, 40);
    return list.slice(0, 40);
  }
  list = master.filter((m) => m.ncode.includes(q) || m.nname.includes(q));
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

// ===================================================================== select / fetch / render
function selectCode(code) {
  curCode = code; curName = codeToName.get(code) || code;
  $("q").value = `${code}  ${curName}`;
  dataset = dailyData = marginData = null;   // 銘柄が変わったら全ビューのキャッシュを破棄
  loadActiveView();
}

function loadActiveView() {
  if (view === "intra") loadIntra(curCode);
  else if (view === "daily") loadDaily(curCode);
  else loadMargin(curCode);
}

function statusEmpty(big, sub) {
  currentProfile = null;
  candleSeries.setData([]); vwapSeries.setData([]); volSeries.setData([]); setProfileLines(null);
  $("date").innerHTML = "";
  $("meta").innerHTML = `<div class="stat"><span class="k">銘柄</span><span class="name"><span class="c">${curCode}</span>${curName}</span></div>`;
  $("empty").hidden = false;
  $("empty").innerHTML = `<div class="big">${big}</div>${sub ? `<div class="sub">${sub}</div>` : ""}`;
}

// /api/intra は {bars:[{ts,o,h,l,c,v}]}、/api/chart は Yahoo生JSON → どちらも正準形 {ts,o,h,l,c,v}[] に
function parseIntra(j) { return j && j.chart ? parseYahoo(j) : (j.bars || []); }
function buildByDay(bars) {
  const byDay = new Map();
  for (const b of bars) { const d = jstDate(b.ts); (byDay.get(d) || byDay.set(d, []).get(d)).push(b); }
  for (const d of byDay.keys()) { const a = byDay.get(d).sort((x, y) => x.ts - y.ts); addVwap(a); }
  return byDay;
}
function dateOptions(dates) {
  const tk = todayKey();
  return [...dates].reverse().map((d) => `<option value="${d}">${d}${d === tk ? "（当日）" : ""}</option>`).join("");
}

// 過去(R2 /api/intra) + 当日(ライブ /api/chart) を結合
async function loadIntra(code) {
  stopLiveTimer();
  statusEmpty("読み込み中…", `${code} のデータを取得しています`);
  try {
    const pastReq = intraCache.has(code)
      ? Promise.resolve(intraCache.get(code))
      : fetch(`${apiBase()}/api/intra?code=${code}`, { cache: "default" }).then((r) => r.json()).then(parseIntra);
    const liveReq = fetch(`${apiBase()}/api/chart?symbol=${encodeURIComponent(code + ".T")}&range=${cfg.liveRange || "5d"}&interval=5m`, { cache: "no-store" })
      .then((r) => r.json()).then(parseYahoo).catch(() => []);
    const [past, live] = await Promise.all([pastReq, liveReq]);
    if (code !== curCode) return;                 // 取得中に別銘柄へ切替
    intraCache.set(code, past);

    const map = new Map();
    for (const b of past) map.set(b.ts, b);
    for (const b of live) map.set(b.ts, b);        // 同tsはライブ優先
    const all = [...map.values()];
    if (!all.length) return statusEmpty("データがありません", "この銘柄は5分足データが取得できませんでした（新規上場・低流動性など）。");

    const byDay = buildByDay(all);
    const dates = [...byDay.keys()].sort();
    dataset = { code, dates, byDay };
    $("date").innerHTML = dateOptions(dates);
    $("empty").hidden = true;
    render();
    maybeStartLiveTimer();
  } catch (e) {
    if (code === curCode) statusEmpty("取得に失敗しました", String(e));
  }
}

// 当日分のみ再取得して差し替え（低遅延・自動更新用）
function refreshLive() {
  const code = curCode;
  fetch(`${apiBase()}/api/chart?symbol=${encodeURIComponent(code + ".T")}&range=1d&interval=5m`, { cache: "no-store" })
    .then((r) => r.json()).then(parseYahoo)
    .then((live) => {
      if (code !== curCode || !dataset || !live.length) return;
      const tk = todayKey();
      const m = new Map();
      for (const b of (dataset.byDay.get(tk) || [])) m.set(b.ts, b);
      for (const b of live) m.set(b.ts, b);
      const today = [...m.values()].sort((a, b) => a.ts - b.ts);
      addVwap(today);
      dataset.byDay.set(tk, today);
      if (!dataset.dates.includes(tk)) { dataset.dates.push(tk); dataset.dates.sort(); $("date").innerHTML = dateOptions(dataset.dates); }
      if (($("date").value || tk) === tk) render();
    }).catch(() => {});
}
function maybeStartLiveTimer() {
  stopLiveTimer();
  if (cfg.liveAuto === false) return;
  const sec = Number(cfg.liveRefreshSec || 90);
  liveTimer = setInterval(() => {
    if (view !== "intra" || document.visibilityState !== "visible") return;
    if (($("date").value || todayKey()) !== todayKey()) return;   // 当日選択時のみ
    refreshLive();
  }, sec * 1000);
}
function stopLiveTimer() { if (liveTimer) { clearInterval(liveTimer); liveTimer = null; } }

function render() {
  if (!dataset) return;
  const date = $("date").value || dataset.dates[dataset.dates.length - 1];
  const bars = dataset.byDay.get(date);
  if (!bars) return;

  candleSeries.setData(bars.map((b) => ({ time: b.ts, open: b.o, high: b.h, low: b.l, close: b.c })));
  vwapSeries.setData(bars.map((b) => ({ time: b.ts, value: b.vwap })));
  volSeries.setData(bars.map((b) => ({ time: b.ts, value: b.v,
    color: b.c >= b.o ? "rgba(8,153,129,0.45)" : "rgba(242,54,69,0.45)" })));
  chart.timeScale().fitContent();

  let prof, profLabel;
  const w = period.startsWith("c") ? Number(period.slice(1)) : 0;
  if (w) {
    const idx = dataset.dates.indexOf(date);
    const win = dataset.dates.slice(Math.max(0, idx - w + 1), idx + 1);
    const all = win.flatMap((d) => dataset.byDay.get(d));
    prof = volumeProfile(all, cfg.profileBins, cfg.valueAreaPercent);
    profLabel = `直近${win.length}日`;
  } else {
    prof = volumeProfile(bars, cfg.profileBins, cfg.valueAreaPercent);
    profLabel = "当日";
  }
  currentProfile = prof;
  applyVisibility();

  const last = bars[bars.length - 1], first = bars[0];
  const chg = last.c - first.o, dev = ((last.c - last.vwap) / last.vwap) * 100;
  const cls = (x) => (x >= 0 ? "up" : "down"), sign = (x) => (x >= 0 ? "+" : "");
  const nd = dataset.dates.length;
  const accum = nd > 60 ? `蓄積${nd}日` : `蓄積中 ${nd}日`;
  const liveTag = (date === todayKey()) ? "・当日ライブ" : "";
  $("meta").innerHTML = `
    <div class="stat"><span class="k">銘柄</span><span class="name"><span class="c">${curCode}</span>${curName}</span></div>
    <div class="stat"><span class="k">終値（${date}）${liveTag}</span><span class="v ${cls(chg)}">${fmtInt(last.c)} <span style="font-size:13px">${sign(chg)}${fmtInt(chg)}</span></span></div>
    <div class="stat"><span class="k">VWAP</span><span class="v vwap sub">${fmtInt(last.vwap)}</span></div>
    <div class="stat"><span class="k">VWAP乖離</span><span class="v sub ${cls(dev)}">${sign(dev)}${dev.toFixed(1)}%</span></div>
    <div class="stat"><span class="k">POC（${profLabel}）</span><span class="v poc sub">${fmtInt(prof.poc)}</span></div>
    <div class="stat"><span class="k">バリューエリア</span><span class="v sub">${fmtInt(prof.val)} 〜 ${fmtInt(prof.vah)}</span></div>
    <div class="stat"><span class="k">5分足</span><span class="v sub">${accum}（${dataset.dates[0]}〜）</span></div>`;
}

function buildPeriodControl() {
  const opts = [{ v: "day", label: "当日" }].concat((cfg.compositeWindows || []).map((w) => ({ v: `c${w}`, label: `直近${w}日` })));
  $("period").innerHTML = opts.map((o) =>
    `<button class="seg-btn${o.v === period ? " on" : ""}" data-v="${o.v}">${o.label}</button>`).join("");
}

// ===================================================================== view切替・メッセージ
function showMessage(big, sub) {
  $("empty").hidden = false;
  $("empty").innerHTML = `<div class="big">${big}</div>${sub ? `<div class="sub">${sub}</div>` : ""}`;
}
function hideMessage() { $("empty").hidden = true; }

function setView(v) {
  view = v;
  if (v !== "intra") stopLiveTimer();
  document.querySelectorAll("#tabs .tab").forEach((t) => t.classList.toggle("on", t.dataset.view === v));
  document.querySelectorAll(".view").forEach((el) => (el.hidden = el.dataset.view !== v));
  $("overlay").hidden = v !== "intra";
  document.querySelectorAll(".ctl").forEach((c) => (c.hidden = c.dataset.for !== v));
  hideMessage();
  loadActiveView();
}

// ===================================================================== 日足ビュー
function initDailyChart() {
  if (dchart) return;
  dchart = LightweightCharts.createChart($("chartDaily"), {
    autoSize: true,
    layout: { background: { color: "#fff" }, textColor: "#475569", fontSize: 12, attributionLogo: false },
    grid: { vertLines: { color: "#eef2f7" }, horzLines: { color: "#eef2f7" } },
    rightPriceScale: { borderColor: "#e2e8f0" }, timeScale: { borderColor: "#e2e8f0" },
    localization: { priceFormatter: (p) => fmtInt(p) },
  });
  dCandle = dchart.addCandlestickSeries({ upColor: "#089981", downColor: "#f23645", wickUpColor: "#089981", wickDownColor: "#f23645", borderVisible: false, priceFormat: { type: "price", precision: 0, minMove: 1 } });
  dVol = dchart.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "vol", lastValueVisible: false });
  dchart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
  buildDrange();
}
function buildDrange() {
  const opts = [["1y", "1年"], ["3y", "3年"], ["5y", "5年"], ["all", "全期間"]];
  $("drange").innerHTML = opts.map(([v, l]) => `<button class="seg-btn${v === drange ? " on" : ""}" data-v="${v}">${l}</button>`).join("");
}
async function loadDaily(code) {
  initDailyChart();
  if (dailyData && dailyData.code === code) return renderDaily();
  showMessage("読み込み中…", `${code} の日足を取得しています`);
  let j;
  try { j = await fetch(`${apiBase()}/api/daily?code=${code}`, { cache: "no-store" }).then((r) => r.json()); }
  catch (e) { return showMessage("取得に失敗しました", String(e)); }
  if (code !== curCode) return;
  if (!j.bars || !j.bars.length) { dailyData = null; return showMessage("日足は未取得です", "バックフィル待ちです（デプロイ後にCron/管理APIで蓄積されます）。"); }
  dailyData = { code, bars: j.bars, splits: j.splits || [] };
  hideMessage(); renderDaily();
}
function renderDaily() {
  if (!dailyData) return;
  const bars = dailyData.bars;
  const yrs = { "1y": 1, "3y": 3, "5y": 5 }[drange];
  let shown = bars;
  if (yrs) { const d = new Date(); d.setFullYear(d.getFullYear() - yrs); const from = d.toISOString().slice(0, 10); shown = bars.filter((b) => b.date >= from); }
  if (!shown.length) shown = bars;
  // 調整後OHLC（分割・併合で連続化）: factor = adj/c
  dCandle.setData(shown.map((b) => { const f = b.c ? b.adj / b.c : 1; return { time: b.date, open: +(b.o * f).toFixed(2), high: +(b.h * f).toFixed(2), low: +(b.l * f).toFixed(2), close: +b.adj.toFixed(2) }; }));
  dVol.setData(shown.map((b) => ({ time: b.date, value: b.v, color: b.c >= b.o ? "rgba(8,153,129,0.45)" : "rgba(242,54,69,0.45)" })));
  dchart.timeScale().fitContent();
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2] || last;
  const chg = last.c - prev.c;
  const cls = (x) => (x >= 0 ? "up" : "down"), sign = (x) => (x >= 0 ? "+" : "");
  const hi = Math.max(...shown.map((b) => b.h)), lo = Math.min(...shown.map((b) => b.l));
  $("meta").innerHTML = `
    <div class="stat"><span class="k">銘柄</span><span class="name"><span class="c">${curCode}</span>${curName}</span></div>
    <div class="stat"><span class="k">終値（${last.date}）</span><span class="v ${cls(chg)}">${fmtInt(last.c)} <span style="font-size:13px">${sign(chg)}${fmtInt(chg)}</span></span></div>
    <div class="stat"><span class="k">出来高</span><span class="v sub">${fmtInt(last.v)}</span></div>
    <div class="stat"><span class="k">期間高値</span><span class="v sub">${fmtInt(hi)}</span></div>
    <div class="stat"><span class="k">期間安値</span><span class="v sub">${fmtInt(lo)}</span></div>
    <div class="stat"><span class="k">日足</span><span class="v sub">${bars.length}本（${bars[0].date}〜）</span></div>
    <div class="stat"><span class="k">分割/併合</span><span class="v sub">${dailyData.splits.length}件</span></div>`;
}

// ===================================================================== 信用残高ビュー
function initMarginChart() {
  if (mchart) return;
  mchart = LightweightCharts.createChart($("chartMargin"), {
    autoSize: true,
    layout: { background: { color: "#fff" }, textColor: "#475569", fontSize: 12, attributionLogo: false },
    grid: { vertLines: { color: "#eef2f7" }, horzLines: { color: "#eef2f7" } },
    rightPriceScale: { borderColor: "#e2e8f0" }, timeScale: { borderColor: "#e2e8f0" },
    localization: { priceFormatter: (p) => fmtInt(p) },
  });
  mBuy = mchart.addAreaSeries({ lineColor: "#2563eb", topColor: "rgba(37,99,235,0.25)", bottomColor: "rgba(37,99,235,0.02)", lineWidth: 2, title: "買残" });
  mSell = mchart.addAreaSeries({ lineColor: "#f23645", topColor: "rgba(242,54,69,0.20)", bottomColor: "rgba(242,54,69,0.02)", lineWidth: 2, title: "売残" });
}
async function loadMargin(code) {
  initMarginChart();
  if (marginData && marginData.code === code) return renderMargin();
  showMessage("読み込み中…", `${code} の信用残高を取得しています`);
  let j;
  try { j = await fetch(`${apiBase()}/api/margin?code=${code}`, { cache: "no-store" }).then((r) => r.json()); }
  catch (e) { return showMessage("取得に失敗しました", String(e)); }
  if (code !== curCode) return;
  if (!j.weeks || !j.weeks.length) { marginData = null; return showMessage("信用残高は未取得です", "週次（火曜）にJPXから自動取込されます。"); }
  marginData = { code, weeks: j.weeks };
  hideMessage(); renderMargin();
}
function renderMargin() {
  if (!marginData) return;
  const w = marginData.weeks;
  mBuy.setData(w.map((x) => ({ time: x.week, value: x.buy })));
  mSell.setData(w.map((x) => ({ time: x.week, value: x.sell })));
  mchart.timeScale().fitContent();
  const last = w[w.length - 1];
  const ratio = last.sell ? (last.buy / last.sell).toFixed(2) : "—";
  const sign = (x) => (x >= 0 ? "+" : "");
  $("meta").innerHTML = `
    <div class="stat"><span class="k">銘柄</span><span class="name"><span class="c">${curCode}</span>${curName}</span></div>
    <div class="stat"><span class="k">買残（${last.week}）</span><span class="v vwap sub">${fmtInt(last.buy)} <span style="font-size:13px">${sign(last.buy_chg)}${fmtInt(last.buy_chg)}</span></span></div>
    <div class="stat"><span class="k">売残</span><span class="v down sub">${fmtInt(last.sell)} <span style="font-size:13px">${sign(last.sell_chg)}${fmtInt(last.sell_chg)}</span></span></div>
    <div class="stat"><span class="k">信用倍率</span><span class="v sub">${ratio}</span></div>
    <div class="stat"><span class="k">記録週数</span><span class="v sub">${w.length}</span></div>`;
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
$("date").addEventListener("change", render);
$("period").addEventListener("click", (e) => {
  const b = e.target.closest(".seg-btn"); if (!b) return;
  period = b.dataset.v;
  $("period").querySelectorAll(".seg-btn").forEach((x) => x.classList.toggle("on", x === b));
  render();
});
$("tabs").addEventListener("click", (e) => {
  const t = e.target.closest(".tab"); if (t) setView(t.dataset.view);
});
$("drange").addEventListener("click", (e) => {
  const b = e.target.closest(".seg-btn"); if (!b) return;
  drange = b.dataset.v;
  $("drange").querySelectorAll(".seg-btn").forEach((x) => x.classList.toggle("on", x === b));
  renderDaily();
});
for (const btn of document.querySelectorAll(".toggle")) {
  btn.addEventListener("click", () => {
    const k = btn.dataset.key; show[k] = !show[k];
    btn.classList.toggle("on", show[k]); applyVisibility();
  });
}

initChart();
resizeOverlay();
boot().catch((e) => { $("meta").textContent = "読み込みに失敗しました: " + e; });
