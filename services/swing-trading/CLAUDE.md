# 003 Swing Trading — kabulab

**kabulab** プロジェクト群の 003 番。
**数日〜2週間の短期売買**をサポートするサービス。Notion ガイド
「短期売買実践ガイド」の 3 章を日足ベースで自動化し、定量ルールで
毎朝の売買判断を再現可能にする。

仕様の正本は [docs/003-swing-trading.md](../../docs/003-swing-trading.md)。
本ファイルは実装時の規約のみを持つ。

## ディレクトリ構成

```
services/swing-trading/
├── base-path.ts                  # BASE_PATH = "/swing-trading"
├── app.ts                        # Hono サブアプリ公開エントリ
└── src/
    ├── index.ts                  # Hono({ strict: false }) + routes + onError (共有 createErrorHandler)
    ├── db/{client,schema}.ts     # 003 固有 swing_* (共有 core は src/shared/db/ を参照)
    ├── routes/{pages,api}.ts     # SSR ページ + POST /api/risk/calc
    ├── services/risk.ts          # ポジションサイズ計算 (純関数。UI から直接 import)
    ├── validators/               # Zod スキーマ (zod/mini)
    ├── views/                    # layout / dashboard / screening / signals / stock-detail / risk
    └── tests/unit/               # indicators / patterns / risk
```

テクニカル計算系は root の `src/shared/` + `src/cron/daily.ts` へ移動済み。
本サービス配下に残る純ロジックは `risk.ts` のみ。

## コーディング規約

- 命名規則: 変数・関数は camelCase、型・クラスは PascalCase、定数は UPPER_SNAKE_CASE
- テーブル名・カラム名は snake_case、TypeScript 側は camelCase (Drizzle が自動マッピング)
- コメントは日本語、公開 API・関数には JSDoc を記述
- `any` 型禁止。やむを得ない場合は `unknown`
- TypeScript strict mode 必須
- API 入出力には Zod スキーマでバリデーション
- テストカバレッジ 80% 以上

## CLAUDE.md ルール遵守の要点

### 1. フォールバック禁止

- Yahoo 取得失敗 → throw (silent に null を返さない)
- 日経 VI 取れない → `judgment = "HOLD"` として明示 (VIX だけで B 判定にしない)
- ④需給 ⑤カタリスト → "外部データ未対応" として UI に明示
- エラーハンドラも 200 で握り潰さず、必ず 4xx/5xx を返す

### 2. 実データ必須

- ユニットテストの純関数は OK (indicators/patterns/risk)
- 統合テストはローカルの D1 (wrangler) で実データを使うこと
- sync は 1 銘柄単位で Yahoo から実際のレスポンスを取ってくる

## フロントエンド方針

- フレームワーク: Hono (template literal を返す `.ts` 関数で SSR。**JSX 不可**)
- スタイリング: インライン CSS — `views/layout.ts` の `GLOBAL_STYLES` に集約
- デザインは kabulab Editorial Swiss Grid ([docs/overview.md](../../docs/overview.md) 参照)
- ヘッダー左端に `← KABULAB` リンク、ロゴサブタイトルは `003 / KABULAB`

## コマンド

すべて **リポジトリルート** から実行する (一覧は root README 参照):

```bash
pnpm dev                 # ローカル開発サーバー起動 (wrangler dev)
pnpm sync:daily:core     # 手動日次 (core/rsi/swing)。通常は GitHub Actions
pnpm test / pnpm typecheck / pnpm lint
```

## Git 規約

Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`, `perf:`)
