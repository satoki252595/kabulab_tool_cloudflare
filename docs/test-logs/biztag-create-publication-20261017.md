# 事業タグcreate/versionの永続publication境界（2026-10-17）

通常createは最初のNotion POST以前に同canonical stateへ`request.json`/`intent.json`をwx・0600・file/directory fsyncで保存する。まだpage IDがないので、operation=create/DB/銘柄/次doc（明示nullを含む）/全入力SHAへ束縛する。POSTと残りのproperties PATCHはsingleAttempt。DB、全長文properties、全children/根拠を通常共有readerで検査し、実page ID/fullPOST SHAを含む`completed.json`が保存できた時だけ次項目へ進む。

factoryは旧replace3filesと新create3filesを同一storeで検証する。どちらの欠測/破損/部分dirも次runをHTTP前に止める。別doc/別request SHA/別outputで結果不明を避けない。閉鎖記録は削除しない。既存64MiB/request・1MiB/record・4GiB/store上限、closure tail予約、同writer排他を再利用し、新broker/依存/DDL/モデルはない。

版だけの更新は`writeRowWithEvidence`へ寄せ、最新doc guard、旧propsと物理PRE、CAS、全読戻し、同journalを使う。別docへの付替えは旧値保持HOLD。現normal plannerがversion_bumpを生成しない点はそのままで、メタデータを読んだだけで語彙再判定を追加しない。

## 検証

既存実4502の保存fixtureを再使用した。原39本文・原判定入力は変更せず、Notionプロトコルだけを投影し、単一/複数chunk・明示null doc・実保存nested根拠・POST結果不明・部分PATCH結果不明・根拠読取不明・全文/DB不一致を確認した。成功後だけ新factoryが通り、unknownは旧request/intent bytesを保持して新factoryのHTTP0停止となる。

既存実9273原文でcreateのrequest/intent/completion各FS中断、旧replace closureとの共存を確認した。version経路は最新guardとevidence経路を通り、doc不一致はmutation0でHOLDになる。架空の事業値/確率・新fixtureは追加しない。

プロジェクトNixで関連5 suites 175 tests PASS、full TypeScript・owned ESLint・diff checkを実施する。HTTP/モデル/業務書込0の検証であり、本番の次定時・全createの受入ではない。

## 負荷と未実装

既存createはPOSTと残PATCHだけだった。今回、その後にページGET＋root children GETの最小2 GET、25件以上の長文propertyと根拠階層に応じた追加GETがある。新源取得/モデル0でもNotion時間・runner時間は増え得るため、全量所要は未測定とする。全G機械同期は既存行replaceであり、今回のcreate差分を進行中runtimeへ配備しない。

正規operator用の未閉鎖publication read-only照合CLIは未実装。自動completion・自動再送は追加しない。手動dedupの汎用update経路は今回未移行と明記し、そこへ新snapshot/lock抽象を増やさない。通常publisherの新規作成と版更新を保護したことを全20機能完了へ読み替えない。
