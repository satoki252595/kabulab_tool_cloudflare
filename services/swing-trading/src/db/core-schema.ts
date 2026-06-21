/**
 * 共有 core スキーマ（Cloudflare D1 / SQLite 版） — ADR-0001。
 *
 * 唯一の正本は `src/shared/db/core-schema.ts`。003 は core.* を読み取り専用で
 * 参照するだけなので、既存 import パスを保ったまま共有定義を re-export する。
 */
export * from "../../../../src/shared/db/core-schema.js";
