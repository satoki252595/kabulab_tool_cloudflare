/**
 * jev (TypeSafe System One) 用の型付き環境変数アクセサ (CLAUDE.md ルール3)。
 *
 * `process.env.TYPESAFE_API_KEY` の直参照はここに集約する。未設定は
 * 参照時に throw する (黙ってフォールバック値で埋めない。ルール2)。
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

export const jevEnv = {
  /** TypeSafe jev (System One) の API キー。事業タグ判定 (biztag) が使う秘密値。 */
  TYPESAFE_API_KEY: () => required("TYPESAFE_API_KEY"),
};
