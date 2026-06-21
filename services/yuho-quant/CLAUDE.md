# 005 yuho-quant — kabulab

**kabulab** プロジェクト群の 005 番。金融庁 **EDINET** の有価証券報告書から
「**受注高 / 受注残高**」をセグメント別 + 全社合計で構造化し、最大 5 年の
推移を可視化する定量情報検索サービス。

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

`ingestDocument` は先に軽量な CSV(type=5) を取り、全文に受注語が
無ければ重い XBRL(type=1) を**落とさない**。これは推測ではなく
「CSV は全テキストブロックを平坦化して含む」事実に基づく確定判定。

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
| `yuho_documents` / `yuho_order_facts` | 005 のみ | 有報メタ / 受注ファクト |

スキーマ生成は `drizzle.d1.config.ts`（`pnpm db:generate:d1`）→ `drizzle/d1/*.sql` を
`wrangler d1 execute kabulab-cf --remote --file=...` で適用。order_facts のバルク insert は
D1 の bind 上限(100)に合わせ 8 行/文 + `db.batch()` で投入する（`ingest.ts`）。

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
