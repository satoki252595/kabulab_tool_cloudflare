# 保有価格windowの事前主体資格（2026-10-17）

通常cronの`resumePendingShareholdingsPrices`と、原本完了済みの価格指定CLIは同じ`publishHoldings`を使う。従来は価格unknown markerが純qualifierより前にあり、保存原本から確定する英字商号不一致まで結果不明となっていた。有限window全行の既存qualifierを先に実行し、資格成立後に同じwriterへ渡す。追加GET・モデル・価格計算の重複は増やさない。

主体不一致だけを`HoldingPriceIssuerMismatch`で表現し、公式名・原本名・symbol・gzip/body SHAを要確認理由へ保持する。ASCII句読点以外の照合緩和、価格/0/旧値の補完は行わない。事前HOLDは再開待ちからのみ許可し、source完了・全facts・cursor・欠測数を保持する。nontypedの原本/通信例外はunknownで停止し、価格writer以後の例外は同じ型でもHOLDに付け替えない。既存unknownはCLIからも変更しない。

保存済みの実原本で以下の2件をローカル再現した。EDINET ZIP・code list・gzip全体とYahoo memberのSHAを確認し、通常qualifierが専用型を返すことを検証した。Notion IDや生原本はprivate証跡へ保持する。

| 保有会社 | 保有対象symbol | code list英字商号 | 価格原本英字商号 | gzip SHA / body SHA |
| --- | --- | --- | --- | --- |
| 1333 | 8418.T | Yamaguchi Finacial Group,Inc. | Yamaguchi Financial Group, Inc. | `c663f9b644752012e86747eb3526f6f09790de1d140e3627b052445edb8acafd` / `1aca595d4d08cd9cb45e264ca2a45bfeee31562cc6470c9891eae120720a31b3` |
| 1377 | 2874.T | Yokohama Reito Co.,Ltd. | Yokorei Co.,Ltd. | `c5702632f04bc1eddb6be1541c55b110bd408ea9ba8ff5b7b3fef6b3d155af18` / `be0bea4b6040077c1873624b77fee3d91984ad9fae3d19a800c45dd1886afb45` |

Nix Node22.22.2/pnpm9.15.9で全TypeScript検査・変更4ファイルのlintを実行。関連4suiteの125 testsがPASSした。前行の資格成立後に次行が主体HOLDとなる2反例で、保有行mutation0・unknown marker0・HOLD marker1・全旧値/cursor保持を確認。同じmessageの一般Errorと、writer以後の専用型Errorはunknownを保持し、次回原本GET/loader/再送0を確認した。正常な価格・split・snapshot限定・SHA破損・ACK不明・source/cursor保全の既存検証もPASS。

実原本の再現はnative/model/業務write0。今回の本番価格公開は0であり、原本確定146行の価格受入、旧16未検証行の受入、全体完了を意味しない。保存issuer有報のDEI英字商号に別名根拠は見つかったが、今回の変更ではaliasとして採用せず、既知HOLDを維持する。
