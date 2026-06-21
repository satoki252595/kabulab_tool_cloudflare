# 設計ドキュメント

## アーキテクチャ

- [共有DB設計](./architecture/shared-database.md) — kabulab プロジェクト間で一次情報を共有する方針

## 構成原則 (TL;DR)

1. **一次情報は `core_*` テーブル** (銘柄マスタ・財務)
2. **計算結果は各プロジェクトのテーブル** (RSI・スコア・優待)
3. **`core_*` の更新は1プロジェクトのみ** (現在は 001_RSIScreening)
4. **全プロジェクトが同一の Cloudflare D1 DB (`kabulab-cf`) を使う** (接頭辞テーブルで同居 / ADR-0001)

詳細は [shared-database.md](./architecture/shared-database.md) 参照。
