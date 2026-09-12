/**
 * 公開面 (無認証の HTML / JSON) が `core_stocks` から読む**市場区分と業種**の
 * 単一の出口。
 *
 * ## なぜ要るのか
 *
 * `core_stocks` は 1 行の中に出所の違う列を混ぜている。EDINET コードリスト由来
 * (`code` / `name` / `edinet_code` / `sector33`) は commercial-ok で、JPX
 * 東証上場銘柄一覧 (data_j.xls) 由来 (`market` / `sector` / `sector17` /
 * `instrument_type`) は personal-only。行の `license_tag` 1 列では表現できない。
 *
 * 2026-09-13 時点の**実測**では、無認証の公開面が personal-only を返していた:
 *
 *   GET /otakara-yutai/stocks/7203  → 200 / 39,582 B に
 *                                     `<p>プライム（内国株式） / 輸送用機器</p>`
 *   GET /swing-trading/screening    → 200 / 76,566 B に 33 業種名
 *                                     (情報・通信業 ×15 / 電気機器 ×4)
 *
 * 宣言 (stockStock の `jss_column_license`) は `market` / `sector33` /
 * `sector17` / `instrument_type` を personal-only としており、**宣言と実装が
 * 食い違っている**。食い違いは「どちらが正しいか」を人が毎回判断しないと
 * 読めないので、漏れよりも先に直す。
 *
 * ## 何をしているのか
 *
 * - **市場区分**: JPX の市場区分に EDINET 側の等価物が無い。代替が無いので
 *   公開面の値を SQL の `NULL` に潰す。列 (キー) は残す —— キーごと消すと
 *   クライアントが「その項目は存在しない」と解釈してしまうため
 *   (stockStock `worker/src/shared/license.ts` の `redactColumns` と同じ方針)。
 * - **業種**: `core_stocks.sector` (JPX 33 業種を src/cron/universe.ts が
 *   `sector: r.sector33` で書いている) から `core_stocks.sector33` へ切り替える。
 *   `sector33` を書いているのは stockStock の
 *   `collectors/edinet_codelist.py` だけで、そこは EDINET の「提出者業種」を
 *   `license_tag=commercial-ok` として取得している。
 * - **`sector33` が NULL のとき `sector` へフォールバックしない。** フォール
 *   バックを書くと、値が入るまでの間ずっと JPX の値が公開面に出続ける。
 *   それは今の状態そのもので、直したことにならない。
 *
 * ## 今すぐ見える影響
 *
 * 本番の `core_stocks.sector33` は**全行 NULL** (移行 P4b が未了)。よって
 * 当面、公開面の業種は空 (`—`) になる。値を入れるのは stockStock 側の別レーン。
 */
import { sql } from "drizzle-orm";
import { stocks } from "./core-schema.js";

/**
 * `true` にすると公開面が JPX 由来の市場区分と業種を**従来どおり**出す。
 *
 * ### `true` にできるのは何を判断したときか
 *
 * JPX「東証上場銘柄一覧 (data_j.xls)」の利用条件が、この Worker の公開面
 * (無認証の HTML / JSON) での再配布を許すと**法的に**判断できたとき。
 * 判断に要るのは次の 2 点で、どちらもコードからは決められない:
 *
 *   1. data_j.xls の利用条件が個人利用に限られるのか、二次配布を許すのか。
 *   2. 許されるとして、市場区分・33 業種区分という「区分の値そのもの」の
 *      掲載が引用の範囲に収まるのか。
 *
 * 1 が「許す」なら、この定数を `true` にするだけで元の表示に戻る
 * (併せて stockStock の `jss_column_license` の宣言も直すこと。宣言が
 * personal-only のままだと、また宣言と実装が食い違う)。
 *
 * 1 が「許さない」なら `false` のままで、業種は `sector33` (EDINET 由来) の
 * 充填を待つ。
 *
 * ### `true` にすると赤くなるテスト (想定どおり)
 *
 * `true` へ切り替えると次の 2 つが落ちる。どちらも「JPX 由来を公開しない」を
 * 期待値として固定しているテストなので、**判断が変わったなら期待値も変える**
 * のが正しい。通すためにガードを緩めるのではなく、期待値を書き換えて
 * その理由をコミットメッセージに残すこと:
 *
 *   - services/otakara-yutai/src/tests/stock-detail-license.test.ts
 *     (番兵値が HTML / JSON に出ないこと)
 *   - src/shared/db/core-stocks-license-boundary.test.ts
 *     (公開面が `market` / `sector` を修飾つきで読まないこと)
 *
 * 型は `true` でも通る (2026-09-13 に実測) ので、落ちるのは期待値だけ。
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

/**
 * フラグの**型**。
 *
 * TypeScript は三項演算子の条件が `false` リテラル型でも結果を**両枝の union**
 * にする (narrowing は if 文にしか効かない)。`columns` の形が union になると
 * drizzle は選択列を推論できず、返り値の型から列が丸ごと消える
 * (実際に `columns: { id, name, ...spread }` が `id` と `name` だけの型になり
 * TS2559 で落ちた)。条件**型**なら単一の形に解決するので、下の cast で
 * 形を 1 つに固定する。`PUBLISH_JPX_DERIVED_COLUMNS` から導出しているので
 * 書き換える場所は定数 1 箇所のまま。
 */
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
 * 「市場区分 / 業種」の表示行を組む。
 *
 * `publicMarketColumn` が `NULL` を返すようになったので、view 側の
 * `${h(row.market)} / ${h(row.sector)}` はそのままだと `null / null` や
 * ` / ` という行を出す。**項目が無いときは項目ごと落とす**のが読者にとって
 * 正しい (「市場区分が null という銘柄」ではなく「この面では出さない」)。
 *
 * 全部 null のときだけ `—` を返す。空文字にすると要素が潰れて、
 * 「表示が壊れた」のか「値が無い」のかが見た目で区別できない。
 *
 * 戻り値は**エスケープしていない生の文字列**。呼び出し側で `h()` を通すこと
 * (区切り文字は `/` と ` ` だけなのでエスケープ後も見た目は変わらない)。
 */
export function publicStockMetaLabel(
  parts: ReadonlyArray<string | null | undefined>,
  separator = " / ",
): string {
  const shown = parts.filter((p): p is string => typeof p === "string" && p.trim() !== "");
  return shown.length === 0 ? "—" : shown.join(separator);
}
