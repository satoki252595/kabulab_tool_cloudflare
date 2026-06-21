/**
 * 共有 core スキーマ（Cloudflare D1 / SQLite 版） — ADR-0001。
 *
 * 旧 Neon 版の core.* 定義はこのファイルに直書きしていたが、D1 移行で
 * 唯一の正本を `src/shared/db/core-schema.ts` に集約した。各サービスは
 * 既存の import パス（`./core-schema.js`）を変えずに共有定義を使えるよう、
 * ここから re-export するだけにする（定義の二重管理を排除）。
 */
export * from "../../../../src/shared/db/core-schema.js";
