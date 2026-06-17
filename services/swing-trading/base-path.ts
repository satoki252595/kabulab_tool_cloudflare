/**
 * 003 Swing Trading — kabulab portal 配下のマウントパス
 *
 * すべての HTML リンク・form action・JS ナビゲーション・cron 経路は
 * このプレフィックスを前置すること。Hono のルート定義 (`app.get("/screening")` 等)
 * は親側のマウント時に自動で /swing-trading が付与されるため、サブアプリ内の
 * ルート登録には BASE_PATH を含めない。
 */
export const BASE_PATH = "/swing-trading";
