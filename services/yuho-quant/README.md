# 005 yuho-quant — 有報定量検索

金融庁 **EDINET** の有価証券報告書から「受注高 / 受注残高」(セグメント別 +
全社合計) と「海外（地域別）売上高 / 海外売上高比率」を構造化し、
最大 5 年の推移をグラフ化する定量情報検索サービス。

公開 URL: `https://kabulab-cf.satoki252595.workers.dev/yuho-quant/`

仕様の正本は [docs/005-yuho-quant.md](../../docs/005-yuho-quant.md)、
実装規約は [CLAUDE.md](./CLAUDE.md)。

## 何ができるか

- 銘柄コード / 会社名で上場銘柄を検索
- 会社ごとに **受注高 / 受注残高** の最大 5 年推移を SVG グラフ + 表で表示
- セグメント別内訳 + 全社合計、連結/個別の区別
- **海外売上高比率**の地域別エクスポージャ表示 + スクリーニング
- 取り込んだ有報の出典 (EDINET docID・提出日・構造化結果) を併記
- 構造化できなかった有報は数値を作らず「未対応」と明示

## セットアップ

1. `.env` に `EDINET_API_KEY`(EDINET 利用登録で発行される Subscription-Key)
   を設定 (Worker では secret として登録)。
2. スキーマ適用 (適用済みなら不要): `pnpm db:generate:d1` で
   `drizzle/d1/*.sql` を生成し、
   `wrangler d1 execute kabulab-cf --remote --file=drizzle/d1/<生成された>.sql`
   で D1 に反映。
3. 日次 CLI `pnpm ingest:yuho-edinet` は Node から共通取込を直接実行し、
   既存 D1 HTTP atomic sender と Notion 物理保管を使う。
   `EDINET_API_KEY`、`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`、
   `D1_DATABASE_ID`、`NOTION_TOKEN`、`NOTION_ARCHIVE_PAGE_ID`、
   `NOTION_YUHO_TEXT_DB_ID` を開始前に検査する。`--part=0 --of=8` は shard 指定。
   Worker の認証ルート `POST /yuho-quant/admin/catchup` は別入口として保持する。
   初回・期間指定の回収は既存 `pnpm yuho:backfill` / `pnpm yuho:backfill:missing` を使う。
   取込例外は新規文書を開始せず停止する。バックフィルの並列実行では既に開始した
   文書の完了を待つため、その文書の保存は完了し得る（全実行のロールバックではない）。
   非シャードの正常完了時は、新規取込0でも全体L2を再生成する。
4. 以降は GitHub Actions の `catchup.yml` (平日 11:00 UTC) が自動で新規有報を
   取り込む。

## 注意

- 受注高/受注残高は **受注生産型** (重工・機械・電機・プラント・建設等) の
  会社が中心。それ以外は EDINET 上に開示が無く「受注の開示なし」になる。
- 数値は有報の開示単位を円換算し **億円** 表示。「—」は非開示=欠損
  (0 ではない)。
- 投資判断は必ず原典 (有価証券報告書) を確認すること。
