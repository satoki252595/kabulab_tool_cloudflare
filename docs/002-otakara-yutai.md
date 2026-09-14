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
│   ├── export-benefit-descriptions.ts  # 月次 ②ユニーク description 抽出 → JSONL (Notion 一次データ記録)
│   ├── export-summary-tasks.ts         # 月次 ③要約タスク書き出し (要約は外部のクラウド LLM)
│   ├── import-summary-results.ts       # ④LLM の結果を検証し short_summary/estimated_value を D1 反映 (既定 dry-run)
│   ├── summary-tasks.ts / summary-import.ts  # ③④の純ロジック (タスク選定 / 結果検証)
│   ├── estimated-value-guard.ts / private-path.ts / benefit-rows.ts  # 金額ガード / 置き場所ガード / D1 読み取り
│   ├── benefit-key.ts / summary-contract.ts  # 上記が共有するキー生成・要約契約
│   ├── fetch-yutai-data.ts
│   └── data/                  # (gitignore) 掲載文を含む作業ファイル: 抽出 JSONL・要約タスク・結果
├── docs/llm-summary-task.md   # クラウド LLM 向けの要約作業仕様書
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

ユニークな優待 description について、モバイル表示向けの短縮文言 (`shortSummary`) と推定金銭価値 (`estimatedValue`) を **リポジトリ外のクラウド LLM (Cursor Automations 等)** が作る (2026-09-13 から)。

1. `pnpm yutai:summary:export` が要約の要る `(銘柄, 掲載文)` をタスク JSONL に書き出す (要約が NULL / 既存要約が契約違反。`--violations-only` で後者だけ)。
2. 外部エージェントが [作業仕様書](../services/otakara-yutai/docs/llm-summary-task.md) に従って結果 JSONL を返す。
3. `pnpm yutai:summary:import` が結果を**信用せずに**検証し (要約契約 `summary-contract.ts`、金額の決定論ガード `sanitizeEstimatedValue`、`taskId` と今の D1 の内容キーの一致、契約の版)、通った行だけを書く。既定は dry-run。

タスク / 結果ファイルは掲載文を含むので gitignore 済みの `data-scripts/data/` かリポジトリ外にしか置けない (`private-path.ts` が git に確かめて止める)。

経緯: `claude -p` (サブスク CLI) → node-llama-cpp によるローカル LLM (ELYZA-JP-8B、初回に数 GB を DL) → クラウド LLM。ローカル経路は生成側に長さチェックの退路があり、契約違反の要約 85 行 (8,314 行中) を公開面に残していた。クラウド LLM の費用は Cursor 等の契約側で発生し、このリポジトリの原価ではない。

- 例: `"QUOカード 1,000円相当"` / `"ゼンショー食事券 6,000円(年12,000円)"` / `"高島屋10%割引(限度30万円)"`
- `estimatedValue`: 年間の推定金銭価値 (円)。割引券など金額換算不能なものは `null`
- カード一覧: `shortSummary` を `" / "` 区切りで表示
- 銘柄詳細: `shortSummary` のみを表示する。`description` は出典サイトの掲載文そのもので、
  規約上の再掲不可のため**公開面には出さない** (推定額の算出など内部処理専用。
  `app.ts` の `publicSummary()` と `public-summary-safety.test.ts` で固定)

## スクリーニングのページングと総件数 (2026-09-12)

### 直った実害

`/api/screening` は `month/genre/perMax/pbrMax/yieldMin/rsiMax/sort/order/limit` の 9 個を
サーバ側で読み、ジャンル・権利月は `inArray(stocks.id, サブクエリ)` で効かせている
(**サーバ側フィルタは以前から実在した**。「固定 50 件を返すだけ」という理解は誤り)。
実害は別のところにあった:

- `limit` は既定 50・**上限 100 にクランプ**され、`offset` / `page` が無かった。
  優待銘柄の母集団は **1,616**、権利月3月だけで **848 件**。どう絞り込んでも
  **101 件目以降に到達する手段が無かった**。
- 総件数を返していないため、読者は「848 件中の 100 件を見ている」ことを知れなかった。

応答は裸の配列から `{ items, total, offset, limit }` に変えた。利用者は同ファイル内の
スクリーニングページのクライアント JS だけ (README でも内部利用と明記) なので、
互換シムは置かなかった。

### COUNT の走査コスト (D1 は走査行課金)

同一 WHERE の `COUNT(*)` は**データ取得クエリと同額の走査を払う**。実測 rows_read:

| クエリ | rows_read |
|--------|-----------|
| データ取得 (無フィルタ / OFFSET 0) | 6,947 |
| データ取得 (無フィルタ / OFFSET 1550) | 6,947 |
| `COUNT` 無フィルタ | 6,947 |
| `COUNT` 権利月=3 | 13,725 |
| `COUNT` 全条件 | 13,412 |

OFFSET の走査コストは平坦 (0 と 1550 で同値) なので keyset ページングは採らず素直な
OFFSET にした。一方 COUNT を毎リクエスト打つと権利月フィルタ時に 13,725 → 27,450 と
倍になるため、次の 2 段構えにした:

1. **`withTotal=1` を付けた時だけ COUNT を打つ。** クライアントは絞り込み条件を
   変えた最初の 1 回だけ付ける (ページ送り・ソート変更では総件数が変わらない)。
   SSR の `/screening` は 1 ページ目と総件数を埋め込むので、ページを開いた時点では
   API も COUNT も走らない。
2. **財務列フィルタが無い COUNT は LEFT JOIN を落とす。** LEFT JOIN は行を減らさず、
   `otakara_stock_financials` / `otakara_stock_scores` の `stock_id` は UNIQUE なので
   行も増えない → join 無しの `count(*)` と同値。財務列を WHERE で参照するときは
   落とせないので、その場合だけ `count(distinct)` で join する。

採らなかった案: 「先頭 N 件で打ち切って `N+` と表示」。母集団 1,616 / 権利月3月 848 件
という規模では「848 件中」と正確に出せる価値の方が大きい。

この設計は `services/otakara-yutai/src/tests/screening-pagination.test.ts` の
「COUNT の走査コスト設計」で SQL レベルに固定してある (withTotal 無しでは COUNT が
1 回も発行されないこと、join を落とす/落とさない分岐)。

### 死にコードの除去

`.limit(limit * 3)` + JS 側の重複除去は死にコードだった。`schema.ts` の
`stockId.unique()` (本番 D1 にも `otakara_stock_financials_stock_id_unique` /
`otakara_stock_scores_stock_id_unique` が実在) により JOIN で行は増えないため、
重複除去は一度も仕事をしない。素直な `.limit(limit).offset(offset)` にした。

「保険として残す」は採らなかった。**この組み合わせは前提が崩れたときにこそ有害**で、
OFFSET は重複除去**前**の行数を数えるため、除去した分だけページ境界が実際の
銘柄数からずれて次ページの先頭を取りこぼす (offset が無かった旧実装では先頭
ページしか出せなかったのでこのズレは露出しなかった)。前提が成り立つなら無駄・
崩れるなら有害、という判断で外し、UNIQUE 前提の側をテストで固定した。

ORDER BY には第 2 キーとして `stocks.id` を足した。総合スコアは NULL と同値が
大量にあり単一キーでは全順序にならず、OFFSET ページングではページ間で順序が
揺れると行の重複と欠落が起きる。これは「実際に取りこぼす」形ではテストに
固定できない (node:sqlite はこの規模だと第 2 キー無しでも安定した順序を返し、
第 2 キーを外してもページング系のテストは全て通ってしまう。順序が揺れるのは
索引や実行計画が変わる本番 D1 側)。そのため**発行 SQL の ORDER BY 句の形**を
`screening-pagination.test.ts` の「ページ跨ぎの順序安定性」で固定してある。

なお同じ「第 2 キーが無い OFFSET ページング」は `/genres/:slug` の SSR ページング
(`gSortExpr` + `page` パラメータ) にも残っている。本 PR の対象外だが同種の
ページ間ズレを起こしうるので、`.limit(PAGE_SIZE * 3)` の整理と併せて別タスク。

### 索引: 必要だが本 PR では入れない

EXPLAIN では `idx_core_stocks_active_market` で SEARCH → 権利月/ジャンルの
サブクエリで `SCAN yutai_benefits` になる。実測どおり 1 クエリ 6,947〜13,725 行を
走査しており、**`core_stocks.is_yutai` と `yutai_benefits.record_month` に索引が無い**
(実測で確認)。母集団が増えれば走査行課金に直接跳ねる。

それでも本 PR では追加しない。理由:

- `pnpm db:generate:otakara` は `dialect: "postgresql"` の死んだ経路で、
  **D1 マイグレーションを 1 行も生成しない**。
- D1 用は `pnpm db:generate:d1` だが、`drizzle/d1/meta/0008_snapshot.json` は
  `core_stocks` を **9 列・索引 1 本**と記録しているのに本番は **21 列・索引 3 本**
  (2026-09-12 の移行 P4a が直接 ALTER で先行適用)。この状態で生成すると
  `core_stocks` への `ALTER TABLE ADD COLUMN` が 12 本混入し、適用すれば
  `duplicate column name` で落ちる。`drizzle.d1.config.ts` の冒頭コメントが
  この手順を警告している。

→ 索引追加は「スナップショットを本番に合わせる」作業と同じ PR でやるべきで、
別タスクとして切る。
