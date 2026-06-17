# 006 ir-catalog — IRカタログ (適時開示の意味別色分け)

東証上場の **個別株の適時開示 (IR / TDnet)** を全量取得し、表題から
**決定論的に** タグ分類して色分け、銘柄ごとに発表タイミングを時系列
マッピングするサービス。

> kabulab mono-repo (`services/ir-catalog/`) として配置され、
> `https://kabulab.vercel.app/ir-catalog/*` で公開される。

## コンセプト

- 「いつ・どの銘柄が・どんな意味の開示を出したか」を一覧化。増配 /
  上方修正 / 自社株買い / 配当政策の変更 などの **高シグナル開示** を
  色で即判別できる。
- **タグ分類は表題のみ** から決定論的に行う (全量取得が現実的)。どの規則
  にも当たらない開示は **「未分類」** と正直に出す (推測タグを捏造しない —
  ルール1/2)。
- 方向 (増配/減配・上方/下方) は **表題に明示があるときだけ** 付ける。
  「配当予想の修正」等で方向が書かれていなければ中立タグに留める。
- **PDF 本文のセンチメント (ポジ/ネガ) 判定** は、表題だけで方向が確定
  しない一部の高シグナルタグ (業績予想の修正 / 配当(決定・予想) / 特別損益 /
  配当政策の変更 / エクイティファイナンス / 自己株式の処分) に **限り**、
  開示 PDF 本文を取得して **OSS 軽量実装** で判定する (クラウド AI API 不使用・
  利用料ゼロ)。判定不能・対象外は捏造せず `unknown`/`skipped` を正直記録
  (ルール1/2)。詳細は後述の「PDF センチメント判定」節。

## データ取得元 (yanoshin TDnet WebAPI)

| 用途 | エンドポイント |
|---|---|
| 開示一覧 | `GET https://webapi.yanoshin.jp/webapi/tdnet/list/{range}.json?limit=N&page=P` |

- `{range}` = `YYYYMMDD` / `YYYYMMDD-YYYYMMDD` / `recent`。
- `total_count` は当該レスポンス件数なので **件数判定に使わない**。
  返却件数 < `limit` のページで打ち切る。
- `company_code` は 5 桁 (例 `72030` → ティッカー `7203`)。先頭 4 桁を
  取り `core.stocks.code` と突合。居なければ **ユニバース外**として
  正直に除外 (ETF/REIT/非上場/上場廃止)。
- 全 TDnet 通信は `tdnet/client.ts` がプロセス内で直列化し最小間隔
  750ms を強制 (サイト負荷回避)。5xx/429 は指数バックオフ、4xx は throw。

## タグ分類 (`src/services/classify.ts`)

決定論的キーワード規則。配列順 = primaryTag 優先順位。高シグナル
(`highSignal`) を上位に並べる。色は UI チップと Notion multi_select で
共有する単一定義。各タグに投資初心者向けバルーン文 (ルール7) を持つ。

**高シグナル**: 上方修正 / 下方修正 / 増配 / 減配・無配 /
配当政策の変更 / 自社株買い / 自己株式の消却。
**その他**: 配当(決定・予想) / 業績予想の修正 / 決算短信 / 特別損益 /
株式分割・併合 / エクイティファイナンス / 自己株式の処分 /
M&A・資本提携 / 月次・速報 / 重要事象(調査等) / 上場・市場区分 /
人事・組織 / 訂正・取消。

## PDF センチメント判定 (`src/services/pdf-sentiment/`)

表題だけで方向が確定しない一部タグに限り、開示 PDF 本文を取得して
ポジ/ネガを **OSS 軽量実装** で判定する (クラウド AI API 不使用)。テキスト
抽出は `unpdf`、判定は `dispatch.ts` が `primary_tag` でエンジンを振り分ける。

| 対象タグ | エンジン | 方式 |
|---|---|---|
| 業績予想の修正 | `rule_v1` (forecast) | 数値テーブル抽出 (営業利益等の新旧比較) |
| 配当(決定・予想) | `rule_v1` (dividend) | 配当額テーブル抽出 |
| 特別損益 | `rule_v1` (extra) | 特別損益テーブル抽出 |
| 配当政策の変更 / エクイティファイナンス / 自己株式の処分 | `dict_v1` | kuromoji 形態素解析 + 東北大『日本語評価極性辞書』 |

- 出力: `positive` / `negative` / `mixed` / `unknown` / `skipped`、`score` (-1.0〜+1.0)、`method` (rule_v1/dict_v1)。
- **表題で方向確定済**のタグ (上方修正 / 下方修正 / 増配 / 減配・無配 / 自社株買い / 自己株式の消却 等) や判定不要タグ・未分類は `skipped`。PDF が画像化/抽出 0 文字なら `unknown`。**架空の positive/negative で埋めない** (ルール1/2)。
- ingest 経路 (`ingest.ts`) で算出し DB の `pdf_sentiment*` 4 列へ保存。既存行の再判定は `pnpm ir:backfill -- --rejudge-pdf-sentiment` (terminal でない行を再評価)。

## DB スキーマ (`ir_catalog`)

```
ir_catalog.disclosures   1 適時開示 = 1 行 (tdnet_id 一意 = 冪等キー)
  stock_id → core.stocks(id)            -- core は 001 所有・読み取り専用
  tdnet_id / company_code / company_name / title
  pubdate / document_url / xbrl_url(nullable) / markets_string
  tags text[] (0件可=未分類) / primary_tag(nullable=未分類)
  ingested_at
  -- PDF センチメント (後述。判定対象外/未判定は NULL)
  pdf_sentiment text(nullable)         -- positive / negative / mixed / unknown / skipped
  pdf_sentiment_method text(nullable)  -- rule_v1 / dict_v1
  pdf_sentiment_score real(nullable)   -- -1.0〜+1.0
  pdf_sentiment_at timestamptz(nullable)
```

実 DB 反映は手書き SQL を
`node scripts/db/apply-migration.mjs drizzle/create-ir-catalog.sql`。
PDF センチメント 4 列は後追いの
`drizzle/add-pdf-sentiment-to-ir-disclosures.sql` で追加 (NULL 多数のため
`pdf_sentiment` は WHERE 付き部分 index)。
`drizzle.ir-catalog.config.ts` は型生成 / studio / 差分確認用。

## データ取得フロー

1. **全履歴バックフィル (手動)**: `pnpm ir:backfill`
   (`-- --from=YYYY-MM` / `--to=YYYY-MM` / `--ticker=7203` /
   `--no-archive` / `--no-notion-signal` / `--refetch-archived`)。
   月単位で新しい順に遡り、空月が 12 連続したらデータ開始点に到達と
   判断して停止 (推測でなく事実で止める)。tdnet_id / Notion key 冪等で
   **再開可能**。確定済み過去月は API を叩かずスキップ。
2. **日次キャッチアップ**: 新規 cron は作らず統一 daily cron に相乗り。
   `src/cron/ir-catalog-tdnet.ts` を `src/index.ts` の日次ハンドラが
   **shard 0 のときだけ** 呼ぶ (TDnet は範囲一括取得でシャード分散
   不要)。直近 7 日を 1 回で取得。既存 Yahoo 日次とは独立し、失敗
   しても本体を壊さない (が結果はレスポンスに載せ運用者が気づける)。

### Notion 記録 (一次データ + 二次データ)

**一次データ (ルール6)**: 取得バッチ (= 月 / 当日) 単位の確定 JSON 配列
(`.json`) を物理アップロード (`一次データ｜ir-catalog`、key 冪等)。DB が
全件の正本。

**二次データ (銘柄ごと階層)**: 親 DB `銘柄一覧｜ir-catalog`
(「バックアップ」配下。1 銘柄 = 1 ページ。列: 銘柄コード[タイトル] /
銘柄名[rich_text・buffett-code リンク] / コード[select]) → 各銘柄ページ
配下に子 DB `適時開示｜<コード>` を自動生成し、その銘柄の
**全適時開示・全タグ・1 IR = 1 行** で冪等記録する。一次データの
Postgres 格納と同タイミング、TDnet API へ追加負荷なし。冪等キー:
親=ticker / 子行=TDnet ID。暫定採用していた旧フラット DB
`適時開示｜ir-catalog` は初回に **自動で Notion ゴミ箱へ退避**
(Postgres から再生可)。

子 DB の列 (タイトル列は Notion 仕様上必ず最左固定。タグはタイトル直後):
開示表題[タイトル] / **タグ[multi_select・色付き・全タグ]** /
代表タグ[select] / IR発表日[date] / 市場[rich_text] /
資料[URL=document_url] / **IR資料[files=開示 PDF 実体]** /
**IR資料状態[select: uploaded/unavailable/too_large/error]** /
**PDF判定[select: positive/negative/mixed/skipped・色は UI チップと整合]** /
TDnet ID[rich_text=冪等キー]。子DB行は銘柄が文脈で確定するため
銘柄コード/銘柄名列は持たない (親ページ側で表現)。Notion API には
列の表示順を設定するエンドポイントが無いため、UI上の最終列順は
一度のドラッグ調整が必要 (プログラムからは保証不可・プラットフォーム制約)。

状態の意味と再実行収束:
- `uploaded` … PDF 実体添付済 (終端・再実行 skip)
- `unavailable` … 原本が恒久不在 (404/非PDF。再取得しても不変=終端)
- `too_large` … WS ファイル上限超過 (終端)
- `error` … **一過性失敗** (原本側 5xx/429/timeout/network、または
  Notion 側エッジ遮断が client.ts 再試行後も継続)。**再実行で再取得・
  ページ更新され収束**する (作り直さず PATCH。重複作成なし)。

> ⚠️ TDnet (release.tdnet.info) は開示 PDF を **公開後 ~31 日で purge**
> する。よって物理添付できるのは概ね直近 ~31 日の開示のみ — 日次
> キャッチアップ分は実添付され、全履歴 backfill の過去分は原本が既に
> 存在せず `unavailable` を正直記録する (ファイルは捏造しない・`資料`
> URL 列で出典は担保 — ルール1/2)。

> ℹ️ 大量投入時、Notion 前段の CDN/WAF が一過性 HTML 403 を返すことが
> ある。client.ts は **非 JSON 4xx をエッジ起因の一過性とみなし指数
> バックオフ再試行** する (真正 Notion エラー JSON は従来どおり恒久
> throw で surface)。1 行の最終失敗はバッチ全体を落とさず `error` で
> 可視化し、再実行で収束。backfill は `--notion-deadline-hours=N` で
> 上限を設けると、広域遮断継続時に正直に打ち切り (`(打切)` ログ) →
> 再実行で `error`/未添付行から収束できる。
一次データの Postgres 格納と **同タイミング** で投入する (手元の items を
そのまま使うため TDnet API へ追加負荷なし)。親は ticker、子行は TDnet ID
で冪等 (全履歴投入が再開可能)。

> ⚠️ 「1 IR = 1 Notion 行」を全銘柄・全履歴で行うのは、ルール6
> 「高頻度・大量取得の境界」が個別大量生成を避ける根拠とした Notion
> 上限/コストに直結する。これは規模 (IR行 数十万・全履歴投入 数日級)
> をユーザが明示了承したうえでの設計判断。冪等・再開可能 (現状の運用
> 方針は「直近 ~1ヶ月」。過去 5 年は不要)。

日次キャッチアップの二次データ投入は Vercel 300s 内に収めるため
`NOTION_BUDGET_MS`(50s) で必ず打ち切り、残りは WINDOW_DAYS の重なりと
TDnet ID 冪等で翌日以降が回収する (常態的に打ち切るなら過去ギャップ大
= backfill を回す合図)。backfill は無制限 (再開可能)。Notion 通信は
全て共有 `notion-archive` のレート制御クライアント経由
(api.notion.com を直叩きしない)。`一次データ｜ir-catalog` の `.json`
バッチ archive は従来どおり不変。

## UI

- `/` 検索 (コード/会社名) + タグ色分け凡例 (初心者バルーン付) +
  最近の高シグナル開示。ヒット 0 件は「該当なし」を正直表示。
- `/stock/:code` IR 発表タイミングの月グループ・タグ色分け
  タイムライン。期間 1年/2年/5年/全期間。銘柄名は buffett-code へ
  リンク。加えて **横軸シグナル時系列 SVG** (JS 不要。title 確定=塗り潰し /
  PDF推定=中抜き dashed / TITLE+PDF=外輪) と **シグナルハイライト** 節で、
  title 判定 (確定) と PDF 判定 (推定) を source 付きで混在表示。各行は
  PDF センチメントで左ボーダー色付け、矛盾時は「本文確認推奨」を明示。
  「PDF推定」は確定でない旨と「AI API 不使用 (利用料 0)」をバルーンで明記。
- `/signals` 全銘柄横断の高シグナル一覧。
- `/api/stock/:code` JSON。
- デザインは共通 Editorial Swiss Grid (`src/shared/design.ts`)。

## 注意・免責

- 分類は **表題ベース**。内容の最終確認は各開示の原本 (PDF) で行う。
- 「未分類」は推測タグを付けていない開示 (≠分類漏れの黙殺)。
- 出典: TDnet (yanoshin WebAPI)。投資判断は必ず開示原本を確認。
