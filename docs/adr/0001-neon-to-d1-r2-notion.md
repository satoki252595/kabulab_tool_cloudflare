# ADR-0001: Neon PostgreSQL を廃し Cloudflare D1 + R2 + Notion へ移行する

- ステータス: **完了 / 本番稼働中**（Neon 廃止、全サービス D1 + R2 + Notion へ移行済。取込は GitHub Actions(Node)。Workers Paid / Cron は不使用）
- 日付: 2026-06-20（起案） / 2026-06-22（完了)
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

**読取（配信）**は Cloudflare Workers + Hono が `c.env.DB`(D1) バインディング / `c.env.BUCKET`(R2) を
直接叩く（`createServiceDb` / `createDb(c.env.DB)`）。`DATABASE_URL`(Neon) 参照は全廃。

**取込（書込）**は **Node（GitHub Actions）** から D1 REST 経由（`createD1HttpDb`）で UPSERT し、
時系列は R2 へ書く。Yahoo 由来（株価日次）は 429 制約があるため **Worker のエッジルート
（`/api/ingest/yahoo`, 環境変数 `YAHOO_PROXY_BASE`）を経由**してエッジ IP から叩き、レート制限を回避する。
一次データ（raw）は `src/shared/notion-archive` で Notion へ物理バイト列を冪等記録する（ルール6）。

> ⚠️ **検討途中で破棄した選択肢（歴史的経緯）**: 当初は取込ロジックを Worker 上に置き、
> 認証付き HTTP ルート（`POST /yuho-quant/admin/catchup`, CRON_SECRET, fail-closed）→ 最終的に
> Workers Cron Triggers + `scheduled` ハンドラで自動化する段階導入を想定していた。
> しかし **Workers Cron は Paid プラン前提**であり、xlsx パース（JPX 母集団同期）等が Node 専用で
> あることも踏まえ、**取込は GitHub Actions(Node) に確定**した。Workers Paid / Workers Cron は
> 採用しない（配信は無料枠の Workers のまま）。

---

## 3. D1 のレイアウト

### 3.1 単一 D1 + テーブル接頭辞

D1 は **1 DB = 1 SQLite ファイル**で、DB 間 JOIN が不可。現在 PostgreSQL の `core` / `rsi` / `swing` /
`ir_catalog` / `yuho_quant` / `otakara` / `finmath` というスキーマ分割は使えない。

→ **全テーブルを 1 つの D1（`kabulab-cf`）に統合**し、旧スキーマ名を接頭辞に降ろす（本番の実テーブル名）:

```
core_stocks, core_stock_financials, core_stock_annual_financials
rsi_percentile
swing_daily_ohlcv, swing_stock_indicators, swing_stock_screening, swing_entry_signals, swing_market_context, swing_sector_daily
ir_disclosures
yuho_documents, yuho_order_facts
yutai_genres, yutai_benefits, otakara_stock_financials, otakara_stock_scores
finmath_price_snapshot, finmath_daily_ohlcv
```

これで全サービスが参照する共有 `core_stocks` への FK が同一 DB 内に収まり、横断参照（N+1）を避けられる。

### 3.2 時系列は R2 へ（007 VWAP は R2 が正本）

> **as-built 補足**: 007 VWAP の時系列（日足10年 / 5分足 / 週次信用残高）は **R2（バケット `vwap-data`：
> `daily/{code}.json` / `intra/{code}.json` / `margin/{week}.json`）が正本**で、`vwap-ingest.yml`（GitHub Actions）
> が書き込む。一方、当初プランで「廃止」とした `swing_daily_ohlcv` / `finmath_daily_ohlcv` は移行後も D1 に
> 残置している（§3.1 の実テーブル一覧参照）。以下は設計時のOHLCV一本化案の記録。

日足 OHLCV は移行前は **三重保存**（`swing.daily_ohlcv` 90日 / `finmath.daily_ohlcv` 2y+指数 / R2 `daily/{code}.json` 10年）。
源泉は同一の Yahoo Chart。正規化方針（重複を持たない）に従い **R2 `daily/{code}.json` の単一正本に一本化**する
（指数 `^N225` も code 名前空間で同居）。`swing.daily_ohlcv` / `finmath.daily_ohlcv` は廃止し、指標は R2 を読んで計算。

- OHLCV（日足10年, 〜1,000万行級）→ R2 `daily/{code}.json`（**唯一の正本**）
- 5分足 → R2 `intra/{code}.json` / 週次信用残高 → R2 `margin/{week}.json`（既存維持）

これにより D1 は小さな正規化テーブル群（年度財務2万行 / IR開示・受注ファクト数万行 / マクロ年245行 等）に収まる。

### 3.3 正規化ターゲット（一次データ正本 + 派生層 / 重複排除）

設計原則（決定）: **DBは正規化が肝。重複データを持たない。一次データ（源泉）を正本として保存し、
派生値（指標・スコア・判定）は計算 or「VIEW的なもの」で導出する。** 3層に分離する:

**(A) 正本 = primary（源泉・単一の真実）**

| ストア | テーブル | 源泉 |
|---|---|---|
| D1 | `core_stocks` | JPX 上場 XLS（全サービスの FK 集約点） |
| D1 | `core_stock_financials` | Yahoo QuoteSummary 生値（最新ファンダ唯一の正本） |
| D1 | `core_stock_annual_financials` | Yahoo 年度売上 |
| D1 | `yutai_genres` / `yutai_benefits` | minkabu 優待スクレイプ（LLM 確定出力は再生成不能→persist） |
| D1 | `ir_disclosures` | TDnet 開示（PDFセンチメントは源泉PDFがpurgeされ再計算不可→persist） |
| D1 | `yuho_documents` / `yuho_order_facts` | EDINET 有報（既に D1 済） |
| D1 | `macro_market_context` | 日次マクロ指数生値（1日1行） |
| **R2** | `daily/{code}.json` | **日足OHLCV 唯一の正本**（指標は全てここから計算） |

**(B) 派生層 = derived（正本から導出。method で3分類）**

- **sql-view**（D1通常VIEW・閾値/集計で表現可・低頻度）: `swing_screening_view`（指標の閾値判定）, `sector_daily_view`（業種集計 GROUP BY/RANK）
- **on-read-ts**（リクエスト時に TS 純関数・複雑かつ個別経路）: VWAP / CAPM β / σ / モメンタム（個別詳細のみ）, IR タグ分類（取込時）, 受注CAGR/YoY（有報は小母集団）
- **regenerable-cache**（日次/月次に再計算して D1 へ実体化・全銘柄スクリーニングの高頻度ホットパス）:
  `rsi_percentile_cache`（Wilder RSI+5y percentile）, `blue_chip_judgment`, `swing_indicators`（SMA/ATR/MACD等）,
  `entry_signals_cache`, `yutai_yield_cache`, `yutai_scores_cache`
  → SQLite は materialized view 非対応 + Wilder/EMA/percentile は SQL 非現実的なため、TS で再計算し「VIEW的キャッシュ」として保持。源泉(R2/core)から常に再生成可能。

**(C) 重複排除 = dedup（DROP して正本へ統合）**

| 破棄 | 統合先 | 理由 |
|---|---|---|
| `otakara public.stock_financials`（財務9列） | `core_stock_financials` | core の完全ミラー |
| `otakara public.stock_financials`（指標6列 ma/rsi/macd） | `swing_indicators` | swing 指標の二次コピー |
| `finmath.price_snapshot` | `core_stock_financials`（+code オーバーレイ） | core とほぼ同一カラム |
| `finmath.daily_ohlcv` / `swing.daily_ohlcv` | R2 `daily/{code}.json` | OHLCV 三重保存の解消 |
| `rsi.stock_rsi_percentile.operating_margin_ttm` | `core_stock_financials.operating_margin` | 同値二重保存 |
| `swing.stock_indicators.fib_high/low` | `range_20d_high/low` | 同値コピー列 |
| `core-schema.ts` 物理4コピー | `src/shared/db/core-schema.ts` | 定義ドリフト源（re-export に統一） |

> 2層分離（ホットパス派生は regenerable-cache、軽量判定のみ sql-view）で「正規化 vs スクリーニング性能」を両立する。

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

### 5.1 移行前（歴史的経緯 — 全 6 サービス共通の Neon パターン）

```ts
// services/*/src/db/client.ts
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
export function createDb(databaseUrl: string) {
  return drizzle(neon(databaseUrl), { schema });
}
```

### 5.2 移行後（本番稼働中の実態）

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

- **読取（配信）**: Worker は `createServiceDb` / `createDb(c.env.DB)` を使う。`DATABASE_URL`（Neon）参照を全廃。
- **書込（取込）**: Node（GitHub Actions）は `src/shared/db/d1-http-client.ts` の `createD1HttpDb`（D1 REST）を使う。
- `wrangler.toml` に `[[d1_databases]] binding = "DB"`（単一 DB `kabulab-cf`）を追加（実施済）。
- D1 型は `@cloudflare/workers-types` を入れず `src/shared/db/cloudflare.d.ts` に最小宣言。

---

## 6. 取込モデル (GitHub Actions(Node) へ確定)

```
[GitHub Actions cron: 日次/月次/週次]
        │
        ├─ fetch 一次データ (EDINET/TDnet/JPX/scrape)
        │      └─ recordPrimaryData()  → Notion「バックアップ」へ物理バイト列 (ルール6)
        │
        ├─ parse → 正規化
        │      └─ UPSERT → D1 (createD1HttpDb / D1 REST)
        │
        └─ 時系列があれば → R2 に {code}.json
```

- **自動化は GitHub Actions 3 本**（Workers Cron は不使用 = Paid 回避）:
  - `stock-sync.yml`: 日次 core/rsi/swing 同期 + 月次 universe / otakara rebuild。
  - `vwap-ingest.yml`: 日足10年 / 5分足 / 信用残高 → R2（007 VWAP）。
  - `catchup.yml`: 005 EDINET 有報 + 006 TDnet 開示のキャッチアップ。
  - 002 優待の LLM 解釈のみローカル手動。
- 書込は Node から **`createD1HttpDb`（D1 REST）** 経由。D1 の制約に合わせ **バッチ書込は `db.batch()` で分割**
  （1文 100KB / bind 変数 **100** / 1 invocation 1000 query 以内）。
  **実装済**: `ingest.ts` の `order_facts`（12 列/行）は 8 行/文（96 bind）に分割し、delete と全 insert を
  `db.batch()` で原子的に置換（建設業など 9 セグメント超で単一 INSERT が bind 上限超過で落ちるのを防ぐ）。
- Yahoo 直叩きは GitHub Actions ランナー IP だと 429 を食らうため、**Worker のエッジルート
  `/api/ingest/yahoo`（環境変数 `YAHOO_PROXY_BASE`）経由**でエッジ IP から取得する。
  サブリクエスト上限の参考（このエッジルートに効く Workers 値）: Paid は 2026-02 に 1,000→**10,000**/invocation
  へ増加・wrangler `[limits] subrequests` で最大 10M、Free は外部 50。大量分は「1 回で N 件・docId 冪等で
  次回継続」（既存の時間予算パターン）を踏襲。
- 母集団 JPX 同期は xlsx パーサが Node 専用のため `pnpm sync:universe`（Node / GitHub Actions）に残す。

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
| Workers（配信のみ） | Free プラン | 配信（Workers Builds の Git 連携で自動デプロイ） | $0 |
| 取込自動化 | GitHub Actions Free | stock-sync / vwap-ingest / catchup の 3 ワークフロー | $0 |

→ **実質 $0/月**。取込は Workers Cron(Paid) ではなく GitHub Actions(Node) で回すため Paid 課金は発生しない。
Yahoo を高頻度ポーリングしない限り無料枠超過も出ない。

---

## 9. 段階移行プラン（決定: 設計書→1サービス実証）

> **現況: 全 Phase 完了・本番稼働中。** 全 6 サービスが D1 + R2 + Notion 構成へ移行し、Neon 依存は全廃。
> 取込自動化は当初想定の Workers Cron ではなく **GitHub Actions(Node) に確定**（§6）。以下は移行プランの記録。

- **Phase 0**（本 ADR）: 設計合意。✅
- **Phase 1 — 基盤** ✅: 単一 D1(`kabulab-cf`) 作成、`wrangler.toml` `binding=DB`、共有 `core_*` スキーマ
  (`src/shared/db/core-schema.ts`, sqlite-core)、CF 型のローカル宣言、`drizzle.d1.config.ts` + 生成 SQL 適用。
- **Phase 2 — 実証(POC)** ✅: **005 yuho-quant を D1 へ通し移行**（schema/client/read/取込ルート）。
  検証: typecheck/test green、wrangler dev で D1 読取確認、admin 取込ルート 401。
  **保留**: 5 年バックフィル(bulk) の Worker 実装（要 EDINET/Notion 鍵）、Neon→D1 実データ移送(§7, cutover)。
  - 推奨 POC = **005 yuho-quant**: 自己完結・EDINET(非Yahoo・今すぐ再取込可)・order_facts ~3万行で D1 適正・
    Notion ZIP 実体アップロード(ルール6)を通しで検証できる。時系列なしで D1 経路に集中できる。
  - `ir_disclosures.tags` の `text[]→JSON` 特殊ケースは本 ADR §4 で先に解法を確定済み。次フェーズ ir-catalog で適用。
- **Phase 3 — 正規化横展開**（§3.3 設計に沿う。重複排除しながら移行）:
  1. `core-schema.ts` 定義を `src/shared/db/core-schema.ts` に一本化（rsi/swing/finmath の逐語コピーを re-export へ）
  2. R2 `daily/{code}.json` を OHLCV 正本に確定（指数含む全母集団バックフィル完了確認）
  3. `core_stocks` / `core_stock_financials` / `core_stock_annual_financials` を D1 へ（writer を D1 化）
  4. financials 重複解体（`finmath.price_snapshot` / `otakara public.stock_financials` 破棄 → core + code オーバーレイ）
  5. `swing_indicators`（regenerable-cache）を R2 OHLCV から日次再計算で D1 へ。`swing/finmath.daily_ohlcv` を DROP→R2 参照
  6. `swing_screening_view` / `sector_daily_view` を D1 通常 VIEW 化
  7. `rsi_percentile_cache` / `blue_chip_judgment` / `entry_signals_cache` を日次再生成キャッシュとして D1 へ
  8. otakara `yutai_genres/benefits` → D1、`yutai_yield_cache` / `yutai_scores_cache` を月次キャッシュ化（財務6列ミラー破棄）
  9. ir-catalog（`ir_disclosures` + 分類/sentiment）→ D1（独立・最後に）
  10. `intra/` `margin/` の R2 運用は維持（確認のみ）
- **Phase 4 — 切替 & Neon 解約** ✅: 各サービス cutover（§7 ゲート: 移送→行数検証→deploy）→ 全サービスが Neon 非依存に
  なったことを確認 → **Neon 解約**（`DATABASE_URL` 依存を全廃）。取込自動化は **GitHub Actions(Node)** に確定（§6。
  Workers Cron / Workers Paid は不採用）。デプロイは **Cloudflare Workers Builds（Git 連携）** で main push 時に無料自動化。

各 Phase 完了時に CLAUDE.md ルール4（専門エージェント精査）→ ルール5（push）。

---

## 10. リスクと対策

| リスク | 対策 |
|---|---|
| 時系列を D1 に残すと書込負荷・容量超過 | §3.2 で R2 へ退避（最優先の一手） |
| スキーマ統合時のテーブル名衝突 | §3.1 接頭辞で回避。migration を root 単一正本に |
| D1 のバッチ書込制約（1文 100KB / bind 100 / 1000 query） | `db.batch()` 分割 + 冪等キーで分割継続（GitHub Actions(Node) → D1 REST。既存の時間予算パターン踏襲） |
| GitHub Actions ランナー IP からの Yahoo 429 | Worker エッジルート `/api/ingest/yahoo`（`YAHOO_PROXY_BASE`）経由でエッジ IP から取得（§6） |
| Neon 移送時の型崩れ（timestamp/array/数値精度） | §4 マッピング表に沿う変換スクリプト + 件数/代表値の突合検証 |
| Yahoo 系株価が 429 で再取込できない | 既存 Neon 移送で保全（§7）。Yahoo 取込は別 ADR |

---

## 11. 未決事項（起案時 / 全て解決済）

起案時の確認事項は全て解決し、移行は完了している（記録として残す）:

- ~~POC 対象サービスを **005 yuho-quant** で確定してよいか~~ → 005 で実証し、全サービスへ横展開完了。
- ~~既存 Neon の実 `DATABASE_URL` を移送時に一時提供できるか~~ → 移送完了 → **Neon 解約済**。
- ~~Notion 連携（`NOTION_TOKEN` / バックアップ・ごみページ ID）の実値を `.env` に投入できるか~~ → 投入済（ルール6 取込稼働中）。
