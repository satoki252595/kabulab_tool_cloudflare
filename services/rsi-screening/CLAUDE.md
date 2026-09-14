# 001 RSI Screening — kabulab

**kabulab** プロジェクト群の001番。過去 5 年間で RSI (10/40/120 営業日) が
最も低水準にある優良株を発見する Web サービス。

仕様の正本は [docs/001-rsi-screening.md](../../docs/001-rsi-screening.md)。
本ファイルは実装時の規約のみを持つ。

## 優良株の定義

`evaluateBlueChip` ([src/shared/indicators/blue-chip.ts](../../src/shared/indicators/blue-chip.ts)):
売上高トレンド=上昇 AND 営業利益率 TTM ≥ 5%。
詳細・既知の欠陥は docs/001 の「優良株判定ロジック」を参照。

## ディレクトリ構成

```
services/rsi-screening/
├── app.ts / base-path.ts     # Hono サブアプリ公開エントリ / BASE_PATH
└── src/
    ├── index.ts               # Hono アプリ本体 (SSR 配線、onError は共有 createErrorHandler)
    ├── db/{client,schema}.ts  # rsi_percentile + 共有 core 再 export
    ├── routes/pages.ts        # SSR: / /screening /stocks/:code
    ├── services/              # screening-service / stock-detail-service (UI クエリ)
    ├── views/                 # template literal を返す .ts 関数
    ├── validators/screening.ts # Zod スキーマ (zod/mini)
    └── tests/{unit,integration}/
```

計算ロジックは `src/shared/indicators/` にあり本サービスは持たない。
日次 sync は統一 `sync:daily:core` (docs/001 参照)。

## コーディング規約

- 命名規則: 変数・関数は camelCase、型・クラスは PascalCase、定数は UPPER_SNAKE_CASE
- テーブル名・カラム名は snake_case、TypeScript側は camelCase (Drizzleが自動マッピング)
- コメントは日本語、公開API・関数にはJSDocを記述
- `any` 型禁止。やむを得ない場合は `unknown`
- TypeScript strict mode 必須
- API入出力にはZodスキーマでバリデーション
- テストカバレッジ 80% 以上

## フロントエンド方針

- フレームワーク: Hono (template literal を返す `.ts` 関数で SSR。**JSX 不可**)
- 共通トークンは root の `src/shared/design.ts` から取り込み、サービス固有スタイルは `src/views/layout.ts` の `GLOBAL_STYLES` に集約
- デザインは kabulab Editorial Swiss Grid ([docs/overview.md](../../docs/overview.md) 参照)
- ヘッダー左端に `← KABULAB` リンク、ロゴサブタイトルは `001 / KABULAB`

## コマンド

すべて **リポジトリルート** から実行する (一覧は root README 参照):

```bash
pnpm dev                # ローカル開発サーバー起動 (wrangler dev)
pnpm sync:daily:core    # 手動日次 (core/rsi/swing)。通常は GitHub Actions
pnpm test / pnpm typecheck / pnpm lint
```

## Git 規約

Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`, `perf:`)
