/**
 * D1 バインディングの取り出し。
 *
 * `c.env.DB` を直接触ると、`c.env` が無い呼び出し（`app.request()` を
 * env なしで叩くテストなど）で **TypeError** になる。それがルートの
 * `try` の中で起きると catch に落ち、入力は正しいのに 400（クライアント
 * エラー）として返っていた。実際に統合テスト 2 件がこれで赤かった。
 *
 * ここで明示的に投げ分けることで、
 * 「バインディングが無い」= サーバ側の構成エラーだと分かるようにする。
 */
export class MissingBindingError extends Error {
  constructor(name: string) {
    super(`バインディング ${name} がありません（wrangler の設定か、テストの env 指定を確認）`);
    this.name = "MissingBindingError";
  }
}

export function requireDb(c: { env?: { DB?: D1Database } }): D1Database {
  const db = c.env?.DB;
  if (!db) throw new MissingBindingError("DB");
  return db;
}

/**
 * 例外に対して返すべき HTTP ステータス。
 *
 * これらのルートは catch でフォームを再表示するが、**入力が原因でない失敗まで
 * 400 で返していた**。クライアントには「入力を直せば通る」と読めてしまう。
 * バインディング不在のようなサーバ側の構成エラーは 5xx にする。
 */
export function errorStatus(e: unknown): 400 | 500 {
  return e instanceof MissingBindingError ? 500 : 400;
}

/** 値として受け取ったバインディングを検証する（遅延評価したい呼び出し用）。 */
export function requireBinding<T>(value: T | undefined | null, name: string): T {
  if (!value) throw new MissingBindingError(name);
  return value;
}
