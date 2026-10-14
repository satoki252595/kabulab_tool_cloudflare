# RAW保存添付の全試行計数・転送予約・同一rate枠

main406の共通保存添付GETは同一URLの通信切断だけを最大2回読める。通常RAWの`createRawDownloader`は呼出時にoptionsを渡さず、返却された最後の`wire.length`だけを記録していた。そのため1回目の部分本文・再GET・hosted GETの待ち時間がRAWの計数と`.25rps`指定に入らず、サイズ/親期限もhelperへ伝わっていなかった。旧unknownはこの修正で解消した扱いにしない。

RAW callerは既存`onAttempt`でstart/complete/transport-error/非通信errorを私有receiptへ確定し、全試行の実受信本文bytesを集計する。正常結果だけでなく、サイズ超過・途中失敗の受信量も停止receiptと秘匿済みconsoleに残す。`notionDownloads`は対象原本数、`notionDownloadAttempts`はpacing後の送信前observerまで進んだ試行数、`notionDownloadBytes`は全試行で観測した復号済み本文の合計である。observer失敗や直後abortなら送信前で止まるため、attempt数はその境界を保守的に含む。既存`notionRequests`はNotion API通信数のままで、hosted試行を黙って混ぜない。

各hosted GETは、元添付なら公表metadataの`sizeBytes=S`、Notionによる単一ZIP wrapperなら`S+W`（既存`W=ceil(S*0.001)+4096`）を上限とする。wrapperは既存の実名1member・展開サイズ・原本全文SHAを維持する。全2GETの成功/partialを含むため、従来の保守的予約`4S+W`に2回目最大`S+W`を加え、対象1件を開始する前に`5S+2W`を予約する。予約不足なら次対象を開始せずpartialで残す。新しい任意cap・サイズ切詰め・他原典の利用はない。

元runの開始時計から算出した絶対期限をhosted readの親signalとして渡す。helperの既存全体90秒/各45秒/最大2GETも同時に維持し、async observer後にも親期限を再確認する。API側の既存native待機を小さいexport関数へ移し、RAWの各hosted startも同じ`nativeMinIntervalMs/lastNativeStart`を利用する。`.25rps`はmetadata APIとhosted再GETの開始を通じた同じ4秒間隔になる。async observerの拒否・親abort・不明markerを通信切断へ分類して再読取しない。設定しない通常APIの380ms queue・既存rate/retry・成功時の取得URL/本文値は維持する。

親signalは新規hosted readに限定する。既に原本PUT/index intentを確定した1件は、期限を跨いでも旧inflightを解決するための必要R2/D1 readbackとcursor確定を行い、次原本を開始しない。既存state/active/manifest/CAS/plain unique INSERT・unknown停止を変えない。

計数の範囲は全wire量ではない。HTTP headers/HTTPエラー本文・未取得部分・R2途中失敗の受信prefixは未計測で、結果に`hostedBytesKind:decoded_body_all_observed_attempts`、`httpHeadersAndErrorBodyBytesMeasured:false`、`r2PartialReadBytesMeasured:false`を明示する。`rawTransferBytes`は従来の成功R2 GET/PUT本文に全観測hosted本文を加えた量である。stream上限を超えたchunkも観測量を保存してSTOPし、上限内だったと偽らない。

ローカルprotocol回帰は、2B partial→4B全再GETを2attempt/6Bへ計数し、原本PUT4B＋独立GET4B込み14Bとなること、予約未満でhosted0、原サイズ超過を記録して再GET/原本PUT/index0、intent後の必要readbackを期限で一律拒否しないことを確認する。共通helperのasync observer拒否/unknown/親abort、API→hosted1→hosted2→APIの開始0/4/8/12秒と待機中abortの送信0も確認する。これは通信故障を注入したローカル回帰で、実本番エラーの原因特定や全原本完了ではない。

本番run/dispatch、原本GET、Notion/D1/R2、vendor、modelは0。元RAW200run枠はrootのmanual38588508638受入後の14消費/残186（次resume自身を含みcontinue185上限）のまま保持する。再開はmain/CI受入・rootの別固定intent後のみ。旧receipt/state/freezeや稼働中本文runtimeへ変更しない。

検証: Nix node22.22.2/pnpm9.15.9・既存lockで関連9suite230testsがPASS。fixtureのobserver契約を明示した後もRAW72testsと全体`tsc --noEmit`がPASS。変更6code/testのeslintと`git diff --check`がPASS。追加依存なし。実共有helperの正常byte/同URL有限再読取・API queue回帰を含み、実vendor/native通信を使わない。
