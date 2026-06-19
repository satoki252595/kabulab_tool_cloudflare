# ADR-0001: Neon PostgreSQL を廃し Cloudflare D1 + R2 + Notion へ移行する

- ステータス: **承認済 / Phase 1 基盤 + Phase 2 POC(005 yuho-quant) 実装済・cutover 前**
- 日付: 2026-06-20
- 決定者: @satoki252595
- 関連: [overview.md](../overview.md) / CLAUDE.md ルール6（一次データ Notion アーカイブ）

---

## 1. 背景 (Context)

現在 kabulab の 6 サービスは **Neon PostgreSQL**（`@neondatabase/serverless` + `drizzle-orm/neon-http`）を
正本データストアとして利用している。配信は Cloudflare Workers、時系列の一部（VWAP 007）は既に R2。

外部の Neon に依存し続けることには次の課題がある:

- データストアが Cloudflare の外にあり、`DATABASE_URL` シークレット管理・接続経路が二重になる。
- Worker からのリクエスト毎 HTTP 接続（neon-http）でレイテンシ・コールドコストが乗る。
- ローカル CLI 取込が「Neon URL を知っていれば誰でも書ける」構造で、取込経路が分散している。

**目標**: Neon を完全に外し、すべて Cloudflare ネイティブ + Notion に寄せる。

---

## 2. 決定 (Decision)

データを役割で 3 層に分離して配置する:

| データ種別 | 例 | 配置先 | 理由 |
|---|---|---|---|
| **一次データ**（raw source） | EDINET 有報 ZIP / TDnet 開示 / JPX 上場 XLS / 優待スクレイプの確定エクスポート | **Notion**（`src/shared/notion-archive`） | CLAUDE.md ルール6 の正準窓口。冪等・物理バイト列保存・退避(ごみ)管理が既にある |
| **正規化リレーショナル** | 銘柄マスタ・財務・スコア・RSI・優待・IR開示メタ・受注高 | **D1**（SQLite, 単一DB） | クエリ性が要る。総量は最大でも ~100MB 級で D1 無料枠に収まる |
| **時系列ブロブ** | 日足OHLCV(36–45万行)・5分足・週次信用残高・指数 | **R2**（JSON/JSONL, code別ファイル） | 大量・追記中心。VWAP 007 の素通しパターンを踏襲し D1 を軽く保つ |

取込（書込）は Node ローカル CLI から **Worker 上** へ移す（D1 はバインディング経由のみ）。
取込ロジックを Worker に置き `c.env.DB`(D1) / `c.env.BUCKET`(R2) を直接叩く。

**起動経路は段階導入**する:
- **現状（Phase 2）**: 認証付き HTTP ルート `POST /yuho-quant/admin/catchup`（CRON_SECRET, fail-closed）。
  手動 curl / 薄い CLI トリガ（`scripts/sync/yuho-edinet.ts` が `WORKER_BASE_URL` を叩く）から起動。
- **Phase 3**: `wrangler.toml` に `[triggers] crons` + `worker/entry.ts` に `scheduled` ハンドラを足して
  定期自動起動にする（現状は未配線）。

Yahoo 由来（株価日次）の取込は 429 制約があるため本 ADR の対象外とし、別途検討する。

---

## 3. D1 のレイアウト

### 3.1 単一 D1 + テーブル接頭辞

D1 は **1 DB = 1 SQLite ファイル**で、DB 間 JOIN が不可。現在 PostgreSQL の `core` / `rsi` / `swing` /
`ir_catalog` / `yuho_quant` / `otakara` / `finmath` というスキーマ分割は使えない。

→ **全テーブルを 1 つの D1 に統合**し、旧スキーマ名を接頭辞に降ろす:

```
core_stocks, core_stock_financials, core_stock_annual_financials
rsi_percentile
swing_indicators, swing_screening, swing_entry_signals, swing_market_context, swing_sector_daily
ir_disclosures
yuho_documents, yuho_order_facts
otakara_yutai_genres, otakara_yutai_benefits, otakara_stock_financials, otakara_stock_scores
finmath_price_snapshot
```

これで全サービスが参照する共有 `core_stocks` への FK が同一 DB 内に収まり、横断参照（N+1）を避けられる。

### 3.2 時系列は D1 に入れない

以下は **D1 ではなく R2** に置く（VWAP と同じ `{code}.json` / `{key}.json` 方式）:

- `swing.daily_ohlcv`（36–45万行）→ R2 `swing/ohlcv/{code}.json`
- `finmath.daily_ohlcv`（指数含む）→ R2 `finmath/ohlcv/{symbol}.json`
- 既存 VWAP の `daily/` `intra/` `margin/` はそのまま

これにより D1 の行数は ~25万行（IR開示が支配的, ~100MB）に収まり、**D1 無料枠 500MB/DB に余裕**。

---

## 4. 方言移行 (PostgreSQL → SQLite)

`drizzle-orm/pg-core` → `drizzle-orm/sqlite-core`。機械的変換が大半:

| PostgreSQL | SQLite (D1) | 備考 |
|---|---|---|
| `serial` 主キー | `integer().primaryKey({ autoIncrement: true })` | Drizzle で吸収 |
| `timestamp(..,{withTimezone:true})` + `defaultNow()` | **`integer({mode:'timestamp'})`（epoch 秒）** | drizzle は `floor(ms/1000)` 秒で保存し `new Date(s*1000)` で復元（JS `Date` を維持）。既定は `sql\`(unixepoch())\``。**移送スクリプトは ISO 文字列ではなく epoch 秒を入れること**（ミリ秒や ISO を入れると 1000 倍ずれ/型崩れ） |
| `text[]`（`ir_disclosures.tags` のみ） | `text({mode:'json'})` に JSON 配列 | **唯一の特殊ケース**。読取側 `JSON.parse` |
| `doublePrecision`（yuho 2列） | `real` | 精度確認済みで可 |
| `bigint({mode:'number'})`（yuho 2列） | `integer({mode:'number'})` | 円単位整数、安全 |
| `ON CONFLICT DO UPDATE` | 同構文 | SQLite 3.24+ で同一、Drizzle 対応 |
| 複合 unique / index / FK CASCADE | そのまま | `PRAGMA foreign_keys=ON` は D1 既定で有効 |

PG 独占機能（enum / jsonb / window / date_trunc / percentile_cont / PostGIS）は**未使用**のため変換不要。

---

## 5. 接続層の変更

### 5.1 現状（全 6 サービス共通パターン）

```ts
// services/*/src/db/client.ts
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
export function createDb(databaseUrl: string) {
  return drizzle(neon(databaseUrl), { schema });
}
```

### 5.2 移行後（POC 実装の実態）

共有 `core` スキーマは `src/shared/db/core-schema.ts`（sqlite-core）に集約するが、
drizzle クライアント生成は従来どおり **per-service**（`services/*/src/db/client.ts`）に置く。

```ts
// per-service: services/yuho-quant/src/db/client.ts
import { drizzle } from "drizzle-orm/d1";
import * as coreSchema from "../../../../src/shared/db/core-schema.js";
import * as yuhoSchema from "./schema.js";
export function createDb(d1: D1Database) {
  return drizzle(d1, { schema: { ...coreSchema, ...yuhoSchema } });
}
```

- Worker: `createDb(c.env.DB)` を使う。`DATABASE_URL`（Neon）参照を全廃。
- 影響範囲（移行するごとに）: 各 `services/*/src/db/client.ts` + 取込経路。
- `wrangler.toml` に `[[d1_databases]] binding = "DB"` を追加（実施済）。
- D1 型は `@cloudflare/workers-types` を入れず `src/shared/db/cloudflare.d.ts` に最小宣言。

---

## 6. 取込モデル (Workers Cron へ移管)

```
[Cron Trigger 日次/月次/週次]
        │
        ├─ fetch 一次データ (EDINET/TDnet/JPX/scrape)
        │      └─ recordPrimaryData()  → Notion「バックアップ」へ物理バイト列 (ルール6)
        │
        ├─ parse → 正規化
        │      └─ UPSERT → D1 (c.env.DB)
        │
        └─ 時系列があれば → R2 (c.env.BUCKET) に {code}.json
```

- `wrangler.toml` に `[triggers] crons = [...]` を追加（日次/週次など）。
- D1 の制約に合わせ **バッチ書込は `db.batch()` で分割**（1文 100KB / bind 変数 **100** / 1 invocation 1000 query 以内）。
  **実装済**: `ingest.ts` の `order_facts`（12 列/行）は 8 行/文（96 bind）に分割し、delete と全 insert を
  `db.batch()` で原子的に置換（建設業など 9 セグメント超で単一 INSERT が bind 上限超過で落ちるのを防ぐ）。
- 1 実行のサブリクエスト数は Workers 上限（Paid 1000/invocation）内に収める。`MAX_INGEST=40`（×最悪 ~14 req/doc ≈ 560）。
  大量分は「1 回で N 件・docId 冪等で次回継続」（既存の時間予算パターン）を踏襲。
- Yahoo 系（株価）は 429 制約のため本 ADR 対象外（別 ADR で検討）。

---

## 7. 既存 Neon データの一度きり移行

クリーンな再取込ではなく、**既存 Neon を一度だけ D1 へ移送**する（決定: 2026-06-20）:

> ⚠️ **cutover ゲート（マージ前提条件）**: yuho-quant の読取は既に `c.env.DB`(D1) を直読みし、
> `worker/entry.ts → src/index.ts` 経由で本番配信される。この移行ブランチを **main にマージして
> `deploy:cf` した瞬間に、本番 yuho は D1 を指す**。よって **マージ/デプロイの前に必ず本手順
> (§7) を完了**し、本番 D1 の `core_stocks` / `yuho_documents` / `yuho_order_facts` の行数が
> 想定下限を超えることを検証すること。未移送のままデプロイすると本番 yuho が空 DB を指し、
> 全銘柄検索 0 件・`/stock/:code` 一律 404 になる。コードに黙ったフォールバックは入れない
> （ルール2）ため、順序は運用ゲートで守る。PR 説明の冒頭にこの警告を必須記載する。

1. 本番 Neon の実 `DATABASE_URL` を一時的に取得（移行完了後に破棄）。
2. `pg_dump`（または Drizzle スクリプト）で対象テーブルを取得。
3. 変換スクリプトで SQLite 方言へ整形（**timestamp→epoch 秒**（`integer mode:'timestamp'`。ISO/ミリ秒にしない）, tags→JSON, schema接頭辞付与）。
4. 時系列テーブルは R2 JSON へ、それ以外は D1 へ投入（`wrangler d1 execute --file` または D1 HTTP API）。
5. 本番 Worker の D1 読取で件数・代表クエリを検証 → 一致したら Neon を解約。

---

## 8. コスト

| 項目 | 無料枠 | 本ワークロード | 想定課金 |
|---|---|---|---|
| D1 ストレージ | 500MB/DB・10DB | ~100MB（時系列はR2へ） | $0 |
| D1 読取/書込 | 25B読/5000万行書 月 | 日次数万件 | $0 |
| R2 ストレージ/操作 | 10GB / 1M書・10M読 月 | VWAP+時系列で数GB | $0 |
| Workers + Cron | Cron無料 / Paidで$5 | 配信+定期取込 | $0〜$5/月 |

→ **実質 $0〜$5/月**。Yahoo を高頻度ポーリングしない限り超過は出ない。

---

## 9. 段階移行プラン（決定: 設計書→1サービス実証）

- **Phase 0**（本 ADR）: 設計合意。✅
- **Phase 1 — 基盤** ✅: 単一 D1(`kabulab-cf`) 作成、`wrangler.toml` `binding=DB`、共有 `core_*` スキーマ
  (`src/shared/db/core-schema.ts`, sqlite-core)、CF 型のローカル宣言、`drizzle.d1.config.ts` + 生成 SQL 適用。
- **Phase 2 — 実証(POC)** ✅(cutover 前): **005 yuho-quant を D1 へ通し移行**（schema/client/read/取込ルート）。
  検証: typecheck/test green、wrangler dev で D1 読取確認、admin 取込ルート 401。
  **保留**: 5 年バックフィル(bulk) の Worker 実装（要 EDINET/Notion 鍵）、Neon→D1 実データ移送(§7, cutover)。
  - 推奨 POC = **005 yuho-quant**: 自己完結・EDINET(非Yahoo・今すぐ再取込可)・order_facts ~3万行で D1 適正・
    Notion ZIP 実体アップロード(ルール6)を通しで検証できる。時系列なしで D1 経路に集中できる。
  - `ir_disclosures.tags` の `text[]→JSON` 特殊ケースは本 ADR §4 で先に解法を確定済み。次フェーズ ir-catalog で適用。
- **Phase 3 — 横展開**: 002/006 → 001/003/004 を順次。時系列は R2 へ退避。
- **Phase 4 — 切替**: §7 cutover ゲートに従い「移送 → 本番 D1 行数検証 → main マージ → `deploy:cf`」
  の順を厳守（空 D1 へ向けて本番を壊さない）→ Neon 解約。Workers Cron 配線もこの段階で追加。

各 Phase 完了時に CLAUDE.md ルール4（専門エージェント精査）→ ルール5（push）。

---

## 10. リスクと対策

| リスク | 対策 |
|---|---|
| 時系列を D1 に残すと書込負荷・容量超過 | §3.2 で R2 へ退避（最優先の一手） |
| スキーマ統合時のテーブル名衝突 | §3.1 接頭辞で回避。migration を root 単一正本に |
| 取込を Worker 化する際の実行時間制限 | `db.batch()` 分割 + 冪等キーで分割継続（既存 45s 予算パターン踏襲） |
| Neon 移送時の型崩れ（timestamp/array/数値精度） | §4 マッピング表に沿う変換スクリプト + 件数/代表値の突合検証 |
| Yahoo 系株価が 429 で再取込できない | 既存 Neon 移送で保全（§7）。Yahoo 取込は別 ADR |

---

## 11. 未決事項 (POC 開始前に確認)

- POC 対象サービスを **005 yuho-quant** で確定してよいか（代替: 006 ir-catalog で array 変換も同時実証）。
- 既存 Neon の実 `DATABASE_URL` を移送時に一時提供できるか（§7-1）。
- Notion 連携（`NOTION_TOKEN` / バックアップ・ごみページ ID）の実値を `.env` に投入できるか（ルール6取込に必須）。
