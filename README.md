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
重いデータ取得・加工は **Node/Python (GitHub Actions)** で行う。
Macの自動起動は廃止。本文39・基本補足・優待機械要約は[Linux定期同期](docs/mechanical-publishing.md)、Clefの意味判定は[月次手動](docs/mac-monthly-manual.md)とする。NodeのD1書込は `createD1HttpDb` (D1 REST) 経由。

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
pnpm sync:monthly         # 優待取得 → rebuild。Mac要約の起動は除去済み
pnpm sync:universe        # 東証内国株の母集団 seed (xlsx=Node 専用・月次/復旧時に実行)

# データ取得 (007 VWAP → R2。定期workflowと同じ本体)
pnpm ingest:vwap-daily    # 日足10年→R2。同session証跡は再利用、未完銘柄は10年系列を全置換
pnpm ingest:vwap-intra    # 全銘柄の5分足 (直近) を蓄積 → R2 intra/{code}.json
pnpm ingest:vwap-margin   # JPX公表PDF (信用残高) → R2

# データ取得 (006 TDnet → D1。Nodeが共通処理を直接実行)
pnpm ingest:ir-tdnet      # 原本Notion保管・本文抽出 → D1

# データ取得 (005 EDINET → D1。Node が共通処理を直接実行)
pnpm ingest:yuho-edinet   # Node 共通取込 + D1 HTTP atomic sender (EDINET/D1/Notion 設定必須)

# 事業タグ (日次自動は廃止。月次手動スクリプトは docs/mac-monthly-manual.md)
pnpm biztag:monthly --runtime .runtime/mac-publishing-20261025 --preflight # 月次手動の準備確認
```

> **母集団**: JPX `data_j.xlsx` に載る東証プライム／スタンダード／グロースの
> 内国株式のうち、共有 4 文字コード契約に合う約 3,700 銘柄。地域市場の
> 単独上場銘柄と 5 桁種類株は対象外。002 otakara はさらに
> `is_yutai=true` の優待銘柄のみを対象とする。
> Yahoo Finance はレート制限 (429) が厳しいため、VWAP の大量取得は低負荷 (逐次 + ディレイ) で行う。

## 本番の定期処理・先行条件・LLM利用

確認日: **2026-10-25**。時刻は **JST**。Cloudflareが起動・結果監視、Actionsが機械取得を担当する。**Macの2自動起動は廃止・停止済み。本文39・基本補足・優待機械要約は毎日04:17のLinux/Actionsへ分離し、Clef・設定済み競合準備は月次手動**。SSHは不足補完用で日次cronは未登録。
原本はNotionに物理保管し、構造化データはD1、時系列・実行receiptはR2へ保存する。

**全件は[データ取得・更新・監視の全件一覧](docs/batch-data-inventory.md)**。通常データ40行、資金フロー29取得元、旧Mac内7機能、監視9機能、手動/停止/未実装20項目、本文39項目を列挙する。下表は予定時刻の要約。

| 処理 | 予定時刻・頻度 | 必要な先行条件・順序 | LLM利用（定期実行） |
| --- | --- | --- | --- |
| 日証金の貸借・需給 | 平日12:17、CF起動 | 公表済みの当日CSV。株式同期の完了待ちは不要 | なし |
| VWAP日足・5分足 | 月水金17:00、CF起動 | 公式銘柄表・対象日の原本資格。日足→5分足。段階間でYahoo共通排他を解放し、同runの受付証跡を継承。結果不明では後続停止 | なし |
| 市場の信用残高 | 平日17:00、CF起動 | 公表元の対象日資料。専用排他で実行し、Yahoo取得の待ち行列には入れない | なし |
| 株価・財務断面・RSI・スイング・モメンタム・業種騰落 | 平日18:00、CF起動 | 母集団と通常取得原本。指標は価格・分割単位の資格確認後、Yahoo共通排他 | なし |
| 東証33業種の対応 | 株式job終了後（失敗時も独立実行） | core銘柄集合＋公式提出者表。取消・起動資格の失敗では停止 | なし |
| 価格依存の業種別資金フロー | 株式同期の成功後、許容失敗もない場合だけ | 当日の必要価格・`core_stocks.sector`。現ハーネスはstock-sync job全体の成功も要求 | なし |
| 価格非依存の資金フロー28取得元 | 平日18:15、CF起動 | 当日の株式同期は待たず、非Yahooの結果を閉じてからYahoo→両lane成功後join。既知のsource失敗だけなら独立Yahooは続行、不明な保存結果では停止 | なし |
| TDnet・有報の補完 | 平日19:00、CF起動 | 共通起動資格・保存設定を確認し、予算内でTDnet→Node有報。TDnet失敗でも独立した有報は実行し、共通資格失敗・取消では停止 | なし |
| 本文39・基本補足 | 毎日04:17、Actions | 保存済み原本の変更＋巡回、最大50社。共有publisher初回移行後だけ有効化 | なし |
| 事業タグ・競合入力準備 | 月次手動 | 本文同期とは独立。旧タグ根拠を保持し、適格な実入力変更だけ再判定 | タグのClefだけ |
| EDINET財務サマリ・原本 | 平日21:00、CF起動 | 指定提出日の公式一覧・主体確認→原本保管→財務抽出。19時Nodeの完了待ちは不要 | なし |
| 優待機械要約 | 本文job終了後、同日Actions | 本文の既知HOLDとは独立、最大60群。原文取込とも共有writerで排他 | なし。モデル許可を拒否 |
| 鮮度・ジョブ・schema・ライセンス監視 | 毎日23:30 | 現在の保存状態とjob実績。取込失敗でも検査を実施 | なし |
| 日米マクロ結合 | 火〜土06:00、CFの月〜金21:00 UTC起動 | 対応する予定日の保存済み日本市場原本＋米国側観測→結合。最新値で過去を代用しない | なし |
| EDINET銘柄マスタ | 毎月1日06:00 | 現在の公式コード表。月次優待処理とは独立して取得可能 | なし |
| 母集団・優待原文・優待スコア | 毎月10日10:30 | **母集団更新→優待原文取得→スコア再計算**。保存財務が必要。MA乖離比較は財務日と指標日の一致を確認 | なし |
| TDnet速報・上場状態 | 平日09:00〜19:00毎時、CF起動 | 公表済み対象日の資料→主体確認・原本保管→構造化 | なし |

予定日時はCFからCLIへ渡し、環境準備後の実時計で受付を再検査する。日証金・TDnet・EDINETは予定JST日の資料を対象とし、原本に記された基準日・公表日は保持する。受付を過ぎたrunは停止し、翌日分へ読み替えない。各受付・締切は[時刻契約](docs/stock-scheduler.md#取得処理の時刻契約)を参照。

現行CF／Actionsの定期は機械処理。Mac専用分は[月次手動](docs/mac-monthly-manual.md)とし、日次の自動起動は再開しない。機械未対応分を自動でモデルへ渡さない。
取得結果は[ゼロ・不該当・未公表・欠測の区分](docs/batch-result-states.md)で確認する。空欄や処理0件だけで失敗・補完対象とは判定しない。
詳細なworkflow・保存先・SSHの実行コマンド・過去分の制約は[本番定期処理一覧](docs/production-job-inventory.md)を参照。

先行条件は、月次では **母集団→優待原文→スコア再計算**、有報では **原本・主体確認→本文→タグ→競合の機械準備**。
価格依存の資金フローは株式同期の成功後、価格非依存の28取得元は株式同期を待たず **非Yahoo→Yahoo→両方の成功確認・結合** の順で動く。
独立した準備・検査は並行できるが、Yahoo共通排他・同じ保存先のwriter・NotionのAPI予算を優先する。
本文/優待の切替前条件・secret・旧Mac writer無効化は[切替手順](docs/mechanical-publishing.md)を参照。Notionのレート制御はプロセス内であり、ジョブをまたぐ全体上限は未成立。追加の取得並列化は見送り、既存の取得順とrateを維持している。

### 現在の復旧状況

10/26更新の[完了条件と残件](docs/work-plans/production-completion-20261025.md)に、改修・データ不足・本番受入をまとめています。#617までのCI・Cloudflareの100%配備・SSHへの同一revision反映を確認しました。全件充足は未完です。

**定期設定と全データ充足は別です。** CFの14 trigger、GitHubの14有効workflow（機械同期を含む）は継続。Macの20/21時calendarは廃止し、専用分は月次手動スクリプトへ変更しました。歴史RAW用workflow1本も意図的停止。10/21の株式429・VWAP保存不明・有報停止と修正範囲は[10/22の稼働確認](docs/test-logs/recovery-functional-status-20261022.md)、現設定は[全件一覧](docs/batch-data-inventory.md)へ記録します。以下は10/26までの有限確認で、全件充足を示す数値ではありません。残件は[Issue #348](https://github.com/satoki252595/kabulab_tool_cloudflare/issues/348)で追跡します。

| 対象 | 確認済み | 残り・未検収 |
| --- | --- | --- |
| 実行環境 | #617 main `1c3c0590`までCI3本成功・CF `f55463b0` 100%・SSH同headを受入。有報の保留巡回、優待の条件照合、本文同期の銘柄別結果記録を通常経路へ反映 | 次の自然定期の成功は別受入。Mac専用の意味判断は合意済み月次手動 |
| 株価・VWAP | 日足run[40169768650](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/40169768650)は更新2,695・skip990・HOLD1。5分足run[40177951577](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/40177951577)は更新3,679・skip2・error5。両runとも全3,686件集計・unknown/未着手0、summary保管済み | 日足523Aの履歴欠測、株式マスタ38件、5分足5エラー・更新分の旧日付40件・5d窓外欠測、旧PUT不明は未検収。メタデータPUTだけを足の更新に数えない |
| 本文39列・有報・財務 | 現役3,686社の固定母集団では478社を通常CLIで処理（同期261・同値216・保留1）。全10窓を閉鎖し、結果不明0。財務7911/8566のROA4行は反映済み | 未処理3,208社と2683の社名変更による保留が残る。全市場の財務・歴史relationは未完。保存scope候補なし137セルを公式非開示とは断定しない |
| IR | 単一ID・期限付き再開と元PDF識別guardを配備。1279652は元URL/同一文書JPXとも404。[会社公式の限定調査](docs/research/tdnet-1279652-original-20261026.md)でも同一原本の移転先は未確認 | 1279652は原本未取得HOLD。40日窓外で日次再取得対象外、9/9差替PDFを代用しない |
| 優待 | #616の通常処理で3498の2行・6040の1行を反映。物理PRE/POST・非対象保持・共有owner閉鎖を受入 | 最新の通常全7,728行POSTで未完35群/57行/13銘柄を実測。銀行条件の反映と、外数の8336初回2026-09-30限定3行の追加が残る |
| 受注・海外 | 旧除外候補20文書の既存75行に続き、行なし13文書120明細をSSHで補完。原本・全6表・物理PRE/POSTと別実行の独立inspectを受入 | 区分NULL不一致31文書が残る。6721も区分一致だけで金額・自然key・全6表は未資格。恒久stateは146ファイル/145claim、旧133ファイルを保持 |
| 資金フロー | 10/23の独立28取得元は26正常・投信/REITの2取得元が503。[公式告知](https://www.imaj.or.jp/news/2026/20261023_001929.html)でも統計サービスの停止継続を確認 | 株価依存の業種売買代金は別経路で未検収。最新keyだけで全期間・全系列の充足とはしない |
| 保有・権利処理 | 新snapshot `40169768650.1`・session10/23・3,685 membersを独立確認。通常再開の次窓も23書込のHTTP200・未解決書込なしで閉鎖し、pending=false | キュー消化は全価格の充足を意味しない。同窓のheld3と、全保有価格・分割/併合/増資等の法的日付・株数/価格basisの資格確認は残る |
| 指標・意味判断 | API/MCPは代表読取を本番確認済み。Clefの保存済み結果を保持 | Prime売買代金20日比、個別需給/カタリスト（2週間、過去/未来の範囲は確認中）は未接続。タグ・競合等の意味判断は合意済み月次手動 |

旧数値と実測は[10/18の列別監査](docs/test-logs/notion-field-coverage-20261018.md)、[10/19の受入](docs/test-logs/recovery-functional-status-20261019.md)へ保存。旧欠測件数を現在の残数にせず、固定集合の成功も全体完了にしない。原本全量ミラー・全市場再取得・月次一括再実行は先行条件に戻さない。

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
   重い取得本体はActionsで実行する。旧Macの自動起動2本は廃止し、専用分は月次手動へ。利用中のWorkers/D1はPaid枠。
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
要約の旧Mac21時jobは廃止・停止済みで、機械要約は日次Actionsの`sync:mechanical`で実行する。書込前の比較・条件付き更新・保存後の全値照合を維持し、機械未対応は保留する。

```bash
# Actions・Linuxでの月次処理 (Nix内。前段失敗時は後続を起動しない)
pnpm sync:universe
pnpm yutai:fetch
pnpm sync:monthly:core

```

`pnpm sync:monthly`は優待取得→再計算だけを束ね、Mac要約を起動しない。母集団更新は上記の別段階。
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
| マクロ判定が `HOLD` | 対応原本・対象日・終値・VIの資格不足 | 予定日receiptと原本理由を確認。別日や別benchmarkで置換せず、必要対象だけ補完 |
| セクターが「未分類」 | 公式マスタ欠測・主体/対象資格不足 | 対象コードと公式原本を確認。マスタ更新が必要な場合だけ`sync:universe`を実行 |
| Yahoo 429/503で停止 | 取得元の制限 | D1の共有停止期限を守る。原本・未完状態・known/unknownを確認し、期限後も必要な範囲だけ通常入口で再開 |
| 有報の項目が空 | 原本なし・未構造化・主体/開示HOLD等 | 保存理由を先に確認。原本に値がある抽出漏れだけ通常取込/backfillで直し、推測で埋めない |

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
