/**
 * 004 Financial Math — kabulab portal 配下のマウントパス
 *
 * すべての HTML リンク・form action・JS ナビゲーションは
 * このプレフィックスを前置すること。Hono のルート定義は親側のマウント時に
 * 自動で /financial-math が付与されるため、サブアプリ内のルート登録には
 * BASE_PATH を含めない。
 */
export const BASE_PATH = "/financial-math";
