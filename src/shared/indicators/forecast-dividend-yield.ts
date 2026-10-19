/**
 * 予想配当利回り (`core_stock_financials.dividend_yield`, % 値) の判定。
 *
 * 値 = 会社予想の年間1株配当 (TDnet 決算短信 XBRL の `dps_forecast`) ÷ 株価 × 100。
 *
 * Yahoo `summaryDetail.dividendYield` は使わない。2026-10-16 の本番断面で
 * 会社予想 ÷ 株価と突合すると 2,302 銘柄中 82 銘柄が 2 倍以上ずれ、
 * ちょうど 2 倍・4 倍の過大値 (例: 年間予想 178 円・株価 13,450 円 = 1.32% の
 * 銘柄が 5.4%) が並んでいた。供給元の値を検算する手段が無いため採らない。
 *
 * 会社予想の株数基準・鮮度を確定できない時は値を作らず null にする
 * (CLAUDE.md ルール1・2)。null は「無配」ではなく「未確定」。無配は 0。
 */

/** 予想を出した決算短信より後に出ると、その予想を無効にしうる開示 */
export type DividendForecastEventKind = "tanshin" | "dividend" | "share-split";

export interface DividendForecastRow {
  /** 年間1株配当の会社予想 (円)。null = 短信に予想なし (未定) または採れなかった */
  dpsForecast: number | null;
  /** 短信の開示時刻 (unix 秒) */
  disclosedAt: number;
}

export interface DividendForecastEvent {
  kind: DividendForecastEventKind;
  /** 開示時刻 (unix 秒) */
  pubdate: number;
}

export type DividendForecastBasis =
  | { kind: "forecast"; dps: number; disclosedAt: number }
  | { kind: "unverified"; reason: DividendYieldUnverifiedReason };

export type DividendYieldUnverifiedReason =
  /** TDnet 短信の財務サマリが 1 件も無い */
  | "no-forecast-row"
  /** 短信行に開示時刻が無く、最新の予想を決められない */
  | "disclosed-at-missing"
  /** 最新短信に年間配当予想が無い (未定 / 採取不能) */
  | "forecast-undisclosed"
  /** 同一短信の行 (連結/単体) で予想が食い違う */
  | "forecast-conflict"
  /** 予想より後に短信・配当・分割/併合の開示がある (未取込の新しい予想がありうる) */
  | "superseded"
  /** 予想の前後に株式分割/併合の開示があり、予想の株数基準を確定できない */
  | "share-split-basis"
  /** 最新短信が古すぎる (四半期短信の取り込み漏れ) */
  | "stale"
  /** 株価が無い・正でない */
  | "price-missing";

/** 新しい短信が出ているはずの経過日数。四半期短信の間隔 (最長 ~100 日) + 余裕 */
export const FORECAST_MAX_AGE_DAYS = 130;
/**
 * 短信より前の分割/併合開示を疑う日数。発表から効力発生までは通常 1〜6 か月で、
 * その間の短信は分割前・後どちらの株数で予想を書いたか XBRL から判別できない。
 */
export const SPLIT_LOOKBACK_DAYS = 200;

const DAY_SEC = 86_400;

/**
 * 判定に要る開示を読む窓 (基準時刻から遡る日数)。stale でない予想 (≤130 日) の
 * 分割遡り (200 日) までを覆う。これより古い予想は stale で、理由だけが変わりうる。
 */
export const EVENT_WINDOW_DAYS = FORECAST_MAX_AGE_DAYS + SPLIT_LOOKBACK_DAYS;

/** `classifyDividendForecastEvent` が拾う表題語 (SQL の LIKE 絞り込みにも使う) */
export const DIVIDEND_FORECAST_EVENT_KEYWORDS = ["株式分割", "株式併合", "配当", "決算短信"] as const;

/** 予想配当の基準時刻 = 対象営業日の終わり (JST 23:59:59) の unix 秒 */
export function dividendForecastAsOfSec(date: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`予想配当の基準日が不正です: ${date}`);
  const ms = Date.parse(`${date}T23:59:59+09:00`);
  if (!Number.isFinite(ms)) throw new Error(`予想配当の基準日が不正です: ${date}`);
  return ms / 1000;
}

/** ir_disclosures.title から判定に使う開示種別を引く。該当しなければ null */
export function classifyDividendForecastEvent(title: string): DividendForecastEventKind | null {
  if (title.includes("株式分割") || title.includes("株式併合")) return "share-split";
  if (title.includes("配当")) return "dividend";
  if (title.includes("決算短信")) return "tanshin";
  return null;
}

/**
 * 銘柄 1 つ分の最新短信行 (同一 disclosedAt の全行) と開示イベントから基準を決める。
 *
 * @param latestRows 最新の短信 (disclosedAt 最大) の行。空 = 短信なし
 * @param events     asOf 以前の判定対象開示 (`classifyDividendForecastEvent` 済み)
 * @param asOfSec    判定基準時刻 (unix 秒)。これより後の行・開示は渡さないこと
 */
export function judgeDividendForecast(
  latestRows: readonly DividendForecastRow[],
  events: readonly DividendForecastEvent[],
  asOfSec: number,
): DividendForecastBasis {
  if (latestRows.length === 0) return { kind: "unverified", reason: "no-forecast-row" };
  const disclosedAt = latestRows[0].disclosedAt;
  if (latestRows.some((r) => r.disclosedAt !== disclosedAt)) {
    throw new Error("予想配当の判定には同一短信 (同じ disclosedAt) の行だけを渡してください");
  }
  if (disclosedAt > asOfSec || events.some((e) => e.pubdate > asOfSec)) {
    throw new Error("予想配当の判定に基準時刻より後の開示が混入しています");
  }
  const values = new Set(latestRows.map((r) => r.dpsForecast));
  if (values.size > 1) return { kind: "unverified", reason: "forecast-conflict" };
  const [dps] = values;
  if (dps === null || dps === undefined) return { kind: "unverified", reason: "forecast-undisclosed" };
  if (!Number.isFinite(dps) || dps < 0) throw new Error(`予想配当が不正です: ${dps}`);
  if (events.some((e) => e.kind === "share-split" && e.pubdate > disclosedAt - SPLIT_LOOKBACK_DAYS * DAY_SEC)) {
    return { kind: "unverified", reason: "share-split-basis" };
  }
  if (events.some((e) => e.pubdate > disclosedAt)) return { kind: "unverified", reason: "superseded" };
  if (asOfSec - disclosedAt > FORECAST_MAX_AGE_DAYS * DAY_SEC) return { kind: "unverified", reason: "stale" };
  return { kind: "forecast", dps, disclosedAt };
}

/** 予想配当利回り (% 値、小数 2 桁)。未確定は null と理由 */
export function forecastDividendYield(
  basis: DividendForecastBasis,
  price: number | null,
): { value: number; reason: null } | { value: null; reason: DividendYieldUnverifiedReason } {
  if (basis.kind === "unverified") return { value: null, reason: basis.reason };
  if (price === null || !Number.isFinite(price) || price <= 0) return { value: null, reason: "price-missing" };
  return { value: Math.round((basis.dps / price) * 100 * 100) / 100, reason: null };
}
