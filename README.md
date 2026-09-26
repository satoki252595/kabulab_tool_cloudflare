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

旧構成 (Vercel Serverless Functions + Neon) から **Cloudflare Workers + Hono** へ移行済み
(2026-06 確定。経緯は git 履歴)。Worker は **配信専用**
(`worker/entry.ts` が `src/index.ts` の Hono root app を fetch ハンドラとして公開) で、読取は
**D1 バインディング** (`c.env.DB`) 経由。データ取得・加工・本番書き込みは Worker に載せず
**Node (GitHub Actions)** で実行し、`createD1HttpDb` (D1 REST) で書き込む (後述)。

データストア:

| 種別 | ストア | 状況 |
|---|---|---|
| 正規化リレーショナル | **Cloudflare D1** (SQLite) | 全サービスを単一 DB `kabulab-cf` に接頭辞テーブルで同居。Drizzle ORM は `drizzle-orm/d1` + sqlite-core |
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
│   ├── cron/                        # 取込オーケストレーション (Node / GitHub Actions から実行)
│   │   ├── daily.ts / monthly.ts    # 日次/月次 sync (Yahoo → D1。D1 REST 書込)
│   │   ├── universe.ts              # JPX 母集団同期
│   │   ├── yuho-edinet.ts           # 005 EDINET キャッチアップ (D1。Worker 取込ルートから呼ぶ)
│   │   └── ir-catalog-tdnet.ts      # 006 TDnet キャッチアップ
│   └── shared/
│       ├── design.ts                # 共通デザイントークン
│       ├── term-tip.ts              # 投資初心者向けバルーンヘルプ (ルール7)
│       ├── auth.ts                  # cron Bearer token 認証 (CRON_SECRET)
│       ├── db/                      # D1(SQLite) 共有 core スキーマ + CF 型
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
├── drizzle.d1.config.ts             # drizzle-kit 設定 (D1)。旧 drizzle.<svc>.config.ts(pg) は obsolete
├── public/                          # PWA 静的アセット + public/vwap-analysis/ フロント
├── docs/                            # mono-repo ドキュメント (概要=overview.md / 設計判断は git 履歴)
├── flake.nix / .envrc               # Nix devShell (Node 22 + pnpm 9)
└── package.json
```

詳細は [docs/overview.md](./docs/overview.md) を参照。変更履歴は [docs/release-notes.md](./docs/release-notes.md)。

## 主要コマンド

```bash
# 開発 (nix develop 内 / pnpm 9 で実行)
pnpm install
pnpm dev:cf               # wrangler dev (Cloudflare ローカル実行)
pnpm typecheck
pnpm test
pnpm lint
# ⚠️ 上記 3 つが緑でも検査されていない範囲がある。tsconfig の exclude は実質なし
#    (node_modules/dist のみ。経緯は tsconfig.json のコメント) だが、include 対象は
#    src・services・scripts・*.config.ts のみで worker/・tests/ は tsc の対象外。
#    lint は src + services のみ (scripts・worker・config は対象外)。
#    詳細は docs/ci-typecheck-blind-spots.md

# デプロイ (詳細は下記「デプロイ」節)
pnpm deploy:cf            # 本番を手動デプロイ (= wrangler deploy)

# DB スキーマ管理 (D1)
pnpm db:generate:d1       # D1(SQLite) スキーマ生成 → drizzle/d1/*.sql (適用は wrangler d1 execute)
# 注: 旧 Neon(pg) 用の db:push:* / db:generate:<svc> / db:studio:* は K1a で削除済み

# データ取得 (日次/月次 stock sync。本体は GitHub Actions が自動実行 — 下記「運用ステータス」)
pnpm sync:daily:core      # core/rsi/swing 日次 (Node → D1 REST。GitHub Actions と同じ本体)
pnpm sync:daily           # 手動フル日次 (上記 core + VWAP 日足/5分足/信用残高)
pnpm sync:monthly:core    # otakara 派生テーブル rebuild (Node → D1 REST、Yahoo なし)
pnpm sync:monthly         # 手動フル月次 (上記 rebuild + 優待取得/抽出/要約タスク書き出し。要約は外部のクラウド LLM)
pnpm sync:universe        # 東証内国株の母集団 seed (xlsx=Node 専用・月次/復旧時に実行)

# データ取得 (007 VWAP → R2。cron 対象外=手動/CI)
pnpm ingest:vwap-daily    # 全銘柄の日足10年 (未取得はバックフィル, 既存は差分) → R2 daily/{code}.json
pnpm ingest:vwap-intra    # 全銘柄の5分足 (直近) を蓄積 → R2 intra/{code}.json
pnpm ingest:vwap-margin   # JPX 週次PDF (信用残高) → R2 margin/{week}.json

# データ取得 (006 TDnet → D1。Worker 取込ルートを叩く)
pnpm ingest:ir-tdnet      # /ir-catalog/admin/catchup を CRON_SECRET 認証で POST

# データ取得 (005 EDINET → D1。Worker 取込ルートを叩く)
pnpm ingest:yuho-edinet   # WORKER_BASE_URL の /yuho-quant/admin/catchup を CRON_SECRET 認証で POST

# 事業タグ (005 EDINET 取込の次に実行。D1 は読むだけ・書込は Notion のみ)
pnpm biztag run           # 事業タグ判定 (差分処理。詳細は docs/005-yuho-quant-business-tags.md §11)
```

> **母集団**: JPX `data_j.xlsx` に載る東証プライム／スタンダード／グロースの
> 内国株式のうち、共有 4 文字コード契約に合う約 3,700 銘柄。地域市場の
> 単独上場銘柄と 5 桁種類株は対象外。002 otakara はさらに
> `is_yutai=true` の優待銘柄のみを対象とする。
> Yahoo Finance はレート制限 (429) が厳しいため、VWAP の大量取得は低負荷 (逐次 + ディレイ) で行う。

## 運用ステータス（自動化・手作業・残タスク）

**Neon を全廃し Cloudflare D1 + R2 + Notion へ移行済み**。データ・読取・取込の現況
(規模の数値は 09-13 受入時点。変動する):

### データ格納状況（直近営業日まで投入済み）

| データ | 保存先 | 規模 | 鮮度 |
|---|---|---|---|
| 日次 OHLCV + 財務 + RSI + swing 指標 | D1 | ~3,700 銘柄 | 直近営業日 |
| お宝優待 財務/スコア (`otakara_*`) | D1 | ~1,605 銘柄 | 月次 |
| 有報受注 (`yuho_*`) / 適時開示 (`ir_disclosures`) | D1 | 移行済み | 取込次第 |
| 日足10年 (007 VWAP) | R2 `daily/{code}.json` | 4,444 銘柄 | 直近 |
| **5分足** (007 VWAP) | R2 `intra/{code}.json` | 4,243 銘柄 | 直近 |
| 信用残高 (週次) | R2 `margin/{week}.json` | 週次 | 直近週 |
| 一次データ (raw) | Notion | サービス別 | 取込次第 |

### 自動化（GitHub Actions・**Workers Paid 不要**）

取込はすべて GitHub Actions(Node)で定期実行する。Yahoo は共有クライアントが
`YAHOO_PROXY_BASE`(Cloudflare エッジの `/api/ingest/yahoo` に一本化)経由で
叩くため、ランナー IP の 429 を回避する。
D1 へは `createD1HttpDb`(D1 REST)で書き込む。

| ワークフロー | 内容 | スケジュール (UTC) |
|---|---|---|
| `.github/workflows/stock-sync.yml` | 日次=core/rsi/swing 取得+指標+**増分 OHLCV** / 月次=東証母集団同期 + otakara rebuild | 平日 21:00 / 10 日 01:30 |
| `.github/workflows/vwap-ingest.yml` | 日足10年 + **5分足** → R2 / 信用残高(週次) | 月水金 08:00 / 土 09:00 |
| `.github/workflows/catchup.yml` | 005 有報(EDINET) + 006 適時開示(TDnet) キャッチアップ(TDnet=Node, EDINET=Worker ルート) + 005 事業タグ(biztag。Node → Notion) | 平日 11:00 |
| `.github/workflows/ci.yml` | 型・lint・単体テスト + 地図突合 + D1 generate 差分 | push/PR 毎 (cron なし) |

Worker は **無料プラン**で、サイト配信(D1 読取)+ 取込プロキシ + 005/006 の
`/admin/catchup` のみを担う(Workers Cron は使わない)。schedule は **main にマージ後**に
有効化される(GitHub Actions の schedule は default ブランチのみ)。

> 💡 実行時間の目安 (public repo のため Actions 分課金は無し): 日次 stock(~40-50分)×平日 +
> VWAP(月水金。差分時は数十分、バックフィル時は 2-3h 域。timeout 300 分) ≈ 月
> 1,300-1,600 分(バックフィル除く)。

### 手作業のまま（任意・低頻度）

| 処理 | コマンド | 備考 |
|---|---|---|
| 優待スクレイプ+LLM要約 (002) | data-scripts（後述） | 要約はリポジトリ外のクラウド LLM (Cursor Automations 等) が行い、結果を検証して取り込む |

> `pnpm sync:daily`(= `all-daily.ts`)はローカル手動フル実行用(stock + VWAP を束ねる)。
> 通常は GitHub Actions に任せてよい。

### 残タスク

1. **Neon 解約** (あなたの手作業。Neon コンソールで実施) — 解約後は `.env`/GH Secret の
   `DATABASE_URL` を削除してよい。
2. **GH Secret `WORKER_BASE_URL`** (= Worker URL) — catchup.yml(EDINET/TDnet)用。未追加なら追加。
3. **文書リフレッシュ** — 各サービス CLAUDE.md/README の Neon/Vercel 期記述を現行に合わせる
   (K5c で順次実施中)。

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
   - `DB` … D1 データベース `kabulab-cf` (全サービス共有の単一 DB)
3. **シークレットは Cloudflare が正のソース** — `wrangler secret put DATABASE_URL` 等で設定する
   (`.env` はローカル開発/取込専用で、本番 Worker には読まれない)。Worker は `nodejs_compat` 有効で
   secret を `process.env` 経由でも参照する。
4. **Workers Cron は不使用（Workers Paid 不要）** — 取込(日次/月次 stock + VWAP)は
   GitHub Actions(Node)で実行する。`wrangler.toml` に `[triggers]`/`[limits]` は無い。Worker は
   サイト配信 + 取込プロキシ(`/api/ingest/yahoo`)+ 005/006 の
   `/admin/catchup` のみ。
5. **push→自動デプロイ** — Cloudflare Workers Builds (Git 連携) を接続済み。`main` への push で
   **無料プランのまま**自動 build & deploy。手順は [docs/deploy-cloudflare.md](./docs/deploy-cloudflare.md)。

## 環境変数

`.env.example` を参考にローカル `.env` を作成する (取込 CLI が読む)。本番 Worker 側は Cloudflare の
Secret が正のソース。

```
CRON_SECRET=your-cron-secret-here                                      # 取込ルート/cron 認証
EDINET_API_KEY=your-edinet-subscription-key-here                       # 005 yuho-quant
NOTION_TOKEN=ntn_xxx                                                   # 一次データ Notion アーカイブ (ルール6)
NOTION_ARCHIVE_PAGE_ID=<notion-archive-page-id>                        # 「一次データ保管」ページ ID (一次データ/銘柄別/ごみ 全部)
NOTION_YUHO_TEXT_DB_ID=<notion-yuho-text-db-id>                        # 有報テキスト (単一DB) ID
R2_ACCOUNT_ID=<cloudflare-account-id>                                  # 007 VWAP の R2 書込 (S3互換)
R2_ACCESS_KEY_ID=<r2-access-key-id>
R2_SECRET_ACCESS_KEY=<r2-secret-access-key>
R2_BUCKET=vwap-data
WORKER_BASE_URL=https://kabulab-cf.<subdomain>.workers.dev             # 005 取込トリガ CLI が叩く Worker
```

> R2 の Access Key は Cloudflare ダッシュボード → R2 → Overview → Account details → API Tokens
> 「Manage」→ Object Read & Write で発行する (Secret は発行時のみ表示)。

### D1 スキーマ（全サービス・単一 `kabulab-cf` に接頭辞テーブルで同居）

全サービスを Neon → D1 (SQLite) へ移行済み。共有 core を各サービスが参照する
(0017 時点の実効テーブル。DROP 済みは除く):

| 接頭辞 | 所有 | 主なテーブル |
|---|---|---|
| `core_*` | 日次 sync が更新 (他は読取専用) | `core_stocks` / `core_stock_financials` / `core_stock_annual_financials` (`src/shared/db/core-schema.ts` が正本) |
| `rsi_*` | 001 RSI Screening | `rsi_percentile` (RSI 10/40/120 + パーセンタイル + 優良株フラグ) |
| `yutai_*` / `otakara_*` | 002 お宝優待 | `yutai_genres` / `yutai_benefits` / `otakara_stock_financials` / `otakara_stock_scores` |
| `swing_*` | 003 Swing Trading | `swing_daily_ohlcv` (90 営業日) / `swing_stock_indicators` / `swing_entry_signals` / `swing_market_context` / `swing_sector_daily` (旧 `swing_stock_screening` は 0015 で削除) |
| (なし) | 004 金融数学 | 所有する表は無い。`core_stock_financials` / `swing_daily_ohlcv` / `swing_market_context` / `p_momentum` を読取参照 (旧 `finmath_*` 2 表は 0012 で削除) |
| `yuho_*` | 005 有報定量 | `yuho_documents` / `yuho_order_facts` / `yuho_overseas_facts` |
| `p_*` | 日次 sync が更新 (L2 投影) | `p_momentum` (004 EMH が参照) / `p_yuho_growth` (005 が参照。0017 で追加) |
| `ir_disclosures` | 006 IR Catalog | `ir_disclosures` (TDnet 全量 + タグ + PDF センチメント) |

時系列 (VWAP) は R2、一次データ (raw) は Notion。スキーマ生成は `pnpm db:generate:d1` → `drizzle/d1/*.sql` を `wrangler d1 execute kabulab-cf --remote --file=...` で適用。

## 運用 / 定点ジョブ

日次 stock sync + 月次 otakara rebuild は **GitHub Actions が自動実行**する（Workers Paid 不要・
Workers Cron は使わない。詳細は上記「運用ステータス」）。以下は **定期取込の対象外で手動 (or CI) 実行**する取込:

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
別系統。要約 (`short_summary`) と推定金額はこのリポジトリでは作らず、**リポジトリ外のクラウド LLM
(Cursor Automations 等)** が [作業仕様書](./services/otakara-yutai/docs/llm-summary-task.md) に従って作る。
このリポジトリはタスクの書き出しと、結果の検証・取り込みだけを持つ (LLM の出力は信用しない)。

```bash
pnpm exec tsx services/otakara-yutai/data-scripts/fetch-yutai-full.ts          # 1. minkabu スクレイプ → 本番 DB
pnpm exec tsx services/otakara-yutai/data-scripts/export-benefit-descriptions.ts # 2. ユニーク description 抽出 (Notion 一次データ記録)
pnpm yutai:summary:export                                                       # 3. 要約タスク書き出し (--violations-only で契約違反だけ)
#    → タスクファイルと作業仕様書をクラウド LLM に渡し、結果 JSONL を受け取る (どちらもコミットしない)
pnpm yutai:summary:import --tasks <タスク> --results <結果>                      # 4. dry-run: 書く件数・はじいた行と理由
pnpm yutai:summary:import --tasks <タスク> --results <結果> --apply              # 5. 通った行だけ D1 に書く
```

- タスク / 結果ファイルは出典サイトの掲載文を含むので、`services/otakara-yutai/data-scripts/data/` (gitignore 済み) かリポジトリ外にだけ置く。コマンドはそれ以外を指定すると止まる。
- 取り込みは要約契約 (`summary-contract.ts`)・金額ガード (`estimated-value-guard.ts`)・`taskId` と今の D1 の一致を検査し、違反した行だけをはじく。
- `pnpm sync:monthly` は 1〜3 までを実行し、要約が未反映でも失敗にしない (取り込み手順をログに出す)。
- クラウド LLM の費用は Cursor 等の契約側で発生し、このリポジトリの原価には乗らない。

### 一次データの Notion アーカイブ (CLAUDE.md ルール6)

外部 API / スクレイピングで取得した一次データ (EDINET 有報 ZIP、JPX 上場銘柄 XLS、優待スクレイプの
確定 JSONL 等) は、構造化保存とは別に **[`src/shared/notion-archive/`](./src/shared/notion-archive/)**
経由で Notion「一次データ保管」ページ配下へ物理ファイルごと冪等記録する。

- 唯一の窓口は `recordPrimaryData()` / `moveToTrash()` / `isArchived()`。**`api.notion.com` を直接
  叩かない** — `client.ts` が ~3req/s 直列化・429/5xx リトライを一元管理。
- ページ配下に `一次データ｜<service>` / `銘柄一覧｜<service>` / `ごみ｜<service>` のサービス別 DB を
  自動生成 (区切りは全角縦棒 U+FF5C)。**銘柄別の子ページ/子DBを大量に作らない**
  (2026-09-25 に per-stock 子ページが数千件累積して旧「バックアップ」ページが開けなくなった教訓。
  有報テキストは全銘柄共通の単一 DB — `stock-text.ts`)。
- 環境変数 `NOTION_TOKEN` / `NOTION_ARCHIVE_PAGE_ID` / `NOTION_YUHO_TEXT_DB_ID` (上記「環境変数」参照)。

### よくある障害と対処

| 症状 | 原因 | 対処 |
|---|---|---|
| VWAP の日足/5分足が「未取得」 | Yahoo Finance の 429 (IP レート制限) で未投入 | 別回線/時間を空けて低負荷 (逐次 + ディレイ) で `ingest:vwap-*` を再実行 |
| マクロ判定が `HOLD` のまま | 日経電子版の HTML 構造変更 or 到達不能 | `src/shared/yahoo/nikkei-vi.ts` を確認 (silent に B/C 判定しない・ルール2) |
| セクター一覧が "未分類" 1 件 | `core.stocks.sector` が NULL (初回 or JPX URL 変更) | `pnpm sync:universe` を手動実行。必要なら続けて `pnpm sync:monthly:core` |
| Yahoo rate limit で失敗多発 | crumb 期限切れ or 上限超過 | 並列度を下げる (`CONC` / `DELAY_MS`)、翌日再試行 |
| 005 yuho-quant が空表示 | D1 へ未投入 | `pnpm ingest:yuho-edinet` で EDINET から取込 (要 `WORKER_BASE_URL` + `CRON_SECRET`) |

### クラウドコスト監視と休止中のサービス

- **Workers AI (RTN) の超過課金 (2026-09-21 確認)**: 31 日で 609k Neurons 使用
  (込み 310k を超過した 299k 分が課金対象・約 $3.30)。平均 約19.6k Neurons/日で
  無料枠 (10k/日) の約2倍。
- **原因**: kabuMCP (本リポジトリ外の別サービス。同一 Cloudflare アカウント) の
  管理者チャットが `@cf/openai/gpt-oss-120b` を AI Gateway (`.../ai/v1`) 経由で
  呼び出し、1 質問で財務ツールを複数回回すため Neurons が膨らむ。
  kabulab-cf 自体は Workers AI を使っておらず Neurons を消費しない。
- **対応**: kabuMCP を休止する (2026-09-21 決定)。Cloudflare に Worker の
  一時停止ボタンは無いため、確実な休止 = kabuMCP 側での Worker 削除
  (再開は再デプロイ) または管理者チャットの無効化。実施後に本節の状態を更新する。
- **再開条件**: AI Gateway キャッシュ・小型モデル化・Neurons 予算アラートの
  いずれかで日次使用量が無料枠内に収まる見込みが立つこと。

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
