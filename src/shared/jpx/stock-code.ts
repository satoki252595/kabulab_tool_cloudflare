/**
 * 日本株 証券コード (ティッカー) の正準定義・正規化ヘルパ。
 *
 * ## なぜ共有化するか
 * 各サービスが個別に `/^\d{4}$/` (4 桁数字限定) を持っていたため、JPX が
 * 2024 年に開始した「英数字コード」の銘柄が検索・詳細表示・取込で弾かれる
 * 不具合が複数サービスに散在していた。正準パターンと正規化を 1 箇所へ集約し、
 * 仕様変更 (例: 将来 2 桁目も英字化) があってもこのファイルの修正だけで
 * 全サービスへ波及するようにする。
 *
 * ## JPX 英数字コードの背景 (証券コード協議会)
 * 4 桁数字コードの在庫枯渇に伴い、2024 年 1 月から英文字を含む証券コードの
 * 付番が始まった。コードは引き続き **4 文字**。現行付番分は
 * 「**数字 3 桁 + 末尾 1 文字 (数字 or 英大文字)**」の形式で、
 * 末尾の英字から順に消費される (130A → 131A → … → 139A → 140A …)。
 *   - 例: `130A` (ヴェリタス・イン・シリコ), `141A` (トライアル HD)
 * 旧来の純 4 桁数字 (例: `7011` 三菱重工業) もそのまま有効。
 *
 * 仕様上は 2 桁目も将来英字化されうる。その段階に達したら
 * {@link STOCK_CODE_REGEX} と {@link STOCK_CODE_HTML_PATTERN} の 1 箇所を
 * 更新すれば全サービスへ反映される。
 *
 * このモジュールは zod 非依存 (views / data-scripts / scraper からも使える)。
 * zod スキーマが必要な場合は `stock-code-schema.ts` を使う。
 */

/**
 * 証券コードの正準パターン: 数字 3 桁 + (数字 or 英大文字) 1 桁。
 * 純 4 桁数字 (例: 7011) と英数字コード (例: 130A) の両方に一致する。
 */
export const STOCK_CODE_REGEX = /^\d{3}[0-9A-Z]$/;

/**
 * HTML `<input pattern="...">` 属性に渡す文字列 (前後の `^`/`$` は付けない)。
 * フォーム値は小文字で打たれても受理し (サーバ側で大文字化正規化する)、
 * 表示は `text-transform:uppercase` で大文字に揃える運用とする。
 */
export const STOCK_CODE_HTML_PATTERN = "[0-9]{3}[0-9A-Za-z]";

/** バリデーション失敗時にユーザへ出す共通メッセージ。 */
export const STOCK_CODE_ERROR =
  "証券コードは4桁で指定してください。数字4桁 (例: 7011)、または新規上場銘柄の英字入りコード (例: 130A) に対応しています。";

/**
 * 証券コードの表記揺れを吸収する正規化。
 *
 * これは「フォールバック」ではなく「同じ意味の値の表現揺れを揃える」処理
 * (mono-repo ルール2 の明示的な例外)。値の意味は変えず、表現だけ揃える:
 *   - 前後の空白を除去
 *   - 全角英数字 (`１３０Ａ`) を半角化 — モバイル日本語 IME 対策
 *   - 英字を大文字化 — JPX 付番は英大文字。利用者が `130a` と打っても拾う
 *
 * 妥当性 (4 文字・形式) は判定しない。判定は {@link isValidStockCode} /
 * {@link parseStockCode} / zod スキーマで行う。
 */
export function normalizeStockCode(raw: string): string {
  return raw
    .trim()
    .replace(/[０-９Ａ-Ｚａ-ｚ]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
    )
    .toUpperCase();
}

/** 正規化後に正準パターンへ一致するか。 */
export function isValidStockCode(code: string): boolean {
  return STOCK_CODE_REGEX.test(normalizeStockCode(code));
}

/**
 * 正規化して妥当なら正準形 (大文字・半角・trim 済み) を返し、
 * 妥当でなければ `null` を返す。
 *
 * 欠損・不正を `null` で表現し、呼び出し側に判断を委ねる (ルール2)。
 * `??` 等で別の値に黙って差し替えてはならない。
 */
export function parseStockCode(raw: string): string | null {
  const code = normalizeStockCode(raw);
  return STOCK_CODE_REGEX.test(code) ? code : null;
}
