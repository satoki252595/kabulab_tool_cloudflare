# 歴史原本索引の復旧計画（2026-10-14）

本番bulk書込は未実施。既存local原本向け読取専用 `scripts/notion/raw-index-plan.ts` に加え、GH既存資格で⑤hosted原本だけを読む `scripts/notion/raw-index-backfill.ts` と手動専用 workflow を用意した。原本をupstreamから取り直さず、Notion原本/派生を新規作成しない。

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

raw primary追加は最大24.73GB（予算上限25GB、既存同値skipで実増は減る）。既存全R2を約4GBとする保守計算では月28.73GB、無料10GB控除と課金単位切上げ後は19GB×$0.015＝**$0.285/月**。Workers既存固定$5/月とは別。raw PUT最大78,831に永続state最大3 PUT/件を加え約315k Class A、current/旧候補/保存後確認のraw GET＋receipt全文読戻しは約473k Class B。chunk起動の少数GET、manifest約数十MBの保管、既知エラーの再調査は別。口座の当月他利用との合算が包含枠内なら操作料金増0。超過時は操作課金も切上げ単位で発生する。[R2公式料金](https://developers.cloudflare.com/r2/pricing/)

worst-case通信はNotion DL24.73GB＋R2 PUT24.73GB＋全文GET24.73GB＝74.19GB。local全量ヒットや既存R2 skipで減る。20/50/100Mbpsなら転送だけ約8.24/3.30/1.65時間で、API latency/Notion pacing/D1 commit待ちは別途必要。dryのR2 GET時間を実測し、次の限定write pilotでPUT＋readback＋D1所要を測ってから全量スケジュールを決める。D1 raw索引は本文を持たず、78,831行×概算2KiBでも約161MB（索引込みの実サイズはpilotで測定、未実測を確定値にしない）。通常cronへ全量作業を入れず、件数/bytes/時間予算を持つ明示CLIで進める。

R2のS3 APIは`PutObject`の条件付き操作をサポートする。SHA16 keyの存在だけでは同一性を認めず、完全SHA256を必ず照合する。[R2 S3互換API](https://developers.cloudflare.com/r2/api/s3/api/)

## 明示GH pilotと再開契約

`.github/workflows/raw_index_backfill.yml` は workflow_dispatch のみ。既存 `CF_*`/`R2_*`/`NOTION_*` secretsをtyped envへ渡す。新鍵・権限拡大・source GET・通常cron追加・artifact公開はない。既存GH鍵のraw読取は run [38432393181](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/38432393181) で全文SHA一致を確認済み。local.env鍵とはscopeが異なる。

初回は `mode=dry / plan_id=canonical-20261014 / expected_count=78831 / limit=50 / max_bytes=67108864 / max_seconds=1200`。dryはremote mutation 0。期待件数は調査時の値で、固定cutoffの現在集合と不一致なら黙って除外せず停止する。applyは同じ入力のmodeだけを変更し、以降同plan-idのcursorから次chunkへ進める。rootがsummaryの正常partialを確認して再dispatchする。自動workflow起動とactions:writeは追加しない。

全集合は作成時刻cutoffとSHA16分割で確定。10,000件に到達したpartitionはhas_more=falseでも破棄し再分割する。共有strict list envelope/cursor前進検査に加えて全SHA/page一意・期待件数・実日付・キーmetadataを検証する。原本URLの更新はSHA 50件OR queryのfilesをメモリ内だけで再利用し、78k件の個別page GETを行わない。非対応拡張子のNotion ZIPラップは原名1member/展開サイズ上限と原本全SHAを検査する。

既存vwap-dataの `ops/raw-index/<plan-id>/manifest.json,state.json,complete.json` にCAS＋全文readbackで保管する。原文・hosted署名URL・取得URLはmanifest/state/local receiptへ含めない。local receiptは0600で各phaseをfsync。global `ops/raw-index/active.json` が別planへの逃避を止める。vwap配信readerはdaily/intra/marginの構成済みkeyしか読まず、ops prefixを任意keyとして公開しない。

順序はR2 current/旧key全文GET→欠測時のみhosted全DL/SHA→永続raw_inflight→単発If-None-Match PUT→全文GET/SHA→永続index_inflight→単一atomic INSERT→D1 readback→cursor確定。D1既存行は取得履歴/derived等を更新せず、同値ならraw/index write0（進捗receipt更新は別に計数）。unknownは即停止し次原本へ進まない。次runはinflight原本/索引を先に読む。一致すれば適用済みを回収、未確認なら再PUT/再INSERTせず保全停止する。

bytes予算はraw転送を1件ごとにworst-case予約し、収まらない次原本を切り詰めず残す。件数・時間予算で正常partialを返す。時間予算後は新原本を開始せず、開始済み1件（または開始済み最終anti-join）を完結する。GH hard timeout/runner消失でも永続inflightが再送を止める。全cursor到達後にcanonical SHA全件をD1 PK IN<=100で再突合し、anti-join 0＋complete receipt全文readbackを検証して初めてsnapshot_complete。全cursor直後に予算到達した場合はremaining=0でもpartialを返し、次runで最終検証だけを再開する。新規Notion原本がcutoff以降に増えた分まで完了とは表示しない。

TDnetの既存doc_idはPDF一覧由来であり、XBRL ZIP URLの番号から同一性を推測しない。既存writerのdoc_idは保持して `retained_existing_unverified`、旧索引のnullは `archived_id_verified_index_legacy_null`、原典metadataでID未確定は `not_proven_from_archived_metadata` と個別receiptへ明示する。SHA原本索引の完了と、④開示→原本のdoc_id結合完了は分ける。

現時点でEDINET/TDnet/yfinance/日証金の既存⑤metadata各1件をread-onlyで照合し、実データのdatatype/scope/date/hosted/key契約が通ることを確認した（追加metadata 4 query、source GET 0）。実pilotのR2 PUT＋D1所要と操作数はGH実行後にrootが計測する。全量の時間は未実測。最悪のNotion metadata pacingは、全棚卸し約800 query＋URL更新約1,577 queryで約15分に抑え、原本転送・逐次D1 latency・fsyncは別途加わる。

## dry/apply間の同時追加を除く固定cutoff（2026-10-14）

run38449677494は棚卸し78,917件と期待78,832件の不一致で、manifest/active/stateを含む全mutationより前に停止した。先行dry50後にcanonical原本85件が追加され、別々の起動時計をcutoffに使ったことが原因だった。原本/索引/receipt write0の元失敗履歴は保持する。

CLIに任意の`--cutoff=<UTC ISO>`を追加し、workflow_dispatchではcutoff入力を必須とする。値の現在時刻defaultは作らない。UTCのZ終端・実暦日・未来でないことを全request前に検証し、同じ値をdry/apply/再開へ渡す。新manifestはそのcutoffで棚卸し、保存済manifestが明示cutoffと異なればreceiptや原本を書かず停止する。CLIで省略した既存呼出しは従来の取得時計/保存manifest利用を維持する。active/inflight/unknownの再送禁止と全SHA/件数/順序検査は変更しない。

rootのSQL読取でcutoff`2026-10-13T18:31:00.000Z`のcanonical件数78,832を確認した。同じplan-id/expected_count=78832/cutoffでdry→applyを実施する。固定cutoff後の新原本まで全量完了と扱わない。異なる起動時計のdry/apply/再開でmanifest SHAが同じになる回帰と、保存cutoff不一致・不正/未来cutoffの送信前停止を検証する。
