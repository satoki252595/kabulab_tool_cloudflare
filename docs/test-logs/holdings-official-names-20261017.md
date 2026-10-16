# 保存公式英字名集合による保有価格の主体資格（2026-10-17）

code listの原英字商号を変更せず、最新issuer有報の`FilerNameInEnglishDEI`を別の公式根拠として事前に集合へ追加する。商号不一致をcatchして別の値へ切り替えず、同じ共通qualifierが公式集合と原価格名を比較する。法定名の近似照合、ブランド名の推測、価格/0/別日の補完は行わない。

通常Node price loaderは資格済みcode list・raw chartから必要主体を固定し、scoped latest selectorと既存`readSavedHoldingsZip`で現行type1を読む。公式DEI namespace、一意PublicDoc、EDINET/sec/FY、日本語DEI=最新提出者名=code list法定名、FilingDateInstantの実entity識別子/提出日、提出時点<=価格captureを検証する。ZIP/member SHA、doc、原取得時計・提出時計・contextを価格根拠へ保存する。原metadataや未知の旧manifestは変更しない。通常ingestが既に物理保存する同じZIPを再利用でき、新しい上流GET・有料API・モデル・DDL・依存追加はない。

通常window全行の資格後、価格unknown markerより前にissuerの最新doc/主体を再照合する。変化・公式根拠の欠測は既知HOLD、SHA/transport等の不明は従来のunknown STOP。通常resumeの`shouldStop`を同じloaderへ渡し、各新issuerのlatest開始前・保存ZIP開始前・writer直前latest開始前と完了後で実時間予算を検査する。既知の時間不足は価格cursorを進めず再開待ちを維持し、既に失敗した原本Promiseを時間HOLDへ置換しない。原本予約は既知の全文サイズ、未知サイズは20MiBとし、既存256MiB枠を使う。予算不足はhosted GET前にHOLD、未知結果は予約を返さず同runの原本再送0。必要主体のPromise/cacheをrun内で共有する。price indexも同じsource配列に束縛してpublisherへ渡し、chart展開/検証を重複させない。canonical一致だけなら追加D1/issuer原本GET0。

## 保存実原本の純local再計算

10/14固定snapshotの英字商号STOP289行を、33 issuer・保存有報ZIP合計28,965,130Bと固定価格26ファイルで照合した。19 issuerの165行は公式DEI英字名と価格名が一致する。既存の期末bar/split資格を維持した内訳は次の通り。

| 結果 | 行数 |
| --- | ---: |
| 期末参考時価の資格成立候補 | 124 |
| 同日期末barなし | 35 |
| 株数/価格単位を確認できず | 6 |
| 公式集合にも英字名が一致せずHOLD継続 | 124 |

これは保存原本上の候補であり、fresh D1/Notion資格・snapshot受入・価格公開の受入ではない。新たな本番価格書込/HOLD解除は0。1333→8418は公式有報のFinancial、1377→2874は公式有報のYOKOREIを根拠にできるが、1377の5/31は同日bar欠測を価格で埋めない。

Nix Node22.22.2/pnpm9.15.9、単発の同じ289行/冷price index比較は、旧canonical資格0.514秒、issuer原本のSHA/DEI/context解析0.921秒、集合付き資格0.613秒。ローカルZIP読取を含む増分は約1.020秒。終了時RSSは753,483,776B（約719MiB、peak未計測）。ネットワーク待機は含まない。必要主体ごとに保存Notion query/property読取（typedは通常2、legacyは通常3）、hosted GET1、scoped latest SELECT初回/書込直前を追加するため、通常のレート/byte/time枠内で処理し、全量時間短縮は未受入とする。

## 検証

最新main #440/#441を通常mergeで取り込み、Nixで全tsc・変更10ファイルlint・関連9suite170 testsを確認。公式context/entity/提出日/namespace再束縛・法定名/証券/EDINET違い、SHA/metadataサイズ不整合、価格capture不一致はSTOP。公式名の欠落/重複・最新doc変更は価格書込前HOLD。正常集合の根拠保持、既存canonical名の不変、価格/split/別日を緩和しないこと、index source配列の束縛、予算GET前停止、原本unknown同run再送0、canonical一致の追加D1/原本GET0を検証した。
