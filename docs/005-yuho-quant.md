# 005 yuho-quant — 有報定量検索

金融庁 **EDINET** の有価証券報告書 (有報) から「**受注高 / 受注残高**」を
セグメント別 + 全社合計で構造化し、最大 5 年の推移を可視化するサービス。

> kabulab mono-repo (`services/yuho-quant/`) として配置され、
> `https://kabulab.vercel.app/yuho-quant/*` で公開される。

## コンセプト

- 有報の **受注に関する開示は非構造化** (会社ごとに表の作りが違う)。これを
  ローカルで実データ精査 → 決定論的パーサで構造化 → DB 化して横断検索。
- 取得範囲はユーザ要件により **「受注 + 書類メタのみ」**。全 XBRL ファクトは
  Neon 容量逼迫リスクのため取り込まない。
- EDINET で取得できる過去分 (本サービスは最大 5 年表示)。

## EDINET API v2 (使用エンドポイント)

| 用途 | エンドポイント |
|---|---|
| 書類一覧 | `GET /api/v2/documents.json?date=YYYY-MM-DD&type=2&Subscription-Key=KEY` |
| 書類取得 | `GET /api/v2/documents/{docID}?type=N&Subscription-Key=KEY` |

- `type=1` = 提出本文書 (XBRL) ZIP / `type=5` = CSV ZIP
- 有報判定: `docTypeCode` `120`(有報) / `130`(訂正有報)、`withdrawalStatus≠1`
- 書類一覧の `results[]` に `secCode`(証券コード5桁) と `edinetCode` が含まれる
  ため、**別途 EDINET コードリストを引かず** `secCode→core.stocks.code`
  (先頭4桁) で銘柄突合する。
- `filerName` / `submitDateTime` は取下げ等で `null` になり得る (実 API 確認済)。

## 受注開示の実地調査 (data-scripts/investigate*.ts, tmp/)

`pnpm yuho:investigate` で受注生産型 28 社の最新有報を取得し精査した結果:

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

## DB スキーマ (`yuho_quant`)

```
yuho_quant.documents      取り込んだ有報 1 通 = 1 行 (doc_id 一意 = 冪等キー)
  stock_id → core.stocks(id)
  edinet_code / doc_id / doc_type_code / filer_name
  period_start / period_end / submitted_at
  parse_status / honbun_file / ingested_at
yuho_quant.order_facts    (有報, 会計期末, セグメント) 粒度
  document_id → documents(id) / stock_id → core.stocks(id)
  fiscal_year_end / segment_name / segment_kind (segment|subtotal|total|elimination)
  is_consolidated (連結t/個別f/不明NULL — 推測しない)
  unit_label / orders_received_raw / order_backlog_raw
  orders_received_yen / order_backlog_yen (円換算, 欠損NULL)
  pattern (pattern_a|pattern_b)
  UNIQUE(document_id, fiscal_year_end, segment_name)  -- 冪等 upsert
```

`core` は 001 所有のため読み取り専用参照 (再宣言せず rsi-screening の
core-schema を import)。実反映は `drizzle/create-yuho-quant.sql` を
`scripts/db/apply-migration.mjs` で適用。

## データ取得フロー

1. `ingestDocument`: docId 既存ならスキップ → CSV(type=5) 取得 → 全文に
   受注語が無ければ `no_order_table` 確定 (XBRL を落とさない) → 有れば
   XBRL(type=1) を取得し `parseOrderData` で構造化 → `documents` /
   `order_facts` を冪等 upsert。訂正報告書 (130) は提出日時が新しい方を
   UI 採用。
2. **初回 5 年バックフィル**: `pnpm yuho:backfill` (手動・冪等・再開可能)。
3. **日次キャッチアップ**: 統一 daily cron (shard 0) が
   `runYuhoEdinetCatchup` を呼ぶ。直近 45 日・1 回 80 件上限。
   既存 Yahoo 日次から独立し、失敗は本体を壊さずレスポンスに記録。

## UI

- `/` 検索フォーム (コード/会社名)。ヒット 0 件は「該当なし」を正直表示。
- `/stock/:id` 受注高/受注残高の 5 年 SVG グラフ + 年次×セグメント表 +
  出典 (EDINET docID/提出日/構造化結果)。構造化不能は「未対応」を明示。
- `/api/trend/:id` JSON。
- デザインは共通 Editorial Swiss Grid (`src/shared/design.ts` から token)。

## 注意・免責

- 数値は有報開示単位を円換算し **億円** 表示。「—」は非開示=欠損 (≠0)。
- 受注高/受注残高は受注生産型が中心。それ以外は EDINET に開示が無い。
- 投資判断は必ず原典 (有価証券報告書) を確認すること。出典: 金融庁 EDINET。
