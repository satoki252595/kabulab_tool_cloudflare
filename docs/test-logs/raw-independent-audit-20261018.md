# RAW 固定全量の独立read-only監査（2026-10-18）

Refs #515。`scripts/notion/raw-index-audit.ts` は固定manifestを独立に読み直す通常CLIで、SSH移行・本番全量監査の実施ではない。転送writer、既200 pool、旧unknown/STOP、state/active/cursor、Notion・上流・モデルは変更しない。追加依存・DDLなし。

同日方針変更: 本CLIの全量実行は任意の保守監査で、全20機能の復旧条件から外す。通常運用の原本保存時検証は維持し、必要な本番原本の確認には`pnpm raw:required`を使う。[範囲の修正](../deterministic-production.md#必要なraw原本だけの確認)。

## 入力・結果

plan/cutoff/count/full manifest SHA、件数/総受信bytes/requests/secondsを全て明示する。activeが同plan/SHAであること、manifest全body SHA、既`parseRawManifest`の集合・一意SHA/page・順序を検査する。原本は既R2 readerの`singleAttempt:true`で全文SHA/サイズを再検査する。D1は100 SHA以下の`WHERE sha256 IN (...)`を先に指定し、全15列を取得する。全表取得後のfilterやPUT/INSERT/state更新APIの接続はない。既single-SHA SELECT/通常writerのSQL・再読契約は維持する。

既`validateBody`/`expectedRawIndex`/`validateIndex`を共用する。既取得履歴のfirst/lastを新しい時計で上書きしない。legacy NULL doc_idも原値保持する。原本全bytes/索引metadataの`integrityAccepted`と、manifestに対するdoc_id/取得時計だけの`semanticFullyQualified`を分ける。後者は金融主体・権利日・価格basisの資格ではない。EDINET doc_id不明や取得履歴時計がmanifestと異なる場合は理由付きHOLD、非EDINETのdoc_idは適用外。欠測・metadata/SHA不一致も理由付きHOLDにし、推定値を作らない。

private JSONLには全15列、R2 key/etag/SHA/サイズ、観測時点、累積費用、停止理由とprefix digestを保存する。生原本・認証値・署名URLをGitやstdoutへ出さない。receiptは全raw payloadのexportではなく、この通常監査が全文を検証した観測証拠。別時点に並ぶ読取でありatomicなcurrent全体snapshotと呼ばない。本番で最終整合を認定するactor排他/静止資格は別releaseの条件になる。

## 有限費用・再開

固定canonical-20261014/cutoff2026-10-13T18:31:00.000Zの保存manifest（SHA `fccedf9bb6c1548ff3a0b206634fbdbf531acaac63192275cc31720f1db11362`）は78,832件、原本合計24,728,913,967 bytes、manifest31,579,382 bytes。全件が既存で正常なら最低78,832 raw GET＋789 D1 SELECT＋active/manifestの2 GET=79,623 requests。D1応答・control再読と再開分は別加算される。manifestだけでもEDINET doc_id未確定878件を含むので、全raw integrity PASSと全semantic資格を混同しない。これらは保存集合の計数で、current R2/D1の存在や完了を示さない。

`--max-bytes`はR2とD1応答の実受信bytes合計、`--max-requests`は単発送信へ入場した試行数。R2200部分受信・D1部分受信も加算する。headers/error-body等を既helperで測定できなかった応答は`unmeasuredResponses`として可視化し、未測定bytesを0と認定しない。helperの再試行は使わない。D1応答は1MiB、manifest64MiB、既receipt入力256MiBを上限にする。単一rawはmanifestの実sizeを予約し既helper同様に全文をメモリ保持するので、SSHのRAM/最大原本size資格は別途必要。

毎native直前に65秒headroomを再検査し、SDK/D1読取は60秒timeoutと同じ絶対signalを使う。毎recordをwx0600の出力へfsyncする。正常`partial`終端だけを`--resume=<旧receipt> --resume-sha256=<全文SHA>`で新outへ再開できる。監査/helper source・zod wrapper・package/pnpm/Nix lockのhash、全入力・manifest・初期/祖先checkpoint・連続prefix・累積bytes/requests/elapsedの全keyを照合し、元notAfterを継承する。原時計/費用をresetしない。旧receiptと全祖先SHAの証跡を保持する。旧fileは上書きしない。STOP・途中JSONL・不明応答を再開資格に昇格しない。

全量`complete`でもHOLDがあればCLI exit1。正常partialもexit1だがreceiptの`phase=summary,status=partial`で、例外STOPと区別する。監査費用は別有限read budgetで、転送pool200にrunを足さない。安全な本番再開・SSH writer・新credential・通常chain停止はこのCLIの機能ではない。

環境はNixを使い、実行時はNodeの`.env` loaderを明示する。以下の費用上限・出力先はrootのreview/releaseで決めるため、ここでは実行しない。

```sh
nix develop --offline --command node --env-file=.env --import tsx \
  scripts/notion/raw-index-audit.ts \
  --plan-id=canonical-20261014 --cutoff=2026-10-13T18:31:00.000Z \
  --expected-count=78832 \
  --manifest-sha256=fccedf9bb6c1548ff3a0b206634fbdbf531acaac63192275cc31720f1db11362 \
  --limit="$RAW_AUDIT_ITEM_CAP" --max-bytes="$RAW_AUDIT_BYTE_CAP" \
  --max-requests="$RAW_AUDIT_REQUEST_CAP" --max-seconds="$RAW_AUDIT_TIME_CAP" \
  --out="$RAW_AUDIT_NEW_PRIVATE_RECEIPT"
```

## 検証と未適用境界

既Git原本`pipeline/tests/fixtures/direct-roa/8566-S100YF3N-type5.zip`（138,896 bytes、SHA `270c211710faf3133d66459f3050700be1378ab8284b627fff50ec0c1d175f25`）が保存fullmanifest itemと一致するため、その原値を再利用した。追加fixtureは原metadataとprovenanceだけ。R2/D1 transport/ETag/索引行は明示protocol projectionであり、本番current実観測ではない。実原本回帰はCIでも同じ既Git bytesで実行する。

欠測・hash/metadata不一致・legacy NULL/履歴時計保持・partial受信・100SHA/full15 SQL・duplicate/offscope・未知/503の再読0・post-fsync期限・resume SHA/source/末尾/prefix/費用/原時計を検証する。新auditと既backfill/plan/hosted pacingをNixで回帰、fulltsc/対象eslintも実施する。実R2/D1/Notion/SSH/native writer・本番全量anti-joinの新受入は0。#515全体は未完。
