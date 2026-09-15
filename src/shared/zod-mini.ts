/**
 * zod/mini の共有入口 (L-59)。
 *
 * 実行時の validator は classic (`zod`) ではなく全てここから `z` を取る。
 * en ロケールを明示設定する。mini は既定で汎用メッセージ ("Invalid input")
 * しか出さないため、classic と同一文言にするにはこれが要る
 * (フォームの再表示が `issues[0].message` を出す)。
 */
import * as z from "zod/mini";

z.config(z.locales.en());

export { z };
