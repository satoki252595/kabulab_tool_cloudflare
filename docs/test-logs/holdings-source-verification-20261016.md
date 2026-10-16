# 保有明細の原本window・最新文書照合

更新: 2026-10-16。関連 #348。原本列の有限回復を、価格確定・全量公開・通常定時の成功と区別する。

## 固定100行の本番作業

10/16 23:33:32–23:45:56 JST、main `59dd527e0606585ee72ca971f05b9a1e640aa44f` の通常 `applyLatestHoldings` → `publishVerifiedShareholdings` をNixで実行した。新規原本取得・LLM・R2操作は0。最新10通のfresh準備は7通146明細が適格、3通は原表資格HOLDだった。既存行も共有resolverで照合し、原表順の先頭100行だけを実行した。

| 結果 | 実測 |
|---|---|
| 原本列の確定 | 100行。旧未検証行59を同じpageで移行、新規41 |
| 文書の完了 | 4通99行。1376の1行は既知の部分window |
| 残り | 1376の13行、1377の16行、1379の17行。3通の原表HOLDは保持 |
| 価格 | 新たな価格確定0。旧価格など5列を保持し、価格未確認をNULLと理由で明示 |
| 通信 | 467 HTTP = Notion 440 / hosted 17 / D1 SELECT 10。実mutation 146 |
| バイト・所要 | 要求9,019,320B / 応答21,357,935B、743.05秒 |
| D1読取 | 1,713,610 rows_read、query duration合計3,057.3924ms |
| 受入 | 100行の全native PRE/POST・旧列と他props保持・4組の物理migration PRE/POST全文SHAを独立検証 |

行数100・HTTP800・20分・Notion0.6rpsの元予算内で完了した。共有journalの`writes=148`は検索POST2件も含む値なので、実mutation146と区別する。通常CLIはHOLD3/pending3を残したためexit1で、未知の書込失敗とは扱わない。pending-write不在・既知結果receipt・独立監査を照合した。

元legacy4原本のFetched At（6/17、6/22、6/23、6/25）と未知の旧manifestを維持した。元legacyページは変更せず、新しいcustodyだけで物理全文SHAを確認した。計画SHA `4ba79ab574734edded48cae4c2bdc7990ccd7351abb4be0eb791d32446f2a493`、通常結果receipt SHA `a891103d2b9041a489ab206baee4c6d41ecf5a6fb66fce46622922f57db0899e`。raw・native本文・私有receiptはGitへ保存しない。

## 共通publisherの補強

既完prefixを、すでに読んだ同一issuer・期末の一覧で照合するため追加GETは0。原本列が変わっていれば残windowを書かず、元cursorを保持してHOLDにする。最後のwindowでは全原表を1回検索し、全出典・確定値の一致を確認してからsource完了と価格queueを登録する。不一致なら実行中のunknownを残し、同じwindowを自動で再送しない。通常取込・定期再開・保存原本CLIは同じ関数を使う。

価格の資格条件や値は変更しない。追加のNotion一覧は文書のsource完了時だけで、LLM・取得元アクセス・新依存・DDLはない。100行の実測を全1,833通の一晩での完走へ外挿しない。

## 最新文書SELECTの削減

通常CLIのfresh照合を、row_numberの内側から対象stockCodeへ絞る。外側のstockCode条件も既存のcode一意索引へ接続する。active普通株・120/130・最新会計期末・訂正のsubmittedAt/PK順・cursor/limitは維持する。

10/16 23:50:16–17 JST、本番D1へSELECT8回だけ実行し、全体latest1回と対象7件の最新行すべてが一致した。

| 指標 | 全体latestを毎回読む場合 | 銘柄別7件の実測 |
|---|---:|---:|
| rows_read | 171,361×7 = 1,199,527相当 | 330（1件34–54） |
| query duration | 313.3158ms×7 = 2,193.2106ms相当 | 合計7.3868ms |

比較の全体queryは1回の実測で、7回分は相当値。ネットワーク時間や全量処理の性能倍率とは呼ばない。Notion・上流・モデル・書込はすべて0。共有selector SHA `5aa54ba88357afc51da271e4c2f718233a0d5be04374b609eaa478f898a831b5`、pnpm lockは通常本番と同じ `805dd5b36ca9ec385b29de1ded715305537eac514dbc7c77dfc55b2d56617e58`。

Nixで関連4 suites・84 tests、typecheck、lintが成功した。prefix変更・最終読戻しのdrift・unknown再送禁止、SQLiteで最新年度/訂正の変更・対象外の銘柄種別/非active・不正codeを検証済み。残46行と価格・全量・通常定時の受入は別途必要。
