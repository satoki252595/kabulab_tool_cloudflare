# 共有DB設計 — kabuTool プロジェクト間の一次情報共有

## 概要

kabuTool配下の複数プロジェクトは **単一の Neon PostgreSQL データベース** を共有し、
**PostgreSQLスキーマ** を使って名前空間を分離する。

```
┌─────────────────────── Single Neon DB ───────────────────────┐
│                                                               │
│  ┌─── core スキーマ ───┐   ← 一次情報 (全プロジェクト共有)      │
│  │ stocks              │                                      │
│  │ stock_price_history │   所有: 001_RSIScreening             │
│  │ stock_financials    │   更新: sync-core バッチ              │
│  │ stock_annual_       │   読み: 全プロジェクト                 │
│  │   financials        │                                      │
│  └─────────────────────┘                                      │
│                                                               │
│  ┌─── rsi スキーマ ────┐   ← 001_RSIScreening 固有            │
│  │ stock_rsi_history   │                                      │
│  │ stock_rsi_percentile│   FK: core.stocks(id)                │
│  └─────────────────────┘                                      │
│                                                               │
│  ┌─── yutai スキーマ ──┐   ← 002_otakara-yutai 固有            │
│  │ yutai_genres        │    (未移行)                          │
│  │ yutai_benefits      │                                      │
│  │ stock_scores        │   FK: core.stocks(id)                │
│  │ stock_history       │                                      │
│  └─────────────────────┘                                      │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

---

## 設計原則

### 1. 一次情報は `core` に、プロジェクトの解釈はプロジェクトスキーマに

| 種別 | 置き場所 | 例 |
|------|----------|-----|
| 一次情報 (Yahoo Finance等の生データ) | `core.*` | OHLCV, PER, ROE, 売上高 |
| 計算結果・指標 | プロジェクトスキーマ | RSI, MACD, スコア |
| プロジェクト固有の概念 | プロジェクトスキーマ | 優待ジャンル, パーセンタイル |

**判断基準**:
「このデータを別のプロジェクトでも**そのまま**使いたいか？」
→ YES なら `core`、NO なら各プロジェクト。

加工済みの値 (移動平均, RSI等) を `core` に置くと、
「A案で期間を14日にしたい」「B案で20日にしたい」といった要求に
スキーマ変更が必要になる。だから `core` は生データに限定する。

### 2. `core` の所有者は1プロジェクトのみ

**001_RSIScreening が `sync-core` バッチで `core.*` を日次更新する**。
他プロジェクトは `core.*` を**読むだけ**。

書き込みの単一窓口化により:
- Yahoo Finance API呼び出しを重複させない (レート制限対策)
- マスタデータの不整合を防ぐ (銘柄追加・削除が片方だけ反映される事故を防ぐ)
- 運用監視がシンプルになる (sync失敗を1箇所だけ見ればよい)

将来、`core` の責務が大きくなったら `000_core-sync` として独立プロジェクト化する。

### 3. プロジェクトスキーマは外部キーで `core.stocks` を参照する

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

### スキーマ定義

```ts
// src/db/core-schema.ts (共有、プロジェクト横断)
import { pgSchema } from "drizzle-orm/pg-core";

export const coreSchema = pgSchema("core");

export const stocks = coreSchema.table("stocks", {
  id: serial("id").primaryKey(),
  code: text("code").notNull().unique(),
  // ...
});
```

```ts
// src/db/schema.ts (001固有)
import { pgSchema } from "drizzle-orm/pg-core";
import { stocks } from "./core-schema";

export const rsiSchema = pgSchema("rsi");

export const stockRsiHistory = rsiSchema.table("stock_rsi_history", {
  id: serial("id").primaryKey(),
  stockId: integer("stock_id")
    .references(() => stocks.id)   // ← core.stocks への外部キー
    .notNull(),
  // ...
});
```

### クライアント

```ts
// src/db/client.ts
import * as coreSchema from "./core-schema";
import * as rsiSchema from "./schema";

export function createDb(databaseUrl: string) {
  const sql = neon(databaseUrl);
  return drizzle(sql, { schema: { ...coreSchema, ...rsiSchema } });
}
```

### drizzle-kit 設定

```ts
// drizzle.config.ts
export default defineConfig({
  schema: ["./src/db/core-schema.ts", "./src/db/schema.ts"],
  dialect: "postgresql",
  schemaFilter: ["core", "rsi"],  // ← スキーマを明示
  dbCredentials: { url: process.env.DATABASE_URL! },
});
```

---

## 新プロジェクトを追加する方法

`003_new-project` を追加する場合の手順:

### 1. Drizzleスキーマで `core` を参照する

```ts
// 003_new-project/src/db/core-schema.ts
// 001と同じ定義をコピーするか、共有パッケージ化する
import { pgSchema, serial, text } from "drizzle-orm/pg-core";
export const coreSchema = pgSchema("core");
export const stocks = coreSchema.table("stocks", { ... });
```

### 2. プロジェクト固有スキーマを定義する

```ts
// 003_new-project/src/db/schema.ts
import { pgSchema } from "drizzle-orm/pg-core";
import { stocks } from "./core-schema";

export const newProjectSchema = pgSchema("new_project");

export const someTable = newProjectSchema.table("some_table", {
  stockId: integer("stock_id").references(() => stocks.id).notNull(),
  // ...
});
```

### 3. drizzle-kit は自分のスキーマだけ管理する

```ts
// 003_new-project/drizzle.config.ts
export default defineConfig({
  schema: "./src/db/schema.ts",  // core-schema.ts は含めない
  schemaFilter: ["new_project"],  // ← coreは含めない
  // ...
});
```

**重要**: 新プロジェクトは `core.*` の CREATE TABLE を行わない。
`db:push` / `db:generate` は `new_project.*` のみを対象にする。
`core.*` は 001 が管理する。

### 4. 環境変数を同じDBに設定

```bash
# 003_new-project/.env
DATABASE_URL=<001と同じNeon DBの接続文字列>
```

---

## 責任分界

| 操作 | 担当プロジェクト |
|------|----------------|
| `core.stocks` への銘柄追加 | 001 (seed-stocksスクリプト) |
| `core.*` の日次更新 | 001 (sync-coreバッチ) |
| `core.*` スキーマ変更 | 001 が提案、他プロジェクトに影響確認 |
| 各プロジェクトスキーマの変更 | 各プロジェクトが自律的に実施 |

### `core` スキーマ変更時のルール

`core.*` は他プロジェクトからも参照されるため、**破壊的変更は慎重に**:

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

## 002_otakara-yutai の移行 (未実施)

現状、002は `public` スキーマに独自の `stocks` / `stock_financials` 等を持つ。
移行時の手順:

1. 002 の `stocks` データを `core.stocks` にマイグレーション (重複するコードはマージ)
2. 002 の `stock_financials` から技術指標カラム (rsi_14, ma_5等) を削除
3. 002の非一次情報カラムを `core.stock_financials` にマッピング
4. 002の Drizzleスキーマを書き換え:
   - `stocks`, `stock_financials` → `core.*` を参照 (CREATE TABLE しない)
   - `yutai_*`, `stock_scores`, `stock_history` → `yutai.*` に移動
5. 002の `stock-data-sync.ts` を廃止 (001の sync-core に統合)
6. 002の `drizzle.config.ts` で `schemaFilter: ["yutai"]` を指定

移行は `002_otakara-yutai` 側のタスクとして別チケット化する。

---

## トレードオフ

### メリット

- **API呼び出しの削減**: Yahoo Finance のレート制限にかかりにくい
- **ストレージ効率**: 株価履歴 (5年×全銘柄) が1コピー
- **マスタ一貫性**: 銘柄追加・削除が全プロジェクトに即時反映
- **拡張容易**: 新プロジェクトは `core.*` を読むだけで立ち上がる

### デメリットと緩和策

| デメリット | 緩和策 |
|-----------|--------|
| `core` 変更時の影響範囲が広い | 破壊的変更の事前通知ルールを運用 |
| core-schema.ts を各プロジェクトにコピーする重複 | 将来 pnpm workspace で共有パッケージ化 |
| sync バッチ障害が全プロジェクトに影響 | Neon のポイントインタイムリカバリで復旧 |
| DB接続が単一障害点 | Neon のHA機能に依存 |

---

## 関連ファイル

- [src/db/core-schema.ts](../../src/db/core-schema.ts) — core スキーマ定義
- [src/db/schema.ts](../../src/db/schema.ts) — rsi スキーマ定義
- [src/db/client.ts](../../src/db/client.ts) — Drizzle クライアント
- [drizzle.config.ts](../../drizzle.config.ts) — Drizzle Kit 設定
- [src/services/sync-service.ts](../../src/services/sync-service.ts) — sync-core バッチ本体
