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
      // recommended はコア規則を「tsc が報告するから重複」として無効化するが、
      // それは tsc がそのファイルを見ている前提。exclude に入ったファイルは
      // どちらからも見られないので、lint 側でも独立に検出させる。
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
  },
  // 007 のブラウザ単一ファイルだけ最小宣言 (他 UI の監査はしない)。
  // 正当なブラウザ global の no-undef を解消するための環境宣言であり、
  // ルールの無効化・ignore 追加ではない。
  {
    files: ["public/vwap-analysis/app.js"],
    languageOptions: {
      globals: {
        document: "readonly",
        fetch: "readonly",
        LightweightCharts: "readonly",
        requestAnimationFrame: "readonly",
        ResizeObserver: "readonly",
        setTimeout: "readonly",
        window: "readonly",
      },
    },
  }
);
