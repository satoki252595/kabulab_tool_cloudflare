/** 新規銘柄の初回事業タグ以外の外部判定は停止する。 */
export class TypeSafeDisabledError extends Error {
  constructor() {
    super(
      "TypeSafe は新規銘柄の初回事業タグに限って利用します。既存銘柄は保存タグを参照し、不足のみ機械照合します。語彙審査・精度測定・競合他社の外部判定は停止中です。"
    );
    this.name = "TypeSafeDisabledError";
  }
}

/** 呼出側は公式上場・初回未完・本文の資格を成立させてから用途を渡す。 */
export function assertTypeSafeEnabled(usage?: "new-stock-biztag"): void {
  if (usage === "new-stock-biztag") return;
  throw new TypeSafeDisabledError();
}
