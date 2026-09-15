/**
 * 公開面 (無認証の HTML / JSON) が `core_stocks` から読む市場区分と業種の単一の出口。
 *
 * 規則:
 * - **市場区分**: EDINET 側に等価物が無いので SQL の `NULL` に潰す (列キーは残す)。
 * - **業種**: JPX の `sector` ではなく EDINET の `sector33` を読む。
 * - **`sector33` が NULL でも `sector` へフォールバックしない。**
 * - 母集団の述語は active-equity.ts に置く (値は select しない)。
 */
import { sql } from "drizzle-orm";
import { stocks } from "./core-schema.js";

/**
 * `true` にすると公開面が JPX 由来の市場区分と業種を従来どおり出す。
 * `true` にできるのは data_j.xls の再配布が法的に許されると判断できたときだけ
 * (併せて stockStock の宣言も直すこと)。判断が変わったら下の 2 テストの
 * 期待値を書き換える (ガードを緩めない):
 * stock-detail-license.test.ts / core-stocks-license-boundary.test.ts。
 */
export const PUBLISH_JPX_DERIVED_COLUMNS = false;

/**
 * 公開面が「市場区分」として select する式。
 *
 * `false` のときは SQL の `NULL`。**`stocks.market` を select しない**ので、
 * 値は Worker のプロセスにも載らない (行を spread した 1 箇所で漏れるという
 * 事故の余地を残さない)。
 */
export const publicMarketColumn = PUBLISH_JPX_DERIVED_COLUMNS
  ? stocks.market
  : sql<string | null>`NULL`;

/**
 * 公開面が「業種」として select する式。
 *
 * `false` = `sector33` (EDINET 提出者業種 / commercial-ok)、
 * `true` = `sector` (JPX 33 業種 / personal-only)。
 * どちらも `string | null` なので、切り替えで呼び出し側の型は変わらない。
 */
export const publicSectorColumn = PUBLISH_JPX_DERIVED_COLUMNS
  ? stocks.sector
  : stocks.sector33;


/** フラグの型。三項演算子では union になって drizzle の推論が壊れるため、条件型で形を 1 つに固定する。 */
type PublishJpxDerived = typeof PUBLISH_JPX_DERIVED_COLUMNS;

/**
 * drizzle の**関係クエリ** (`db.query.stocks.findFirst/findMany`) 用の
 * `columns` 断片。`.select()` と違い関係クエリは列オブジェクトではなく
 * `{ 列名: true }` を取るので、`publicMarketColumn` / `publicSectorColumn` を
 * そのまま渡せない。
 *
 * 呼び出し側は `columns: { id: true, name: true, ...publicStockRelationalColumns }`
 * と書き、値の取り出しは `publicStockMetaFromRow` に通す。**公開面のファイルに
 * `sector33` という識別子を書かせない**ためにここへ寄せてある
 * (src/shared/db/core-stocks-license-boundary.test.ts が公開面での参照を禁じる)。
 */
export const publicStockRelationalColumns = (
  PUBLISH_JPX_DERIVED_COLUMNS
    ? ({ market: true, sector: true } as const)
    : ({ sector33: true } as const)
) as PublishJpxDerived extends true
  ? { readonly market: true; readonly sector: true }
  : { readonly sector33: true };

/**
 * 関係クエリで引いた行から、公開してよい市場区分と業種を取り出す。
 *
 * フラグで**列名が変わる** (`sector` ↔ `sector33`) ので、呼び出し側が
 * `row.sector33` と書くとフラグを `true` にした瞬間に静かに undefined になる。
 * 読み替えはここ 1 箇所に閉じる。
 */
export function publicStockMetaFromRow(row: {
  market?: string | null;
  sector?: string | null;
  sector33?: string | null;
}): { market: string | null; sector: string | null } {
  return PUBLISH_JPX_DERIVED_COLUMNS
    ? { market: row.market ?? null, sector: row.sector ?? null }
    : { market: null, sector: row.sector33 ?? null };
}

/**
 * 「市場区分 / 業種」の表示行を組む。無い項目は落とし、全部無いときだけ `—`。
 * 戻り値は未エスケープ。呼び出し側で `h()` を通すこと。
 */
export function publicStockMetaLabel(
  parts: ReadonlyArray<string | null | undefined>,
  separator = " / ",
): string {
  const shown = parts.filter((p): p is string => typeof p === "string" && p.trim() !== "");
  return shown.length === 0 ? "—" : shown.join(separator);
}

/**
 * personal-only 列 (両綴りで拾う)。`sector33` は EDINET 由来で入れない。
 * 消す前に公開面が直接読み始めていないか確かめること
 * (`public-columns.test.ts` が固定)。
 */
export const PERSONAL_ONLY_COLUMNS = [
  "market",
  "sector",
  "sector17",
  "instrumentType",
  "instrument_type",
  "licenseTag",
  "license_tag",
  "srcSource",
  "src_source",
  "quality",
] as const;
