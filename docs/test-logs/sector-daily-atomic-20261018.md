# 業種集計の単一batch置換（2026-10-18）

旧通常経路は`scripts/sync/daily.ts`→`createDailyDb`→`runDailySync`→`aggregateSectorDaily`。sqlite-proxyは各SQLを別のD1 HTTP要求として実行するため、DELETE成功後の期限停止や後続INSERT失敗で当日行が欠落/部分化し得た。共有batch senderは同runの上場銘柄overlayで使われていたが、業種集計には接続されていなかった。静的な到達可能性の確認であり、本番で実際に部分化したという報告ではない。

通常callerの一箇所から既存senderを必須引数で渡し、同じDELETEと同じ16行INSERTチャンクを先に全てコンパイルして単一`{batch}`へ送る。全1000文以下・各100bind以下を送信前に検査し、既存期限guardは送信直前に一度通す。INSERTの明示値は5列なので16行で実80bind（旧コメントの6列は過大）。16行自体は変更しない。値・順位・90%coverage・保持期限・母集団・公開業種列を変更しない。

Nodeの`createDailyDb`と共有senderは、同じ型付き`sharedEnv`のCloudflare token/account/database getterを使う。新環境変数や接続先を増やさない。Workerの公開経路は`c.env.DB`のbindingで同じ`swing_sector_daily`を読むだけで、本writerのWorker callerはない。未使用のWorker書込adapterは追加しない。画面のキーはsector表の最大日付ではなく`macro.date`であり、その日付に一致した部分行が公開され得る境界を修正する。

## ローカル回帰

既存SQLite回帰の全値・順位・保持期限・coverage検査を維持し、同じ既存transactional test senderで次の宣言SQL/transport protocolを検証する。本番原本の観測や本番D1応答と混同しない。

- 17業種はDELETE＋16行＋1行の全3文を1batchで送り、実bind数2/80/5と全値/順位を照合する。
- 送信直前の期限STOPはsenderを呼ばず、当日行と保持期限以前の行も残す。
- 第2 INSERT位置の一意制約faultは、DELETE・保持期限掃除・第1 INSERTを全てrollbackする。
- 応答不明は一度のsender呼出しでthrowし、個別文や同じbatchへ戻らない。このtransport fixtureはSQLを実行しないため、本番unknownの未適用/rollbackを証明しない。

`daily-batch-custody`の通常callerも同じ既存SQLite batch senderへ接続し、実8303由来の保存入力を使う既回帰と原本保管順序を維持する。外部認証値を用意せず、実D1/Notion/原典HTTP/モデル/業務書込は0。

Nix/Node v22.22.2で`daily-sector-aggregate`、`daily-batch-custody`、共有`d1-http-batch-sender`、`derived-jpx-copies`の4 suites/59 tests PASS。全体`tsc --noEmit`と変更した3 TypeScript filesのESLintもPASS。SQL/transport負例は宣言protocolで、実D1への新しいfault injectionではない。

構造上のHTTP件数は`1 + ceil(業種数/16)`から1へ減る。SQL文数と値は同じで、全市場の実D1費用/CPUを新たに測ったとは扱わない。共有senderのREST batch原子性は既存の隔離D1 rollback実証と同じenvelopeに基づき、公式REST文書の新しい保証とは呼ばない。unknown時の実適用有無は別の読取照合が必要。本番定時での受入は別途。
