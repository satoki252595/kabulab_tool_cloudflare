/**
 * `core_stocks.instrument_type` の語彙と、JPX data_j の 1 行からの分類 — **契約の正本**。
 *
 * `instrument_type` は JPX「東証上場銘柄一覧 (data_j.xlsx)」の「市場・商品区分」から
 * 導く **personal-only** の列 (src/shared/db/core-stocks-license-boundary.test.ts)。
 * 値を書くのは src/cron/universe.ts だけで、公開面には出さない。
 *
 * ## 語彙は data_j の区分の粒度より細かくしない
 *
 * 設計書 (stockStock `docs/CF-CANONICAL-DESIGN.md` A-1) は当初
 * `equity/etf/etn/reit/pro/foreign/preferred` の 7 語を置いていたが、同じ設計書の
 * P4a 節が書くとおり data_j の区分からは 1:1 に導けない:
 *
 * - `ETF・ETN` は **1 つの区分**で、ETF と ETN を分ける列が data_j に無い
 * - `REIT・ベンチャーファンド・カントリーファンド・インフラファンド` も 1 区分
 * - `出資証券` は 7 語のどれにも当たらない
 *
 * 銘柄名の「ＥＴＦ」「ＥＴＮ」「投資法人」などの文字列から推し量ることはしない
 * (mono-repo ルール2: 推定で値を埋めない)。名前は発行体が付けるもので区分では
 * なく、外れたときに誰も気づけない。**区分 1 つに語 1 つ**を当て、分けたくなったら
 * 分けられる一次データを持ってきてから語彙を割る。
 *
 * ## `equity` の述語は `isListedEquity` と同一でなければならない
 *
 * 母集団ガード (c)(d2) は分母を `is_active = 1 AND instrument_type = 'equity'` で
 * 数え、(c) の分子は `isListedEquity` を通った件数である。充填の述語がこれと
 * ずれると分母と分子が別の集合になる。例: PRO Market の内国株を `equity` に
 * 入れると分母が構造的に分子より大きくなり、(c) が恒久的に 98% を割る。
 * だから `equity` は `isListedEquity(row)` をそのまま呼んで決め、区分の表からは
 * 引かない。
 *
 * 文字列 `"equity"` は stockStock の
 * `src/jp_stock_pipeline/cloud_store/universe_guards.py` の `INSTRUMENT_TYPE_EQUITY`
 * と一致させる (instrument-type.test.ts で固定)。
 *
 * ## 分類できない行は `null` (未分類) にする
 *
 * - 「内国株式」かつ プライム|スタンダード|グロース だが 4 文字コード契約に合わない行
 *   (5 文字の種類株。例: 伊藤園第１種優先株式 25935)。区分は普通株と同じで、
 *   data_j の列からは優先株か他の種類株かを言えない。共有コード契約の外なので
 *   `core_stocks` の active にも居ない (universe.ts が対象外化する)
 * - 表に無い区分文字列。JPX が区分名を変えた / 区分を足したときにここへ落ちる。
 *   近い語へ寄せる (部分一致で拾う) と、変わったことに気づけないまま誤分類する。
 *   未分類の件数は UniverseSyncResult.unclassifiedCategories に区分ごとに出す
 *
 * ## 採らなかった案
 *
 * - **非 equity を `other` 1 語にまとめる**: 第 2 段 (非 equity 行 +725 の追加) で
 *   公開サービスごとに「ETF は出す / PRO Market は出さない」を選ぶ必要があり、
 *   そのとき区分を読み直すことになる。区分の粒度で持っておけばコストは同じ
 * - **区分の日本語をそのまま値にする**: 値の意味は変わらないが、`WHERE` や
 *   契約ファイルに全角括弧を含む長い文字列を書かせることになり、JPX の表記
 *   変更がそのまま値の変更 (= 過去行との不一致) になる
 */
import { isListedEquity, type JpxRow } from "./sectors.js";

/** `core_stocks.instrument_type` に書いてよい値の全集合。 */
export const INSTRUMENT_TYPES = {
  /** 内国普通株。`isListedEquity` と同一の述語 (上の docstring)。 */
  equity: "equity",
  /** data_j「プライム（外国株式）」「スタンダード（外国株式）」「グロース（外国株式）」 */
  foreign: "foreign",
  /** data_j「PRO Market」。内国/外国を区分で分けていない */
  proMarket: "pro_market",
  /** data_j「ETF・ETN」。ETF と ETN は区分では分けられない */
  etfEtn: "etf_etn",
  /** data_j「REIT・ベンチャーファンド・カントリーファンド・インフラファンド」 */
  reitFund: "reit_fund",
  /** data_j「出資証券」 */
  investmentCertificate: "investment_certificate",
} as const;

export type InstrumentType = (typeof INSTRUMENT_TYPES)[keyof typeof INSTRUMENT_TYPES];

/**
 * 母集団ガード (c)(d2) の分母を数えるときの値。stockStock
 * `universe_guards.INSTRUMENT_TYPE_EQUITY` と同じ文字列。
 */
export const INSTRUMENT_TYPE_EQUITY = INSTRUMENT_TYPES.equity;

/**
 * 非 equity の区分文字列 → 語。**完全一致**で引く (部分一致にしない理由は docstring)。
 *
 * 区分文字列は data_j の「市場・商品区分」列の値で、sectors.ts が前後の空白だけを
 * trim して `JpxRow.marketCategory` に入れたもの。括弧は全角。出典はリポジトリ内の
 * 既存コード (scripts/vwap/build_stocks.py の `SEG_SHORT`、sectors.ts の
 * isListedEquity の docstring、sectors*.test.ts の実在行) と stockStock 設計書 P4a 節。
 */
const NON_EQUITY_CATEGORIES: ReadonlyMap<string, InstrumentType> = new Map([
  ["プライム（外国株式）", INSTRUMENT_TYPES.foreign],
  ["スタンダード（外国株式）", INSTRUMENT_TYPES.foreign],
  ["グロース（外国株式）", INSTRUMENT_TYPES.foreign],
  ["PRO Market", INSTRUMENT_TYPES.proMarket],
  ["ETF・ETN", INSTRUMENT_TYPES.etfEtn],
  ["REIT・ベンチャーファンド・カントリーファンド・インフラファンド", INSTRUMENT_TYPES.reitFund],
  ["出資証券", INSTRUMENT_TYPES.investmentCertificate],
]);

/** テストが表の中身を検査するための読み取り専用ビュー。 */
export const NON_EQUITY_CATEGORY_TABLE: ReadonlyMap<string, InstrumentType> =
  NON_EQUITY_CATEGORIES;

/**
 * data_j の 1 行を `instrument_type` の語へ分類する。分類できなければ `null`。
 *
 * `null` は「未分類」であって「equity ではない」の意味ではない。呼び出し側は
 * `null` を別の語で埋めないこと。
 */
export function classifyInstrumentType(
  row: Pick<JpxRow, "code" | "marketCategory">
): InstrumentType | null {
  if (isListedEquity(row)) return INSTRUMENT_TYPES.equity;
  return NON_EQUITY_CATEGORIES.get(row.marketCategory) ?? null;
}
