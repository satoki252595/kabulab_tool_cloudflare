/**
 * SemIf (ローカル MLX 推論。https://github.com/TheoLeeCJ/SemIf) 用の
 * 型付き環境変数アクセサ (CLAUDE.md ルール3)。
 *
 * `process.env.SEMIF_PYTHON` の直参照はここに集約する。未設定は参照時に
 * throw する (黙ってフォールバック値〔既定パス決め打ち等〕で埋めない。
 * ルール2)。SemIf は `~/.local/share/semif/.venv` のような **リポジトリ外**
 * の隔離venvへインストールする運用 (docs/005-yuho-quant-business-tags.md
 * §12.9) のため、venv の python 実行ファイルの場所はマシンごとに異なる —
 * リポジトリ側で既定パスを持たず、`judge=semif` を使う運営が `.env` に
 * 絶対パスを設定する。
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

export const semifEnv = {
  /** SemIf 用の隔離venv内 python 実行ファイルの絶対パス (`judge=semif` のときのみ必要)。 */
  SEMIF_PYTHON: () => required("SEMIF_PYTHON"),
};
