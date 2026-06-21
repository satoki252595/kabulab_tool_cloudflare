# 共有DB設計 — kabulab プロジェクト間の一次情報共有

## 概要

kabulab 配下の複数プロジェクトは **単一の Cloudflare D1 (SQLite) データベース (`kabulab-cf`)** を
共有する。D1 は 1 DB = 1 SQLite で PostgreSQL のようなスキーマ名前空間が無いため、旧
PostgreSQL スキーマ名を **接頭辞テーブル** (`core_*` / `rsi_*` 等) に降ろして同居させる (ADR-0001)。

```
┌─────────────────────── Single D1 DB (kabulab-cf) ─────────────┐
│                                                               │
│  ┌─── core_* テーブル ─┐   ← 一次情報 (全プロジェクト共有)      │
│  │ core_stocks         │                                      │
│  │ core_stock_         │   所有: 001_RSIScreening             │
│  │   financials        │   更新: 日次同期 (Node/Actions)       │
│  │ core_stock_annual_  │   読み: 全プロジェクト                 │
│  │   financials        │                                      │
│  └─────────────────────┘                                      │
│                                                               │
│  ┌─── rsi_* テーブル ──┐   ← 001_RSIScreening 固有            │
│  │ rsi_percentile      │   FK: core_stocks(id)                │
│  └─────────────────────┘                                      │
│                                                               │
│  ┌─ yutai_*/otakara_* ─┐   ← 002_otakara-yutai 固有            │
│  │ yutai_genres        │                                      │
│  │ yutai_benefits      │                                      │
│  │ otakara_stock_scores│   FK: core_stocks(id)                │
│  │ otakara_stock_      │                                      │
│  │   financials        │                                      │
│  └─────────────────────┘                                      │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

---

## 設計原則

### 1. 一次情報は `core_*` に、プロジェクトの解釈は各サービスのテーブルに

| 種別 | 置き場所 | 例 |
|------|----------|-----|
| 一次情報 (Yahoo Finance等の生データ) | `core_*` | PER, ROE, 売上高 |
| 計算結果・指標 | 各サービスのテーブル | RSI, MACD, スコア |
| プロジェクト固有の概念 | 各サービスのテーブル | 優待ジャンル, パーセンタイル |

**判断基準**:
「このデータを別のプロジェクトでも**そのまま**使いたいか？」
→ YES なら `core_*`、NO なら各プロジェクト。

加工済みの値 (移動平均, RSI等) を `core_*` に置くと、
「A案で期間を14日にしたい」「B案で20日にしたい」といった要求に
スキーマ変更が必要になる。だから `core_*` は生データに限定する。

### 2. `core_*` の所有者は1プロジェクトのみ

**001_RSIScreening が日次同期 (Node / GitHub Actions) で `core_*` を更新する**。
他プロジェクトは `core_*` を**読むだけ**。

書き込みの単一窓口化により:
- Yahoo Finance API呼び出しを重複させない (レート制限対策)
- マスタデータの不整合を防ぐ (銘柄追加・削除が片方だけ反映される事故を防ぐ)
- 運用監視がシンプルになる (sync失敗を1箇所だけ見ればよい)

将来、`core_*` の責務が大きくなったら独立した同期プロジェクトに切り出す。

### 3. 各サービスのテーブルは外部キーで `core_stocks` を参照する

```ts
stockId: integer("stock_id")
  .references(() => stocks.id, { onDelete: "cascade" })
  .notNull(),
```

これにより:
- 銘柄マスタが単一ソース化される
- 銘柄削除時にカスケードで関連データが消える
- 各プロジェクトが独自の銘柄マスタを持つ必要がない

---

## Drizzle ORM での実装

正本の共有テーブル定義は root の `src/shared/db/core-schema.ts` (drizzle-orm/sqlite-core)。

### スキーマ定義

```ts
// src/shared/db/core-schema.ts (共有、プロジェクト横断 / 正本)
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";

export const stocks = sqliteTable("core_stocks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  code: text("code").notNull().unique(),
  // ...
});
```

```ts
// services/rsi-screening/src/db/schema.ts (001固有)
import { sqliteTable, integer } from "drizzle-orm/sqlite-core";
import { stocks } from "../../../../src/shared/db/core-schema.js";

export const stockRsiPercentile = sqliteTable("rsi_percentile", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  stockId: integer("stock_id")
    .references(() => stocks.id)   // ← core_stocks への外部キー
    .notNull(),
  // ...
});
```

### クライアント

D1 はバインディング (`c.env.DB`) 経由でのみアクセスする。

```ts
// services/rsi-screening/src/db/client.ts
import * as rsiSchema from "./schema.js";
import { createServiceDb } from "../../../../src/shared/db/client.js";

export function createDb(d1: D1Database) {
  return createServiceDb(d1, rsiSchema);   // drizzle(d1, { schema: { ...core, ...rsi } })
}
```

### drizzle-kit 設定

D1 のスキーマ管理は全サービス共通の `drizzle.d1.config.ts` (dialect: `sqlite`) に集約する。

```ts
// drizzle.d1.config.ts
export default defineConfig({
  schema: [
    "./src/shared/db/core-schema.ts",       // 共有 core
    "./services/rsi-screening/src/db/schema.ts",  // 001 (+ 他サービスを列挙)
    // ...
  ],
  dialect: "sqlite",
  out: "./drizzle/d1",
});
```

---

## 新プロジェクトを追加する方法

新サービスを追加する場合の手順:

### 1. 共有 core テーブルを import して参照する

```ts
// services/<new-service>/src/db/schema.ts (冒頭)
// 正本の共有定義をそのまま import する (再定義しない)
import { stocks } from "../../../../src/shared/db/core-schema.js";
```

### 2. サービス固有テーブルを定義する (接頭辞を付ける)

```ts
// services/<new-service>/src/db/schema.ts
import { sqliteTable, integer } from "drizzle-orm/sqlite-core";
import { stocks } from "../../../../src/shared/db/core-schema.js";

export const someTable = sqliteTable("newsvc_some_table", {   // ← サービス接頭辞
  stockId: integer("stock_id").references(() => stocks.id).notNull(),
  // ...
});
```

### 3. drizzle.d1.config.ts の schema 配列に追記する

```ts
// drizzle.d1.config.ts
schema: [
  "./src/shared/db/core-schema.ts",
  // ...既存サービス...
  "./services/<new-service>/src/db/schema.ts",   // ← 追加
],
```

**重要**: 新サービスは `core_*` の CREATE TABLE を行わない (core-schema.ts を
再定義せず import する)。`pnpm db:generate:d1` で生成される SQL は接頭辞付きの
固有テーブルのみ。`core_*` は 001 が管理する。

### 4. Worker バインディングで同じ DB を使う

```toml
# wrangler.toml
[[d1_databases]]
binding = "DB"
database_name = "kabulab-cf"   # ← 全サービス共通の単一 D1
```

---

## 責任分界

| 操作 | 担当プロジェクト |
|------|----------------|
| `core_stocks` への銘柄追加 | 001 (`pnpm sync:universe`) |
| `core_*` の日次更新 | 001 (日次同期 / GitHub Actions) |
| `core_*` スキーマ変更 | 001 が提案、他プロジェクトに影響確認 |
| 各サービステーブルの変更 | 各プロジェクトが自律的に実施 |

### `core_*` スキーマ変更時のルール

`core_*` は他プロジェクトからも参照されるため、**破壊的変更は慎重に**:

**安全な変更** (他プロジェクトへの影響なし):
- カラム追加 (NULL許容)
- インデックス追加
- 新テーブル追加

**要調整な変更** (他プロジェクトに通知必要):
- カラム名変更
- カラム削除
- 型変更
- NOT NULL制約の追加

---

## 002_otakara-yutai の同居

002 も同じ D1 (`kabulab-cf`) に **接頭辞テーブル**で同居する:

- 共有: `core_stocks` / `core_stock_financials` を import して参照 (CREATE TABLE しない)。
  母集団は `is_yutai = true` の銘柄のみを対象とする。
- 固有: `yutai_genres` / `yutai_benefits` / `otakara_stock_financials` /
  `otakara_stock_scores` を 002 が所有する。

これにより 001/002 は単一銘柄マスタ (`core_stocks`) を共有し、Yahoo 取得を重複させない。

---

## トレードオフ

### メリット

- **API呼び出しの削減**: Yahoo Finance のレート制限にかかりにくい
- **マスタ一貫性**: 銘柄追加・削除が全プロジェクトに即時反映
- **拡張容易**: 新サービスは `core_*` を import して読むだけで立ち上がる
- **運用コスト**: D1 は Workers の無料枠で運用 (Workers Paid / Cron 不使用)

### デメリットと緩和策

| デメリット | 緩和策 |
|-----------|--------|
| `core_*` 変更時の影響範囲が広い | 破壊的変更の事前通知ルールを運用 |
| 全サービスが単一 core-schema.ts を共有 | 正本を root の `src/shared/db/core-schema.ts` に一元化 |
| sync 障害が全プロジェクトに影響 | GitHub Actions のリトライ + 一次データを Notion にアーカイブ |
| DB が単一障害点 | Cloudflare D1 の Time Travel で復旧 |

---

## 関連ファイル

- `src/shared/db/core-schema.ts` (repo root) — 共有 core テーブル定義 (正本・sqlite-core)
- [src/db/schema.ts](../../src/db/schema.ts) — rsi_percentile テーブル定義
- [src/db/client.ts](../../src/db/client.ts) — D1 Drizzle クライアント
- `drizzle.d1.config.ts` (repo root) — D1 用 Drizzle Kit 設定 (dialect: sqlite)
- `scripts/sync/daily.ts` (repo root) — 日次同期本体 (Node / GitHub Actions)
