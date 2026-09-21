# 005 yuho-quant — 有報定量検索

金融庁 **EDINET** の有価証券報告書 (有報) から「**受注高 / 受注残高**」(セグメント別
+ 全社合計)と「**海外（地域別）売上高 / 海外売上高比率**」を構造化し、最大 5 年の
推移を可視化するサービス。**同じ有報 1 通**から受注・海外売上に加え、投資判断に
使う**開示テキスト 39 項目**（定性 6 + 株主・資本・資産・体制の細目。
`TEXT_SECTIONS` が正本。項目名は EDINET CSV の実測値に合わせ、
` [テキストブロック]` 接尾辞を剥がして照合する）を並行抽出する
（XBRL は 1 回だけ取得、開示テキストは CSV のみで追加ダウンロードなし）。
個別銘柄ページで受注と海外売上を、スクリーニングで「受注の成長性」⇄
「海外売上高比率（中国/米州 等の地域別エクスポージャ）」をトグルで
切替表示する。開示テキストはテーマ判定等の下流が D1 から読む。

> kabulab mono-repo (`services/yuho-quant/`) として配置され、
> `https://kabulab-cf.satoki252595.workers.dev/yuho-quant/*` で公開される。
> 旧 008 overseas-sales（独立サービス）は元ネタが同じ有報のため本サービスへ統合
> （取得・パーサ・コーパスを共有して二重取得を避ける）。

## コンセプト

- 有報の **受注に関する開示は非構造化** (会社ごとに表の作りが違う)。これを
  ローカルで実データ精査 → 決定論的パーサで構造化 → DB 化して横断検索。
- 取得範囲はユーザ要件により **「受注 + 海外売上 + 開示テキスト 39 項目 + 書類メタのみ」**。
  全 XBRL ファクトは D1 容量逼迫リスクのため取り込まない（ファクト本体の
  所在索引は pipeline 側の `jss_xbrl_documents` が持つ）。
- EDINET で取得できる過去分 (本サービスは最大 5 年表示)。
  書類一覧 API の遡及下限は **直近 10 年のローリング** (2026-09-21 に実 API で
  確認: 2016-06 以前は一覧が空形状で返り取得不可、2016-09 以降は取得可)。

## EDINET API v2 (使用エンドポイント)

| 用途 | エンドポイント |
|---|---|
| 書類一覧 | `GET /api/v2/documents.json?date=YYYY-MM-DD&type=2&Subscription-Key=KEY` |
| 書類取得 | `GET /api/v2/documents/{docID}?type=N&Subscription-Key=KEY` |

- `type=1` = 提出本文書 (XBRL) ZIP / `type=5` = CSV ZIP
- 有報判定: `docTypeCode` `120`(有報) / `130`(訂正有報)、`withdrawalStatus≠1`
- 書類一覧の `results[]` に `secCode`(証券コード5桁) と `edinetCode` が含まれる
  ため、**別途 EDINET コードリストを引かず** `secCode→core_stocks.code`
  (先頭4桁) で銘柄突合する。
- `filerName` / `submitDateTime` は取下げ等で `null` になり得る (実 API 確認済)。

## 受注開示の実地調査 (削除済みの一時スクリプト data-scripts/investigate*.ts と tmp/)

一時スクリプトで受注生産型 28 社の最新有報を取得し精査した結果（スクリプトは
K1a で削除。git 履歴に残る）:

- **EDINET CSV(type=5)** はテキストブロックを平坦テキスト化し表セル境界を
  失う → 受注表の確実な構造化には **iXBRL(type=1) の `<table>`** が必要。
  ただし CSV は全テキストブロックを含むので「受注語の有無判定」には有効
  (= 重い XBRL を落とす前の事前フィルタに使う)。
- 受注表は本文 iXBRL
  `XBRL/PublicDoc/..._honbun_jpcrp030000-asr-..._ixbrl.htm` の `<table>`。
- 開示は概ね 2 パターンに集約 (それ以外は **構造化せず明示**):

### Pattern A — 受注高/受注残高 セグメント表 (重工・機械・電機等)

例: 7011 三菱重工 / 7012 川崎重工 / 7013 IHI。見出しに「受注高」と
「受注残高(or 期末受注残高)」を持つセグメント表。

```
セグメント名 | 受注高(百万円) | 前期比% | 受注残高(百万円) | 前期比%
```

- 当該有報の **当期 (連結) 1 期分**のみ (前年は%比較だけ)。5 年推移は
  年次有報を 5 通積み上げて構成。
- 見出しが 2 行でセグメント列が結合され省かれるケース (7011) は列補正。
- `合計`=total / `報告セグメント計`等=subtotal / `調整額`『全社又は消去』
  =elimination。`△` は負値。
- IHI には「受注高+売上収益+営業損益」表 (受注残高なし) もあるが、
  これは Pattern A 要件 (受注高 **かつ** 受注残高) を満たさないので
  `orders_only` として**構造化しない** (誤マップ防止)。

### Pattern B — 建設業 完成工事 (期別×種類別)

例: 1812 鹿島建設。

```
期別 | 種類別 | 期首繰越高 | 当期受注高 | 計 | 当期売上高 | 期末繰越高
```

- `当期受注高`→受注高、`期末繰越高`→受注残高相当。`前事業年度` /
  `当事業年度` の **2 期分**を含む。rowspan で平坦化されセル数が
  揺れるため「末尾 K 個の数値セル + その直前を種類別ラベル」で抽出
  (決定論的・推測なし)。

### それ以外

`orders_only` / `table_unrecognized` / `no_order_table` / `parse_error`
を `parse_status` に正直に記録し、UI で「未対応 / データなし」と表示。
数値は一切捏造しない。

## DB スキーマ (D1 / 単一 SQLite, 接頭辞テーブル)

```
yuho_documents        取り込んだ有報 1 通 = 1 行 (doc_id 一意 = 冪等キー)
  stock_id → core_stocks(id)
  edinet_code / doc_id / doc_type_code / filer_name
  period_start / period_end / submitted_at
  parse_status / honbun_file / ingested_at
yuho_order_facts      (有報, 会計期末, セグメント) 粒度
  document_id → yuho_documents(id) / stock_id → core_stocks(id)
  fiscal_year_end / segment_name / segment_kind (segment|subtotal|total|elimination)
  is_consolidated (連結t/個別f/不明NULL — 推測しない)
  unit_label / orders_received_raw / order_backlog_raw
  orders_received_yen / order_backlog_yen (円換算, 欠損NULL)
  pattern (pattern_a|pattern_b)
  UNIQUE(document_id, fiscal_year_end, segment_name)  -- 冪等 upsert
yuho_overseas_facts     (有報, 会計期末, 地域) 粒度
  document_id → yuho_documents(id) / stock_id → core_stocks(id)
  fiscal_year_end / region_name / overseas_sales_yen / overseas_ratio
yuho_text_sections      (有報, セクション) 粒度。開示テキスト 39 項目の本文
  document_id → yuho_documents(id) / stock_id → core_stocks(id)
  fiscal_year_end / section_key (TextSectionKey 39 項目。TEXT_SECTIONS が正本) /
    text / element_id / item_name / context_id / char_count
  UNIQUE(document_id, section_key)  -- 冪等 upsert
p_yuho_growth           L2 投影 (K4b)。EDINET catchup の末尾で再生成
  stock_id / 受注 CAGR・YoY / 海外比率 (screening の読取専用)
```

`core_*` は日次 sync が更新するため読み取り専用参照 (再宣言せず共有
`src/shared/db/core-schema.ts` を import)。スキーマ生成は
`pnpm db:generate:d1` → `drizzle/d1/*.sql` を
`wrangler d1 execute kabulab-cf --remote --file=...` で適用。order_facts の
バルク insert は D1 の bind 上限(100)に合わせ 8 行/文 + `db.batch()` で投入する。

## データ取得フロー

1. `ingestDocument`: docId 既存ならスキップ → CSV(type=5) 取得 → 全文に
   受注語が無ければ `no_order_table` 確定 (XBRL を落とさない) → 有れば
   XBRL(type=1) を取得し `parseOrderData` で構造化 → `documents` /
   `order_facts` を冪等 upsert。同じ XBRL から海外売上も並行構造化し、
   CSV 行からは開示テキスト 39 項目を `extractTextSections` で並行抽出
   (XBRL 不要・追加ダウンロードなし) → `text_sections` を冪等 upsert。
   訂正報告書 (130) は提出日時が新しい方を UI 採用。既存有報の定性
   埋め戻しは `pnpm yuho:backfill:text` (CSV のみ再取得)。
   日次は古い日から FIFO で 60 件/300s まで。ピーク期の取りこぼしは
   `pnpm yuho:backfill:missing -- --from= --to=` で期間指定回収する
   (2026-06 ピークは日次上限で欠落したため本経路で回収)。
2. **初回 5 年バックフィル**: 旧 `pnpm yuho:backfill` CLI は D1 移行に伴い
   無効化 (fail-fast。`assertYuhoBackfillSupported()`。理由は同関数の
   docstring と `d1-http-batch-boundary.test.ts` を参照:
   `db.batch()` が sqlite-proxy で動かないため)。
   D1 はバインディング経由でのみ触れるため、バルク取込は Worker 側へ
   再実装予定 (別タスク)。
3. **日次キャッチアップ**: Worker の認証ルート
   `POST /yuho-quant/admin/catchup` (CRON_SECRET) が
   `runYuhoEdinetCatchup(createDb(c.env.DB))` を呼ぶ (`src/cron/yuho-edinet.ts`)。
   GitHub Actions の `catchup.yml` が平日 11:00 UTC に薄いトリガ
   (`scripts/sync/yuho-edinet.ts` が `WORKER_BASE_URL` を叩く) で起動する。
   直近 60 日を走査し 1 回 40 件 / TIME_BUDGET 90 秒で打ち切り、超過分は
   次回が docId 冪等で回収。`part`/`of` で shard 並走可 (非シャード実行の
   末尾で L2 投影 `p_yuho_growth` を再生成)。失敗しても本体を
   壊さずレスポンスに記録 (運用者が気づける)。Workers Cron は使わない
   (無料運用方針)。

## UI

- `/` 検索フォーム (コード/会社名)。ヒット 0 件は「該当なし」を正直表示。
- `/screening` 受注の成長性スクリーニング (L2 投影 `p_yuho_growth` 読み) +
  `/api/screening` JSON。
- `/screening-overseas` 海外売上高比率スクリーニング (地域別エクスポージャ) +
  `/api/screening-overseas` JSON。
- `/stock/:code` 受注高/受注残高の 5 年 SVG グラフ + 年次×セグメント表 +
  出典 (EDINET docID/提出日/構造化結果)。構造化不能は「未対応」を明示。
- `/api/trend/:code` JSON。
- デザインは共通 Editorial Swiss Grid (`src/shared/design.ts` から token)。

## 注意・免責

- 数値は有報開示単位を円換算し **億円** 表示。「—」は非開示=欠損 (≠0)。
- 受注高/受注残高は受注生産型が中心。それ以外は EDINET に開示が無い。
- 投資判断は必ず原典 (有価証券報告書) を確認すること。出典: 金融庁 EDINET。
