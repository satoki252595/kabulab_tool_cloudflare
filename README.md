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
| `/vwap-analysis/` | 007 VWAP / 価格別出来高 — 5分足VWAP・価格別出来高 (POC/バリューエリア)・日足10年 (分割調整)・信用残高を多時間軸で表示 |

## プラットフォーム

旧構成 (Vercel Serverless Functions + Neon) から **Cloudflare Workers + Hono** へ移行済み
(2026-06 確定。経緯は git 履歴)。Worker はサイト配信・取得プロキシと
**CronによるActionsの起動・結果監視**を担い、読取は **D1 バインディング** (`c.env.DB`) 経由。
重いデータ取得・加工は **Node/Python (GitHub Actions)**、事業タグ・優待要約は
**Macの定期実行環境**で行う。NodeのD1書込は `createD1HttpDb` (D1 REST) 経由。

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
├── worker/entry.ts                  # Cloudflare Worker エントリ — fetch + scheduled 起動・監視
├── wrangler.toml                    # Worker 設定 — ASSETS(public) / R2(BUCKET=vwap-data) / D1(DB=kabulab-cf)
├── src/
│   ├── index.ts                     # ルート Hono アプリ + ポータル + サブアプリ mount
│   ├── cron/                        # 取込オーケストレーション (Node / GitHub Actions から実行)
│   │   ├── daily.ts / monthly.ts    # 日次/月次 sync (Yahoo → D1。D1 REST 書込)
│   │   ├── universe.ts              # JPX 母集団同期
│   │   ├── yuho-edinet.ts           # 005 EDINET キャッチアップ (Node 日次 CLI / Worker ルート共通)
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
│   └── vwap-analysis/               # 007 (/vwap-analysis) — R2 の保存済み日足・5分足・信用残を配信
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
pnpm sync:monthly         # Mac用フル月次 (優待取得 → rebuild → ローカル機械要約。Linuxは下表の3段階)
pnpm sync:universe        # 東証内国株の母集団 seed (xlsx=Node 専用・月次/復旧時に実行)

# データ取得 (007 VWAP → R2。定期workflowと同じ本体)
pnpm ingest:vwap-daily    # 全銘柄の日足10年 (未取得はバックフィル, 既存は差分) → R2 daily/{code}.json
pnpm ingest:vwap-intra    # 全銘柄の5分足 (直近) を蓄積 → R2 intra/{code}.json
pnpm ingest:vwap-margin   # JPX公表PDF (信用残高) → R2

# データ取得 (006 TDnet → D1。Nodeが共通処理を直接実行)
pnpm ingest:ir-tdnet      # 原本Notion保管・本文抽出 → D1

# データ取得 (005 EDINET → D1。Node が共通処理を直接実行)
pnpm ingest:yuho-edinet   # Node 共通取込 + D1 HTTP atomic sender (EDINET/D1/Notion 設定必須)

# 事業タグ (本番の唯一writerはMac定期環境。原本・本文の準備後に実行)
pnpm biztag run           # 事業タグ判定 (差分処理。詳細は docs/005-yuho-quant-business-tags.md §11)
```

> **母集団**: JPX `data_j.xlsx` に載る東証プライム／スタンダード／グロースの
> 内国株式のうち、共有 4 文字コード契約に合う約 3,700 銘柄。地域市場の
> 単独上場銘柄と 5 桁種類株は対象外。002 otakara はさらに
> `is_yutai=true` の優待銘柄のみを対象とする。
> Yahoo Finance はレート制限 (429) が厳しいため、VWAP の大量取得は低負荷 (逐次 + ディレイ) で行う。

## 本番の定期処理・先行条件・LLM利用

確認日: **2026-10-18**。時刻は **JST**。Cloudflareが起動・結果監視を担い、取得本体はActionsまたはMacで実行する。
原本はNotionに物理保管し、構造化データはD1、時系列・実行receiptはR2へ保存する。

| 処理 | 予定時刻・頻度 | 必要な先行条件・順序 | LLM利用（定期実行） |
| --- | --- | --- | --- |
| 日証金の貸借・需給 | 平日12:17 | 公表済みの当日CSV。株式同期の完了待ちは不要 | なし |
| VWAP日足・5分足 | 月水金17:00、CF起動 | 公式銘柄表・対象日の原本資格。Yahoo共通排他内で日足→5分足、結果不明では後続停止 | なし |
| 市場の信用残高 | 平日17:00 | 公表元の対象日資料。株価とのデータ依存はないが、現在はVWAPと共通workflow排他 | なし |
| 株価・財務断面・RSI・スイング・モメンタム・業種騰落 | 平日18:00、CF起動 | 母集団と通常取得原本。指標は価格・分割単位の資格確認後、Yahoo共通排他 | なし |
| 東証33業種の対応 | 株式同期の成功後 | 現workflowは株式成功後。入力はcore銘柄集合＋公式提出者表 | なし |
| 価格依存の業種別資金フロー | 株式同期の成功後、許容失敗もない場合だけ | 当日の必要価格・`core_stocks.sector`。現ハーネスはstock-sync job全体の成功も要求 | なし |
| 価格非依存の資金フロー28取得元 | 平日18:15、CF起動 | 当日の株式同期は待たず、非Yahoo→Yahoo→両lane成功後join。共有Notion枠未成立のため取得直列を維持 | なし |
| TDnet・有報の補完 | 平日19:00、CF起動 | 主体・原本を確認→抽出→保存・価格資格。共有保存予算内でTDnet→Node有報、前段失敗で停止 | なし |
| 事業タグ・39本文・競合の機械準備 | 毎日20:00、Mac LaunchAgent | 有報原本→39本文・根拠→タグ。同一入力の保存判定は再利用。競合準備はタグjobの正常終了後 | **例外あり**：適格新規・実入力変更のタグだけローカルClef-Flash。本文・競合準備は不使用 |
| EDINET財務サマリ・原本 | 平日21:00 | 指定提出日の公式一覧・主体確認→原本保管→財務抽出。19時Nodeの完了待ちは不要 | なし |
| 優待要約 | 毎日21:00、Mac LaunchAgent | 保存済み優待原文→機械抽出・契約検証→PRE/CAS/POST。月次スコアの完了待ちは不要 | **標準はなし**。機械未対応は保留。手動の明示`--allow-model`だけ既存MLX |
| 鮮度・ジョブ・schema・ライセンス監視 | 毎日23:30 | 現在の保存状態とjob実績。取込失敗でも検査を実施 | なし |
| 日米マクロ結合 | 火〜土06:00、CFの月〜金21:00 UTC起動 | 対応する予定日の保存済み日本市場原本＋米国側観測→結合。最新値で過去を代用しない | なし |
| EDINET銘柄マスタ | 毎月1日06:00 | 現在の公式コード表。月次優待処理とは独立して取得可能 | なし |
| 母集団・優待原文・優待スコア | 毎月10日10:30 | **母集団更新→優待原文取得→スコア再計算**。保存財務が必要。MA乖離比較は財務日と指標日の一致を確認 | なし |
| TDnet速報・上場状態 | 平日09:00〜19:00毎時 | 公表済み対象日の資料→主体確認・原本保管→構造化 | なし |

「LLM利用」は本番の取得・更新経路を示す。標準は機械処理で、事業タグの適格な新規・変更入力だけローカルClef-Flashを使う。
優待要約のモデルは手動の明示指定だけで、定期実行の機械未対応分は保留する。
詳細なworkflow・保存先・SSHの実行コマンド・過去分の制約は[本番定期処理一覧](docs/production-job-inventory.md)を参照。

先行条件は、月次では **母集団→優待原文→スコア再計算**、有報では **原本・主体確認→本文→タグ→競合の機械準備**。
価格依存の資金フローは株式同期の成功後、価格非依存の28取得元は株式同期を待たず **非Yahoo→Yahoo→両方の成功確認・結合** の順で動く。
独立した準備・検査は並行できるが、Yahoo共通排他・同じ保存先のwriter・NotionのAPI予算を優先する。
Notionのレート制御はプロセス内であり、ジョブをまたぐ全体上限は未成立。追加の取得並列化は見送り、既存の取得順とrateを維持している。

### 現在の復旧状況

以下は10/18の受入済み実績。**本日は日曜で、株価の最新対象日は10/16**。
定期設定が有効であること、自然時刻で成功すること、全データが充足することは別に確認する。

| 対象 | 確認済み | 残り・保留 |
| --- | --- | --- |
| 本番定期環境 | GitHubの14 workflow有効、CF配備成功・10 trigger登録。Macの本日20時/21時の自然起動・正常終了・R2 receipt全文一致を確認 | 10/19の17時/18時の自然起動は未受入。全履歴RAWミラーと競合の自動意味判定は意図的に停止 |
| 本日10/18の開示確認 | 16:13までに通常TDnet・EDINETが正常終了。両一覧は確認時点0件、原本・派生6ファイルをNotion・R2へ保管 | 本日の最終確定や、Node有報の主体未解決の解消とは扱わない |
| 株価・VWAP | VWAP日足は10/15・10/16各3,685/3,687銘柄。不足41銘柄のOHLCVに続き、同runの通常5年原本から[財務断面・RSI・指標・モメンタムを反映・全値照合](docs/test-logs/stock41-financial-replay-20261018.md)。通常coverageは価格・指標・モメンタム各3,687/3,687 | 日足523A/641Aは原本資格HOLD。8303のRSIは過去245件の非正調整値でHOLD。全金融項目の充足とは扱わない |
| 5分足 | 固定回復対象1,856銘柄中1,854銘柄を補完 | 7531/9311は取得元に必要期間がなく旧データ維持 |
| 有報・IR・優待 | 39本文2,417件、優待v5の969群1,074行を機械処理で反映 | Node有報の主体未解決16件、旧TDnet原本1279652のPDF1件が残る。非公表・原本欠測を生成値で埋めない |
| Notionの列別充足 | 現役3,687社の補足行は全て存在。通常処理で業種9社・主リンク5社・主マスタ1社を補完 | 初期欠測対象の再読では業種・主リンク・主マスタが各2社残。本文39列の全件検査、財務履歴の空欄理由分類、競合の全自動判定、原本の過去relationは未完了。[列別の実測と通常writerの対応](docs/test-logs/notion-field-coverage-20261018.md)を参照。固定バッチの完了件数を全列充足とは扱わない |
| 保有明細の参考時価 | 固定217文書2,822行の確認を一巡し、保存状態を機械集計。未処理0 | 採用・旧確定値保持1,064行、資格未成立1,758行。[保存理由の内訳](docs/test-logs/holdings-price-requalification-20261018.md#現在の資格未成立1758行の理由)も機械集計済み。別名義208Aの4行は対象外。新規資格成立数や全行の権利根拠再確認とは扱わない |

機能別の受入・未完了・原本欠測は[復旧台帳](docs/test-logs/functional-recovery-20261018.md)、
定期環境と共有予算の確認範囲は[本番処理の検証記録](docs/test-logs/production-dependencies-mechanical-20261018.md)を参照。
全履歴RAWミラー、全市場の再取得、月次処理の一括再実行は不足補完の先行条件に加えない。

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
3. **シークレットは Cloudflare が正のソース** — `wrangler secret put CRON_SECRET` 等で設定する
   (`.env` はローカル開発/取込専用で、本番 Worker には読まれない)。Worker は `nodejs_compat` 有効で
   secret を `process.env` 経由でも参照する。
4. **Workers Cron** — `wrangler.toml` の `[triggers]` でActionsの定時起動と結果監視を行う。
   重い取得本体はActionsで実行し、Macの2処理はLaunchAgentで定期実行する。利用中のWorkers/D1はPaid枠。
5. **push→自動デプロイ** — Cloudflare Workers Builds (Git 連携) を接続済み。PRをマージして
   `main` を更新すると自動 build & deploy。main CIと実配備の成功を確認する。
   手順は [docs/deploy-cloudflare.md](./docs/deploy-cloudflare.md)。

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
WORKER_BASE_URL=https://kabulab-cf.<subdomain>.workers.dev             # moneyflow 等の既存 Worker 接続先 (EDINET 日次 CLI は不使用)
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

定期予定は上表を参照。
以下は同じ通常CLIを手動で使う例。定期jobとの重複・原本の保存結果・pendingを確認し、必要な不足だけを対象にする。

```bash
# 母集団 (JPX) — 上場/廃止があった時
pnpm sync:universe

# 007 VWAP → R2 (Yahoo 429 を避け低負荷で。YAHOO_PROXY_BASE 経由推奨)
pnpm ingest:vwap-daily  # 日足10年
pnpm ingest:vwap-intra  # 5分足
pnpm ingest:vwap-margin # 信用残高 (平日更新・JPX PDF・Yahoo 非依存)

# 006 TDnet / 005 EDINET — Node から D1 HTTP で共通取込
pnpm ingest:ir-tdnet
pnpm ingest:yuho-edinet

# 手動フル日次 (上記 VWAP も束ねて叩く・ローカル実行用)。stock sync 本体は cron に任せてよい
pnpm sync:daily
```

### 優待データ取込パイプライン (002 otakara)

月次のActionsで母集団・優待原文を更新し、保存済み財務からスコアを再計算する。
要約はMacの毎日21時jobが同じ機械抽出・要約契約・金額検証を使い、変更・未要約分だけ処理する。
書込前の比較、条件付き更新、保存後の全値照合を行い、機械未対応の条件は旧値を保って保留する。
手動の明示`--allow-model`だけ既存のローカルMLXを利用できる。定期実行では指定しない。

```bash
# Actions・Linuxでの月次処理 (Nix内。前段失敗時は後続を起動しない)
pnpm sync:universe
pnpm yutai:fetch
pnpm sync:monthly:core

# Mac専用runtimeの通常入口。定期jobと排他・設定を共有する
pnpm exec tsx --env-file-if-exists=.env scripts/biztag-local/main.ts run yutai-summary
```

`pnpm sync:monthly`は優待取得→再計算→Macの要約入口を束ねる。Linuxでは上記3段階を使う。
旧タスクexport/importは手動用に残るが、定期処理の先行条件にはしない。
原文・タスク・結果・実行記録はGit対象外へ保存する。

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
| VWAP の日足/5分足が「未取得」 | 取得失敗・原本欠測・予定起動失敗など | 取得状況・Cron/Actionsの実績・pendingを確認。結果不明は再送せず、既知の不足だけを通常CLIで補完 |
| マクロ判定が `HOLD` のまま | 日経電子版の HTML 構造変更 or 到達不能 | `src/shared/yahoo/nikkei-vi.ts` を確認 (silent に B/C 判定しない・ルール2) |
| セクター一覧が "未分類" 1 件 | `core.stocks.sector` が NULL (初回 or JPX URL 変更) | `pnpm sync:universe` を手動実行。必要なら続けて `pnpm sync:monthly:core` |
| Yahoo rate limit で失敗多発 | crumb 期限切れ or 上限超過 | 並列度を下げる (`CONC` / `DELAY_MS`)、翌日再試行 |
| 005 yuho-quant が空表示 | D1 へ未投入 | `pnpm ingest:yuho-edinet` で EDINET から取込 (要 EDINET/D1/Notion 設定) |

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
PR・CIによるレビュー / 一次データの Notion アーカイブ / 専門用語のバルーンヘルプ 等) は
[CLAUDE.md](./CLAUDE.md) と各 `services/<slug>/CLAUDE.md` に定義。
