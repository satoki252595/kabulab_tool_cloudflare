/**
 * muse (ローカル CLI, Meta muse-spark-1.3-contributor) 用の型付き環境変数
 * アクセサ (CLAUDE.md ルール3)。
 *
 * `process.env.MUSE_BIN` の直参照はここに集約する。未設定は参照時に throw する
 * (黙ってフォールバック値〔既定パスの決め打ち等〕で埋めない。ルール2)。
 * 実行バイナリの場所は環境ごとに異なる (ローカル PC のインストール先) ため、
 * リポジトリ側で既定パスを持たない — `judge=muse` を使う運営が `.env` に
 * 設定する。
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

export const museEnv = {
  /** muse CLI 実行ファイルの絶対パス (`judge=muse` を使うときのみ必要)。 */
  MUSE_BIN: () => required("MUSE_BIN"),
};
