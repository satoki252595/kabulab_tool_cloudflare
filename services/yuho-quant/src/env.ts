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

export const yuhoEnv = {
  /** EDINET API v2 の Subscription-Key (金融庁 EDINET 利用登録で発行) */
  EDINET_API_KEY: () => required("EDINET_API_KEY"),
  /** Neon 接続文字列 (sslmode=require を含む) */
  DATABASE_URL: () => required("DATABASE_URL"),
};
