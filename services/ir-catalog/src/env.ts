/**
 * 006 ir-catalog の型付き環境変数アクセサ (CLAUDE.md ルール3)。
 *
 * `process.env.*` の直参照はこのモジュールに集約する。未設定時は参照時点で
 * throw し、silent fallback (ルール2) は行わない。`.env` は値の唯一の source
 * of truth。Vercel ランタイムでは Dashboard の Environment Variables が
 * `.env` の代わりに正のソースになる。
 *
 * TDnet (yanoshin WebAPI) は API キー不要なので DB 接続のみを集約する。
 * Notion 関連の env は src/shared/notion-archive/env.ts が一元管理する。
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

export const irEnv = {
  /** Neon 接続文字列 (sslmode=require を含む) */
  DATABASE_URL: () => required("DATABASE_URL"),
};
