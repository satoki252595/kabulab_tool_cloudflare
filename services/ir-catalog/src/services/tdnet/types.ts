/**
 * yanoshin TDnet WebAPI のレスポンス型と正規化・銘柄コード変換。
 *
 * エンドポイント:
 *   GET https://webapi.yanoshin.jp/webapi/tdnet/list/{YYYYMMDD}.json?limit=N
 *
 * 実 API で確認した事実 (2026-05 時点):
 *   - `?page=N` は無視される (ページング不可)。1 日単位で取得する。
 *   - 各 item は通常 `{ "Tdnet": {...} }` だが、limit 値によってはラッパ
 *     無しの素フィールドで返ることがある (同一データの符号化揺れ)。
 *   - company_code は 5 文字 (4 文字ティッカー + 検査文字 1 文字; 例 "72030" → 7203)。
 *     本番 ir_disclosures 37,641 行は全件この形で、末尾は全件 "0" (実測)。
 *   - url_xbrl は提供されない開示で null になり得る。
 */

import { sourceCodeToTicker } from "../../../../../src/shared/jpx/stock-code.js";

/** TDnet 開示 1 件の正規化後フィールド */
export interface TdnetItemRaw {
  id: string;
  pubdate: string;
  company_code: string;
  company_name: string;
  title: string;
  document_url: string;
  url_xbrl: string | null;
  /** ETF/投信/上場廃止通知等で欠けることがある (捏造せず null 保持) */
  markets_string: string | null;
  update_history: string | null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/**
 * API の 1 要素を `TdnetItemRaw` に正規化する。
 *
 * `{Tdnet:{...}}` ラッパ有無の **符号化揺れだけ** を吸収する (ルール2 の
 * 「同じ意味の値の表現揺れを揃える」正規化例外)。
 *
 * 開示を一意に識別する本質フィールド (id/pubdate/company_code/
 * company_name/title/document_url) のいずれかが欠ける要素は **異常入力**
 * なので `null` を返す。呼び出し側 (client) は件数とサンプルを **明示的に
 * ログ計上して除外** する (黙って既定値で埋めない & 黙って捨てない —
 * ルール2: 異常を運用者に可視化したうえで正直に除外する)。1 件の異常で
 * その日/月のバッチ全体を落とさない。
 *
 * `markets_string` は ETF/投信/上場廃止通知等で欠けることがある。これらは
 * 個別株ユニバース外で後段除外されるが、欠損は捏造せず `null` のまま保持
 * する (DB 列も nullable・UI は「—」)。
 */
export function normalizeTdnetItem(
  raw: unknown,
  ctx: string
): TdnetItemRaw | null {
  if (raw === null || typeof raw !== "object") {
    console.warn(`[tdnet] item が object でない — 除外 (${ctx})`);
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const t = (
    "Tdnet" in obj && obj.Tdnet && typeof obj.Tdnet === "object"
      ? obj.Tdnet
      : obj
  ) as Record<string, unknown>;

  const id = str(t.id);
  const pubdate = str(t.pubdate);
  const company_code = str(t.company_code);
  const company_name = str(t.company_name);
  const title = str(t.title);
  const document_url = str(t.document_url);
  if (
    !id ||
    !pubdate ||
    !company_code ||
    !company_name ||
    !title ||
    !document_url
  ) {
    console.warn(
      `[tdnet] 必須フィールド欠落で除外 (${ctx}) id=${id ?? "?"}: ` +
        `${JSON.stringify(t).slice(0, 160)}`
    );
    return null;
  }
  return {
    id,
    pubdate,
    company_code,
    company_name,
    title,
    document_url,
    url_xbrl: str(t.url_xbrl),
    markets_string: str(t.markets_string),
    update_history: str(t.update_history),
  };
}

/**
 * TDnet の 5 文字コードを 4 文字ティッカーへ変換する。
 *
 * 判定と正規化は共有ヘルパ {@link sourceCodeToTicker} に委譲する。ここに独自の
 * 正規表現を持っていたため、同じ入力に対する答えが EDINET 側 (`secCodeToTicker`)
 * や Python 側の実装と割れていた:
 *   - `07203` / `25935` を先頭 4 文字で切って `0720` / `2593` を返していた
 *     (`2593` は伊藤園 普通株で、`25935` は同社の第1種優先株式 — 取り違え)
 *   - `A130` (1 桁目英字。JPX 付番体系に無い) を通していた
 *   - 全角 `７２０３` だけを弾いていた (EDINET 側は半角化して受理していた)
 *
 * 想定外フォーマットは推測で補正せず null を返し、呼び出し側で core_stocks
 * 突合により「ユニバース外」として正直に切り捨てる (ルール2)。
 */
export function companyCodeToTicker(
  code: string | null | undefined
): string | null {
  return sourceCodeToTicker(code);
}
