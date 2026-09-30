/**
 * 日経平均 VI (Nikkei Volatility Index) スクレイパー
 *
 * Yahoo Finance は日経VI を提供していない (2026-04 時点で ^NKVI / ^VNKY /
 * ^JNIV / ^VXJ / ^N225VI 全て 404)。唯一安定して取れるのは Nikkei 電子版の
 * スマートチャート (`https://www.nikkei.com/smartchart/?code=N145/O`) で、
 * HTML 内に `window.__INITIAL_STATE__` として JSON が埋め込まれている。
 *
 * 取得する値:
 *   - DPP  : 現在値 (day present price)
 *   - PRP  : 前日終値 (previous reference price)
 *   - DYWP : 前日比値幅 (day yield wealth progress)
 *
 * CLAUDE.md のフォールバック禁止ルールに従い、HTML 構造が変わって抽出に
 * 失敗した場合は throw する。呼び出し側が catch して null に変換し、judgeMacro()
 * が "HOLD" を返す = 判定保留を UI に明示する。
 */

const NIKKEI_SMARTCHART_URL = "https://www.nikkei.com/smartchart/?code=N145/O";

export interface NikkeiViSnapshot {
  /** 現在値 (DPP) — 市場閉場後は大引け値 */
  price: number;
  /** 前日終値 (PRP) */
  previousClose: number;
  /** 前日比値幅 (DYWP) */
  change: number;
  /** 前日比率% (DYRP) */
  changePct: number;
  /** データ日付 (ZXD, YYYY-MM-DD) */
  date: string;
  /** 現在値のタイムスタンプ (ISO8601 with TZ) */
  latestTimestamp: string | null;
}

export interface NikkeiViRawCapture {
  status: number;
  bytes: Uint8Array;
}

export interface FetchNikkeiViOptions {
  /**
   * 原文 capture の受取 (任意・1 件)。chart の onRaw と同型。
   * HTTP 判定より前に clone して呼ぶ (未指定の通常呼出は従来どおり)。
   */
  onRaw?: (capture: NikkeiViRawCapture) => void | Promise<void>;
}

export async function fetchNikkeiVi(
  options?: FetchNikkeiViOptions
): Promise<NikkeiViSnapshot> {
  const res = await fetch(NIKKEI_SMARTCHART_URL, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
    },
  });

  if (options?.onRaw) {
    const bytes = new Uint8Array(await res.clone().arrayBuffer());
    await options.onRaw({ status: res.status, bytes });
  }

  if (!res.ok) {
    throw new Error(
      `Nikkei smartchart HTTP エラー: ${res.status} ${res.statusText}`
    );
  }

  const body = await res.text();
  const match = body.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});/);
  if (!match) {
    throw new Error(
      "Nikkei smartchart: window.__INITIAL_STATE__ が見つかりません (HTML 構造変化の可能性)"
    );
  }

  let state: unknown;
  try {
    state = JSON.parse(match[1]);
  } catch (e) {
    throw new Error(
      `Nikkei smartchart: __INITIAL_STATE__ JSON パース失敗: ${e instanceof Error ? e.message : e}`,
      { cause: e }
    );
  }

  if (
    typeof state !== "object" ||
    state === null ||
    !("symbolInfo" in state) ||
    typeof (state as { symbolInfo: unknown }).symbolInfo !== "object"
  ) {
    throw new Error("Nikkei smartchart: symbolInfo が無い");
  }
  const symbolInfo = (state as { symbolInfo: Record<string, unknown> })
    .symbolInfo;
  const response = symbolInfo.RESPONSE;
  if (typeof response !== "object" || response === null) {
    throw new Error("Nikkei smartchart: symbolInfo.RESPONSE が無い");
  }
  const ohlc = (response as Record<string, unknown>).ohlc;
  if (typeof ohlc !== "object" || ohlc === null) {
    throw new Error("Nikkei smartchart: ohlc が無い");
  }
  const o = ohlc as Record<string, unknown>;

  const dpp = parseNumericField(o.DPP, "DPP");
  const prp = parseNumericField(o.PRP, "PRP");
  const dywp = parseNumericField(o.DYWP, "DYWP");
  const dyrp = parseNumericField(o.DYRP, "DYRP");

  const diff = Math.abs(dpp - prp - dywp);
  if (diff > 0.05) {
    throw new Error(
      `Nikkei smartchart: DPP(${dpp}) - PRP(${prp}) と DYWP(${dywp}) が一致しません (diff=${diff.toFixed(3)})`
    );
  }

  // ZXD (データ日付) の欠損・不正を実行日での黙殺補完はしない (ルール2)。
  // 前日終値 PRP の日付も原文に無いので推測しない。どちらも欠ければ
  // 呼び出し側が HOLD する (確定日照合の材料に自明な日付を入れない)。
  if (typeof o.ZXD !== "string" || !isCalendarDateString(o.ZXD)) {
    throw new Error(
      "Nikkei smartchart: ZXD (データ日付) が暦上有効な YYYY-MM-DD ではありません (欠損・不正のため STOP)"
    );
  }
  const date = o.ZXD;
  // DPP:T (現在値タイムスタンプ) は explicit TZ 付き ISO8601 が必須で、
  // 日付が ZXD と一致すること。欠損・不正・日付不一致は STOP
  // (呼び出し側 HOLD)。異なる日の古い tick と当日の ZXD を混ぜない。
  // Date.parse だけでは Feb30 繰り上げ・TZ 無しを通すため別途検証する。
  const dppT = o["DPP:T"];
  if (typeof dppT !== "string" || !isTimestampWithZone(dppT)) {
    throw new Error(
      "Nikkei smartchart: DPP:T (現在値タイムスタンプ) が TZ 付き ISO8601 ではありません (STOP)"
    );
  }
  if (!isCalendarDateString(dppT.slice(0, 10))) {
    throw new Error(
      "Nikkei smartchart: DPP:T の日付が暦上有効ではありません (STOP)"
    );
  }
  if (dppT.slice(0, 10) !== date) {
    throw new Error(
      `Nikkei smartchart: DPP:T の日付 ${dppT.slice(0, 10)} と ZXD ${date} が一致しません (STOP)`
    );
  }
  const latestTimestamp = dppT;

  return {
    price: dpp,
    previousClose: prp,
    change: dywp,
    changePct: dyrp,
    date,
    latestTimestamp,
  };
}

/** 暦上有効な YYYY-MM-DD (Feb30・13月などの繰り上げ元を拒否)。 */
function isCalendarDateString(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  return d <= dim;
}

/** explicit Z/signed-offset 付き ISO8601 (TZ 無しを拒否)。 */
function isTimestampWithZone(value: string): boolean {
  if (
    !/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?(\.\d+)?(Z|[+-]([01]\d|2[0-3]):?[0-5]\d)$/.test(
      value
    )
  ) {
    return false;
  }
  return !Number.isNaN(Date.parse(value));
}

function parseNumericField(value: unknown, name: string): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.length > 0) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  throw new Error(
    `Nikkei smartchart: ${name} が数値ではない (${JSON.stringify(value)})`
  );
}
