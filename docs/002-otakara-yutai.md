# 002 お宝優待 — kabulab

割安な株主優待銘柄をファンダメンタルズ × テクニカル分析のスコアリングで発見するサービス。

> kabulab mono-repo (`services/otakara-yutai/`) として配置され、Cloudflare Workers 上で `https://kabulab-cf.satoki252595.workers.dev/otakara-yutai/*` として公開される。

## コンセプト

- 東証対象銘柄の株主優待を分類・スクリーニング
- 独自スコアリング (ファンダ 60% + テクニカル 40%) で「割安な優待銘柄」を自動ランク付け
- モバイルファーストの PWA 対応 UI で投資判断を支援
- 優待内容は手動解釈した短縮サマリー (`shortSummary`) をカード表示に活用

## ディレクトリ構成

```
services/otakara-yutai/
├── app.ts                     # Hono サブアプリ — 全 SSR ページ (/, /screening, /genres/:slug,
│                              #   /stocks/:code 等) と /api/screening を保持する単一ファイル構成
├── src/
│   ├── db/
│   │   ├── client.ts          # createDb(c.env.DB) — D1 + Drizzle (drizzle-orm/d1)
│   │   └── schema.ts          # yutai_* / otakara_* 接頭辞テーブル定義
│   │                          # (stocks は core-schema.ts から再 export — 銘柄マスタ統一化)
│   ├── services/
│   │   ├── yutai-scraper.ts        # HTML/CSV/JSON からの優待データ取込
│   │   └── yutai-data-provider.ts  # ファイルベースインポート
│   ├── validators/
│   │   └── yutai-scraper.ts   # 優待スクレイパー用 Zod スキーマ
│   ├── middleware/            # ⚠️ app.ts は未使用 (テストのみが参照)。
│   │   ├── error-handler.ts   #    将来マウントする余地として据え置き
│   │   └── rate-limiter.ts
│   └── tests/                 # scoring は src/shared/ に移動済み、本サービスは他の unit test のみ
├── data-scripts/              # 月次パイプライン + 1 回限りの保守スクリプト
│   ├── fetch-yutai-full.ts             # 月次 ①minkabu 取得 → yutai_benefits + is_yutai
│   ├── export-benefit-descriptions.ts  # 月次 ②ユニーク description 抽出 → JSONL
│   ├── interpret-benefits.ts           # 月次 ③ローカル LLM (ELYZA) 解釈
│   ├── apply-benefit-interpretations.ts# 月次 ④short_summary/estimated_value を DB 反映
│   ├── benefit-key.ts / summary-contract.ts  # 上記が共有するキー生成・要約契約
│   ├── enrich-from-web.ts / fetch-yutai-data.ts / fix-stock-names.ts
│   ├── salvage-realign-interpretations.ts / test-parse.ts / verify-data.ts
│   └── data/                  # ソースデータ + 解釈結果のチャンク
├── drizzle/                   # drizzle-kit 生成の migration
├── CLAUDE.md
└── README.md
```

**過去から変わった点** (2026-09):

- `src/routes/` (5 ファイル) と `src/views/` (8 ファイル)、および `src/types.ts` /
  `src/validators/index.ts` / `src/middleware/index.ts` / `src/middleware/db.ts` を **削除**
  (計 17 ファイル / 4,245 行)。いずれも `app.ts` 単一ファイル構成へ移行した後に
  残っていた**未マウントの並行実装**で、本番エントリ
  (`wrangler.toml` → `worker/entry.ts` → `src/index.ts` → `app.ts`) から到達不能だった。
  `src/views/*.tsx` は overview.md の「ビューは JSX を使わず template literal」という
  mono-repo 方針にも反していた。
- 放置の代償として、D1 (SQLite) が解釈できない `ILIKE` と同一オブジェクト内の
  重複キー 5 箇所を抱えたまま CI が緑だった。再発防止は
  [docs/ci-typecheck-blind-spots.md](./ci-typecheck-blind-spots.md) を参照。
- `src/middleware/db.ts` は `DATABASE_URL` 文字列を `createDb()` に渡す Neon 期の残骸で、
  ADR-0001 (D1 バインディング経由のみ) と矛盾していたため削除。`app.ts` はインライン版を使う。

**過去から変わった点** (2026-04):

- 本サービス固有の `yahoo-finance.ts` / `stock-data-sync.ts` / `scoring.ts` / `cron-auth.ts` / `validators/yahoo-finance.ts` / `scripts/sync-and-score.ts` は **削除**。
- `scoring.ts` は [src/shared/scoring.ts](../src/shared/scoring.ts) に移動 (純関数のみ)。DB I/O を伴う `scoreAllStocks` は [src/cron/monthly.ts](../src/cron/monthly.ts) に統合。
- 銘柄マスタを `core.stocks` に一本化 (旧 `public.stocks` は削除、`yutai_benefits.stock_id` の FK を付け替え)。`src/db/schema.ts` は `stocks` シンボルを `coreStocks` の再 export として提供しているので、`app.ts` の既存クエリはそのまま動く。
- 本サービス内の cron ルート `/api/cron/sync-monthly` は廃止。統一 cron (`/api/cron/sync-monthly` at root) が代替。

`app.ts` がモノリシックに全ての SSR ページと内部 API (`/api/screening`) を保持する設計は変わらず。`src/db/` は単一 source of truth として `app.ts` と `data-scripts/` の両方から参照される。

ルート Hono アプリ (`src/index.ts`) は次のようにマウントする:

```ts
import { otakaraYutaiApp, BASE_PATH as OTAKARA_BASE_PATH } from "../services/otakara-yutai/app.js";
app.route(OTAKARA_BASE_PATH, otakaraYutaiApp);
```

PWA 静的アセット (`manifest.json` / `sw.js` / `icon-*.png`) は ルート repo の `public/otakara-yutai/` に配置し、Cloudflare Worker の静的アセット (`ASSETS` バインディング) として配信する。

## DB スキーマ

銘柄マスタは **`core_stocks` を参照** する (2026-04 に `public.stocks` を廃止)。`yutai_benefits.stock_id` / `otakara_stock_financials.stock_id` / `otakara_stock_scores.stock_id` は全て `core_stocks(id)` に対する FK。

```
yutai_genres
├── id / name (UNIQUE) / slug (UNIQUE) / description?
└── created_at

yutai_benefits
├── id          serial PK
├── stock_id    FK → core_stocks(id)
├── genre_id    FK → yutai_genres
├── description     text        # スクレイピング元テキスト (長文)
├── short_summary   text?       # 手動解釈した短縮文言 (20-30 文字)
├── min_shares      integer     # 最低必要株数
├── record_month    integer     # 権利確定月 (1-12)
├── estimated_value integer?    # 推定金銭価値 (円)
└── created_at / updated_at

otakara_stock_financials
├── id / stock_id FK → core_stocks(id) (UNIQUE)
├── price / per / pbr / dividend_yield / eps / bps   # core から monthly sync でコピー
├── roe / roa / market_cap                           # core から monthly sync でコピー
├── ma_5 / ma_25 / ma_75       # swing_stock_indicators から monthly sync でコピー
├── rsi_14 / macd / macd_signal # swing_stock_indicators から monthly sync でコピー
├── yutai_yield                 # monthly sync で yutai_benefits から算出
├── data_date / fetched_at

otakara_stock_scores
├── id / stock_id FK → core_stocks(id) (UNIQUE)
├── fundamental_score / technical_score / total_score   real (0-100)
└── scored_at
```

> 過去には `public.stock_history` (月次 PER/PBR 推移) も持っていたが、
> アプリ側から一切参照されていなかったため 2026-04 に削除した。
>
> 過去には `public.stocks` (002 固有の銘柄マスタ) もあったが、2026-04 の refactor で
> `core.stocks` に一本化された。`yutai_benefits` 等の FK は code ベースで remap 済み。

## スコアリングエンジン

### ファンダメンタルスコア (総合の 60%)

| 指標 | 配分 | ロジック |
|---|---|---|
| PER | 25% | <10→100, <15→80, <20→60, <30→40, else 20 |
| PBR | 20% | <0.5→100, <1.0→80, <1.5→60, <2.0→40, else 20 |
| 配当利回り | 25% | >5%→100, ≥4→80, ≥3→60, ≥2→40, ≥1→20 |
| ROE | 15% | >15%→100, ≥10→80, ≥5→60, ≥0→40, else 20 |
| 優待利回り | 15% | >5%→100, ≥3→80, ≥2→60, ≥1→40, else 20 |

### テクニカルスコア (総合の 40%)

| 指標 | 配分 | ロジック |
|---|---|---|
| MA25 乖離率 | 45% | 株価が MA25 を下回るほど高スコア |
| RSI(14) | 35% | <30→100 (売られすぎ=買いシグナル) |
| MACD | 20% | MACD>Signal かつ 両方<0 (底値ゴールデンクロス) → 100 |

null 指標はウェイト再配分で欠損を補正。実装は [src/shared/scoring.ts](../src/shared/scoring.ts) (純関数)。

## SSR ページ

| パス | 内容 |
|---|---|
| `/` | ジャンル一覧、今月/来月注目銘柄 |
| `/genres/:slug` | ジャンル別スクリーニング (ページネーション + フィルタ) |
| `/stocks/:code` | 銘柄詳細 (スコア内訳、財務、優待情報をジャンル→保有段階→商品の 3 階層で表示) |
| `/months/:month` | 月別権利確定銘柄一覧 |
| `/search?q=` | 銘柄検索 (コード前方一致 / 名前部分一致) |
| `/screening` | スクリーニング一覧 (2026-04: カードスワイプ UI を廃止、一覧のみに統一) |

## 月次 sync フロー

実装は [src/cron/monthly.ts](../src/cron/monthly.ts)。**Yahoo を 1 回も叩かない**。

```
GitHub Actions 月次
  Phase 1: pnpm sync:universe
           JPX 公式 XLS → core_stocks を東証内国普通株 ~3,700 に同期
           (新規 upsert + name/market/sector 更新 + JPX 基準の対象外化)
  Phase 2: pnpm sync:monthly:core
    for each core_stocks (is_active AND is_yutai):   # 優待銘柄のみ ~1,600
      - core_stock_financials から PER/PBR/配当/EPS/BPS/ROE/時価総額 を取得
      - swing_stock_indicators から MA5/25/75 / RSI14 / MACD/Signal を取得
      - yutai_benefits から推定価値合計 → yutai_yield 算出
      - scoreStock(input) でファンダ + テクニカル → 総合スコア
      - otakara_stock_financials と otakara_stock_scores に upsert
```

> **母集団について**: 2026-05 に sync 母集団は「優待縛り ~1,600」から **東証プライム／スタンダード／グロースの内国株式（共有4文字コード、約3,700）** へ拡張された (004 financial-math が一般日本株を要するため)。地域市場の単独上場銘柄と5桁種類株は対象外。`core_stocks` には非優待銘柄も含まれるが、002 otakara は一覧・カウント・詳細・スコアいずれも `is_yutai=true` で絞るため、優待サービスとしての見え方は不変。`is_yutai` フラグの writer は優待スクレイパー [services/otakara-yutai/data-scripts/fetch-yutai-full.ts](../services/otakara-yutai/data-scripts/fetch-yutai-full.ts) (core_stocks は削除せず upsert + フラグ更新)。

自動実行: GitHub Actions の [.github/workflows/stock-sync.yml](../.github/workflows/stock-sync.yml) の月次 cron (**毎月10日 01:30 UTC = JST 10:30**) で universe seed + monthly rebuild ([src/cron/monthly.ts](../src/cron/monthly.ts)) が走る。JPX の前月末版が第3営業日以降に公開されるため、旧版を翌月分として扱わない日程にしている。Node から `createD1HttpDb` (D1 REST) で書き込む。

> ※ 日次の Yahoo データ取得は統一 daily sync ([src/cron/daily.ts](../src/cron/daily.ts)) が `core_stock_financials` / `swing_stock_indicators` を更新することで間接的に本サービスにも反映される。本サービス独自の Yahoo 呼び出しはゼロ。

## 優待データの短縮サマリー (`shortSummary`)

ユニークな優待 description を **node-llama-cpp によるローカル OSS LLM** で自動解釈し (パイプライン step3 `pnpm interpret:yutai`、既定モデル ELYZA-JP-8B)、モバイル表示向けの短縮文言 (`shortSummary`) と推定金銭価値 (`estimatedValue`) を付与。トークン生成レベルで JSON schema を強制し、決定論ガード (`sanitizeEstimatedValue`) で過大評価を null へ落とす。旧実装の `claude -p` (サブスク CLI) 依存は撤廃済み (クラウド API 課金ゼロ)。

- 例: `"QUOカード 1,000円相当"` / `"ゼンショー食事券 6,000円(年12,000円)"` / `"高島屋10%割引(限度30万円)"`
- `estimatedValue`: 年間の推定金銭価値 (円)。割引券など金額換算不能なものは `null`
- カード一覧: `shortSummary` を `" / "` 区切りで表示
- 銘柄詳細: `shortSummary` のみを表示する。`description` は出典サイトの掲載文そのもので、
  規約上の再掲不可のため**公開面には出さない** (推定額の算出など内部処理専用。
  `app.ts` の `publicSummary()` と `public-summary-safety.test.ts` で固定)
