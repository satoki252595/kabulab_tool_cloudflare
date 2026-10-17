# 全20機能の復旧状況 — 10月17日16:00 JST／17:29・18:21・19:35追記

追跡: [#348](https://github.com/satoki252595/kabulab_tool_cloudflare/issues/348)。[当初の機能別監査](feature-gap-audit-20261014.md)と[受入台帳](recovery-acceptance-20261016.md)の保存証拠を集約した時点記録。全サービスを16時に一括再照会した結果ではない。全20機能の完了には未到達で、原典にない値を埋めない。

最新の追加受入は[19:35 JSTの記録](#1935-jstの追加受入と通常macへの配備)を参照。次の20項目表は16:00時点の履歴で、後続の時点記録を上書きしない。

## 機能別の受入と残件（16:00時点）

| # | 機能 | 確認済みの範囲 | 残件・次の処理 |
|---|---|---|---|
| 1 | 銘柄マスタ・上場状態 | 公式overlayの233イベント、廃止3件・市場変更1件、同値再適用を確認 | 最新の通常定時receiptを別確認 |
| 2 | 株価・財務断面 | 10/16は3,687銘柄中3,645銘柄が完全、42銘柄は未完・部分結果 | 原本OHLCV等が全NULLの41社を公式市場資料と照合。別日の値で補わない |
| 3 | RSI・スイング・モメンタム | 共通の株価系列・資格診断へ接続 | 最新通常系列の全量receipt、8303等の源欠測、旧245保留、権利basisを照合 |
| 4 | マクロ判定 | 日米市場カレンダーと保存原本の資格処理を修正 | 日米それぞれの最新確定sessionと翌朝の結合receiptを全体で受入 |
| 5 | 財務サマリ | ROE102、直接ROA6と実表3社等の限定回収 | 非開示・未対応・期間/連結差を区別。全NULL項目の一律補完はしない |
| 6 | EDINET継続取得・識別 | 保存本文3,666社。保存原本の主体・期末・DEI照合を共通化 | 最新catchupの識別保留・対象HOLD21と、後続取込失敗を別照合 |
| 7 | 有報39項目 | 固定3,666社の本文39項目を回収。原要素自体の不在23件を区別 | 本文補足DBの同期は下記14の有限処理で継続 |
| 8 | 受注・海外売上 | 受注40文書236数値、海外100文書601数値を全6表・原本・両物理ファイルで受入 | 受注72文書243数値、海外66文書392数値。競合する本文writerの閉鎖後に通常CLIで進める |
| 9 | TDnet・IR PDF | 381原本の物理保管等を受入 | 銘柄1447/SAAFの旧PDF1件は未取得を保持。公式代替原本と元pointerを同一視しない。最新EDINET後続失敗も残る |
| 10 | VWAP日足 | 旧10/14の原本4件を限定復旧 | 残3原本HOLDと最新通常日足の全量完了を別確認 |
| 11 | VWAP 5分足 | 固定suffix1,856中1,399銘柄をR2全bytes・ETag・実SDK metadata・物理summaryまで受入 | 残457＝7531原本HOLD＋未受入456。新有限処理は18:18:51 JSTまで、旧期限は延長しない |
| 12 | 信用残・日証金需給 | 保存済み4,247/4,349行と通常取得を確認 | 最新10/16 runの基準日・全件数、旧20銘柄の掲載対象外を照合 |
| 13 | 株主優待・要約 | 7,716行のDTO、選択15群19行の限定採用。通常取込/定期要約は同じcompiler | 保有期間4行は監視器の照合不備でREAD1後に停止、データ更新0。旧claimを保持した明示継続を修正中。tier・併用・公式資格と次21時receiptは未完 |
| 14 | 事業タグ・Mac定時 | 今回の本文固定2,417社中950社を通常機械処理・全39列・物理PRE/POST・永続completionまで受入 | 残1,467社。ローカルClef保存結果104社は生成受入済み・公開0。現在入力の資格確認後に保存結果を再利用 |
| 15 | 競合企業 | 固定83対象の81社574関係を限定受入。新5社の機械準備は物理保管まで実行 | 新5社は候補Bの資格不足でready0。残33社の準備と意味判定、次定時stageは未受入 |
| 16 | 資金フロー | 株価非依存28取得元の10/16結果等を確認 | 株価依存sector-turnoverと最新全量receipt。欠測銘柄を黙って除外しない |
| 17 | RAW原本・API索引 | 受入18,412/78,832。復旧対象1件を通常rawCAS→索引INSERT→cursor18,878まで進めた | cursorとの差466件は全体照合へ未加算。次は現在/直前checkpointの通常inspect、続いて元run pool内の通常bulk。元送信ACKは未知のまま保存 |
| 18 | 有価証券保有明細 | 原本列1,667行115文書を全値・全原表・物理PRE/POSTで受入。1911のunknown行は通常の保全置換で閉鎖 | 次の固定範囲を通常publisherで継続。新規価格資格0、単位HOLD5,362行。分割前期末株数の明示根拠8社と、候補28行を価格確定へ読み替えない |
| 19 | API・MCP | JSS private strict v1/v2/v3を配備、実コード・6bindings・health200・未認証401を確認 | 既存キーはCloudflareのみ。実認証付きv2/v3 payloadの通し受入は未完。鍵の取得・新規発行・変更はしていない |
| 20 | 監視・Notion案内 | coverage/receipt監視、現行カタログ89blocks/5views等を反映 | 最新正常定時の終了receipt、Mac配備版と次20/21時、翌朝readcheckを別確認。配備成功だけで全機能完了にしない |

## 19:35 JSTの追加受入と通常Macへの配備

16:00・17:29・18:21の記録は履歴として保持する。以下は保存済みroot最終証跡の更新であり、全サービスの同時再照会ではない。全20機能は未完で、全体の完了日時・完了率は未確定。

| 項目 | この時点の受入 | 残件・受入の境界 |
|---|---:|---|
| 本文補足の有限機械同期 | 1,450/2,417社 | 残967社で有限chainは自然終了。後述の通常実行110社を、この固定残数から重複照合なしに差し引かない |
| 保有明細 | 2,826行・218文書 | 第19範囲まで原本列・全props・物理PRE/POSTを受入し、照合済み境界で停止。新規価格資格0 |
| 受注 | 固定112文書・479数値 | 固定cohortの全段階を終了。別途除外した65文書や、全開示形式の網羅は含まない |
| 海外売上 | 140/166文書・842/993数値 | 残26文書・151数値。第2段階までの受入を、未実施後続の成功へ広げない |
| VWAP 5分足 | 固定suffix 1,854/1,856銘柄 | 全196処理・親子終端を照合。残7531/9311は当該実応答の有効バー欠測HOLD。永久欠測とは判定しない |
| 保存済みClef結果の公開 | 37/104社 | 先行修復3625の1社＋通常実行36社。残67＝doc変更65＋同一docの根拠HOLD6038/9344。将来の公開には現在入力の再資格化が必要 |
| 競合企業の通常準備 | 今回5社中ready1・HOLD4 | 原本gzipの物理保存まで確認。モデル・競合relation・schema書込み0で、意味判定の公開完了ではない |
| RAW | 通常inspectでcursor20,411・残58,421件 | 全体受入18,412/78,832との未集約差は保持。pool ordinal69/200の単発pilotがLIVE、continue0。新しいhosted枠の速度改善は未受入 |

Mac事業タグの通常installerでaccepted `4a66929c`を別versioned runtimeへ配備し、RunAtLoadを1回実行した。19:02:37〜19:26:12 JSTのlocal終了receiptとR2全bytesが一致し、親子終端・kernel解放・publication journalのreadyを確認した。ただし`scheduledFor`は**10/16 20:00**であり、**10/17の実20時calendarの受入は0**である。Yutai plistの切替えとGitHub監視secretの更新は未実施。現在の20時処理が実際に終端した後、21時まで通常30分と照合余裕が残る場合だけ別の有限releaseを判断する。

初回の通常mainは20分18.683秒で859/3,687社を訪問し、skip712・retag36・sync_text110・create_row1を記録した。create648Aは資格HOLD行で、意味判定の完成ではない。Clef新規forward0・保存出力再利用38・外部モデル0、Notion2,213要求・429/一時retry0。6038/9344は既存の新根拠が結果不明のため保持し、再送していない。後段の通常prepare-onlyは5社の入力を原本gzipへ保存し、ready1/HOLD4、Notion52要求だった。今回の所要を次20/21時や全量完走の保証にしない。

旧104社の保存入力と通常durable completionのcode/doc/target/source identityを通信0で照合した結果、通常semantic36社はすべて旧集合内だった。3625と合わせた残67社には旧モデル69bindingが対応するが、現在raw入力・最新根拠の資格を新たに確認したわけではない。旧103社plan、モデル出力、旧STOPを保持し、実20時の更新後に同じ通常plannerで再資格化する。今回のread-only交差監査を新しい公開許可として使わない。

RAWの残58,421件を、旧500件/3,161.511秒と同じ速度で進める場合は約4〜5日相当となる。これは旧観測による条件付き計算であり、現在pilot69の実測でも全体ETAでもない。新しい通常hosted独立枠はAPI側0.25rps以下を維持するが、pilotの終端・保存原本・費用を照合するまで速度改善率を採用しない。旧poolのACK未知・停止証跡は残し、新poolや自動continuationで回避しない。料金の含有量・実行分数無料の範囲と保存・他用途・ローカル電力等の別費用は、17:29の区別を維持する。

[#490](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/490)の限定option診断/明示公開復旧、[#491](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/491)のRAW hosted枠、[#492](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/492)のsplitを跨ぐ指標HOLD、[#493](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/493)の明示普通株消却診断は、各exact CIと実Cloudflare配信を確認した。最新Workerは`54097f6d`、version `e04093aa-d59d-4f0c-bb7f-25495006f237`。Mac実行版`4a66929c`とは区別する。#492は受領OHLCV/adjcloseを変更せず派生指標だけHOLD、#493は報告日・明記株数だけを観測し、法的効力日・市場落日・価格係数を確定しない。全権利イベント台帳、増資/払込/行使と一株指標の適用、過去調整系列の訂正は未完である。旧5,362行のHOLDをすべて単位欠測と断定せず、価格basis/単位等の現在内訳は未再確定として保持する。

機能9の「1447」は件数ではなく銘柄1447/SAAFを指す。物理保管381件とは別に、旧PDF1件が取得不能で、公式の差替PDF374,068Bは別原本として保管済み。元pointerはNULLを保持し、差替原本を旧PDFへ付け替えない。[既存の原本照合記録](feature-recovery-20261014.md#pr-352後の本番検証)を参照。

残件の分類は既存20項目を引き継ぐ。通常共有機構があり補完・最新定時受入が必要な項目、未対応財務要素・表形式・優待tier/併用・権利適用等の本番ロジックが残る項目、原本や公式資格が欠け現入力では埋められない項目は重複し得る。コード配備・固定cohortの成功・HOLDの正確な保存だけで、全機能完了へ数えない。 画像PDFは既存の[pipelineのPDF変換](../../pipeline/src/jp_stock_pipeline/convert/pdf_to_text.py)・[IRのテキスト抽出](../../services/ir-catalog/src/services/pdf-sentiment/extract-text.ts)でOCRを意図的に対象外としてunknownを保持する設計であり、原本そのものの欠測とも区別する。OCRによる値の補完を今回の実装予定へ追加していない。

追加の私有最終証跡（リンク先はGit対象外。raw本文・署名URL・秘密値はGitへ保存しない）:

- [保有第19範囲](../../tmp/feature-audit-20261017/holdings-next12-rate050-proposal-v1/actual-next12-v2/range-19/root-final-acceptance-v1.json): `d9e11498ae0adf2a3fb66c5e479b289cc9982f502eb2c12f55631d7c4744e57d`。
- [受注112文書の終端](../../tmp/feature-audit-20261017/orders-remaining52-normal-operation-v1/stage-03/root-final-acceptance-v1.json): `987d5aa7092295bb37b8f4ddbc67cecd45ab1455eea115c2971437a490ba2082`。
- [海外140文書](../../tmp/feature-audit-20261017/overseas-remaining66-normal-operation-v1/stage-02/root-final-acceptance-v1.json): `9fa579357e3f46afbe787b056f357a001afa14029203466243c3f264be25f790`。
- [VWAP全196終端・固定1,854](../../tmp/feature-audit-20261017/vwap-intra-remaining196-operation-v2/batch-04/root-final-acceptance-v1.json): `918247803cf83b5f99727553cd2a6fd6ff1a21ebb895839b4d2da32bbb50e368`。
- [Mac初回通常実行のroot受入](../../tmp/feature-audit-20261017/mac-main4a66929c-cutover-v1/root-biztag-first-rollout-acceptance.json): `d385271508fc16dc5154f242b312af2dc8e42853a383b8800f3ec6dc2668ce9a`。
- [旧104入力との独立交差再生](../../tmp/feature-audit-20261017/mac4a-old104-publication-intersection-v1/root-result-v1.json): `5b7fffd8b56b97d5811263fafa020e8d048854f13a26c972f43c3bbda02c23cf`。
- [RAW通常inspect68](../../tmp/feature-audit-20261017/raw66-normal-inspect-github-v1/root-independent-inspect68-acceptance-v1.json): `a428875732a5d95ee6aad924d69d7196b41cfd8a2148b59e6330223ea5970c90`。pilot69は`raw-hosted-main02-single-pilot-v1/`の単発記録を別保持。
- [#490](../../tmp/feature-audit-20261017/continuation/pr490-root-final-review.json): `b88fcaa724021ae9e3ca8da7f51cc668eec80a3c4efc72b7595d61b2132a224d`、[#491](../../tmp/feature-audit-20261017/continuation/pr491-root-final-review.json): `6ac659349f1a438e5dff8efbabb2a6751e55f9bed4175b593a3d3f723484c0d3`、[#492](../../tmp/feature-audit-20261017/continuation/pr492-root-final-review.json): `4bda7c4e7dda028610997e2904be0126db3407356f481ca4237e6bac519da394`、[#493](../../tmp/feature-audit-20261017/continuation/pr493-root-final-review.json): `e082307eceb74d0d18f645c8379d2ea431cd29db2b5e4b3e025c6132d182eb89`。

## 18:21 JSTの追加受入と停止

16:00と17:29の記録は保持する。以下は新たに書込み後まで照合した範囲で、全20機能の完了や最新全量照会を意味しない。

| 項目 | 累計受入 | 現在の残件 |
|---|---:|---|
| 本文補足の機械同期 | 1,450/2,417社 | 残967社。今回の親処理は18:02に自然終了し、全子処理と最後の50社の独立照合を確認 |
| 保有明細 | 2,642行・202文書 | 次範囲を実行中。新規価格資格0。定期実行前に、書込み後照合が閉じた境目で終了させる |
| 受注 | 100文書・440数値 | 残12文書・39数値の通常prepare/apply/inspectを継続 |
| 海外売上 | 120文書・724数値 | 残46文書・269数値。次20文書のwriter終了だけでは加算しない |
| VWAP 5分足 | 1,658/1,856銘柄 | 未受入196の新しい有限処理を実行中。7531・9311の有効バー欠測HOLDは保持 |
| 優待条件 | 選択19行＋保有期間4行 | 他tier・併用・公式情報の資格と次21時の通常receiptは未受入 |
| JSS API/MCP | 認証付き固定11ケースを受入 | REST70行（v1=47/v2=19/v3=4）、MCP initialize/list8/raw metadata1。全データ網羅の証明ではない |
| RAW | 全体受入18,412/78,832件を維持 | 通常bulk63は500件（新規489・既存11）を検証しcursor19,378。続く64が稼働中。cursor以降59,454件と全体差分は別管理 |
| 事業タグ | 保存済みClef判定104社・公開完了受入0 | 通常公開器で1社目のappendとproperties PATCH200後、監視器が後続DELETEの送信前に停止。元intent/PRE/STOPを保全し、現値のREAD照合を実行中 |

VWAPの前操作は9551のsource429で停止した。停止前の既知30銘柄は保存原本・物理raw・通常CASと新しい全R2 POSTを照合して受入し、未書込み20銘柄を加算していない。新しい196銘柄の有限処理は取得間隔を実送信で4秒に限定し、旧429・旧期限・累積費用を保持する。9551の過去429を恒久欠測へ分類せず、未知結果を再送しない。

事業タグの監視器はJSONヘッダ付き・本文0 byteの通常DELETEをJSONとして解釈してしまい、実送信229件の全200後、230件目のintent/nativeより前に停止した。保存応答の独立再生で同じ例外を確認した。最初の1社には新根拠と新propertiesがあるが、旧根拠の退役とdurable completionは未完であり、公開完了へ数えない。このpendingにより通常publisherの全体ready判定も停止する。書込み済みappend/PATCHの再送やpending削除をせず、原PRE・新旧根拠・現properties・最新原書類を照合してから、通常共有コードでの明示的な復旧を準備する。Macの新runtime配備、20/21時の実確認、監視secret更新はこの時点で未実施。

JSSの通し確認では、Cloudflare上の既存キーを同じWorker binding内だけで使う0%一時previewから通常本番認証・REST/MCPへ接続した。鍵の抽出・発行・変更・保存をせず、productionの100%配備と6bindingsが前後同じことを別の読取で確認した。内部D1 SELECTは6回、Notion/R2/source/model/業務書込み0。存在しない優待MCP toolの成功を主張しない。

権利処理は、分割・併合の診断と、明示根拠のある限定的な期末株数basisの確認を行う。原株数と同年度の未調整終値に調整係数を再適用していない。増資・新株予約権行使・自己株消却を含む権利イベント台帳の全面実装、および過去調整価格全履歴の更新は未完である。原典の期間・数量を厳密に抽出する追加診断を検討しており、株数差からイベントや価格係数を推定しない。

完了見込みは、進行中の有限補完を19:30までに区切り、Mac切替と実20/21時の受入はpending解決と各actor終了が条件。原本の残59,454件は直近500件/3,161.511秒と同じペースなら約4〜5日相当であり、将来の保証ではない。現在のRAW workflowは0.25 req/sを固定し、凍結した継続器にMac時間帯のpause/lease gateはない。一律1.0へ上げるとMac約2.63と重なるため変更していない。待機時間の実測がないので速度改善を断定せず、既存pool・通信回数・費用境界を保持する。全20項目には上記以外の権利処理・公式資格・最新receipt等も残り、全体の完了日は未確定。

Worker main `f6314fec4ea7c3b8c1f14cc6b58f6bcf2d1c9393`は[#489](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/489)の3 CI成功後、17:41:37 JSTにversion `5e01287c-763b-4cfb-b8c1-f974acb1a57a`へ配信済み。Mac候補と稼働中の凍結runtimeをWorker配備と同一視しない。

追加の私有証跡（同じ`tmp/feature-audit-20261017/`基準）:

- 本文1,450: `G1548-mechanical-v3/batch-12/root-final-acceptance-v1.json` — `4d6173fabecefb8d4ca4a218caee2419959d87dc0048ae6eba77049a19c53ed7`。
- 保有2,642: `holdings-next12-rate050-proposal-v1/actual-next12-v2/range-17/root-final-acceptance-v1.json` — `9d5b0396afa1c932924a86b0869f230d17d07b612ca7e958af44715f4794698b`。
- 受注100: `orders-remaining52-normal-operation-v1/stage-02/root-final-acceptance-v1.json` — `78cddc86634027aa41e4dbf4b6b742e24af2992f2fe387ed17aaaf5c77e2b160`。
- 海外120: `overseas-remaining66-normal-operation-v1/stage-01/root-final-acceptance-v1.json` — `28318fd3ee4b8f3ea8e8fdc37f098b5cd790d0f6426936030ddcb49e03a92061`。
- VWAP追加30: `vwap276-partial02-saved-audit-v1/root-final-partial30-acceptance-v1.json` — `bf3795214432fef5824b8936b67318f3f6be9ba9866deb49fd5d6369efdd1606`。
- JSS固定11: `jss-yutai-v23-auth-probe-v1/root-final-acceptance-v1.json` — `bbf65942b842366a44a237119a0a0e28ddc3331adec1b773d63fecd264c12011`。
- 事業タグ送信前停止の保存再生: `biztag-3625-applied-stop-qualification-v1/agent-saved-qualification-v1.json` — `77c79bff97f3bc332d42b17db59014f28ecd7e5eb27447e696efda4239eec4d9`。
- RAW速度の条件付き上限: `raw-throughput-source-and-input-audit-v1/conditional-rate-and-mac-overlap-v2.json` — `bf1ab3c07319666655e3806415a340cc8cf0699f637dd1ca16765a6d2d3b57d0`。

## 17:29 JSTの追加受入

上表は16時の記録として保持する。以下はその後に通常処理の保存応答を独立再生し、書込み後まで照合した追加分。全20機能の一括最新照会や全量完了を意味しない。

| 項目 | 累計受入 | 稼働中・残件 |
|---|---:|---|
| 本文補足の機械処理 | 1,300/2,417社 | 後続バッチを継続。モデル起動0 |
| 保有明細 | 2,288行・160文書 | 後続範囲を継続。新規価格資格0 |
| VWAP 5分足 | 1,578/1,856銘柄 | 未着手276の新しい有限処理を開始。7531・9311は取得時の有効バー全欠測としてHOLD |
| 受注 | 60文書・298数値 | 残52文書・181数値の通常prepare/apply/inspectを実行中。追加20文書のwriter照合だけでは加算しない |
| 海外売上 | 100文書・601数値 | 残66文書・392数値の通常処理を実行中 |
| 優待条件 | 選択19行＋保有期間4行 | 47行の全scopeを照合し、4行以外の43行と金額・日付を保全。tier・併用・次21時は未受入 |
| 事業タグ | 保存済みClef判定104社、公開0 | 新しいMac候補で通常consumerの106応答・580設問を通信0で再生。現在入力の資格確認と公開反映は別に必要 |
| RAW | 18,412/78,832件 | 通常bulkを本番Actionsで実行中。cursor18,878との差466件は未加算 |

VWAPの前操作ではsource429で止まった9250を新操作の一度だけの取得で回収し、R2全POSTまで受入した。9311はsource200でも127時点中126がNULL、1が出来高0のため、共通パーサーが書込み前に拒否した。欠測を別値で埋めず、旧R2全body・ETagの不変を新しい読取で確認した。残276用の監視器は「HOLDには通常GET応答が存在しない」分岐を修正し、実保存50銘柄のPOST（価格49＋HOLD1）で旧不具合と修正後・負例を再生した。通常取得器の欠測拒否は維持する。

206A/S100XCINは通常の主体・期末照合で「全節該当事項なし」を確認し、診断3項目のPATCH200後、読取3要求で対象全propertiesと期末明細0を照合した。監視器の関数参照不備で停止した元操作とpendingを残し、更新は再送していない。診断の受入を明細生成や価格反映の成功へ読み替えない。

受注と本文補足の共有44文書は原本・本文をともに読むだけで、更新列も別であることを6074個の保存pinから確認した。受注52と海外66は会社ID・文書ID等の積集合0。両者は同じ会社ならgrowth再計算・全6表CASが競合するため、今回は会社範囲が分離していることを実行条件にした。Notion枠は本文1.35＋保有0.75＋受注0.25＋海外0.25＋RAW0.25＋VWAP0.04＝2.89 req/s。優待4行は終了しており、その枠を海外へ移した。

海外の次操作の既消費は4,003要求。旧3,785という記述では第4段階のPRE218要求が抜けていたため、保存応答から2,524 Notion＋1,302 D1読取＋80 D1 batch＋97 hostedへ訂正し、新操作の費用境界へ全量を引き継いだ。旧証跡・期限は変更していない。

Paid D1は月250億行読取を含むため、1.3億行はその0.52%。仮に全量が含有量を超えた追加読取でも単価から$0.13であり、書込・保存・同月の他用途は別である。[D1公式料金](https://developers.cloudflare.com/d1/platform/pricing/)を再確認した。RAWのリポジトリはpublic、runnerは標準`ubuntu-latest`なので実行分数は無料対象だが、artifact/cache・Cloudflareの保存等まで無料とは断定しない。[GitHub公式課金範囲](https://docs.github.com/en/billing/concepts/product-billing/github-actions)と[R2公式料金](https://developers.cloudflare.com/r2/pricing/)を参照。新規有料モデル・取得元・依存追加0。

Workerは[#487](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/487)の通常優待継続修正を16:12:52、[#488](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/488)の運用記録を16:46:13 JSTに配信済み。後者のversionは`3c9bd5be-fc4c-44c9-8753-b783dadb361d`、startup40ms。Mac候補`7d1ca586f1f3c5b9df42a0ff42df49d12121ceff`は全tracked source・lock・通常preflightを通信0で照合した段階で、launchctl・既存plists・監視secretは未変更。稼働中の旧sourceを置換せず、各有限actorが閉じてから通常installerで切り替え、実20/21時のreceiptを別に確認する。

追加の私有最終証跡（同じ`tmp/feature-audit-20261017/`基準）:

- 本文1,300: `G1548-mechanical-v3/batch-09/root-final-acceptance-v1.json` — `17243403a7a5d2683884188aa4417e8a416e4de2a03aade5f5fb5ea56c7af182`。
- 保有2,288: `holdings-next12-rate050-proposal-v1/actual-next12-v2/range-15/root-final-acceptance-v1.json` — `c870010c2f885666a3a271f64fe691d670ed33ecc7d111479697d3d3f8e26cb3`。
- VWAP1,578: `vwap326-partial01-saved-audit-v1/root-final-partial49-acceptance-v1.json` — `886862ea085ca19b8404dd6b756bed2f674fc2b2749d0fc5a72400e9219b91d6`。
- 優待4行: `yutai-holding4-normal-readonly-resume-v1/root-final-acceptance-v1.json` — `897a66889a86d88d6df1ebb5e706e51f2654f04c628453239bd2ee6fe5bbae83`。
- 206A診断: `holdings-206A-after-ACK13-readonly-v1/root-final-diagnostic-acceptance-v1.json` — `e3f3997129b7803e1e4a9bdd87b0b04188be9a54556a10ce3c82204cb3372d53`。
- 海外の全既消費・範囲: `overseas-remaining66-normal-operation-v1/scope-and-cost-v1.json` — `f3e6ef29f6df2ab640ebcc8046c0d22b030d86b49102226b19372a2817190e38`。
- 公式料金と実runner: `continuation/cost-official-scope-20261017-v1.json` — `1409dd858f48620eba381be33b31fcfd2e32322f2a515aaf48490c14d271accd`。

## 16:00時点の共通実行方針と費用境界

取得・抽出・計算・保存・検証は本番と同じ通常CLI/共有関数を使い、ローカルは同じ依存lockをNixで実行する。意味判断が必要な事業タグだけローカルのCloudflare/clef-flashへ限定する。今回の追加補完・独立再生でモデルを起動していない。新規有料サービス・依存・取得元の追加はない。

現ローカル有限処理のNotion予約は本文1.35＋保有0.75＋受注0.25＋RAW0.25＋優待用0.25＋VWAP0.04＝2.89 req/s。これは本番定時を含む合算保証ではない。土曜の18/19時Worker処理は曜日指定の対象外だが、Macの20/21時は毎日動く。保有CLIはMacのkernel writer lockを取得しないため、通常定時を優先し、補完のネットワーク処理が閉じた保存監査の境界で切り替える方針を検査している。calendar・実行中source・.env・旧期限は変更していない。

保有の新2範囲は合計790 native要求で59行13文書を受入。本文の31社/次50社は実590.678秒/794.410秒で、outer保管込みNotion652/925要求。これを全量時間や将来の完走保証へ拡張しない。RAWの単件復旧は24要求、通常索引登録は12要求で、原manifest取得費用も保持する。HTTPヘッダ・SDKエラーbody等の未計測分は全通信量へ算入できない。[Paid料金の確認と読取見積り](../deterministic-production.md)とは別に、各操作の既消費・HTTP/byte/time capを引き継ぐ。

## 16:00時点の配備・証拠

Cloudflare main `14ce552846fca288d4f4890a84f1f4afbaad48e9`は15:34:18 JST、version `755184da-8d06-4a8b-b062-7fafb04436fd`へ配信済み（[#486](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/486)、3 CI成功、startup35ms）。Macの稼働中e4c、保有b8、受注f7等は凍結し、Worker配備をMacの切替えや定時完了とは数えない。

私有証跡のfull SHAは各JSONへ保持し、原文・署名URL・秘密値はGitへ含めない。以下はGit対象外の`tmp/feature-audit-20261017/`からの相対パス。主要root最終証跡:

- 本文950: `G1548-mechanical-v3/batch-02/root-final-acceptance-v1.json` — `ba324f5d13c4bd5f0898002b06c0d2c623541d187c0cc8d4cc831dbad8dc310e`。
- 保有1,667行: `holdings-next12-rate050-proposal-v1/actual-next12-v2/range-10/root-final-acceptance-v1.json` — `ca55a737cb0587eab4142d50954640a679fc7641c1223ee90e70d4adc9f88826`。
- 受注40文書: `orders-remaining92-normal-plan-v2/stage-01/root-final-acceptance-v1.json` — `06322eecebf3058a904d978153d337a1d3daf2d88a46ee78f06256a7b8986f70`。
- VWAP1,399: `vwap-intra-remaining506-operation-v1/batch-01/root-final-acceptance-v1.json` — `752cfce4711648dcee31a13252b40dae3a163c74f401de2b7aff2af386cbbccb`。
- RAW単件索引登録: [run39011454325](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/39011454325)、`raw-child57-normal-apply1-v1/root-final-acceptance-v1.json` — `e3f8672d1b4243b837add4a8cdf3e134dc54d19b69417c0d3be8ae01b4c97ed3`。通常actorの全SHA/15列検証と全job logを受入した範囲であり、遠隔payloadの独立再取得や全量anti-joinは未受入。

優待の最初の通信0停止に続き、修正後の有限監視器が共有パーサーを使わずscopeを再構成したため、JSONのkey順だけでgzip SHAが変わり、保管Key照会を送信前に拒否した。保存search200→同じ通常recordPrimaryDataの純再生で元AssertionError SHAまで一致した。元claim・新sidecar・全STOP・6準備ファイルを保持し、一般のunknown再送へ広げず、READだけの停止を明示資格化する。調査結果SHA `63657808a2c6a10711c18e5680ad2c8c23cb9df155c4f8bb3401b5a79e48a88e`。この修正の予定を4行の実データ完了とは数えない。
