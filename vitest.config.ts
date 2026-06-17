import { defineConfig } from "vitest/config";

/**
 * 統合 Vitest 設定
 *
 * 全サービス (services/<slug>/) 配下のテストを横断して実行する。
 * カバレッジは services 配下のソースのみを対象とし、テスト・スクリプト・
 * 自動生成スキーマは除外する。
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["services/**/*.test.ts", "src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["services/**/src/**/*.ts", "src/**/*.ts"],
      exclude: [
        "**/*.test.ts",
        "**/tests/**",
        "**/scripts/**",
        "**/*.d.ts",
        "**/db/schema.ts",
        "**/db/core-schema.ts",
        "**/db/client.ts",
        "**/views/**",
        "**/routes/**",
      ],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 70,
        statements: 70,
      },
    },
  },
});
