/**
 * 共有 core スキーマ（Cloudflare D1 / SQLite 版） — ADR-0001。
 *
 * 唯一の正本は `src/shared/db/core-schema.ts`。004 は core.stocks を銘柄名の
 * 補完にだけ読み取り参照する。既存 import パスを保ったまま re-export する。
 */
export * from "../../../../src/shared/db/core-schema.js";
