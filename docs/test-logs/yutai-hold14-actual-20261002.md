# 優待HOLD14行の限定実修復 — 2026-10-02

Refs #146 #196。旧HOLD15のうち2307・2001・3189・6577の14行を、次回権利向けの
定常優待として公式制度へ対応付けた。8508の単発1行は対象外で、単発基準日モデルの
対応を別途必要とする。金額のHOLDと行生成・制度の対応は区別する。

## 公式原本と判断

| 銘柄 | 一次資料と処置 |
| --- | --- |
| 2307 | [9/17変更PDF](https://www.xcat.co.jp/ja/ir/news/auto_20260917537890/pdfFile.pdf)と[旧額面表](https://www.xcat.co.jp/ja/ir/stock/basic.html)を対応付けた。旧5行33181–33185を、初回2027/3/31・以後3月末・6月贈呈へ更新。株数・額面区分は変更なし。選択式電子ギフトの4額面は本文に保持するが共有qualifierの`choice`で金額NULLを維持。交換先・条件の決定を先取りしない。 |
| 2001 | [現行・新制度の公式表](https://www.nippn.co.jp/ir/stock/stockholder/index.html)から、2027/3以降の株数・継続保有期間別4tierへ対応付けた。32973–32975・32977を更新し、旧9月コピー32978–32979を削除。自社商品/寄付の選択はNULLを保持。同一株主番号の連続記載と期間中の最少株数を本文に保持。lesson32976は全11列保護。 |
| 3189 | [公式制度](https://www.anap.co.jp/ir/information/benefit/)と[8/24変更PDF](https://contents.xj-storage.jp/xcontents/AS70999/97d6e1ed/3727/470c/ba82/f70cfa138313/140120260823524767.pdf)から、2026/8末適用を確認。旧無料エステ34369/34375を500株以上のskincare抽選へ更新し、BTC/Jade4行の当選数・条件も更新。通常digital gift 500/2,000円の2tier×2/8月を4行追加。EC6行は全列保護、抽選・購入50%上限ポイントの金額はNULL。 |
| 6577 | [公式制度](https://www.best1cruise-corp.info/yuutai/)の2026/7分配布を最後とする廃止に基づき、digital gift36656を将来の定常行から削除。旅行割引36653–36655は全列保護。 |

過去の基準日で既に成立した権利の配布・受領手続終了は主張しない。2026年分の
2307・2001の旧制度、6577の最終分と次回の定常制度を本文・証跡で区別している。
8508は2026/9/2限りの基準日で、2027/1/18までの受領期間があるため、配布済み・
権利消滅と推定して削除していない。

## 物理保管

追加原本は各1 GETで実体・URL・時刻・HTTP状態・bytes/SHAを保存した。
ANAPのissuerページから観測したXJStorageのscript→listing endpoint→PDFを辿り、
変更資料のURLを推測で組み立てていない。共有`recordPrimaryData(force:false)`、
unique row、fresh downloadによるZIPとmanifest両添付の全bytes/SHA照合を完了した。

appendix保管CLIへ渡した単一`completed-at`値は手入力で、取得終了時刻の証拠には
使用しない。各原本のresponse manifestに保存した実GET時刻を取得来歴として使う。
既存recordや原本pinを上書きしてこの制限を隠していない。

| 保管物 | archive key | ZIP bytes / members | ZIP SHA256 |
| --- | --- | --- | --- |
| 原文8資料＋取得manifest | `yutai-official-hold15-20261002-67a97a594438` | 207,340 / 16 | `67a97a5944386cc35dbfdac5740fd8153f101ca63035e3d06149aa351409cc1a` |
| 2307旧表・ANAP変更原本と取得経路 | `yutai-official-appendix-20261002-6aaca9020648` | 266,247 / 8 | `6aaca9020648feec54e9f63f3ce9b570b0d3da76d68eef092274b1c487fc030f` |
| PRE | `yutai-hold15-pre-20261002-792d5b09f3bb` | 32,374 / 23 | `792d5b09f3bb5e38234caa2686aad6bf941b3c0b7001ae65b4a486d24493fdd7` |
| POST | `yutai-hold15-post-20261002-ef4dfb188ee8` | 58,010 / 45 | `ef4dfb188ee8c65b492dd38004d45553806e04f9906a20a5da38084a7061ad1d` |

PREは最新4表全列の実応答・実本番DDL・planner/writer・確定packet・SQLite証明を
含む。POSTは実送信のattempt/raw/meta、native RETURNING、実POST全列と再入結果を
含む。原文・個別データは公開Gitへ追加していない。

## 原子適用と検証

`benefitRowsOf`の表ローカル月・headed descriptionを使用し、確定額面は既存
`qualifyCompanyPerGrantValue`を通した。3189の新digital gift4行だけが`face-literal`
でcompany適格、2307の選択式4行は`choice`でNULL。寄付・抽選・割引に額面を流用
していない。利回り・scoreは`computeYieldEntries`/`buildYieldScoreStatements`、
月/genre集計は`groupBenefitDisplaySets`を使用した。

core 4×11、benefit 28×11、financial 4×19、score 4×7のPRE全456 cellsを、行数・
NULL・双方向EXCEPT付きguardに固定した。実本番sqlite_master DDLと実PREで、正常
packet27 SQLの全列一致およびcore/保護benefit/financial/score drift・benefit追加・
欠落の6変種全列rollbackを確認した。SQLite POSTの同planner再入はSQL0。

PREの物理保管・readback完了後、共有`createD1HttpBatchSender`で1 batch、27 SQLを
送信した。benefit UPDATE15・DELETE3・INSERT4、financial/score更新2・月集計更新2、
先頭の全列guard1。native INSERT idとserver fetched_atはRETURNINGから取得して
POST期待値へ対応付け、推測値を置いていない。

実POSTの4 SELECTはcore4・benefit29・financial4・score4、全467 cellsが期待値と
一致した。財務のprice・data_date等はPREのままで、新digital giftの利回りとscore
だけが追随。財務data_dateは2026-09-13で、価格が今日の取得値とは主張しない。
実POSTを同じplannerへ再入力して更新・削除・追加・利回り/score変更0、SQL0を確認。
送信はbatch1＋POST読取4、再送0、外部AI呼出0。実行完了は10/2 00:54 JST。

この実績は4銘柄の限定修復であり、8508の単発モデルやその他未資格原本、課金切れ
25銘柄の再判定を完了した実績には含めない。
