# 歴史原本索引の復旧計画（2026-10-14）

本番bulk書込は未実施。`scripts/notion/raw-index-plan.ts` は読取専用で、既存local原本50〜100件のSHA・Notion⑤metadata/hosted添付・D1索引・R2全文を照合する。原本をupstreamから取り直さず、Notion原本/派生を新規作成しない。

## 実測と範囲

- Notion⑤aggregate（`tmp/feature-audit-20261013/raw-notion-stats.json`）は78,831行、全SHA一意、原本サイズ合計24,728,838,351 bytes。EDINET74,101行15,468,020,496 bytes、TDnet4,565行342,586,609 bytes、yfinance110行8,897,101,623 bytes、日証金55行21,129,623 bytes。
- 旧`T-RAW`設計の「70,463件13.8GB」は現在のNotion全量を表さない。`BK_stockStock/data/raw`のmetadata-only棚卸しはprimary70,466件14,863,244,245 bytes（13.842GiB）。原本と別にparquet/txt7,787,963,772 bytes、tidyCSV9,687,129,757 bytesがあるが、今回追加しない。ローカル原本の存在だけでNotionとの同一性は認定しない。
- ローカル測定receiptは`tmp/feature-audit-20261013/raw-local-inventory.json`。174,183通常ファイルのstat棚卸し13.65秒、SHA標本40件7,064,346 bytesは0.0168秒。warm-cache標本なので全量I/O時間やネットワーク速度の実測値として外挿しない。
- repo/旧BK repoにT-RAW専用CLIや適用checkpointは確認できない。既存Python `CloudSink.upsert_raw_artifact` はHEAD存在判定・SDK mutation retry・例外→Falseを持ち、今回の同値照合/unknown停止契約へそのまま流用しない。既存Node R2の単発CAS契約をbinary/明示bucketにも共有した。

## dry標本

`.env`の既存資格情報と`NOTION_DB_RAW_FILES`（database_id）、`R2_BUCKET_RAW`（既存原本bucket）をtyped getterから読む。`LOCAL_OUT`設定時は、remote検証とpreviewを混同しないため停止する。

```sh
pnpm exec tsx scripts/notion/raw-index-plan.ts --raw-dir=/Users/satoki252595/projects/BK_stockStock/data/raw --limit=50 --max-bytes=67108864 --out=tmp/feature-audit-20261013/raw-index-dry50.jsonl
```

標本はprimaryだけを各1回読み、SHA50件ずつのOR queryで⑤を限定読取する。Notionの一意SHA/サイズ/名前/親DB/active状態とhosted添付名を検査し、添付URLは保存しない。Notion本文は再DLせず、**hosted metadata確認と物理本文照合を別の結果として記録**する。D1同SHAを一括SELECTし、既存索引keyまたは実metadataから生成するcanonical/旧keyをR2 GETして全bytesのSHA/サイズを検査する。日付欠測は取得日で埋めず停止、TDnet文書IDはZIP番号から推測しない。

判定は`already_complete`（metadata＋R2全文一致）、`would_index_existing`（R2全文一致・索引なし）、`would_put_and_index`（明示missing）。重複/不一致/未知HTTP結果では次の原本へ進まない。jsonlに完了標本と停止理由を残す。dryでPUT/Notion mutation/D1 mutation/upstream取得は0。bytes上限は標本選定の予算であり、取得物の切詰めではない。

## 全量へ進む際の契約と費用

1. 全Notion⑤のcanonical primary SHA集合を確定し、78,831件aggregateと照合。78,831件を単一Notion queryで取得せず、既存strict paginationの10,000件上限を超えないpartitionを使う。既存保存inventoryを優先する。D1現行2,448行との差76,383件を未照合のまま欠測確定件数としない。
2. SHA/サイズ/名前/hosted添付に対応するlocal bytesがあれば1回読んで使う。ない原本だけNotion現在hosted URLから全bytesを読み、宣言SHA/サイズを検査する。upstream GETは常に0。
3. 新規R2は明示missingに対して`If-None-Match:*`で1回PUT。2xx＋ETagだけで完了にせず、全body GET/SHA照合後にD1 raw metadataをatomic確定する。既存R2は全文同値のときPUTしない。412/unknown/不一致は上書き・再送・次原本処理を止める。
4. append/fsyncしたphase receipt（local verified / R2 attempt / R2 verified / D1 attempt / D1 verified）で再開する。inflight/unknownは最初に読取照合し、同値を証明できない状態で再PUT/再INSERTしない。D1保存済同値はwriteなし、矛盾metadataは保全停止。Notion/body/R2旧keyは削除しない。
5. 完了判定は「Notion canonical SHA集合のD1未索引anti-join=0」と「全索引先R2の全文SHA/サイズ一致」。原本以外の既存R2/D1行があるため、単純なbucket総数一致を完了条件にしない。license tagを保持し、公開APIのcommercial-ok限定契約を拡張しない。doc_id未検証は理由を残し、開示→原本の結合を完了扱いにしない。

raw primary追加は最大24.73GB（予算上限25GB、既存同値skipで実増は減る）。既存全R2を約4GBとする保守計算では月28.73GB、無料10GB控除と課金単位切上げ後は19GB×$0.015＝**$0.285/月**。Workers既存固定$5/月とは別。最大78,831 PUT、候補確認＋保存後全文確認は最大157,662 GET規模で、当月他利用との合算が包含枠内なら操作料金増0。超過時は操作課金も切上げ単位で発生する。[R2公式料金](https://developers.cloudflare.com/r2/pricing/)

worst-case通信はNotion DL24.73GB＋R2 PUT24.73GB＋全文GET24.73GB＝74.19GB。local全量ヒットや既存R2 skipで減る。20/50/100Mbpsなら転送だけ約8.24/3.30/1.65時間で、API latency/Notion pacing/D1 commit待ちは別途必要。dryのR2 GET時間を実測し、次の限定write pilotでPUT＋readback＋D1所要を測ってから全量スケジュールを決める。D1 raw索引は本文を持たず、78,831行×概算2KiBでも約161MB（索引込みの実サイズはpilotで測定、未実測を確定値にしない）。通常cronへ全量作業を入れず、件数/bytes/時間予算を持つ明示CLIで進める。

R2のS3 APIは`PutObject`の条件付き操作をサポートする。SHA16 keyの存在だけでは同一性を認めず、完全SHA256を必ず照合する。[R2 S3互換API](https://developers.cloudflare.com/r2/api/s3/api/)
