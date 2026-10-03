# 有報2通の可逆本文保存・本番受入（2026-10-03）

**本文2通の置換・D1参照更新・POST物理保管が完了し、rootと第二者の独立全raw照合はPASS。**
[旧plain保存のHOLD実績](yuho-text2-roundtrip-hold-20261003.md)は変更しない。
PR281の可逆JSON形式を使った後続実行として、現在の旧全文・属性・D1状態を再確認し、
新しいPREの物理保管と独立照合を済ませてから、全文一致とpointerのみの条件付き更新を確認した。

## 対象と現在の状態

対象は取得済み実CSVの2通・各34節、計68節・296,260 codepoint。
修復前の旧保存本文との差はU+200Bの1文字・3文字で、旧本文296,256 codepointのHOLD履歴を保持する。
原CSVの回収ZIPの全文SHA・CRCと抽出本文は確認済みだが、初回publisher取得時計・
旧manifest・初回本文SHAのUNKNOWNを現在の観測時計や回収SHAで埋めない。
SemIf較正時の85通一致＋2通SOURCE_RECOVEREDという評価来歴も変更しない。

[正準保存形式](../notion-stock-text-format.md)は`json-escaped-v2`を明示し、
不可視文字とsurrogateを可逆エスケープする。旧plain読取・通常既存skip・外部の戻り値は維持する。
今回の実行receiptで、新形式のNotion全文往復は2通とも原本文と一致した。

## 新PREの物理保管

2026-10-03T00:51:12.424Z、現在の旧状態と取得済み根拠を112 member・11,051,395 bytesの
束に格納し、共有`recordPrimaryData(force:false)`で物理保管・全文読戻しを完了した。
gzipは6,028,433 bytes / SHA256
`66216309197bcd4a5186560c0a7e6a169ee177cdb67dbbf09e0c0dedca7f0747`。
実Notion8・保存添付GET1、source取得・D1/R2 write・再試行は0。
receipt SHA256は`d9d8af95c11b1f660cad06e6d008f78beaeaad30d5d326e268172e1b29b3564b`。

独立照合では全9HTTPのrequest/response bytes・SHA・clock・status200、
metadata・manifest、全112 memberと保存添付の全文一致を確認した。
独立receipt SHA256は`8c6d905c9b8d8ac692b529677603b7d18374c1b99933bd85c82d5753240fc819`。
この照合はローカルで行い、追加APIは0。

## 本番実行とPOST

確認済みmain `f1703bbfda7b3e93b6c2e37b0cc00fdfab96815c`の正準処理で、他の書込みを実施せず
2026-10-03T01:00:27.418Z〜01:00:48.187Zに1回だけ実行した。
2通の新全文は原CSVの全3field・68節・296,260 codepoint・U+200B4文字と一致した。
D1の2銘柄・28文書・68索引をfresh3 SELECTで比較してから、全PREに対する条件付きbatchで
本文pointer2件だけを更新した。全POST3 SELECTで、変更はそのpointer2件だけと確認した。

実数はNotion23 / D1 HTTP7 / 保存添付GET1、全31HTTPが200。
POST98 memberはgzip1,418,091 bytes / SHA256
`36a3c2631415a40da59b71e3071408263fa446af11dcbf7d9c3784bfbf8fbbd8`として共有物理保管し、全文を読み戻した。
完了receipt SHA256は`3666a4251bb6687e493f23f4db45a4c35c1b3b3b2876ead1adc0e3858c3d89b1`。
新fresh PRE・旧本文確認・PRE/POST保管を含む今回stage累計はNotion37 / D1 HTTP10 / hosted2、SQL12。
保存応答metaは、実置換phaseがSQL9 / rows_read1,315 / rows_written2、
今回stage全体がSQL12 / rows_read1,435 / rows_written2で、いずれもmax_attempts1。
旧HOLD試行の累計と混ぜず、単発件数を月額へ外挿しない。

rootの独立照合は全31HTTPの原request/response bytes・SHA・clock・200、
全68節の原文一致、fresh全量・guard・pointer2件のみのbatchとPOST差分、
全98 member・保存添付全文一致を確認した。receipt SHA256は
`79c456d6a2d138f03725f81c05c83c41a47e27c40e8218999975daab29e7fa0e`。
manifest fingerprint・日付表示・Files1件と今回stageのD1 metaも照合した。
補足receipt SHA256は`67938d12b7b7779302445eb2b64b1314e2d651fad29da045beb45be43ae55e59`。
第二者の照合も、全31HTTP・全68節のv2正準decodeと原CSV全3field、fresh PRE全bytes、
guard・pointer2件のみの更新・全POST、全98 member・manifest fingerprint・保存添付の全文で一致した。
receipt SHA256は`0410b14de504d1327e8da2e25f3b7cd90ac14598285e8dcf103045cb84497248`。
独立照合の追加API・書込み・テスト実行は0。

応答不明・未完・ブロック形状不正は追加通信0で停止する入口を使った。既知の全文decode/原文不一致や
pointer送信前の既知D1変化は、旧pointer不変を確認できた場合だけ明示復旧する。
原本の再取得、金融値・索引・銘柄・既存タグの更新、モデル呼出し、R2 write、再送は0。
この2通の受入を、本文未取得90件・海外HOLD2・旧全体の来歴修復へ拡張しない。
