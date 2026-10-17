# 新株予約権行使の限定原文診断（2026-10-17）

これは掲載された期間内の発行済株式総数の増加についての診断であり、全権利処理の完了、個々の行使日・法的効力日・普通株クラスの資格、価格や株数の補正ではない。本番データへの適用・次の正常定期実行は未受入。

## 取得済み原本と最小文法

実2375/S100XHRP/E05356、FY2025-10-31の既保管type1 ZIPを変更せずfixtureに固定した。原ZIPは691,698 bytes、SHA `4d4ab3494fbf619df3303658fcfa22531c51c2965a680989714aa7d57e2e5ee7`、単一PublicDoc member SHA `3e36c75394a1af40c885c77dd11c6a2865034d9a2e156c5e109c9f301b7c1cf2`。元保管manifest SHA `5fa05d6ce0245679af3ed0d22dba1a371420eb700ba0a4f494dd19a025af87aa` と保存735社inventory SHA `0e830222a4b7f2f6741f0c77fe02bbdce8a1ec35fd15431639df0846c2605f57` への来歴をfixture provenanceに保持する。追加源GETはない。

`ChangesInNumberOfIssuedSharesStatedCapitalEtcTextBlock` の単一完全factについて、全新株予約権言及が次の全文文法に合う場合だけ読む。

> YYYY年M月D日からYYYY年M月D日までの間に、新株予約権の行使により、発行済株式総数がN株増加しております。

原文の6期間は2020-11-01〜2021-03-31（5,350株）、2021-04-01〜2021-10-31（18,750株）、2021-11-01〜2022-10-31（97,050株）、2022-11-01〜2023-10-31（36,000株）、2023-11-01〜2024-10-31（89,925株）、2024-11-01〜2025-10-31（22,500株）。期間内の個々の行使日を作らず、差分から原因や倍率を逆算しない。

公式[2025年版タクソノミ](https://www.fsa.go.jp/search/20241112/1c_Taxonomy.zip)と[2026年版](https://www.fsa.go.jp/search/20251111/1c_Taxonomy.zip)の保存packageでは、この項目は `nonnum:textBlockItemType / instant` で、名称は「発行済株式総数、資本金等の推移」。既保存の公式schema/label SHAは `tmp/feature-audit-20261017/issued-taxonomy-official-v1` へ束縛されている。`FilingDateInstant` を行使日や期末へ読み替えない。

## 正常経路と停止境界

既存 `observeIssuedShares` の同verified ZIP/展開Map/単一PublicDoc/DEI/issuer/stem/期末/公式namespace資格を再利用する。新field `reportedOptionExercises` はfact SHA・正規化全文SHA・native contextと掲載期間・株数だけを保持する。class、個々の行使日、法的適用はunknown/nullのまま。未知namespace/再束縛、不完全・複数fact、未知context/entity/date/dimensions、矛盾した提出時計、期間逆転・重複・未来、数値区切り・単位不正、非対応の言及は新診断だけHOLDにする。HTML復号の例外も固定した短い理由に隔離し、旧観測値/証拠を消さない。旧発行株数の値・資格・価格は変えない。

Actions `scripts/sync/yuho-edinet.ts` の既存明示有効化から、通常ingest→publisher→同RecoveryInfo保存・resumeへそのまま渡る。ingestの既存結果にはstatus/期間数だけ追加する。保存原本prepareも同関数を使う。Worker adminのfull観測無効は維持し、新常時XML展開やsource/Notion request・DDL・依存は増やさない。旧receiptで新fieldがない場合は、この診断を検証済みとは扱わない。旧observer SHAのprepare/apply planは既存guardで再準備が必要となる。

保存4568の自己株式消却3文は、native contextの資格が欠けるため新診断HOLD。消却をこの新文法へ代用しない。増資の表・注記番号対応、併合、その他権利、旧OHLCV/adj履歴の遡及訂正は対象外。

## 検証と負荷

実原本6期間、同Map再生/追加展開0/通信0、千株・区切り不正・不正/逆転/未来期間・除外表現・提出時計・主体/context/namespace・未完/重複factを回帰で確認する。旧FY/filing valuesは保持する。正常publisher・保存prepare・Actions入口を含む5 suites /154 tests、全tsc/対象lintを確認した。

Nodeの同じ3実原本（2375/4568/7203）・各5回・展開済みMap再利用でbaseline/newを別process測定した。旧全field JSON SHAは3件とも一致。新診断はそれぞれ2,833 /423 /560 bytes増で、原ZIPや値は不変。最終sourceの測定中央値ではobserver CPUは51.54→59.11ms、61.43→66.70ms、91.52→105.64ms。process peak RSSは549,696→551,600KiB（inventory/TS読込・既存展開を含み、observer単独のメモリ差とは断定しない）。これはNodeの有限測定で、Worker128MiBや全社所要を保証しない。旧発行株数診断の64KiBを変更せず、新field/keyを含む追加分は別8KiB、合計72KiB以内とする。新診断だけのHTML例外・予算超過は固定した理由のHOLDへ隔離し、旧fieldsを保持する。旧診断が64KiBに近い原本でも新fieldを理由に旧値を捨てない境界回帰を置いた。

RecoveryInfoは未知の旧tailも保持するため、全体のheadroomを仮定しない。唯一の共通 `recordRecoveryInfo` で全markerのrich_text各100要素・送信body400,000 bytes以内を送信前に検査する。[Notion公式request limits](https://developers.notion.com/reference/request-limits)の配列100要素・request500KBに対し、400,000 bytesはこのproducerの保守的な送信予算であり公式の厳密上限値とは区別する。超過時は値を切らずPATCH0で停止し、旧stateを保持する。新診断の72KiBだけなら最大37要素だが、未知tailを含む全requestの余裕を保証した数字ではない。既存serializerの100要素/400KB超過の負例も確認する。

最終比較の保存result SHAは `31b0d8f980fc0eed918d2c551e13dd8555b0b9779c323b5533c9b708d504a144`（専用WT `tmp/reported-options-benchmark-v1/comparison-v2.json`）。3原本以外へのCPU/RSS外挿はしない。
