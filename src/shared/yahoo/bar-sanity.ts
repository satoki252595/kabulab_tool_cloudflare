/**
 * 日足バーの帯域チェック（取り込み時のサニティ）。
 *
 * Yahoo の Chart API は、ごくまれに桁の壊れたバーを返す。実害が出た例:
 *
 *   1909 日本ドライケミカル 2026-09-11
 *     close = 16,278,046,720 / volume = 0（前日終値 3,700）
 *   → pct_change_1d が 439,947,108.65% になり業種平均を汚染し、
 *     003 のトップページに「機械 +2,105,009.25%」が表示された
 *
 * 値が桁外れであること自体は「正しい急変」と区別できないが、
 * **出来高 0 で価格だけが数百万倍**という組み合わせは市場では起こらない。
 * 推定で直さず、**その1本を採用しない**（§3-1: 欠測は欠測のまま）。
 * 前後のバーは通すので、指標は 1 本欠けた状態で計算される。
 */

// 型を再定義しない。同じ概念を 2 箇所で持つと必ず食い違う。
import type { DailyOhlcv } from "../types.js";

export type Bar = DailyOhlcv;

/** 前日比の許容上限（倍）。ストップ高の連続でもこれは超えない。 */
export const MAX_DAILY_RATIO = 10;

/**
 * 棄却の理由。呼び出し側がログ・記録に使う。
 *
 * **「終値が高安のレンジ外」は棄却理由に入れない。** 本番 336,170 本を調べると
 * 18 本が該当したが、最大乖離率は 1.695%（例: 7112 の high 700 / low 698 /
 * close 697）で、Yahoo 側の丸めや取引時間の差によるもの。指標計算に実害は無く、
 * 弾くと正当なバーを 18 本失う。桁が壊れた本物の事故は `jump_without_volume`
 * が捕まえる（本番で該当したのは 1909 の 1 本だけ）。
 */
export type RejectReason =
  | "non_positive_close"
  | "high_low_inverted"
  | "jump_without_volume";

export type BarCheck = { ok: true } | { ok: false; reason: RejectReason };

/** 1 本のバーが単体で整合しているか。 */
export function checkBarSelf(bar: Bar): BarCheck {
  if (bar.close !== null && bar.close <= 0) {
    return { ok: false, reason: "non_positive_close" };
  }
  // 高安の逆転は構造的にあり得ない（本番実測 0 件）。
  if (bar.high !== null && bar.low !== null && bar.high < bar.low) {
    return { ok: false, reason: "high_low_inverted" };
  }
  return { ok: true };
}

/**
 * 直前のバーと比べて採用してよいか。
 *
 * 弾くのは「**出来高が無いのに価格が桁外れに動いた**」場合だけにする。
 * 出来高を伴う急変（ストップ高連続・TOB・株式分割の調整漏れ）は
 * 本物かもしれないので通す。誤って弾くほうが害が大きい。
 */
export function checkBarAgainstPrevious(bar: Bar, previous: Bar | null): BarCheck {
  const self = checkBarSelf(bar);
  if (!self.ok) return self;
  if (previous === null) return { ok: true };
  const prev = previous.close;
  const cur = bar.close;
  if (prev === null || cur === null || prev <= 0) return { ok: true };
  const ratio = cur / prev;
  const jumped = ratio > MAX_DAILY_RATIO || ratio < 1 / MAX_DAILY_RATIO;
  const noVolume = bar.volume === null || bar.volume === 0;
  if (jumped && noVolume) return { ok: false, reason: "jump_without_volume" };
  return { ok: true };
}

export type SanitizeResult = {
  bars: Bar[];
  rejected: { date: string; reason: RejectReason }[];
};

/**
 * 同一応答の最新有効終値と meta 価格の整合検査の入力。
 *
 * fetchChart は sanitize 後の `adj ?? close`、fetchDaily は整形後の `c` を
 * 最新有効終値に使う (どちらも下流が実際に使う値)。
 */
export interface ResponseCoherenceInput {
  symbol: string;
  /** 最新の有効な使用終値。欠落 (null/undefined) は判定不能 (日次 gate に委ねる)。 */
  latestUsedClose: number | null | undefined;
  /** そのバーの出来高。null/0 と価格乖離の組合せが事故の形。 */
  latestVolume: number | null;
  /** 同一応答の meta.regularMarketPrice。欠落 (null/undefined) は判定不能。 */
  metaPrice: number | null | undefined;
}

/**
 * 応答レベルの価格整合を検査する (F-01 1909 再発防止)。
 *
 * sanitizeBars は「直前に採用したバー」との前日比しか見ないため、先頭から
 * 持続する異常水準は素通りする (1909: 40 本が全て 1.6e10・出来高 0 で採用)。
 * 同一応答内の最新有効終値が meta 価格と 10 倍超乖離し、かつ出来高がない
 * 場合に限り応答全体を拒否する。以下は拒否しない:
 *
 * - 出来高 0 でも乖離なし (薄商いの正当な 0。本番 479 行)
 * - 出来高を伴う乖離 (正規分割・TOB・急騰)
 * - 全履歴と meta の比較 (長期高騰を誤って弾くため最新 1 本のみ見る)
 * - 巨大 split イベント単独 (フロントは splits 未使用。F-09)
 *
 * 各側の実在 invalid (非正・非有限) は、逆側の欠落有無に関わらず先に
 * 独立検査して信頼境界で拒否する。片側 missing の早期 return より先に
 * 検査し、壊れた実値を欠落と混ぜて通さない (F-01 再発防止の穴)。
 * 両側とも有効な実数でなければ、片側欠落は比較不能として通す。
 * 欠損の扱いは日次 gate に委ねる。
 */
export function assertResponsePriceCoherent(
  input: ResponseCoherenceInput
): void {
  const { symbol, latestUsedClose, latestVolume, metaPrice } = input;
  if (
    latestUsedClose !== null &&
    latestUsedClose !== undefined &&
    (!Number.isFinite(latestUsedClose) || latestUsedClose <= 0)
  ) {
    throw new Error(
      `${symbol}: 最新有効終値が無効 (${String(latestUsedClose)}) のため` +
        `応答全体を採用しません。`
    );
  }
  if (
    metaPrice !== null &&
    metaPrice !== undefined &&
    (!Number.isFinite(metaPrice) || metaPrice <= 0)
  ) {
    throw new Error(
      `${symbol}: meta 価格が無効 (${String(metaPrice)}) のため` +
        `応答全体を採用しません。`
    );
  }
  if (
    latestUsedClose === null ||
    latestUsedClose === undefined ||
    metaPrice === null ||
    metaPrice === undefined
  ) {
    return;
  }
  const ratio = latestUsedClose / metaPrice;
  const diverged =
    ratio > MAX_DAILY_RATIO || ratio < 1 / MAX_DAILY_RATIO;
  if (!diverged) return;
  if (latestVolume !== null && latestVolume !== 0) return;
  throw new Error(
    `${symbol}: 最新終値 ${latestUsedClose} が meta 価格 ${metaPrice} と` +
      `10倍超乖離し出来高がありません。応答全体を採用しません。`
  );
}

export type FreshCloseReason = "stale_date" | "missing_fresh_close";

export type FreshCloseCheck =
  | { ok: true }
  | { ok: false; reason: FreshCloseReason };

/**
 * 日次 writer 前提: 対象日の実終値があること。
 *
 * 日付だけの gate では、対象日の fresh null bar が「一致」で通過し、古い
 * 終値で計算した指標を対象日付で保存してしまう (1909 の 9/28 null bar が
 * expectedDate と一致して通過した形)。使用値 (`adj ?? close`) が正の有限値
 * でない対象日は未取得扱いにし、値の補完はしない (ルール2)。
 */
export function checkFreshClose(
  latest: Bar | undefined,
  expectedDate: string
): FreshCloseCheck {
  if (latest === undefined || latest.date !== expectedDate) {
    return { ok: false, reason: "stale_date" };
  }
  const used = latest.adj ?? latest.close;
  if (used === null || !Number.isFinite(used) || used <= 0) {
    return { ok: false, reason: "missing_fresh_close" };
  }
  return { ok: true };
}

/**
 * 日付昇順のバー列から、採用できないバーを取り除く。
 *
 * 比較の基準は「直前に**採用した**バー」。壊れたバーを基準にすると
 * 次の正常なバーまで巻き込んで弾いてしまう。
 */
export function sanitizeBars(bars: readonly Bar[]): SanitizeResult {
  const out: Bar[] = [];
  const rejected: { date: string; reason: RejectReason }[] = [];
  let lastAccepted: Bar | null = null;
  for (const bar of bars) {
    const check = checkBarAgainstPrevious(bar, lastAccepted);
    if (check.ok) {
      out.push(bar);
      if (bar.close !== null) lastAccepted = bar;
    } else {
      rejected.push({ date: bar.date, reason: check.reason });
    }
  }
  return { bars: out, rejected };
}
