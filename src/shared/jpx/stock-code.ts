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
 * ## 正準パターンと JPX 仕様の既知のギャップ (2026-09 時点)
 * 証券コード協議会の付番規則では英字は **2 桁目と 4 桁目のいずれか、または両方**
 * (例 `987A` / `9A76` / `9A7A`) を取りうる。使用する英字は大文字 19 文字
 * (`B` `E` `I` `O` `Q` `V` `Z` を除く)。付番は 4 桁目のみ英字のコードを
 * `130A` から使い切った後に 2 桁目のみ英字 (`1A00` から) へ移る。
 *
 * {@link STOCK_CODE_REGEX} は **4 桁目のみ**英字を許し、除外 7 文字も絞っていない。
 * どちらも意図的な現状追認である:
 *   - 本番 `core_stocks` 3,812 行のうち英字を含むのは 174 行で、**全件が 4 桁目のみ**
 *     (2 桁目英字は 0 件)。今日の実データを 1 件も落とさず 1 件も余計に通さない。
 *   - 除外 7 文字を弾く強化は実データを 1 件も減らさない一方、JPX が運用を変えた
 *     ときに正当なコードを拒否する側に倒れる。
 * JPX が `1A00` 台の付番を始めたら、このパターンと共有テストベクタ
 * (`tests/fixtures/contracts/stock-code-vectors.json` の `future-second-digit-alpha`)
 * を同時に更新する。{@link STOCK_CODE_HTML_PATTERN} も併せて直すこと。
 *
 * このモジュールは zod 非依存 (views / data-scripts / scraper からも使える)。
 * zod スキーマが必要な場合は `stock-code-schema.ts` を使う。
 *
 * ## 言語をまたぐ正
 * 同じ契約を stockStock (Python) の
 * `src/jp_stock_pipeline/contracts/stock_code.py` が持つ。期待値は共有テストベクタ
 * `tests/fixtures/contracts/stock-code-vectors.json` に置き、両リポジトリの
 * テストが同一バイト列のファイルを読む (CI の cross-repo diff ジョブで突合)。
 */

/**
 * 証券コードの正準パターン: 数字 3 桁 + (数字 or 英大文字) 1 桁。
 * 純 4 桁数字 (例: 7011) と英数字コード (例: 130A) の両方に一致する。
 */
export const STOCK_CODE_REGEX = /^[0-9]{3}[0-9A-Z]$/;

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
export function normalizeStockCode(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return "";
  return raw
    .trim()
    .replace(/[０-９Ａ-Ｚａ-ｚ]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
    )
    .toUpperCase();
}

/** 正規化後に正準パターンへ一致するか。 */
export function isValidStockCode(code: string | null | undefined): boolean {
  return STOCK_CODE_REGEX.test(normalizeStockCode(code));
}

/**
 * 正規化して妥当なら正準形 (大文字・半角・trim 済み) を返し、
 * 妥当でなければ `null` を返す。
 *
 * 欠損・不正を `null` で表現し、呼び出し側に判断を委ねる (ルール2)。
 * `??` 等で別の値に黙って差し替えてはならない。
 */
export function parseStockCode(raw: string | null | undefined): string | null {
  const code = normalizeStockCode(raw);
  return STOCK_CODE_REGEX.test(code) ? code : null;
}

/**
 * 取込ソースの 5 文字コードを 4 文字ティッカー (正準形) へ変換する。
 *
 * TDnet の `company_code` と EDINET の `secCode` は「4 文字ティッカー +
 * 検査文字 1 文字」の 5 文字で来る (例 `72030` → `7203`, `130A0` → `130A`)。
 * 4 文字でそのまま来る場合も受理する。
 *
 * ## なぜ末尾を `'0'` に限定するか (単なる先頭4文字切り出しでは駄目な理由)
 * 「5 文字なら先頭 4 文字」で切ると、**別の証券を既存銘柄に取り違える**。
 *   - `25935` (伊藤園第1種優先株式) → `2593` (伊藤園 普通株)。本番 core_stocks に
 *     両方が実在し、優先株の開示を普通株へ付け替えてしまう。
 *   - `07203` → `0720`。本番に先頭 0 のコードは 1 件も無く、実在しない銘柄を捏造する。
 * 本番 `ir_disclosures` 37,641 行の `company_code` は全件が 5 文字かつ末尾 `'0'`
 * なので、TDnet についてはこの限定で取りこぼしは出ない (実測)。
 *
 * **EDINET については末尾 `'0'` 限定の実測根拠が無い** (生の `secCode` を保存して
 * いる表が無く分布を取れない)。仕様上は「4 文字 + 検査文字」なので同形と見なすが、
 * 未検証のまま厳格側へ寄せている。末尾非 0 (例 ETF `1671` の `16714`) は
 * `null` になり呼び出し側で母集団外として落ちる — 取り違えより取りこぼしを選ぶ。
 */
export function sourceCodeToTicker(
  raw: string | null | undefined
): string | null {
  const s = normalizeStockCode(raw);
  if (s.length === 4) return STOCK_CODE_REGEX.test(s) ? s : null;
  if (s.length === 5 && s.endsWith("0")) {
    const head = s.slice(0, 4);
    return STOCK_CODE_REGEX.test(head) ? head : null;
  }
  return null;
}
