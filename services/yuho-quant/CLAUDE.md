# 005 yuho-quant — kabulab

**kabulab** プロジェクト群の 005 番。金融庁 **EDINET** の有価証券報告書から
「**受注高 / 受注残高**」(セグメント別 + 全社合計) と
「**海外（地域別）売上高 / 海外売上高比率**」を構造化し、最大 5 年の推移を
可視化する定量情報検索サービス。**同じ有報 1 通**から受注と海外売上を並行して
構造化する（XBRL を 1 回だけ取得）。

ポータル: `https://kabulab-cf.satoki252595.workers.dev/` / 本サービス: `/yuho-quant/`

## このサービス固有の絶対ルール (mono-repo CLAUDE.md に追加)

### 受注データは「構造化できた時だけ」出す

有報の受注開示は会社ごとに表構造がバラバラ。**確信を持って構造を判定
できた表のみ**数値化する。判定できない表は数値を作らず `parse_status` に
事実を記録し、UI では「未対応」「データなし」と正直に出す
(ルール1/2 の帰結)。新しい開示パターンに対応するときも「とりあえず
それっぽい数値を拾う」実装は禁止。fixture を足してテストで固定してから
パターンを追加する。

### 金額欠損は NULL。0 で埋めない

有報で「－」「―」等の非開示セルは `null`。`order_facts` の
`*_raw` / `*_yen` も NULL。UI 表示は「—」。0 と区別する。

### EDINET API キーは yuhoEnv 経由のみ

`process.env.EDINET_API_KEY` 直参照禁止。`src/env.ts` の
`yuhoEnv.EDINET_API_KEY()` を使う (未設定なら throw)。`.env` のみが
正のソース。Worker ランタイムでは Cloudflare の Secrets が正
(`nodejs_compat` 経由で `process.env` に注入される)。

### 帯域を無駄にしない (CSV 事前判定)

`ingestDocument` は先に軽量な CSV(type=5) を取り、全文に受注語 **も** 海外語 **も**
無ければ重い XBRL(type=1) を**落とさない**。これは推測ではなく「CSV は全テキスト
ブロックを平坦化して含む」事実に基づく確定判定。XBRL は受注・海外どちらかの語が
あれば **1 回だけ**取得し、受注と海外売上を並行構造化する（二重ダウンロードしない）。

### 海外売上は「構造化できた時だけ」出す + 当期・連結を選ぶ (overseas-parser)

海外（地域別）売上の開示も会社ごとに表構造がバラバラ（新収益認識基準の地域別
収益分解・地域ごとの情報・所在地別・営業収益建ての地域別営業概況）。確信を持って
判定できた表のみ数値化し、判定できない表は `overseas_parse_status` に事実を記録して
UI で「未対応」と出す（ルール1/2）。**海外売上高 = 開示された海外地域行の合計**
（`total − 国内` ではない。「その他の収益」等の非地域分を混ぜない）。同一有報の
複数表からは **当期・連結・地域注記** に最も近い候補を採点で選ぶ（前期・個別を
出さない）。「うち、米国」内訳行は二重計上回避で除外。地域行の合計が開示集計行と
1% 超ずれる表は誤読として却下。スクリーニングの国・地域別フィルタは同義地域語を
`REGION_BUCKETS` で束ね、その地域を明示開示する会社だけを対象に丸めている会社は
除外する（架空の比較可能性を作らない）。新パターン対応も **実 fixture を足して
テストで固定してから**。旧基準「海外売上高」注記は現行有報からほぼ消滅（調査280件で
0件）のため対象外。`pnpm audit:overseas` で全銘柄の取りこぼし署名を集計できる。

> ✅ **ADR-0001 で本サービスは Cloudflare D1 へ移行済み・本番稼働中**（`docs/adr/0001-neon-to-d1-r2-notion.md`）。
> DB は **D1(`c.env.DB` バインディング)**、取込は **Worker の認証ルート + GitHub Actions トリガ**。
> 旧 `pnpm yuho:backfill` CLI は D1 移行で無効化（fail-fast）し、Worker バルク取込へ再実装予定。

## 技術スタック

- Runtime: Hono v4 + Cloudflare Workers
- DB: **Cloudflare D1 (SQLite) + Drizzle ORM**（`drizzle-orm/d1`。共有 core は `src/shared/db/core-schema.ts`）
- Validation: Zod v4
- ZIP 展開: 依存ゼロの自前リーダ (`src/services/edinet/zip.ts`)
- Language: TypeScript (strict)

## DB スキーマ（D1 / 単一 SQLite, 接頭辞テーブル）

| テーブル | 所有 | 用途 |
|---|---|---|
| `core_stocks` 他 | 共有(001 系) | 銘柄マスタ・財務 (読み取り専用で参照) |
| `yuho_documents` | 005 のみ | 有報メタ 1 通 = 1 行。`parse_status`(受注) + `overseas_parse_status`(海外) を併記 |
| `yuho_order_facts` | 005 のみ | 受注ファクト (segment 別 + 全社合計) |
| `yuho_overseas_facts` | 005 のみ | 海外売上ファクト (地域別)。同じ `yuho_documents` を親に持つ |

スキーマ生成は `drizzle.d1.config.ts`（`pnpm db:generate:d1`）→ `drizzle/d1/*.sql` を
`wrangler d1 execute kabulab-cf --remote --file=...` で適用。受注・海外とも facts の
バルク insert は D1 の bind 上限(100)に合わせ 8 行/文 + `db.batch()` で投入する（`ingest.ts`）。
統合前に受注のみ取り込んだ既存有報の海外埋め戻しは `pnpm backfill:overseas`（D1 HTTP）。

## データ取得

- **初回 5 年バックフィル**: 旧 `pnpm yuho:backfill` は D1 移行で無効化（fail-fast）。
  Worker バルク取込として再実装予定（別タスク・要 EDINET/Notion 鍵）。
- **日次キャッチアップ**: Worker の認証ルート `POST /yuho-quant/admin/catchup`（CRON_SECRET）で
  `runYuhoEdinetCatchup(createDb(c.env.DB))` を実行（`src/cron/yuho-edinet.ts`）。GitHub Actions の
  `catchup.yml`（平日夜）が薄いトリガ（`scripts/sync/yuho-edinet.ts` が `WORKER_BASE_URL` を叩く）から起動する。
  手動 curl / `pnpm ingest:yuho-edinet` でも叩ける。Workers Cron Trigger 配線は
  Phase 3。直近 WINDOW_DAYS(=60) 日を走査し未取込の有報を **1 回 MAX_INGEST(=40) 件 / TIME_BUDGET_MS(=90 秒)**
  で取り込み、超過分は次回が docId 冪等で回収 (6 月の集中も日次×日数で吸収)。`part`/`of` で
  shard 並走可。既存の他バッチとは独立し、失敗しても本体を壊さない
  (が結果はレスポンスに載せて運用者が気づける)。
- **調査スクリプト**: `pnpm yuho:investigate` (一回限り、`tmp/` 出力)。

### 一次データ Notion アーカイブ (mono-repo ルール6)

`ingestDocument` は `archiveToNotion: true` のとき、有報の **物理 ZIP を 2 本
(type=5 CSV / type=1 XBRL) そのまま Notion へ実体アップロード** し、EDINET
一覧のメタを `一次データ｜yuho-quant` DB (「バックアップ」配下) へ docId
キーで冪等記録する (`src/shared/notion-archive`)。backfill / 日次
キャッチアップとも `archiveToNotion: true`。Notion 記録は DB 取込とは独立に
冪等で、**DB 取込済でも Notion 未記録なら ZIP を取得して記録する** (再開
可能)。受注語なしでも有報自体は全件アップロード対象 (ユーザ要件「全有報」)。
type=1 未提供は捏造せず `xbrlUnavailable=true` を残し CSV のみ記録する。

## ディレクトリ

```
services/yuho-quant/
├── app.ts / base-path.ts
├── src/
│   ├── index.ts                  # Hono サブアプリ本体
│   ├── env.ts                    # 型付き env アクセサ (ルール3)
│   ├── db/{client,schema}.ts     # yuho_* 接頭辞テーブル + Drizzle(d1)
│   ├── routes/pages.ts           # SSR + JSON API
│   ├── services/
│   │   ├── edinet/{client,types,zip,csv,html-table,order-parser}.ts
│   │   ├── ingest.ts             # 1 通取り込み (backfill/cron 共用)
│   │   └── order-query.ts        # UI クエリ (5年推移)
│   ├── views/{layout,home,stock-detail}.ts
│   └── tests/{order-parser.test.ts, fixtures/*}
└── data-scripts/{investigate,investigate2,backfill}.ts
```

詳細は [docs/005-yuho-quant.md](../../docs/005-yuho-quant.md) を参照。
