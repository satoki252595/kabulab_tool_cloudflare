/**
 * root 横断 (src/index.ts / src/cron / src/shared) 用の型付き環境変数アクセサ。
 *
 * CLAUDE.md ルール3: `process.env.*` の直参照は集約モジュールに限定し、
 * 呼び出し側は必ず getter 経由で取得する (誤記事故防止 + フォールバック禁止の一元管理)。
 *
 * - `required()`: 未設定なら throw (ルール2: 黙ってデフォルト値で埋めない)
 * - `optional()`: 未設定は `undefined` を返し、呼び出し側に判断を委ねる
 *   (「未取得」を型で表現する。`??` で消さないこと)
 *
 * 注: 各サービス固有の env は従来どおり各自の env.ts (例:
 * `src/shared/notion-archive/env.ts`) に置く。ここは root 共有分のみ。
 * `DATABASE_URL` は root 規約「必ず process.env.DATABASE_URL から取得」が
 * 現存し参照箇所が多いため、本アクセサへの移行は別タスク。
 */

function required(key: string): string {
  const v = process.env[key];
  if (!v || v.trim() === "") {
    throw new Error(
      `環境変数 ${key} が設定されていません。.env を確認してください。`
    );
  }
  return v;
}

function optional(key: string): string | undefined {
  const v = process.env[key];
  return v && v.trim() !== "" ? v : undefined;
}

export const sharedEnv = {
  /**
   * Vercel Cron 認証用シークレット。未設定は `undefined` を返す —
   * auth.ts 側が fail-closed (常に 401) で処理するため、参照時 throw に
   * すると cron 全体が 500 になり挙動が変わる。optional が正。
   */
  CRON_SECRET: () => optional("CRON_SECRET"),
};

// required は今後 root 共有変数を追加する際に使う (現時点では CRON_SECRET のみ)
export { required as requiredEnv, optional as optionalEnv };
