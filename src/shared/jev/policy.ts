/** 新規初回はローカルSemIfに移管済み。TypeSafeの外部判定は全停止。 */
export class TypeSafeDisabledError extends Error {
  constructor() {
    super(
      "TypeSafe の外部判定は停止中です。新規銘柄の初回事業タグはローカルSemIf、既存銘柄は保存タグを参照し、不足のみ機械照合します。"
    );
    this.name = "TypeSafeDisabledError";
  }
}

/** 過去の用途指定も再開資格にしない。 */
export function assertTypeSafeEnabled(_usage?: "new-stock-biztag"): void {
  throw new TypeSafeDisabledError();
}
