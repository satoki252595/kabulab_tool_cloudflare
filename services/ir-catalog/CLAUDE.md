# 006 ir-catalog — kabulab

**kabulab** プロジェクト群の 006 番。東証上場の個別株の適時開示 (IR /
TDnet) を全量取得し、表題から決定論的にタグ分類して色分け、銘柄ごとに
発表タイミングを時系列マッピングするサービス。

ポータル: `https://kabulab-cf.satoki252595.workers.dev/` / 本サービス: `/ir-catalog/`

## このサービス固有の絶対ルール (mono-repo CLAUDE.md に追加)

### タグは「表題から確信できた時だけ」付ける

**タグ分類**は `src/services/classify.ts` の **決定論的キーワード規則のみ**で、
**表題から行い本文は取得しない**。どの規則にも当たらない開示は `tags=[]` /
`primary_tag=NULL` のまま保存し、UI/Notion で「未分類」と正直に出す
(ルール1/2)。新しい分類を足すときも「それっぽい語で拾う」のは禁止。
必ず `classify.test.ts` に固定してからタグを追加する。

> ※ タグ分類とは別に、方向が表題で確定しない一部の高シグナルタグに限り
> **PDF 本文のセンチメント (ポジ/ネガ)** を `src/services/pdf-sentiment/` の
> OSS 軽量実装 (数値ルール + kuromoji 形態素解析 + 東北大極性辞書) で判定し、
> `pdf_sentiment*` 4 列へ保存する (クラウド AI API 不使用)。判定不能・対象外は
> `unknown`/`skipped` を正直記録 (捏造しない)。詳細は docs/006-ir-catalog.md。

### 方向を捏造しない

「配当予想の修正」「業績予想の修正」は **表題に方向 (増配/減配・
上方/下方) が明示されているときだけ** 方向タグを付ける。明示が
無ければ中立タグ (配当(決定・予想) / 業績予想の修正) に留める。

### ユニバース外は正直に切り捨てる

`company_code` 先頭 4 桁が `core_stocks` に居ない開示
(ETF/REIT/非上場/上場廃止) は取り込まない。推測で銘柄を当てない。

### サイトに負荷をかけない

TDnet 通信は `tdnet/client.ts` が全リクエストを直列化し最小間隔
750ms を強制。バックフィルは確定済み過去月を API で再取得しない
(Notion key 冪等で判定)。

### Notion: 一次=バッチ確定ファイル / 二次=銘柄別1IR=1行 (ルール6)

- **一次データ**: `recordPrimaryData` で月/当日バッチの確定 JSON 配列
  (`.json`) を実体アップロード (`一次データ｜ir-catalog`)。
- **二次データ**: `upsertDisclosuresByStock` で 親 DB `銘柄一覧｜ir-catalog`
  → 銘柄ページ配下 子 DB `適時開示｜<コード>` に **全 IR・全タグ・
  1IR=1行** を冪等記録 (親=ticker / 子行=TDnet ID)。子DB行は銘柄が文脈で
  確定するため銘柄コード/銘柄名列は持たず、タイトル=開示表題・直後に
  タグ。暫定採用の旧フラット `適時開示｜ir-catalog` は初回に自動で
  Notion ゴミ箱へ退避 (D1 から再生可)。一次データの D1 格納と同
  タイミング・TDnet 追加負荷なし。行に開示 PDF 実体を `IR資料` 添付
  + `IR資料状態`(uploaded/unavailable/too_large/**error**)。**TDnet は PDF
  を ~31日で purge** するため過去分は原本消失 = `unavailable`(終端) を
  正直記録 (捏造禁止・`資料` URL で出典担保)。PDF fetch は 15s タイム
  アウト必須。**一過性失敗(原本5xx/timeout・Notionエッジ遮断)は `error`
  にして 1 行でバッチを落とさず継続し、再実行で既存行を PATCH 更新して
  収束**(uploaded/unavailable/too_large は終端 skip)。Notion 前段の
  非JSON 4xx(CDN/WAF 遮断)は client.ts が一過性として再試行 (真正
  Notion JSON エラーは従来どおり恒久 throw)。backfill は
  `--notion-deadline-hours=N` で広域遮断時の時間膨張を打ち切り可。
- 「1IR=1行を全銘柄全履歴」は rule-6「高頻度・大量取得の境界」の明示的
  逸脱。**ユーザが規模 (IR数十万・数日級) を了承済**(現運用は直近~1ヶ月)の
  設計判断。冪等・再開可能を必ず維持し、日次は `NOTION_BUDGET_MS` で
  打ち切り (WINDOW 重なり+冪等で回収)。backfill は無制限。
- Notion 通信は共有 `notion-archive` 経由のみ (api.notion.com 直叩き禁止)。

## 技術スタック

- Runtime: Hono v4 + Cloudflare Workers (読取)
- DB: Cloudflare D1 (SQLite) + Drizzle ORM (drizzle-orm/d1 + sqlite-core)
- Validation: Zod v4
- Language: TypeScript (strict)

## DB スキーマ

単一 D1 `kabulab-cf` に全サービスが接頭辞テーブルで同居 (ADR-0001)。
006 は以下を使う。

| テーブル | 所有 | 用途 |
|---|---|---|
| `core_stocks` | 001 が更新 | 銘柄マスタ (読み取り専用で参照) |
| `ir_disclosures` | 006 のみ | 適時開示 (1 IR = 1 行) |

スキーマ正本: `services/ir-catalog/src/db/schema.ts` (export 名は
`disclosures`、実テーブル名は `ir_disclosures`)。実 DB 反映:
`pnpm db:generate:d1` → `wrangler d1 execute kabulab-cf --remote
--file=drizzle/d1/<n>.sql`。読取は Worker の `c.env.DB` バインディング
(createServiceDb / createDb)。

## データ取得

- **全履歴バックフィル (手動)**: `pnpm ir:backfill`
  (`-- --from=YYYY-MM` / `--to=YYYY-MM` / `--ticker=7203` /
  `--no-archive` / `--no-notion-signal` / `--refetch-archived`)。
  冪等・再開可能。
- **日次キャッチアップ**: GitHub Actions `catchup.yml` が `pnpm
  ingest:ir-tdnet` (`scripts/sync/ir-tdnet.ts`) を平日に実行。Node で
  kuromoji (PDF センチメント) を回し、D1 へは D1 HTTP API
  (createD1HttpDb) で書く。`src/cron/ir-catalog-tdnet.ts` の
  `runIrCatalogCatchup` を再利用し直近数日を 1 回で取得。TDnet は
  ホストが異なり 429 されないためプロキシ不要。

## ディレクトリ

```
services/ir-catalog/
├── app.ts / base-path.ts
├── src/
│   ├── index.ts                  # Hono サブアプリ本体
│   ├── env.ts                    # 型付き env アクセサ
│   ├── db/{client,schema}.ts     # ir_disclosures スキーマ (sqlite-core) + Drizzle
│   ├── routes/pages.ts           # SSR + JSON API
│   ├── services/
│   │   ├── tdnet/{client,types}.ts
│   │   ├── classify.ts           # 決定論的タグ分類 (UI/Notion 共通色)
│   │   ├── ingest.ts             # バッチ取込 (backfill/cron 共用)
│   │   └── query.ts              # UI クエリ
│   ├── views/{layout,home,stock-detail,signals,tag-chip}.ts
│   └── tests/classify.test.ts
└── data-scripts/backfill.ts
```

詳細は [docs/006-ir-catalog.md](../../docs/006-ir-catalog.md) を参照。
