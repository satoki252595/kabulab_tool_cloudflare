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
    setupFiles: ["./src/shared/yahoo/test-setup.ts"],
    // scripts/** は Node 側の取込スクリプト (scripts/moneyflow/ingest.ts 等) の
    // 純関数テスト用。tsconfig は scripts/**/*.ts を型検査しているのに vitest が
    // 拾わないと「書いたテストが CI で一度も走らない」死角になるため含める。
    include: ["services/**/*.test.ts", "src/**/*.test.ts", "scripts/**/*.test.ts"],
    // services/jss-api/** は standalone (独自 lock・vitest 2 設定) のため
    // ルートの vitest 4 では走らせない。jss-api 自身の `pnpm test`
    // (CI の python-pipeline ジョブ) が所有する。exclude を書くと既定値が
    // 置き換わるため、node_modules/dist の既定もここに残す。
    exclude: ["**/node_modules/**", "**/dist/**", "services/jss-api/**"],
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
