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
 *   - company_code は 5 桁 (4 桁ティッカー + 1 桁; 例 "72030" → 7203)。
 *   - url_xbrl は提供されない開示で null になり得る。
 */

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
 * TDnet の 5 桁コードを 4 桁ティッカーへ変換する。
 *
 * 証券コードは 5 桁 (4 桁基底 + 末尾 1 桁)。2024 年以降は英数字混在の
 * 新コード (例 "135A0" → "135A") もある。先頭 4 桁を取る (英数字許容)。
 * 想定外フォーマットは推測で補正せず null を返し、呼び出し側で
 * core.stocks 突合により「ユニバース外」として正直に切り捨てる (ルール2)。
 */
export function companyCodeToTicker(
  code: string | null | undefined
): string | null {
  if (!code) return null;
  const trimmed = code.trim().toUpperCase();
  if (!/^[0-9A-Z]{4,5}$/.test(trimmed)) return null;
  return trimmed.slice(0, 4);
}
