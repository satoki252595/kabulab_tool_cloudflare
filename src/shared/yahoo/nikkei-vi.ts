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

export async function fetchNikkeiVi(): Promise<NikkeiViSnapshot> {
  const res = await fetch(NIKKEI_SMARTCHART_URL, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
    },
  });

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
      `Nikkei smartchart: __INITIAL_STATE__ JSON パース失敗: ${e instanceof Error ? e.message : e}`
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

  const date =
    typeof o.ZXD === "string" ? o.ZXD : new Date().toISOString().split("T")[0];
  const latestTimestamp = typeof o["DPP:T"] === "string" ? o["DPP:T"] : null;

  return {
    price: dpp,
    previousClose: prp,
    change: dywp,
    changePct: dyrp,
    date,
    latestTimestamp,
  };
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
