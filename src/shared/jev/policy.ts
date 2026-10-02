/** 利用停止方針。API キーや呼び出し引数では解除しない。 */
export class TypeSafeDisabledError extends Error {
  constructor() {
    super(
      "TypeSafe の外部判定は利用停止中です。新しい判定は実行せず、未判定は未判定のまま保持します。既存の事業タグ・競合他社の判定結果は変更しません。"
    );
    this.name = "TypeSafeDisabledError";
  }
}

/** キー参照・D1/Notion 操作・外部通信より前に停止する。
 * void 契約で既存 wire/処理の型検査を保つが、実装は常に throw する。
 */
export function assertTypeSafeEnabled(): void {
  throw new TypeSafeDisabledError();
}
