# 有報本文2件の原本資格確認と保存往復不一致（2026-10-03）

対象は `S100YAVT` / `S100YKG2`。SemIf評価で保存Notion本文と回収済みCSV原本の差異が見つかった2件を調査した。本記録の実時刻はUTC。元CSVのpublisher取得時刻・元manifest・当初SHAが不明な部分はUNKNOWNのまま保持した。

## 原本資格と修復前の保存

- 2026-06-12 / 06-25の正準EDINET日付一覧を各1GET、合計2GETだけ取得した。各対象は一意で、府令010・様式030000・書類種別120・取下げなしを確認し、提出日時・発行者・銘柄・会計期間を回収済み原本と照合した。原文の実受信時刻を保存し、旧CSV取得時刻の代わりには使っていない。
- 公式日付一覧を含む14member / 171,766bytesを共有一次保管へ物理保存し、全文bytes/SHAを読み戻した。bundle SHA: `c9d0df10ecde7c8515250f53ebb82ed9379edd4728cc0b5717e994988723b8c2`。rootの追加通信なし独立照合SHA: `62490d440fe57e99dd2922def4b0b1b4b12be4fa742cece93a0cc6e13068195f`。
- current D1の全core2行・全文書28行・本文索引68行をSELECT3で保存した。両本文索引はCSVから抽出した34節ずつと一致し、索引の修正は不要だった。旧本文の34節ずつを読み、CSVとの差分がU+200Bの1文字 / 3文字だけであることを確認した。
- 公式資格・回収済みCSV・現D1全行・旧Notion本文・保存済みタグ根拠等の102member / 2,531,163bytesを修復前に物理保管し、全文readbackを完了した。bundle SHA: `865e7e926b66dbe5c0672f33c55500bcdf9293e3f1c932699c5f32452c4f3354`。rootの追加通信なし独立照合SHA: `5a15cc07b3253f04d5a98d1ee19a9129c650b9e70aff8a5bb347de90dbf86c09`。

## 正準replaceの実結果

2026-10-02T19:32:19.244Zに `HOLD_KNOWN_RESTORED_POST_PHYSICAL_CLOSED` で終端した。本文修復成功は0件。最初の1件のみ正準force保存を実施し、2件目は未実行。

- 正準送信の154block中1つのcode blockにはU+200Bを含む2,000codepointがあったが、appendのHTTP200応答では `text.content` と `plain_text` の両方が1,999codepointになった。その後のchildren GETでも同じ1文字欠落を確認した。他153blockは全文一致し、読み戻した新本文は旧本文と厳密に一致した。
- この実往復はreaderの `plain_text` 優先だけでは解消できない。不可視文字を削除・挿入して一致扱いにはしていない。Notion一般の仕様全体への推測には広げない。
- 新全文不一致のためD1pointer batchは送らず、fresh SELECT3で両旧pointerが変わっていないことを確認した。既知の旧ページをactiveへ戻し、新しく作成した不一致ページをarchivedにして、それぞれGETで明示確認した。旧データの削除・未知mutationの再送は0。
- 当該終端はNotion20 / D1 SELECT3 / hosted1。publisher GET・R2 write・retryは0。本文索引・core・財務・タグ・判定根拠のwriteは0。

本文保存・D1読取・明示復旧までの送受信・全文等を67member / 906,506bytesとして物理保管し、全文readbackした。bundle SHA: `0af3a611bd873a0e2bfbc69e8da9f2fd90b9095869dae1b0803ff72270ea7702`。終端receipt SHA: `f7feeceb08a278468cf062188df5a7f87e780cff8d8b36b83fa68a2aee567787`。追加通信なしのraw差分診断SHA: `38b3125a4bb918cf85740148677db56363a4052a4664d57f6b3ccd0766fc1ee9`。

rootは追加通信なしで全24HTTPの200応答・送受信bytes/SHA・33pin・fresh全PRE一致・旧active復旧/新archived・第二未送信/pointer batch未送信・本文の1文字損失・全67member/hosted/metadata/manifestを独立照合してPASSした。独立照合receipt SHA: `47757b61fbd3be4456de485c99fa9eca6a9d057f8018c23a3130df36d99dc5c5`。本記録はFROZEN。

2本文の修復はHOLDを維持する。再開には、原文を改変せず全68節・296,260codepointを正準保存から完全に読み戻せる実証が必要。現状の旧Notion本文を原本全文一致として資格化せず、原本文は物理CSVと一次保管に保持する。旧publisher取得時計UNKNOWNは修復後も遡って補完しない。
