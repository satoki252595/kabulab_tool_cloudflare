# kabulab — 日本株投資ツール統合ポータル

**kabulab** は日本株投資を支援する Web サービス群の統合ブランド。**単一の Cloudflare Worker** に複数のサービスを Hono サブアプリとしてマウントする mono-repo として運用する。

本番URL: <https://kabulab-cf.satoki252595.workers.dev/>

| URL | 内容 |
|---|---|
| `/` | ポータルホーム (kabulab) |
| `/rsi-screening/` | 001 RSI Screening — 過去 5 年で最も底値圏にある優良株を発見 |
| `/otakara-yutai/` | 002 お宝優待 — 割安な株主優待銘柄をスコアリングで発見 |
| `/swing-trading/` | 003 Swing Trading — 数日〜2週間の短期売買を定量化 (マクロ判定 + 5 条件 + E&E 6 パターン + リスク計算機) |
| `/financial-math/` | 004 金融数学 — DCF Gordon / CAPM β自動推定 / EMH アノマリースクリーニング / Black-Scholes Greeks |
| `/yuho-quant/` | 005 有報定量検索 — EDINET 有報の受注高/受注残高をセグメント別に構造化し最大5年推移を可視化 |
| `/ir-catalog/` | 006 IR Catalog — TDnet 適時開示を全量取得し表題からタグ分類、対象タグは PDF 本文のポジ/ネガを軽量 OSS 判定 |
| `/vwap-analysis/` | 007 VWAP / 価格別出来高 — 5分足VWAP・価格別出来高 (POC/バリューエリア)・日足10年 (分割調整)・週次信用残高を多時間軸で表示 |

## プラットフォーム

旧構成 (Vercel Serverless Functions + Neon) から **Cloudflare Workers** へ移行済み。Worker は
**配信専用** (`worker/entry.ts` が `src/index.ts` の Hono root app を fetch ハンドラとして公開) で、
データ取得・加工・本番書き込みは Worker に載せず **ローカル CLI** (`scripts/sync/*`, `scripts/vwap/*`)
で実行する (D1 のみバインディング経由のため一部 Worker 側、後述)。

データストアは段階移行中:

| 種別 | ストア | 状況 |
|---|---|---|
| 正規化リレーショナル | **Neon PostgreSQL** (主) / **Cloudflare D1** | 005 yuho-quant は D1 へ移行済み ([ADR-0001](./docs/adr/0001-neon-to-d1-r2-notion.md))。他サービスは Neon。Neon 全廃 (D1+R2+Notion 化) を段階移行中 |
| 時系列ブロブ | **Cloudflare R2** (`vwap-data`) | 007 VWAP の 5分足/日足/信用残高 JSON |
| 一次データ (raw) | **Notion** | CLAUDE.md ルール6。EDINET ZIP / TDnet / 優待スクレイプ等を物理ファイルごと冪等アーカイブ |

## 環境構築

開発環境は **Nix Flake** で統一する (Node 22 + pnpm 9 を固定)。pnpm-lock は lockfileVersion 9.0 のため **pnpm 9 系**で扱う (新しい pnpm の store と衝突するため、必ず Nix の pnpm を使う)。

```bash
nix develop               # Node 22 + pnpm 9 の dev shell に入る (初回は nixpkgs 取得)
pnpm install              # 依存インストール
# direnv 利用時は `.envrc` (use flake) で cd 時に自動有効化
```

> 初回 `nix develop` には nix daemon が必要。停止している場合は `sudo launchctl bootstrap system /Library/LaunchDaemons/org.nixos.nix-daemon.plist` で起動する。

## ディレクトリ構成

```
.
├── worker/entry.ts                  # Cloudflare Worker エントリ — src/index.ts(Hono) を fetch で公開
├── wrangler.toml                    # Worker 設定 — ASSETS(public) / R2(BUCKET=vwap-data) / D1(DB=kabulab-cf)
├── src/
│   ├── index.ts                     # ルート Hono アプリ + ポータル + サブアプリ mount
│   ├── cron/                        # 取込オーケストレーション (ローカル CLI から実行)
│   │   ├── daily.ts / monthly.ts    # 日次/月次 sync (Yahoo → Neon)
│   │   ├── universe.ts              # JPX 母集団同期
│   │   ├── yuho-edinet.ts           # 005 EDINET キャッチアップ (D1。Worker 取込ルートから呼ぶ)
│   │   └── ir-catalog-tdnet.ts      # 006 TDnet キャッチアップ
│   └── shared/
│       ├── design.ts                # 共通デザイントークン
│       ├── term-tip.ts              # 投資初心者向けバルーンヘルプ (ルール7)
│       ├── auth.ts                  # cron Bearer token 認証 (CRON_SECRET)
│       ├── db/                      # D1(SQLite) 共有 core スキーマ + CF 型 (ADR-0001)
│       ├── notion-archive/          # 一次データ Notion アーカイブ (ルール6)
│       ├── yahoo/ jpx/ indicators/  # Yahoo クライアント / JPX パーサ / RSI・SMA 等の純関数
│       └── scoring.ts screener.ts patterns.ts macro.ts ...
├── services/
│   ├── rsi-screening/               # 001 (BASE_PATH=/rsi-screening)
│   ├── otakara-yutai/               # 002 (/otakara-yutai)
│   ├── swing-trading/               # 003 (/swing-trading)
│   ├── financial-math/              # 004 (/financial-math) — core/swing を読み取り専用
│   ├── yuho-quant/                  # 005 (/yuho-quant) — EDINET 受注高/残高 (D1: yuho_* テーブル)
│   ├── ir-catalog/                  # 006 (/ir-catalog) — TDnet 適時開示 + PDF センチメント
│   └── vwap-analysis/               # 007 (/vwap-analysis) — R2 の時系列を素通し配信 + 当日5分足は Yahoo 中継
├── scripts/
│   ├── sync/                        # universe / daily / monthly / all-daily / yuho-edinet / ir-tdnet
│   └── vwap/                        # ingest-daily / ingest-intra / ingest-margin (→ R2)
├── drizzle/                         # マイグレーション SQL (drizzle/d1/ = D1 用)
├── drizzle.*.config.ts              # スキーマ別 drizzle-kit 設定 (drizzle.d1.config.ts = D1)
├── public/                          # PWA 静的アセット + public/vwap-analysis/ フロント
├── docs/                            # mono-repo ドキュメント (docs/adr/ = 設計判断記録)
├── flake.nix / .envrc               # Nix devShell (Node 22 + pnpm 9)
└── package.json
```

詳細は [docs/overview.md](./docs/overview.md) を参照。

## 主要コマンド

```bash
# 開発 (nix develop 内 / pnpm 9 で実行)
pnpm install
pnpm dev:cf               # wrangler dev (Cloudflare ローカル実行)
pnpm typecheck
pnpm test
pnpm lint

# デプロイ (詳細は下記「デプロイ」節)
pnpm deploy:cf            # 本番を手動デプロイ (= wrangler deploy)

# DB スキーマ管理 (D1)
pnpm db:generate:d1       # D1(SQLite) スキーマ生成 → drizzle/d1/*.sql (適用は wrangler d1 execute)
# 注: db:push:rsi / :otakara / :swing / :finmath / :ircat は旧 Neon(pg) 用で D1 移行後は obsolete

# データ取得 (日次/月次 stock sync。本体は Worker Cron が自動実行 — 下記「運用ステータス」)
pnpm sync:daily           # 手動フル日次トリガ (Worker /admin/sync-daily を叩く + VWAP も束ねる)
pnpm sync:monthly         # 手動 月次 otakara rebuild トリガ (Worker /admin/sync-monthly)
pnpm sync:universe        # JPX 母集団 seed (xlsx=Node 専用・上場/廃止時に実行)

# データ取得 (007 VWAP → R2。cron 対象外=手動/CI)
pnpm ingest:vwap-daily    # 全銘柄の日足10年 (未取得はバックフィル, 既存は差分) → R2 daily/{code}.json
pnpm ingest:vwap-intra    # 全銘柄の5分足 (直近) を蓄積 → R2 intra/{code}.json
pnpm ingest:vwap-margin   # JPX 週次PDF (信用残高) → R2 margin/{week}.json

# データ取得 (006 TDnet → D1。Worker 取込ルートを叩く)
pnpm ingest:ir-tdnet      # /ir-catalog/admin/catchup を CRON_SECRET 認証で POST

# データ取得 (005 EDINET → D1。Worker 取込ルートを叩く)
pnpm ingest:yuho-edinet   # WORKER_BASE_URL の /yuho-quant/admin/catchup を CRON_SECRET 認証で POST
```

> **母集団**: 全 JPX 上場内国株 ~4,000 銘柄。002 otakara は `is_yutai=true` の優待銘柄のみを対象とする。
> Yahoo Finance はレート制限 (429) が厳しいため、VWAP の大量取得は低負荷 (逐次 + ディレイ) で行う。

## 運用ステータス（自動化・手作業・残タスク）

ADR-0001 で **Neon を全廃し Cloudflare D1 + R2 + Notion へ移行済み**。データ・読取・取込の現況:

### データ格納状況（直近営業日まで投入済み）

| データ | 保存先 | 規模 | 鮮度 |
|---|---|---|---|
| 日次 OHLCV + 財務 + RSI + swing 指標 | D1 | ~3,754 銘柄 | 直近営業日 |
| お宝優待 財務/スコア (`otakara_*`) | D1 | ~1,605 銘柄 | 月次 |
| 有報受注 (`yuho_*`) / 適時開示 (`ir_disclosures`) | D1 | 移行済み | 取込次第 |
| 日足10年 (007 VWAP) | R2 `daily/{code}.json` | 4,444 銘柄 | 直近 |
| **5分足** (007 VWAP) | R2 `intra/{code}.json` | 4,243 銘柄 | 直近 |
| 信用残高 (週次) | R2 `margin/{week}.json` | 週次 | 直近週 |
| 一次データ (raw) | Notion | サービス別 | 取込次第 |

### 自動化（Workers Cron・**要 Workers Paid + デプロイ**）

デプロイ後、Worker の Cron Trigger が自動実行する（`wrangler.toml [triggers]` / `src/cron/scheduled.ts`）:

- **日次 stock sync** … 平日 20:00 UTC〜（4 シャード・3 分間隔）。core/rsi/swing の財務・指標・OHLCV を D1 へ。Yahoo はエッジ直叩きで 429 回避、`db.batch` + 増分 OHLCV。
- **月次 otakara rebuild** … 毎月 1 日 22:00 UTC。core/swing から otakara 財務/スコアを再構築。

push→自動デプロイは **Cloudflare Workers Builds**（Git 連携）。手順は [docs/deploy-cloudflare.md](./docs/deploy-cloudflare.md)。

### ⚠️ まだ手作業（Worker Cron 未配線・Node 実行）

以下は Phase 3 の Worker Cron に**含まれない**。ローカル/CI で実行する（将来 GitHub Actions 等で自動化可・`scripts/vwap/lib/r2.ts` は GitHub Actions 実行を想定済み）:

| 処理 | コマンド | 頻度 | 備考 |
|---|---|---|---|
| JPX 母集団同期 | `pnpm sync:universe` | 上場/廃止時 | xlsx パーサが Node 専用 → Worker 不可 |
| VWAP 日足10年 → R2 | `pnpm ingest:vwap-daily` | 日次 | Yahoo。`YAHOO_PROXY_BASE` でエッジ経由 429 回避 |
| **VWAP 5分足 → R2** | `pnpm ingest:vwap-intra` | 日次 | 同上・**Phase 3 cron 対象外** |
| 信用残高 → R2 | `pnpm ingest:vwap-margin` | 週次 | JPX PDF |
| 適時開示 (006) | `pnpm ingest:ir-tdnet` | 日次 | Worker `/ir-catalog/admin/catchup` を叩く薄いトリガ |
| 有報 (005) | `pnpm ingest:yuho-edinet` | 日次 | Worker `/yuho-quant/admin/catchup` を叩く薄いトリガ |
| 優待スクレイプ+LLM解釈 (002) | data-scripts 4 step（後述） | 月次 | step3 はローカル OSS LLM |

> `pnpm sync:daily`(= `all-daily.ts`) はローカルからの手動フル実行用で、上記 VWAP も束ねて叩く。日次 stock sync 本体は Worker Cron が担うため、通常は cron に任せてよい（VWAP のみ手動 or CI が必要）。

### 残タスク

1. **【未実施・要対応】Workers Paid 化 → 自動デプロイ稼働**
   - Paid へアップグレード（cron / `[limits] cpu_ms` / 10,000 subrequests に必須）
   - Workers Builds は接続済み。**PR #1（`feat/d1-r2-migration`）を `main` にマージ**すると初回自動デプロイ + cron 登録。
   - デプロイ後: 本番ページが D1 から読めること + Triggers に cron 5 本を確認 → **Neon 解約**。
2. **VWAP / EDINET / TDnet / 優待スクレイプの定期自動化**（任意）… GitHub Actions 等へ。
3. **legacy 掃除**（一部完了・残りは非ブロッキング）… ✅ 旧 Neon DB 管理スクリプト `scripts/db/*.mjs` は削除済み。残: `db:push:*` / `drizzle.<svc>.config.ts`（pg dialect・D1 移行で obsolete）、`scripts/full-validation*.mjs` / `get-jpx-listing.mjs`（Neon 依存の dev one-off）、`services/otakara-yutai/src/index.ts`（dead code・ビルド除外）。Neon 解約後に削除でよい。

## デプロイ

Cloudflare Worker **`kabulab-cf`** を `wrangler` で更新する。

```bash
pnpm deploy:cf            # = wrangler deploy (本番反映)
npx wrangler deployments list    # デプロイ履歴確認
npx wrangler tail                # 本番ログをストリーム
```

**前提条件**:

1. **Cloudflare ログイン済み** — `npx wrangler login` (OAuth)。`npx wrangler whoami` でアカウント確認。
2. **バインディング** (`wrangler.toml`):
   - `ASSETS` … `public/` の静的アセット
   - `BUCKET` … R2 バケット `vwap-data` (VWAP 時系列)
   - `DB` … D1 データベース `kabulab-cf` (005 yuho-quant。ADR-0001)
3. **シークレットは Cloudflare が正のソース** — `wrangler secret put DATABASE_URL` 等で設定する
   (`.env` はローカル開発/取込専用で、本番 Worker には読まれない)。Worker は `nodejs_compat` 有効で
   secret を `process.env` 経由でも参照する。
4. **Workers Cron Trigger 配置済み (ADR-0001 Phase 3)** — `wrangler.toml [triggers]` に日次 stock sync
   (4 シャード) + 月次 otakara rebuild を配線。デプロイ時に自動登録される (**要 Workers Paid**)。VWAP /
   EDINET / TDnet / 優待スクレイプは cron 対象外で別途 Node 実行 (上記「運用ステータス」参照)。
5. **push→自動デプロイ** — Cloudflare Workers Builds (Git 連携) を接続済み。`main` への push で
   自動 build & deploy + cron 自動登録。手順・前提は [docs/deploy-cloudflare.md](./docs/deploy-cloudflare.md)。

## 環境変数

`.env.example` を参考にローカル `.env` を作成する (取込 CLI が読む)。本番 Worker 側は Cloudflare の
Secret が正のソース。

```
DATABASE_URL=postgresql://user:password@host/database?sslmode=require  # 旧 Neon (cutover 移行ツール専用・本番未使用。解約後は不要)
CRON_SECRET=your-cron-secret-here                                      # 取込ルート/cron 認証
EDINET_API_KEY=your-edinet-subscription-key-here                       # 005 yuho-quant
NOTION_TOKEN=ntn_xxx                                                   # 一次データ Notion アーカイブ (ルール6)
NOTION_BACKUP_PAGE_ID=<notion-backup-page-id>                          # 「バックアップ」ページ ID
NOTION_TRASH_PAGE_ID=<notion-trash-page-id>                            # 「ごみ」ページ ID
R2_ACCOUNT_ID=<cloudflare-account-id>                                  # 007 VWAP の R2 書込 (S3互換)
R2_ACCESS_KEY_ID=<r2-access-key-id>
R2_SECRET_ACCESS_KEY=<r2-secret-access-key>
R2_BUCKET=vwap-data
WORKER_BASE_URL=https://kabulab-cf.<subdomain>.workers.dev             # 005 取込トリガ CLI が叩く Worker
```

> R2 の Access Key は Cloudflare ダッシュボード → R2 → Overview → Account details → API Tokens
> 「Manage」→ Object Read & Write で発行する (Secret は発行時のみ表示)。

### D1 スキーマ（全サービス・単一 `kabulab-cf` に接頭辞テーブルで同居）

ADR-0001 で全サービスを Neon → D1 (SQLite) へ移行済み。共有 core を各サービスが参照する:

| 接頭辞 | 所有 | 主なテーブル |
|---|---|---|
| `core_*` | 日次 sync が更新 (他は読取専用) | `core_stocks` / `core_stock_financials` / `core_stock_annual_financials` (`src/shared/db/core-schema.ts` が正本) |
| `rsi_*` | 001 RSI Screening | `rsi_percentile` (RSI 10/40/120 + パーセンタイル + 優良株フラグ) |
| `yutai_*` / `otakara_*` | 002 お宝優待 | `yutai_genres` / `yutai_benefits` / `otakara_stock_financials` / `otakara_stock_scores` |
| `swing_*` | 003 Swing Trading | `swing_daily_ohlcv` (90 営業日) / `swing_stock_indicators` / `swing_stock_screening` / `swing_entry_signals` / `swing_market_context` / `swing_sector_daily` |
| `finmath_*` | 004 金融数学 | `finmath_price_snapshot` / `finmath_daily_ohlcv` (Yahoo 由来の遅延キャッシュ・空起動でエッジ再取得)。`core_*` / `swing_*` も読取参照 |
| `yuho_*` | 005 有報定量 | `yuho_documents` / `yuho_order_facts` |
| `ir_disclosures` | 006 IR Catalog | `ir_disclosures` (TDnet 全量 + タグ + PDF センチメント) |

時系列 (VWAP) は R2、一次データ (raw) は Notion。スキーマ生成は `pnpm db:generate:d1` → `drizzle/d1/*.sql` を `wrangler d1 execute kabulab-cf --remote --file=...` で適用。

## 運用 / 定点ジョブ

日次 stock sync + 月次 otakara rebuild は **Worker Cron が自動実行**する（デプロイ後・要 Paid。
詳細は上記「運用ステータス」）。以下は **cron 対象外で手動 (or CI) 実行**する取込:

```bash
# 母集団 (JPX) — 上場/廃止があった時
pnpm sync:universe

# 007 VWAP → R2 (Yahoo 429 を避け低負荷で。YAHOO_PROXY_BASE 経由推奨)
pnpm ingest:vwap-daily  # 日足10年
pnpm ingest:vwap-intra  # 5分足
pnpm ingest:vwap-margin # 信用残高 (週次・JPX PDF・Yahoo 非依存)

# 006 TDnet / 005 EDINET — デプロイ済み Worker の /admin/catchup を叩く薄いトリガ
pnpm ingest:ir-tdnet
pnpm ingest:yuho-edinet

# 手動フル日次 (上記 VWAP も束ねて叩く・ローカル実行用)。stock sync 本体は cron に任せてよい
pnpm sync:daily
```

### 優待データ取込パイプライン (002 otakara, data-scripts・cron 非対象)

優待情報 (`is_yutai` フラグ + `yutai_benefits` + `short_summary`/`estimated_value`) は統一 sync とは
別系統。step3 は完全ローカルの OSS LLM (node-llama-cpp) で実行され、クラウド API も従量課金も発生
しない。初回のみ GGUF モデル (数 GB) を自動 DL する (要ネット)。

```bash
pnpm exec tsx services/otakara-yutai/data-scripts/fetch-yutai-full.ts          # 1. minkabu スクレイプ → 本番 DB
pnpm exec tsx services/otakara-yutai/data-scripts/export-benefit-descriptions.ts # 2. ユニーク description 抽出
pnpm interpret:yutai                                                            # 3. ローカル LLM で解釈 (冪等・再開可能)
pnpm exec tsx services/otakara-yutai/data-scripts/apply-benefit-interpretations.ts # 4. 解釈を DB に反映
```

- 既に最新の `yutai_benefits` があれば step1 はスキップ可 (`2 → 3 → 4` のみ)。
- **step3 は冪等・再開可能**: 途中停止しても再実行で未処理バッチから継続。
- **step4 を実行しないと** otakara の `short_summary`/`estimated_value` に反映されない。

### 一次データの Notion アーカイブ (CLAUDE.md ルール6)

外部 API / スクレイピングで取得した一次データ (EDINET 有報 ZIP、JPX 上場銘柄 XLS、優待スクレイプの
確定 JSONL 等) は、構造化保存とは別に **[`src/shared/notion-archive/`](./src/shared/notion-archive/)**
経由で Notion「バックアップ」ページ配下へ物理ファイルごと冪等記録する。

- 唯一の窓口は `recordPrimaryData()` / `moveToTrash()` / `isArchived()`。**`api.notion.com` を直接
  叩かない** — `client.ts` が ~3req/s 直列化・429/5xx リトライを一元管理。
- ページ配下に `一次データ｜<service>` / `ごみ｜<service>` のサービス別 DB を自動生成 (区切りは全角縦棒 U+FF5C)。
- 環境変数 `NOTION_TOKEN` / `NOTION_BACKUP_PAGE_ID` / `NOTION_TRASH_PAGE_ID` (上記「環境変数」参照)。

### よくある障害と対処

| 症状 | 原因 | 対処 |
|---|---|---|
| VWAP の日足/5分足が「未取得」 | Yahoo Finance の 429 (IP レート制限) で未投入 | 別回線/時間を空けて低負荷 (逐次 + ディレイ) で `ingest:vwap-*` を再実行 |
| マクロ判定が `HOLD` のまま | 日経電子版の HTML 構造変更 or 到達不能 | `src/shared/yahoo/nikkei-vi.ts` を確認 (silent に B/C 判定しない・ルール2) |
| セクター一覧が "未分類" 1 件 | `core.stocks.sector` が NULL (初回 or JPX URL 変更) | `pnpm sync:monthly` を手動実行 |
| Yahoo rate limit で失敗多発 | crumb 期限切れ or 上限超過 | 並列度を下げる (`CONC` / `DELAY_MS`)、翌日再試行 |
| 005 yuho-quant が空表示 | D1 へ未投入 (cutover 前) | ADR-0001 §7 の Neon→D1 移送、または `ingest:yuho-edinet` で取込 |

## 新サービスの追加

[docs/new-project-template.md](./docs/new-project-template.md) を参照。要点:

1. `services/<slug>/` を作成し `app.ts` で Hono サブアプリを定義
2. ルート `src/index.ts` で `app.route(BASE_PATH, subapp)` mount + `SERVICES` 配列に追加
3. **JSX は使えない** — ビューは template literal を返す `.ts` 関数として実装
4. **Hono サブアプリは `new Hono({ strict: false })`** で生成 (trailing slash 吸収)
5. **POST フォームの optional フィールド**は `z.preprocess((v) => v === "" ? undefined : v, ...)` で
   空文字列を `undefined` に正規化する (HTML form の標準挙動)
6. **専門用語にはバルーンヘルプ** (ルール7) — `src/shared/term-tip.ts` の `termTip()` を使う

## デザインシステム

すべてのサービスは **Editorial Swiss Grid**（白黒×ニューブルータリスト）を共有。詳細は
[docs/overview.md](./docs/overview.md) の「デザインシステム」セクション。共通トークンは
[`src/shared/design.ts`](./src/shared/design.ts) に集約。

## 開発ルール

実装時の絶対ルール (ダミーデータ禁止 / フォールバック禁止 / env は `.env` + 型付きアクセサ /
コミット前の多角エージェント精査 / 一次データの Notion アーカイブ / 専門用語のバルーンヘルプ 等) は
[CLAUDE.md](./CLAUDE.md) と各 `services/<slug>/CLAUDE.md` に定義。
