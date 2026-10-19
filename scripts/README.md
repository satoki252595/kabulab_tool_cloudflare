# scripts/

mono-repo横断のCLI。サービス内の細かな処理は`services/<slug>/data-scripts/`へ置く。環境構築はrepoのNixを使う。

取得・更新・監視・手動/停止/未実装の全件は[データ一覧](../docs/batch-data-inventory.md)、予定と先行条件は[README](../README.md#本番の定期処理先行条件llm利用)を参照。

| 入口 | 用途・定期接続 |
|---|---|
| `sync/daily.ts` | core/rsi/swing。CF→Actionsの平日18時、contextは火〜土06時 |
| `sync/monthly.ts` | 優待派生再計算。Actions毎月10日10:30、母集団→優待原文の後 |
| `sync/universe.ts` | JPX公式母集団 |
| `sync/yuho-edinet.ts` | 共有Node取込をD1 HTTPで実行。Worker管理ルートを叩く薄いトリガではない |
| `sync/ir-tdnet.ts` | NodeのTDnet・IR取込 |
| `vwap/ingest-daily.ts` / `ingest-intra.ts` | CF→Actions月水金17時、日足→5分足 |
| `vwap/ingest-margin.ts` | Actions平日17時、市場信用残 |
| `moneyflow/ingest.ts` | 29取得元。独立28はCF平日18:15、業種売買代金は株式成功後 |
| `sync/all-daily.ts` | 手動一括。独立した定期設定ではない |
| `sync/all-monthly.ts` | 手動の優待取得→再計算。Mac要約の起動は除去済み |
| `biztag-local/` | **旧Mac定期2本は廃止・停止済み**。[月次手動スクリプト](../docs/mac-monthly-manual.md)を準備。本文補足同期・タグ・競合準備・優待要約の旧状態/receiptを保持 |
| `notion/`、個別repair/backfill | 固定対象の補完・照合・原本/索引管理。全てが定期ではない |

D1/R2/Notionが本番保存先。CFは配信・取得プロキシ・Cron dispatch/期限監視、Actionsが取得本体を担当する。重い全市場取込をWorkerへ載せない。

秘密・環境固有値はrootのprivate `.env`と型付きアクセサで管理し、本番Worker/Actionsは各プラットフォームのSecretsを使用する。スキーマ生成は`pnpm db:generate:d1`、適用は原本・PRE/POSTを確認して行う。
