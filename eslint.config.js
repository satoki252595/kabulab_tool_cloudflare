import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      // typescript-eslint recommended は `no-dupe-keys` を含むコア規則を
      // 「tsc が TS1117 で報告するから重複」として無効化する。だがそれは
      // **tsc がそのファイルを見ている**前提であり、tsconfig の exclude に
      // 入ったファイルはどちらからも見られない。実際に 002 otakara の
      // 未マウント実装では `shortSummary` の重複キーが 5 箇所残っていた。
      // exclude は将来また増えうるので、lint 側でも独立に検出させる。
      "no-dupe-keys": "error",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-console": ["warn", { allow: ["warn", "error", "info"] }],
    },
  },
  {
    ignores: [
      "node_modules/",
      "dist/",
      "**/drizzle/",
      "coverage/",
    ],
  }
);
