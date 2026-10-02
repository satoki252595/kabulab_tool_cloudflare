/**
 * 005 yuho-quant の型付き環境変数アクセサ (CLAUDE.md ルール3)。
 *
 * `process.env.*` の直参照はこのモジュールに集約する。未設定時は参照時点で
 * throw し、silent fallback (ルール2) は行わない。`.env` は値の唯一の source
 * of truth。Vercel ランタイムでは Dashboard の Environment Variables が
 * `.env` の代わりに正のソースになる (overview.md「認証」節と同方針)。
 */

function required(key: string): string {
  const v = process.env[key];
  if (!v || v.trim() === "") {
    throw new Error(
      `環境変数 ${key} が設定されていません。.env (または Vercel Env) を確認してください。`
    );
  }
  return v.trim();
}

function optional(key: string): string | undefined {
  const v = process.env[key];
  return v && v.trim() !== "" ? v.trim() : undefined;
}

/** 比較に使う暦日。Date.parse の月末超過の正規化は許さない。 */
export function assertBiztagDate(value: string, label: string): void {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) ||
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`${label}: 実在する YYYY-MM-DD が必要です`);
  }
}

export const yuhoEnv = {
  /** 新規上場の初回判定の固定開始日。実行日の代入や暗黙の既定値は禁止。 */
  BIZTAG_NEW_LISTING_FROM: () => {
    const value = required("BIZTAG_NEW_LISTING_FROM");
    assertBiztagDate(value, "BIZTAG_NEW_LISTING_FROM");
    return value;
  },
  /** EDINET API v2 の Subscription-Key (金融庁 EDINET 利用登録で発行) */
  EDINET_API_KEY: () => required("EDINET_API_KEY"),
  // DATABASE_URL (Neon 接続文字列) は ADR-0001 の D1 移行で参照元が無くなった
  // ため削除した。Node から D1 へ書く経路は createD1HttpDb で、認証は
  // src/shared/env.ts の CLOUDFLARE_* アクセサが持つ。
  /**
   * 単語帳(事業タグ語彙)の年次見直し提案 (Cursor Automation) を受け付ける
   * `/yuho-quant/vocabulary/*` の合言葉ハッシュ (SHA-256 hex)。
   * `wrangler.toml` の `[vars]` で設定する (ハッシュなので公開リポジトリに
   * 置いてよい。docs/005-yuho-quant-business-tags.md §6.2)。未設定なら
   * ルート側は常に 401 を返す (fail-closed。既定値で埋めない — ルール2)。
   * 大文字小文字は `shasum` 出力表記ゆれの正規化 (ルール2 の例外・入力正規化)。
   */
  VOCAB_REVIEW_TOKEN_SHA256: () => optional("VOCAB_REVIEW_TOKEN_SHA256")?.toLowerCase(),
};
