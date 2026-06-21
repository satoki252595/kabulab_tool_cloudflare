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
const jstMonthDay = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo", month: "2-digit", day: "2-digit" });
const jstDateTime = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false });
const jstDate = (ts) => new Date((ts + 32400) * 1000).toISOString().slice(0, 10);

// ルール7: 投資初心者向け用語ヘルプ。専門用語を点線下線にし、hover/focus/tap で
// 平易な解説バルーンを下に出す（SSRの term-tip.ts は使えないSPAなので同等のCSSを style.css に持つ）。
const GLOSSARY = {
  VWAP: "出来高加重平均価格。その期間に売買が成立した値段を出来高で重みづけして平均した「みんなの平均売買値」。株価がVWAPより上なら買い方が優勢の目安。",
  "VWAP乖離": "今の株価がVWAP(平均売買値)からどれだけ離れているか。プラスは平均より高い、マイナスは安い。",
  POC: "Point of Control＝その期間で最も出来高が集まった価格帯。多くの人が売買した「板の厚い」値段で、支持線・抵抗線になりやすい。",
  "バリューエリア": "出来高の約7割が集中した価格帯。上端がVAH・下端がVAL。値動きが落ち着きやすい「適正圏」の目安。",
  "価格別出来高": "どの値段でどれだけ売買されたかを、価格帯ごとに横棒で表したもの。横棒が長い価格ほど取引が多い。",
  "信用残高": "信用取引(お金や株を借りて行う売買)の未決済分。買って持っている分が買残、売って持っている分が売残。将来の反対売買(返済)の圧力を示す。",
  "買残": "信用取引で「買って」まだ返済していない株数。多いほど将来の売り圧力(返済売り)になりやすい。",
  "売残": "信用取引で「売って」まだ買い戻していない株数。多いほど将来の買い圧力(買い戻し)になりやすい。",
  "信用倍率": "買残÷売残。1倍より大きいと買い建てが多い(将来の売り圧力)、小さいと売り建てが多い(将来の買い圧力)。",
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// 用語ヘルプ付きラベルを返す。term が GLOSSARY に無ければ素のテキスト。
function tip(term) {
  const text = GLOSSARY[term];
  if (!text) return esc(term);
  return `<span class="tip" tabindex="0" role="note" aria-label="${esc(term)}: ${esc(text)}">${esc(term)}<span class="tip-text" role="tooltip">${esc(text)}</span></span>`;
}

let chart, candleSeries, vwapSeries, volSeries;
let profileLines = [];
let currentProfile = null;
let intraMultiDay = false;       // 5分足ビューが複数日連続表示か（時間軸の刻み表記を切替）
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
let daily5m = null;              // 日足ビュー用 5分足バー [{ts,o,h,l,c,v}]（直近〜1年・R2）
let daily5mErr = null;           // 5分足取得に失敗したときの理由（架空値で埋めず明示する）
let dMargin = null;              // 日足ビュー用 信用残高 [{week,buy,sell,...}]
let dMarginErr = null;           // 信用残高取得に失敗したときの理由
let dailyProf = null;            // 日足ビューの 5分足ベース価格別出来高プロファイル
let profileLinesD = [];          // 日足ビューの POC/VAH/VAL ライン
let drange = "3y";               // 日足の表示期間
let dchart, dCandle, dVol, dVwap5, dMBuy, dMSell;  // 日足チャート(遅延生成)
let mchart, mBuy, mSell;         // 信用残高チャート(遅延生成)
const showD = { vwap5m: true, profile5m: true, margin: true, volume: true };  // 日足ビューの重畳トグル
const apiBase = () => cfg.apiBase || "";
const intraCache = new Map();    // code -> 5分足バー（メモリキャッシュ・当日は含めない）
let liveTimer = null;            // 当日ライブ自動更新タイマー
const todayKey = () => jstDate(Math.floor(Date.now() / 1000));

// ===================================================================== 計算
// 当日内の累積VWAP（buildByDay が1日単位で付与する b.vwap 用）。
function addVwap(bars) {
  let pv = 0, vv = 0;
  for (const b of bars) {
    const tp = (b.h + b.l + b.c) / 3;
    pv += tp * b.v; vv += b.v;
    b.vwap = vv ? +(pv / vv).toFixed(2) : b.c;
  }
  return bars;
}

// 期間アンカーVWAP: 渡したバー列の先頭から通しで累積したVWAPを別配列で返す
// （複数日連続表示で「期間先頭からのVWAP」を出す。b.vwap=当日VWAP は壊さない）。
function anchoredVwap(bars) {
  let pv = 0, vv = 0;
  const out = [];
  for (const b of bars) {
    const tp = (b.h + b.l + b.c) / 3;
    pv += tp * b.v; vv += b.v;
    out.push(vv ? +(pv / vv).toFixed(2) : b.c);
  }
  return out;
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
      tickMarkFormatter: (t) => intraMultiDay ? jstMonthDay.format(t * 1000) : jstTime.format(t * 1000) },
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
// 非表示タブ/バックグラウンド時は描画を止める（モバイルのバッテリ消費を抑える）。
function drawLoop() { if (document.visibilityState === "visible") drawProfile(); requestAnimationFrame(drawLoop); }

// 価格別出来高（縦の価格帯ヒストグラム）を canvas で描く。5分足ビューと
// 日足ビュー（5分足ベース）の両方で、アクティブなチャートに対して描画する。
function drawProfile() {
  const c = $("overlay"), ctx = c.getContext("2d"), w = c.clientWidth, h = c.clientHeight;
  ctx.clearRect(0, 0, w, h);
  let prof = null, series = null, ch = null;
  if (view === "intra" && show.profile) { prof = currentProfile; series = candleSeries; ch = chart; }
  else if (view === "daily" && showD.profile5m) { prof = dailyProf; series = dCandle; ch = dchart; }
  if (!prof || !series || !ch) return;
  const maxLen = (w - ch.priceScale("right").width()) * 0.30;
  const maxVol = Math.max(...prof.bins.map((b) => b.volume)) || 1;
  const half = prof.binSize / 2;
  for (const bin of prof.bins) {
    if (bin.volume <= 0) continue;
    const yT = series.priceToCoordinate(bin.price + half);
    const yB = series.priceToCoordinate(bin.price - half);
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
function setProfileLinesD(prof) {
  for (const l of profileLinesD) dCandle.removePriceLine(l);
  profileLinesD = [];
  if (!prof) return;
  const add = (price, color, title, style) => profileLinesD.push(
    dCandle.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title }));
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
    `全 ${master.length.toLocaleString()} 銘柄（東証全上場） ／ 5分足=蓄積(R2)+当日ライブ・日足10年・週次信用残高`;
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
  daily5m = dMargin = dailyProf = null;
  daily5mErr = dMarginErr = null;
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
  const w = period.startsWith("c") ? Number(period.slice(1)) : 0;

  // 表示するバー列と VWAP・プロファイルの集計範囲を決める。
  // 当日(period=day): 選択1日。複数日(c<N>): 選択日を末尾に直近N日を連続表示し、
  // VWAP は期間先頭からの累積（アンカーVWAP）にする。
  let bars, vwapArr, prof, profLabel, winLen = 1, winStart = date;
  if (w) {
    const idx = dataset.dates.indexOf(date);
    const win = dataset.dates.slice(Math.max(0, idx - w + 1), idx + 1);
    bars = win.flatMap((d) => dataset.byDay.get(d)).sort((a, b) => a.ts - b.ts);
    if (!bars.length) return;
    vwapArr = anchoredVwap(bars);
    prof = volumeProfile(bars, cfg.profileBins, cfg.valueAreaPercent);
    profLabel = `直近${win.length}日`;
    winLen = win.length; winStart = win[0];
  } else {
    bars = dataset.byDay.get(date);
    if (!bars) return;
    vwapArr = bars.map((b) => b.vwap);
    prof = volumeProfile(bars, cfg.profileBins, cfg.valueAreaPercent);
    profLabel = "当日";
  }
  intraMultiDay = winLen > 1;

  candleSeries.setData(bars.map((b) => ({ time: b.ts, open: b.o, high: b.h, low: b.l, close: b.c })));
  vwapSeries.setData(bars.map((b, i) => ({ time: b.ts, value: vwapArr[i] })));
  volSeries.setData(bars.map((b) => ({ time: b.ts, value: b.v,
    color: b.c >= b.o ? "rgba(8,153,129,0.45)" : "rgba(242,54,69,0.45)" })));
  chart.timeScale().fitContent();

  currentProfile = prof;
  applyVisibility();

  const last = bars[bars.length - 1], first = bars[0];
  const lastVwap = vwapArr[vwapArr.length - 1];
  const chg = last.c - first.o, dev = ((last.c - lastVwap) / lastVwap) * 100;
  const cls = (x) => (x >= 0 ? "up" : "down"), sign = (x) => (x >= 0 ? "+" : "");
  const nd = dataset.dates.length;
  const accum = nd > 60 ? `蓄積${nd}日` : `蓄積中 ${nd}日`;
  const liveTag = (!intraMultiDay && date === todayKey()) ? "・当日ライブ" : "";
  const closeLabel = intraMultiDay ? `終値（${winStart}〜${date}）` : `終値（${date}）${liveTag}`;
  $("meta").innerHTML = `
    <div class="stat"><span class="k">銘柄</span><span class="name"><span class="c">${curCode}</span>${curName}</span></div>
    <div class="stat"><span class="k">${closeLabel}</span><span class="v ${cls(chg)}">${fmtInt(last.c)} <span style="font-size:13px">${sign(chg)}${fmtInt(chg)}</span></span></div>
    <div class="stat"><span class="k">${tip("VWAP")}（${profLabel}）</span><span class="v vwap sub">${fmtInt(lastVwap)}</span></div>
    <div class="stat"><span class="k">${tip("VWAP乖離")}</span><span class="v sub ${cls(dev)}">${sign(dev)}${dev.toFixed(1)}%</span></div>
    <div class="stat"><span class="k">${tip("POC")}（${profLabel}）</span><span class="v poc sub">${fmtInt(prof.poc)}</span></div>
    <div class="stat"><span class="k">${tip("バリューエリア")}（${profLabel}）</span><span class="v sub">${fmtInt(prof.val)} 〜 ${fmtInt(prof.vah)}</span></div>
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
  $("overlay").hidden = (v === "margin");   // 価格別出来高オーバーレイは intra / daily で使う
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
  // 5分足ベース・期間アンカーVWAP（調整後の価格軸に合わせる）。
  dVwap5 = dchart.addLineSeries({ color: "#2563eb", lineWidth: 2, priceLineVisible: false, lastValueVisible: true, title: "VWAP(5分足)", priceFormat: { type: "price", precision: 0, minMove: 1 } });
  // 信用残高（週次・別スケール"mgn"で中段に積む）。買残=紫 / 売残=赤。
  dMBuy = dchart.addLineSeries({ color: "#7c3aed", lineWidth: 2, priceScaleId: "mgn", priceLineVisible: false, lastValueVisible: false, title: "買残", priceFormat: { type: "volume" } });
  dMSell = dchart.addLineSeries({ color: "#f23645", lineWidth: 2, priceScaleId: "mgn", priceLineVisible: false, lastValueVisible: false, title: "売残", priceFormat: { type: "volume" } });
  dVol = dchart.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "vol", lastValueVisible: false });
  applyDailyScaleLayout(false);
  buildDrange();
}
// 信用残高ペインの有無で価格軸の縦配分を切替（買残/売残が無いときは2段に詰める）。
function applyDailyScaleLayout(hasMargin) {
  if (!dchart) return;
  if (hasMargin) {
    dchart.priceScale("right").applyOptions({ scaleMargins: { top: 0.05, bottom: 0.45 } });
    dchart.priceScale("mgn").applyOptions({ scaleMargins: { top: 0.57, bottom: 0.22 } });
    dchart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.80, bottom: 0 } });
  } else {
    dchart.priceScale("right").applyOptions({ scaleMargins: { top: 0.05, bottom: 0.25 } });
    dchart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.80, bottom: 0 } });
  }
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
  if (!j.bars || !j.bars.length) { dailyData = null; return showMessage("日足は未取得です", "平日の取引終了後に自動取込されます（バックフィル待ち）。"); }
  dailyData = { code, bars: j.bars, splits: j.splits || [] };
  hideMessage(); renderDaily();          // ローソク+出来高は即描画
  loadDailyOverlays(code);               // 5分足VWAP/価格別出来高・信用残高は非同期で重畳
}
// 日足チャートに重ねる 5分足(直近〜1年) と 信用残高(週次) を取得。
// 取得失敗は架空値で埋めず、理由を保持して meta に正直に出す（ルール2）。
async function loadDailyOverlays(code) {
  let i5 = null, i5err = null;
  if (intraCache.has(code)) i5 = intraCache.get(code);
  else {
    try { i5 = await fetch(`${apiBase()}/api/intra?code=${code}`).then((r) => r.json()).then(parseIntra); intraCache.set(code, i5); }
    catch (e) { i5err = String(e); }
  }
  if (code !== curCode) return;
  daily5m = i5; daily5mErr = i5err;

  let mw = null, mErr = null;
  try { const mj = await fetch(`${apiBase()}/api/margin?code=${code}&n=104`).then((r) => r.json()); mw = mj.weeks || []; }
  catch (e) { mErr = String(e); }
  if (code !== curCode) return;
  dMargin = mw; dMarginErr = mErr;

  if (view === "daily") renderDaily();
}
function renderDaily() {
  if (!dailyData) return;
  const bars = dailyData.bars;
  const yrs = { "1y": 1, "3y": 3, "5y": 5 }[drange];
  let shown = bars, from = null;
  if (yrs) { const d = new Date(); d.setFullYear(d.getFullYear() - yrs); from = d.toISOString().slice(0, 10); shown = bars.filter((b) => b.date >= from); }
  if (!shown.length) { shown = bars; from = null; }

  // 調整係数 f = adj/c（分割・併合の連続化）。5分足(生値)を調整後ローソクの価格軸へ揃える。
  const fmap = new Map();
  for (const b of bars) fmap.set(b.date, b.c ? b.adj / b.c : 1);
  const fOf = (d) => (fmap.has(d) ? fmap.get(d) : 1);

  dCandle.setData(shown.map((b) => { const f = fOf(b.date); return { time: b.date, open: +(b.o * f).toFixed(2), high: +(b.h * f).toFixed(2), low: +(b.l * f).toFixed(2), close: +b.adj.toFixed(2) }; }));
  dVol.setData(shown.map((b) => ({ time: b.date, value: b.v, color: b.c >= b.o ? "rgba(8,153,129,0.45)" : "rgba(242,54,69,0.45)" })));

  // ---- 5分足ベース VWAP + 価格別出来高（#4。5分足が在る直近〜1年のみ） ----
  let vwap5Note = null, fiveDays = 0, vwap5Last = null;
  if (daily5m && daily5m.length) {
    const within = from ? daily5m.filter((b) => jstDate(b.ts) >= from) : daily5m;
    if (within.length) {
      let pv = 0, vv = 0; const perDay = new Map();
      const adjBars = [];
      for (const b of within) {
        const d = jstDate(b.ts), f = fOf(d);
        const tp = ((b.h + b.l + b.c) / 3) * f;
        pv += tp * b.v; vv += b.v;
        perDay.set(d, vv ? +(pv / vv).toFixed(2) : +(b.c * f).toFixed(2));
        adjBars.push({ h: b.h * f, l: b.l * f, c: b.c * f, v: b.v });
      }
      const vwapPts = [...perDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([time, value]) => ({ time, value }));
      dVwap5.setData(vwapPts);
      dailyProf = volumeProfile(adjBars, cfg.profileBins, cfg.valueAreaPercent);
      fiveDays = perDay.size;
      vwap5Last = vwapPts.length ? vwapPts[vwapPts.length - 1].value : null;
    } else { dVwap5.setData([]); dailyProf = null; vwap5Note = "表示期間に5分足なし"; }
  } else {
    dVwap5.setData([]); dailyProf = null;
    vwap5Note = daily5mErr ? "取得失敗" : (daily5m ? "未蓄積" : "読込中…");
  }
  setProfileLinesD(showD.profile5m ? dailyProf : null);

  // ---- 信用残高 買残/売残（#3。週次・日足タイムフレームへ重畳） ----
  let marginNote = null;
  const mAll = dMargin || [];
  const mw = from ? mAll.filter((x) => x.week >= from) : mAll;
  const hasMargin = mw.length > 0;
  if (hasMargin) {
    dMBuy.setData(mw.map((x) => ({ time: x.week, value: x.buy })));
    dMSell.setData(mw.map((x) => ({ time: x.week, value: x.sell })));
  } else {
    dMBuy.setData([]); dMSell.setData([]);
    marginNote = dMarginErr ? "取得失敗" : (dMargin ? "未取得" : "読込中…");
  }
  applyDailyScaleLayout(hasMargin);
  applyDailyVisibility();
  dchart.timeScale().fitContent();

  // ---- meta ----
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2] || last;
  const chg = last.c - prev.c;
  const cls = (x) => (x >= 0 ? "up" : "down"), sign = (x) => (x >= 0 ? "+" : "");
  const hi = Math.max(...shown.map((b) => b.h)), lo = Math.min(...shown.map((b) => b.l));
  let html = `
    <div class="stat"><span class="k">銘柄</span><span class="name"><span class="c">${curCode}</span>${curName}</span></div>
    <div class="stat"><span class="k">終値（${last.date}）</span><span class="v ${cls(chg)}">${fmtInt(last.c)} <span style="font-size:13px">${sign(chg)}${fmtInt(chg)}</span></span></div>
    <div class="stat"><span class="k">期間高安</span><span class="v sub">${fmtInt(lo)} 〜 ${fmtInt(hi)}</span></div>`;
  if (dailyProf && vwap5Last != null) {
    html += `
    <div class="stat"><span class="k">${tip("VWAP")}（5分足${fiveDays}日）</span><span class="v vwap sub">${fmtInt(vwap5Last)}</span></div>
    <div class="stat"><span class="k">${tip("POC")}（5分足${fiveDays}日）</span><span class="v poc sub">${fmtInt(dailyProf.poc)}</span></div>`;
  } else {
    html += `<div class="stat"><span class="k">${tip("VWAP")}/${tip("POC")}（5分足）</span><span class="v sub">${vwap5Note || "—"}</span></div>`;
  }
  if (hasMargin) {
    const lm = mw[mw.length - 1];
    const ratio = lm.sell ? (lm.buy / lm.sell).toFixed(2) : "—";
    html += `
    <div class="stat"><span class="k">${tip("買残")}（${lm.week}）</span><span class="v sub" style="color:#7c3aed">${fmtInt(lm.buy)} <span style="font-size:13px">${sign(lm.buy_chg)}${fmtInt(lm.buy_chg)}</span></span></div>
    <div class="stat"><span class="k">${tip("売残")} / ${tip("信用倍率")}</span><span class="v down sub">${fmtInt(lm.sell)} <span style="font-size:13px;color:var(--fg-2)">×${ratio}</span></span></div>`;
  } else {
    html += `<div class="stat"><span class="k">${tip("信用残高")}</span><span class="v sub">${marginNote || "—"}</span></div>`;
  }
  html += `
    <div class="stat"><span class="k">日足</span><span class="v sub">${bars.length}本（${bars[0].date}〜）</span></div>
    <div class="stat"><span class="k">分割/併合</span><span class="v sub">${dailyData.splits.length}件</span></div>`;
  $("meta").innerHTML = html;
}

function applyDailyVisibility() {
  if (!dchart) return;
  const has5 = !!(daily5m && daily5m.length && dailyProf);
  const hasM = !!(dMargin && dMargin.length);
  if (dVol) dVol.applyOptions({ visible: showD.volume });
  if (dVwap5) dVwap5.applyOptions({ visible: showD.vwap5m && has5 });
  if (dMBuy) dMBuy.applyOptions({ visible: showD.margin && hasM });
  if (dMSell) dMSell.applyOptions({ visible: showD.margin && hasM });
  setProfileLinesD((showD.profile5m && has5) ? dailyProf : null);
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
  mBuy = mchart.addAreaSeries({ lineColor: "#7c3aed", topColor: "rgba(124,58,237,0.22)", bottomColor: "rgba(124,58,237,0.02)", lineWidth: 2, title: "買残" });
  mSell = mchart.addAreaSeries({ lineColor: "#f23645", topColor: "rgba(242,54,69,0.20)", bottomColor: "rgba(242,54,69,0.02)", lineWidth: 2, title: "売残" });
}
async function loadMargin(code) {
  initMarginChart();
  if (marginData && marginData.code === code) return renderMargin();
  showMessage("読み込み中…", `${code} の信用残高を取得しています`);
  let j;
  try { j = await fetch(`${apiBase()}/api/margin?code=${code}`, { cache: "default" }).then((r) => r.json()); }
  catch (e) { return showMessage("取得に失敗しました", String(e)); }
  if (code !== curCode) return;
  if (!j.weeks || !j.weeks.length) { marginData = null; return showMessage("信用残高は未取得です", "週次（土）に自動取込されます。"); }
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
    <div class="stat"><span class="k">${tip("買残")}（${last.week}）</span><span class="v vwap sub" style="color:#7c3aed">${fmtInt(last.buy)} <span style="font-size:13px">${sign(last.buy_chg)}${fmtInt(last.buy_chg)}</span></span></div>
    <div class="stat"><span class="k">${tip("売残")}</span><span class="v down sub">${fmtInt(last.sell)} <span style="font-size:13px">${sign(last.sell_chg)}${fmtInt(last.sell_chg)}</span></span></div>
    <div class="stat"><span class="k">${tip("信用倍率")}</span><span class="v sub">${ratio}</span></div>
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
// 5分足ビュー専用トグル（VWAP / 価格別出来高 / 出来高）
for (const btn of document.querySelectorAll('.ctl[data-for="intra"] .toggle')) {
  btn.addEventListener("click", () => {
    const k = btn.dataset.key; show[k] = !show[k];
    btn.classList.toggle("on", show[k]); applyVisibility();
  });
}
// 日足ビュー専用トグル（5分足VWAP / 5分足価格別出来高 / 信用残高 / 出来高）
for (const btn of document.querySelectorAll('.ctl[data-for="daily"] .toggle')) {
  btn.addEventListener("click", () => {
    const k = btn.dataset.key; showD[k] = !showD[k];
    btn.classList.toggle("on", showD[k]); applyDailyVisibility();
  });
}

initChart();
resizeOverlay();
boot().catch((e) => { $("meta").textContent = "読み込みに失敗しました: " + e; });
