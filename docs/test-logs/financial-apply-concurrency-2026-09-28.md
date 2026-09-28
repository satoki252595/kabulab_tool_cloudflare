# 財務正本修復の通信待ち削減（2026-09-28）

Issue [#124](https://github.com/satoki252595/kabulab_tool_cloudflare/issues/124) の全履歴修復に適用する、明示オプションの検証記録。
原本再解析の完了とNotion/D1反映の完了は区別する。以下はコードの検証であり、全件反映完了の証拠ではない。

## 原因と最小変更

既存Throttleは送信開始時刻から次の開始時刻までを制限しており、応答後に毎回0.4秒を足す実装ではなかった。
2.5rps上限の直列HTTP応答待ちによって、実送信はおよそ1.6〜1.8req/sとなり、全履歴の残処理が数時間必要だった。

- 既存の50コード別batchを標準ライブラリのThreadPoolExecutorで処理する。`--apply-workers` は1〜4、既定1。
- 各runのNotionClientは1つだけ。全通信の開始間隔と429/529のRetry-After期限を、同じthread-safeなThrottleで共有する。
- batch間のコード集合は重複しない。各コード内の最新開示優先・旧ページ保全、原本SHA・parser SHA、ライセンスは変更しない。
- 更新後は既存の新鮮なまとめqueryで全対象値・キー一意性・旧ページを確認する。単一receipt streamへLock付きでappendし、退避成功とreceiptの間に停止判定を挟まない。
- 最初の失敗で共有停止を通知し、未開始futureを取り消す。開始済みHTTP応答をdrainして終了する。未検証の途中PATCHはreceiptにせず、同じjournalの次回新鮮queryで再証明する。

通常の既定2.5rps・直列処理は維持する。今回の私有起動でのみ4workersと既存`NOTION_RPS=6`を指定する予定。
常設の.env、依存、queue、Worker、汎用schedulerは追加しない。
[Notion公式制限](https://developers.notion.com/reference/request-limits) とworkspace共有負荷を確認し、他writerと調整する。Retry-Afterを送信上限より優先する。

## 制御検証

1. 金融数値を含まないHTTP障害注入で4threadから同じClientを使用。429→529のRetry-After各1秒を全threadで守り、6送信の最小間隔が1/6秒以上であることを確認。
2. commercial-okのEDINET実原本4件の値を変更せず、旧連結メタ情報欠損と1batchの再読不一致だけを注入。2本の同時PATCHの片方が失敗した際、他方の応答を待ち、未開始batchを更新せず、receiptを出さないことを確認。
3. 同じjournalで再開し、途中PATCH済み2行を再PATCHせず、新鮮なqueryから再証明。全4行のreceiptに原値・原本SHA・parser SHAが一致することを確認。

ローカル検証:

- 関連2ファイル: **75 pass**。
- Python pipeline全体: **1,258 pass / 58 skip**。skipは未取得原本fixture（既存55件とTDnet local-only ZIP3件）。
- `ruff check pipeline` / `git diff --check`: 合格。
- parser SHA256は `fdfa3c89039dfc27e6a0328dff7ccd05fd6ecb250a49019be097e2b090bfb914` のまま。

旧直列applyは検証中も継続する。通常PR/CIが成功してから旧runを安全なbatch境界で終了し、同じjournalとreceiptで再開する。
実送信数・429/529・未receiptの途中更新・成功数・実所要は切替後に別途記録する。
秘密値、Notion本文、全原本cache、全財務datasetは公開Gitに保存しない。
