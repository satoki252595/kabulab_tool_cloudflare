# 005 yuho-quant — 有報定量検索

金融庁 **EDINET** の有価証券報告書から「受注高 / 受注残高」をセグメント別 +
全社合計で構造化し、最大 5 年の推移をグラフ化する定量情報検索サービス。

公開 URL: `https://kabulab.vercel.app/yuho-quant/`

## 何ができるか

- 銘柄コード / 会社名で上場銘柄を検索
- 会社ごとに **受注高 / 受注残高** の最大 5 年推移を SVG グラフ + 表で表示
- セグメント別内訳 + 全社合計、連結/個別の区別
- 取り込んだ有報の出典 (EDINET docID・提出日・構造化結果) を併記
- 構造化できなかった有報は数値を作らず「未対応」と明示

## セットアップ

1. `.env` に `EDINET_API_KEY`(EDINET 利用登録で発行される Subscription-Key)
   を設定。
2. スキーマ適用 (適用済みなら不要):
   `node scripts/db/apply-migration.mjs drizzle/create-yuho-quant.sql`
3. 初回 5 年バックフィル: `pnpm yuho:backfill`
   - 動作確認は `pnpm yuho:backfill -- --ticker=7012 --from=2025-06-24 --to=2025-06-24`
4. 以降は統一 daily cron が自動で新規有報を取り込む (shard 0 で実行)。

## 注意

- 受注高/受注残高は **受注生産型** (重工・機械・電機・プラント・建設等) の
  会社が中心。それ以外は EDINET 上に開示が無く「受注の開示なし」になる。
- 数値は有報の開示単位を円換算し **億円** 表示。「—」は非開示=欠損
  (0 ではない)。
- 投資判断は必ず原典 (有価証券報告書) を確認すること。

詳細は [docs/005-yuho-quant.md](../../docs/005-yuho-quant.md)。
