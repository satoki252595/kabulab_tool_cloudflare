# 日次信用残の通常業種集計ジョブへの接続（2026-10-02 JST）

Refs #160 #117 #132。通常 `jpx-margin-sector` は、保存済みR2 snapshotと
D1の銘柄/業種mappingをNodeから読む。workflowが既存R2/D1認証変数を渡しておらず、
取得元を選ぶと型付きアクセサの欠落例外で停止する接続漏れを修正した。

`.github/workflows/moneyflow.yml` のjob envとworkflow_callへ、既存の
R2_ACCOUNT_ID・R2_ACCESS_KEY_ID・R2_SECRET_ACCESS_KEY・R2_BUCKET・
CLOUDFLARE_ACCOUNT_ID・CLOUDFLARE_API_TOKEN・D1_DATABASE_IDを接続した。
GitHubの既存Secret名7件の存在だけを確認し、値は読出し/公開していない。
新しいSecret・取得元・Worker endpointは追加していない。

workflow_callの新Secretはoptionalとし、他の取得元だけを選ぶ呼出しに不要な必須値を
課さない。当取得元を選んだ場合は既存型付きgetterが未設定を停止する。
stock-syncの `secrets: inherit` でも同じ名前で渡る。

通常入力はR2 indexの実最大基準日で、sector-turnoverのtrade_dateとは別。
確認済みの最大日は9/30。旧9/28の結果不明1行の再POSTは行わず、その完了も主張しない。
JPXの新PDF取得は0、R2/D1は読取で、派生入力2ファイルの全文保管/照合後に
同基準日のNotion観測ログをupsertし更新行を全文照合する既存経路は保持した。

Nix環境で関連5ファイル44 tests PASS・全体typecheck PASS・lint PASS。
PRの3CIとmain反映後、[通常run36908547972](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/36908547972)
は `only=jpx-margin-sector` で2026-10-01 18:48:43 UTC SUCCESS。
実最大basis9/30の476行（未分類を含む34区分×14指標）は新規476／更新0／同値0で、
通常producerの全476POST照合を通過した。
[保存原本の独立照合](moneyflow-margin-normal-20261002.md)も、実manifestとhosted全文2件の
SHA一致・共有parser476行再解析／validate PASSを確認した（Notion3＋hosted2、追加source／D1／R2／mutation0）。
源PDFの当時のHTTP取得clockはUNKNOWN、旧9/28keyは未照会・再POST0のまま。
全moneyflowやsector-turnoverの正常化ではない。
