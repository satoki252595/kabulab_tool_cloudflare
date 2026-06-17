# 設計ドキュメント

## アーキテクチャ

- [共有DB設計](./architecture/shared-database.md) — kabuToolプロジェクト間で一次情報を共有する方針

## 構成原則 (TL;DR)

1. **一次情報は `core` スキーマ** (銘柄マスタ・株価・財務)
2. **計算結果は各プロジェクトのスキーマ** (RSI・スコア・優待)
3. **`core` の更新は1プロジェクトのみ** (現在は 001_RSIScreening)
4. **全プロジェクトが同一の Neon DB を使う**

詳細は [shared-database.md](./architecture/shared-database.md) 参照。
