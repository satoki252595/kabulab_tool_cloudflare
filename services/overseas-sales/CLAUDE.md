# 008 overseas-sales — kabulab

**kabulab** プロジェクト群の 008 番。金融庁 **EDINET** の有価証券報告書から
「**海外（地域別）売上高 / 海外売上高比率**」を構造化し、最大 5 年の推移を
可視化する定量情報検索サービス。005 yuho-quant（受注高/受注残高）の姉妹版で、
同じ EDINET パイプラインを共有する。

ポータル: `https://kabulab-cf.satoki252595.workers.dev/` / 本サービス: `/overseas-sales/`

## このサービス固有の絶対ルール (mono-repo CLAUDE.md に追加)

### 海外売上は「構造化できた時だけ」出す

有報の地域別売上開示は会社ごとに表構造がバラバラ（新収益認識基準の地域別
収益分解・旧基準の海外売上高注記・所在地別セグメント等）。**確信を持って
構造を判定できた表のみ**数値化する。判定できない表は数値を作らず
`parse_status` に事実を記録し、UI では「未対応」「データなし」と正直に出す
(ルール1/2)。新パターン対応も「とりあえずそれっぽい数値を拾う」実装は禁止。
**実有報の fixture を足してテストで固定してから**パターンを追加する。

### 海外売上高 = 開示された海外地域行の合計（total−国内 ではない）

「外部顧客への売上高」総額には地域に按分されない「その他の収益」が混じる
ことがある。海外売上高は **会社が開示した海外地域行（北米/欧州/アジア…）の
合計** を採り、`total − 日本` で非地域分を海外に混入させない（ルール1）。
地域行の合計と開示総額が 1% 超ずれる表は誤読として却下する。

### 当期・連結を選ぶ（前期・個別を出さない）

同一有報に地域別売上表は複数ある（連結/個別・前期/当期・収益分解/セグメント
情報）。最初に当たった表ではなく、見出し+表の文脈を採点して **当期・連結・
地域注記** に最も近い候補を選ぶ（`scoreCandidate`）。前期や個別の数値を
出さないための要（ルール1）。

### 金額欠損は NULL。0 で埋めない

有報で「－」等の非開示セルは `null`。`sales_raw`/`sales_yen`/`ratio_pct` も
NULL。UI 表示は「—」。0 と区別する。

### EDINET 取得・汎用ユーティリティは 005 を再利用する

EDINET クライアント・CSV パーサ・ZIP リーダ・HTML テーブル化
（`services/yuho-quant/src/services/edinet/{client,csv,zip,html-table,types}.ts`）
は受注専用ではなく汎用なので **import で再利用** し、重複実装を作らない。
008 が固有に持つのは `overseas-parser.ts`（海外売上の構造化）と ingest/query/
views/schema のみ。API キーは 005 の `yuhoEnv.EDINET_API_KEY()` 経由
（`.env` が正のソース。Worker は Cloudflare Secrets）。

### 一次データの Notion アーカイブは 005 が実施済み（重複させない）

有報の物理 ZIP の Notion 一次アーカイブ（ルール6）は 005 yuho-quant が docId
キーで **全有報** を既に実施済み。008 は同一物理ファイルを重複アップロード
しない（ルール6 が課す冪等・レート遵守の帰結）。008 は派生構造化のみを D1 に
持つ。

## 技術スタック

- Runtime: Hono v4 + Cloudflare Workers / DB: Cloudflare D1 + Drizzle ORM(d1)
- Validation: Zod v4 / Language: TypeScript (strict)
- ビュー: template literal を返す `.ts` 関数（JSX 禁止・mono-repo 方針）

## DB スキーマ（D1 / 接頭辞 `oseas_`）

| テーブル | 所有 | 用途 |
|---|---|---|
| `core_stocks` 他 | 共有(001 系) | 銘柄マスタ・財務 (読み取り専用で参照) |
| `oseas_documents` / `oseas_sales_facts` | 008 のみ | 有報メタ / 海外売上ファクト |

`oseas_sales_facts.region_kind`: `domestic`(日本/本邦) / `overseas`(個別海外地域) /
`overseas_total`(海外売上高合計=開示海外地域の和) / `total`(連結売上高=比率の分母)。
スキーマ生成は `drizzle.d1.config.ts`（`pnpm db:generate:d1`）→ `drizzle/d1/*.sql` を
`wrangler d1 execute kabulab-cf --remote --file=...` で適用。facts のバルク insert は
D1 bind 上限(100)に合わせ 8 行/文。

## データ取得

- **日次キャッチアップ**: Worker 認証ルート `POST /overseas-sales/admin/catchup`
  （CRON_SECRET）で `runOverseasEdinetCatchup(createDb(c.env.DB))` を実行
  （`src/cron/overseas-edinet.ts`）。直近 60 日を走査し未取込の有報を構造化保存。
- **バックフィル**: `pnpm exec tsx services/overseas-sales/data-scripts/backfill-overseas.ts`
  （Node → D1 HTTP）。005 が記録済みの yuho_documents（最大5年×全銘柄）を
  コーパスに全有報を構造化。冪等・再開可能。
- **答え合わせ監査**: `audit-all.ts`。最新有報を全銘柄で検証し、取りこぼし
  （日本+海外+売上の実テーブルがあるのに ok にならない）を署名集計して
  追加パターン候補を出す。`tmp/oseas-audit/`、本文 HTML は `tmp/oseas-cache/` に
  キャッシュ（パーサ反復で再ダウンロード不要）。

## ディレクトリ

```
services/overseas-sales/
├── app.ts / base-path.ts
├── src/
│   ├── index.ts                    # Hono サブアプリ本体
│   ├── db/{client,schema}.ts       # oseas_* 接頭辞テーブル + Drizzle(d1)
│   ├── routes/{pages,admin}.ts     # SSR + JSON API / 取込ルート
│   ├── services/
│   │   ├── overseas-parser.ts      # 地域別売上の決定論的構造化（本サービスの核）
│   │   ├── ingest.ts               # 1 通取り込み (Worker binding)
│   │   └── overseas-query.ts       # UI クエリ + スクリーニング
│   ├── views/{layout,home,stock-detail,screening}.ts
│   └── tests/{overseas-parser.test.ts, fixtures/*}
└── data-scripts/{backfill-overseas,audit-all}.ts
```

詳細は [docs/008-overseas-sales.md](../../docs/008-overseas-sales.md) を参照。
