// 007 VWAP Analysis — 5分足VWAP / 価格別出来高 / 日足10年 / 信用残高
// 配信のみ（Hono サブアプリ）。時系列は R2(c.env.BUCKET) の保存済みデータ。
// フロント(SPA)は public/vwap-analysis/ を ASSETS が配信。ここは /api/* だけ。
import { Hono } from "hono";
import type { DailyFetchProof } from "../../src/shared/yahoo/client.js";
import type { DailyBar } from "../../src/shared/yahoo/client.js";
import { assertCorporateEventsShape, assertEventSourceProof, corporateEventPins, corporateSplitProjection,
  currentEventRevisions, priceSnapshotJson, type CorporateEvents } from "../../src/shared/yahoo/corporate-events.js";
import { sha256Hex } from "../../src/shared/sha256.js";
import {
  intraWindowOf,
  isCalendarDateString,
  isDailyBarShape,
  isDailyFetchProof,
  isIntraBarShape,
  zeroSplitCovered,
} from "../../src/shared/vwap/proof.js";
import type { IntraWindow } from "../../src/shared/vwap/proof.js";
import {
  MARGIN_DAILY_FORMAT,
  selectDailyMarginRows,
  validateDailyMarginSnapshot,
} from "./lib/margin-daily.js";
import type { MarginDailySnapshot } from "./lib/margin-daily.js";

export const BASE_PATH = "/vwap-analysis";

type Bindings = { BUCKET: { get: (key: string) => Promise<{ body: ReadableStream; text: () => Promise<string> } | null> } };
const app = new Hono<{ Bindings: Bindings }>({ strict: false });

const CODE_RE = /^[0-9A-Za-z]{4}$/;
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });

// 未使用のライブ入口を停止。画面閲覧で Yahoo 通信を発生させない。
app.get("/api/chart", () => json({
  error: "ライブ取得は停止しています。保存済みの日足・5分足を利用してください。",
}, 410));

// intra 価格 basis 契約: producer proof を検証して配信・適格化する。
// 適格 (zero-split verified) は daily proof の実証 span が保存 intra
// 全体を覆い、窓の初日から日足の最終日まで分割がない場合のみ。legacy
// (proof なし)・span 外・現在の基準までの split は HOLD。wire basis は UNKNOWN
// のまま断定しない。不正形状の既知 object は reject (throw) し、
// 欠落 object の legitempty とは区別する。
const INTRA_SOURCE = "yahoo-5m"; // fetchBars5m (Yahoo chart interval=5m) 由来。code fact。
const INTRA_WIRE = "unknown"; // wire 上の調整 basis は未確定。断定しない。

type IntraBasis = {
  source: string;
  wire: string;
  qualified: boolean;
  reason: string | null;
  window: { firstTs: number; lastTs: number; bars: number } | null; // bars 実測
  sessions: string[]; // bars 実測の JST セッション
};

const holdBasis = (reason: string, window: IntraBasis["window"], sessions: string[]): IntraBasis => ({
  source: INTRA_SOURCE, wire: INTRA_WIRE, qualified: false, reason, window, sessions,
});

const passBasis = (window: IntraWindow): IntraBasis => ({
  source: INTRA_SOURCE,
  wire: INTRA_WIRE,
  qualified: true,
  reason: "zero-split-verified",
  window: { firstTs: window.firstTs, lastTs: window.lastTs, bars: window.bars },
  sessions: window.sessions,
});

type ValidDaily = {
  updated: unknown;
  bars: unknown[];
  splits: Array<{ date: string; ratio: number }>;
  proof: DailyFetchProof | null;
  corporateEvents: CorporateEvents | null;
};

/** 日足 object の strict 読取。欠落は null、形状不正は throw (reject)。 */
async function readDailyObject(
  bucket: Bindings["BUCKET"],
  code: string
): Promise<ValidDaily | null> {
  const o = await bucket.get(`daily/${code}.json`);
  if (!o) return null;
  const body = JSON.parse(await o.text()) as {
    code?: unknown; updated?: unknown; bars?: unknown; splits?: unknown; proof?: unknown; corporateEvents?: unknown;
  };
  if (body.code !== code) throw new Error(`daily object の code 不一致: ${code}`);
  if (!Array.isArray(body.bars)) throw new Error(`daily object の bars 非配列: ${code}`);
  // 消費者は昇順・末尾最新を信頼する。重複は非昇順に含めて一律 reject。
  let prev = "";
  for (const b of body.bars) {
    if (!isDailyBarShape(b)) throw new Error(`daily object の bar 不正: ${code}`);
    const d = (b as { date: string }).date;
    if (d <= prev) throw new Error(`daily object の date 非昇順: ${code}`);
    prev = d;
  }
  if (!Array.isArray(body.splits)) throw new Error(`daily object の splits 非配列: ${code}`);
  const splits: Array<{ date: string; ratio: number }> = [];
  for (const s of body.splits as Array<{ date?: unknown; ratio?: unknown }>) {
    if (s === null || typeof s !== "object" || !isCalendarDateString(s.date) ||
        typeof s.ratio !== "number" || !Number.isFinite(s.ratio) || s.ratio <= 0) {
      throw new Error(`daily object の splits 要素不正: ${code}`);
    }
    splits.push({ date: s.date, ratio: s.ratio });
  }
  if (body.proof !== undefined && body.proof !== null && !isDailyFetchProof(body.proof)) {
    throw new Error(`daily object の proof 不正: ${code}`);
  }
  const proof = body.proof === undefined || body.proof === null
    ? null
    : (body.proof as DailyFetchProof);
  // proof は要求 code の symbol に bind されていること (cross-code 混入防止)。
  // intra/daily 両 path の単一 guard (呼出側の重複検査は持たない)。
  if (proof !== null && proof.symbol !== `${code}.T`) {
    throw new Error(`daily proof の symbol 不一致: ${code}`);
  }
  let corporateEvents: CorporateEvents | null = null;
  if (body.corporateEvents !== undefined) {
    assertCorporateEventsShape(body.corporateEvents, `${code}.T`);
    if (proof === null) throw new Error(`daily events の proof 欠落: ${code}`);
    corporateEvents = body.corporateEvents;
    assertEventSourceProof(corporateEvents, proof);
    if (await sha256Hex(priceSnapshotJson(body.bars as DailyBar[])) !== corporateEvents.source.priceSnapshotSha256 ||
      JSON.stringify(corporateSplitProjection(corporateEvents)) !== JSON.stringify(splits)) {
      throw new Error(`daily events の価格/分割対応不一致: ${code}`);
    }
    for (const pin of corporateEventPins(corporateEvents)) {
      if (await sha256Hex(pin.json) !== pin.sha256) throw new Error(`daily events の原値SHA不一致: ${code}`);
    }
  }
  return { updated: body.updated ?? null, bars: body.bars, splits, proof, corporateEvents };
}

type ValidIntra = { updated: unknown; bars: unknown[]; window: IntraWindow | null };

/** 5分足 object の strict 読取。欠落は null、形状不正は throw (reject)。 */
async function readIntraObject(
  bucket: Bindings["BUCKET"],
  code: string
): Promise<ValidIntra | null> {
  const o = await bucket.get(`intra/${code}.json`);
  if (!o) return null;
  const body = JSON.parse(await o.text()) as { code?: unknown; bars?: unknown; updated?: unknown };
  if (body.code !== code) throw new Error(`intra object の code 不一致: ${code}`);
  if (!Array.isArray(body.bars)) throw new Error(`intra object の bars 非配列: ${code}`);
  const bars = body.bars;
  if (bars.length === 0) return { updated: body.updated ?? null, bars, window: null };
  const tsList: number[] = [];
  const seen = new Set<number>();
  for (const b of bars) {
    if (!isIntraBarShape(b)) throw new Error(`intra object の bar 不正: ${code}`);
    const ts = (b as { ts: number }).ts;
    if (seen.has(ts)) throw new Error(`intra object の ts 重複: ${code}`);
    seen.add(ts);
    tsList.push(ts);
  }
  return { updated: body.updated ?? null, bars, window: intraWindowOf(tsList) };
}

// 蓄積5分足(R2) + proof 検証 basis を配信
app.get("/api/intra", async (c) => {
  const code = (c.req.query("code") || "").trim();
  if (!CODE_RE.test(code)) return json({ error: "bad code" }, 400);
  const cached = (o: unknown) =>
    new Response(JSON.stringify(o), { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" } });
  const intra = await readIntraObject(c.env.BUCKET, code);
  if (!intra) return cached({ code, bars: [], note: "未蓄積", basis: holdBasis("intra-missing", null, []) });
  if (!intra.window) {
    return cached({ code, updated: intra.updated, bars: [], basis: holdBasis("intra-empty", null, []) });
  }
  const daily = await readDailyObject(c.env.BUCKET, code);
  if (!daily) {
    return cached({
      code, updated: intra.updated, bars: intra.bars,
      basis: holdBasis("daily-unavailable", intra.window, intra.window.sessions),
    });
  }
  if (!daily.proof) {
    return cached({
      code, updated: intra.updated, bars: intra.bars,
      basis: holdBasis("proof-absent", intra.window, intra.window.sessions),
    });
  }
  // 適格は full-10y proof のみ。要求 range の真正は producer の meta echo
  // 照合済み。ここでは 10y 以外の proof を HOLD する (書換えはしない)。
  if (daily.proof.requestedRange !== "10y") {
    return cached({
      code, updated: intra.updated, bars: intra.bars,
      basis: holdBasis("range-not-10y", intra.window, intra.window.sessions),
    });
  }
  const cov = zeroSplitCovered(
    daily.proof,
    intra.window,
    daily.bars.map((b) => (b as { date: string }).date),
    daily.splits
  );
  if (!cov.ok) {
    return cached({
      code, updated: intra.updated, bars: intra.bars,
      basis: holdBasis(cov.reason, intra.window, intra.window.sessions),
    });
  }
  return cached({ code, updated: intra.updated, bars: intra.bars, basis: passBasis(intra.window) });
});

// 日足10年(R2) + producer proof を検証して配信
app.get("/api/daily", async (c) => {
  const code = (c.req.query("code") || "").trim();
  if (!CODE_RE.test(code)) return json({ error: "bad code" }, 400);
  const cached = (o: unknown) =>
    new Response(JSON.stringify(o), { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" } });
  const daily = await readDailyObject(c.env.BUCKET, code);
  if (!daily) return cached({ code, bars: [], splits: [], dividends: null, corporateEvents: null,
    corporateEventsStatus: "not-fetched", note: "未取得（バックフィル待ち）", proof: null });
  return cached({ code, updated: daily.updated, bars: daily.bars, splits: daily.splits, proof: daily.proof,
    corporateEvents: daily.corporateEvents, corporateEventsStatus: daily.corporateEvents === null ? "not-fetched" : "observed",
    dividends: daily.corporateEvents === null ? null : currentEventRevisions(daily.corporateEvents.dividends) });
});

// 日次信用残高(R2)を集約。n=直近何営業日ぶん返すか(既定60・上限260=約1年)。
// 日足チャートへ重畳する用途では長期(n=260)を要求する。R2 はバインディング
// 経由(=subrequest にカウントされない)なので、各日ファイルは並列取得して待ち時間を抑える。
// code は 4 文字ティッカーか 5 文字原文コード。旧週次オブジェクトは読まない。
app.get("/api/margin", async (c) => {
  const code = (c.req.query("code") || "").trim().toUpperCase();
  if (!CODE_RE.test(code) && !/^[0-9]{3}[0-9A-Z][0-9]$/.test(code)) {
    return json({ error: "bad code" }, 400);
  }
  const nRaw = c.req.query("n");
  let n = 60;
  if (nRaw !== undefined) {
    const parsed = Number(nRaw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 260) return json({ error: "bad n" }, 400);
    n = parsed;
  }
  // 日次データなので 1 日キャッシュ可。同一銘柄の再オープンで R2 読取を繰り返さない。
  const cached = (o: unknown) =>
    new Response(JSON.stringify(o), { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=86400" } });
  const dl = await c.env.BUCKET.get("margin/dates.json");
  if (!dl) return cached({ code, dates: [], ambiguousDates: [] });
  const dates: string[] = JSON.parse(await dl.text()).slice(-n);
  const rows = await Promise.all(dates.map(async (d) => {
    const o = await c.env.BUCKET.get(`margin/daily/${d}.json`);
    // index に参照日があるのに snapshot が無いのは破損。正常空に落とさず throw する。
    if (!o) throw new Error(`margin snapshot missing for indexed date: ${d}`);
    const snap = JSON.parse(await o.text()) as MarginDailySnapshot;
    if (snap.format !== MARGIN_DAILY_FORMAT) {
      throw new Error(`unknown margin snapshot format: ${snap.format}`);
    }
    // R2 の欠落・破損を空配列で隠さない。Worker-safe 純粋検証を再利用し、
    // 全行形状 + basisDate=index 日付の一致を確認してから selection する。
    validateDailyMarginSnapshot(snap);
    if (snap.basisDate !== d) {
      throw new Error(`margin snapshot date mismatch: index=${d} body=${snap.basisDate}`);
    }
    // 同一ティッカーの複数行 (普通株+種類株等) はどれを使うか決められないため、
    // 値無しで除外日として明示する (先頭行の黙った採用をしない)。
    const sel = selectDailyMarginRows(snap.rows, code);
    if (sel.status === "ambiguous") return { date: d, ambiguous: true as const };
    if (sel.status === "missing") return null;
    return { date: d, publicationDate: snap.publicationDate, ...sel.row };
  }));
  const ambiguousDates = rows.filter((r): r is { date: string; ambiguous: true } => r !== null && "ambiguous" in r).map((r) => r.date);
  return cached({ code, dates: rows.filter((r) => r !== null && !("ambiguous" in r)), ambiguousDates });
});

export default app;
