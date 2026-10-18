# 保有参考時価の市場日と評価日（2026-10-18）

期末が公式休場日の場合に、参考評価時点・株数時点を期末、価格時点をその日以前の公式最終市場営業日として分ける。営業日に価格バーがない場合や、採用すべき営業日のバーが欠ける場合は、さらに前の価格へ逃がさずHOLDにする。これは明示した参考値の算定契約であり、会計上の時価そのものを認定する処理ではない。

## 出典と対象

[JPXの2025年大納会公表](https://www.jpx.co.jp/corporate/news/news-releases/0061/20251120-01.html)の2025-12-30、[大納会の定義](https://www.jpx.co.jp/glossary/ta/274.html)、[現物市場の休業日説明](https://www.jpx.co.jp/faq/others_general.html)を2026-10-18に取得した。3HTML全文を通常`recordPrimaryData`で物理保存し、通常`verifyArchivedAttachments`で全文バイト一致を確認した。一次保管ページは`3fdd74ff-84cd-81b8-8cf3-c4c0fc1ebb53`。取得3回、Notion12回、再試行0、業務値更新0、モデル0。

| 原本 | SHA256 | bytes |
| --- | --- | ---: |
| 2025年大納会 | f881404b121077fc3a880cece0c99edda82dae66dabfc08ef7e8d80dc3f20588 | 34303 |
| 大納会の定義 | 7e4828b9f354ddc3b12efe6a129dd1e5f4dd3c0262cbe69e38cbc6f41cef3225 | 25191 |
| 現物市場の休業日説明 | a6e86784db19e931d8a63e1647e884b39f0fecc7278c18c62c01502dfda2cf51 | 43377 |

共有カレンダーには2025年末の最終営業日と閉場期間だけを加え、未確認の2025年全休日を作っていない。既存2026/2027年カレンダー・原典pinは保持する。未収録年は未資格、日付不正は停止する。[企業会計基準第30号](https://www.asb-j.jp/jp/accounting_standards_system/details.html?topics_id=40)の測定日概念を、前の価格を法定時価と認定する根拠には用いない。

## 共有処理と互換性

`lastJpxSessionOnOrBefore`は公式休場日だけを最大14日遡る。通常の`qualifyHoldingValuation`から共用し、当日期末バーが存在する従来出力は維持する。休場日の場合だけ`evaluationDate`/`sharesAsOf`/`priceAsOf`/`marketCalendar`を価格根拠へ付け、既存の基準日は採用価格日とする。原文の期末株数、取得価格の原値、取得時計、日足全バー、adjcloseは書き換えない。分割係数の再適用はない。

通常publisherは欠測理由欄にも参考評価時点・株数時点・採用市場日を表示する。既存の価格状態の説明とformula表示は「期末株数×採用終値」へ変更するため、通常`applyHoldingsSchema`による物理PRE保存付きスキーマ移行を先に行う必要がある。列IDや数値の変更を意図しない。旧schemaのまま価格公開しない。旧1911/208Aの原snapshot・journal・native保存bytesは不変で、回帰では明示した現行server schemaの技術投影を用いた。旧schemaをそのまま渡す負例はmutation0で停止する。これを新しい実native受入と呼ばない。

## 同一保存入力での実測

通常価格queueの有限全読取は218書類（217再開待ち/2822行、208Aの1要確認/4行）、価格unknown0。最初の2502/S100YVTZ、期末2025-12-31、10行を通常read-only資格関数で照合した。ZIP・提出者一覧・価格5物理原本とactive registryを全SHAへ束縛した同入力の純比較は旧qualified0/10から新qualified3/10。

| 投資先 | 原株数 | 採用終値（2025-12-30） | 参考保有時価（円） |
| --- | ---: | ---: | ---: |
| 4502 武田薬品工業 | 100 | 4835 | 483500 |
| 4523 エーザイ | 100 | 4660 | 466000 |
| 2809 キユーピー | 100 | 4326 | 432600 |

全3行の評価時点と株数時点は2025-12-31。残7行は分割の法的日/株数単位未資格3、active registryに保存価格なし2、原表の注記付き会社名が公式名に未一致2でHOLD。初回0件を誤値・完了と扱わない。全217書類の候補数や現在の市場価格をこの10行から外挿しない。

保存証跡は`tmp/feature-audit-20261018/holdings-rights-needed-current-v1/`の`jpx-yearend-source-v1/SUCCESS.json`、`price-queue-readonly-v1.private.json`、`price-first-source-preflight-v1/`、`price-first-source-paired-v1.private.json`。これらはprivateで、原文全体や署名URLをGitへ含めない。実2502全文回帰はローカルprivate原本がある場合のみ実行し、CIではskipする。CIは営業日欠測/必要session欠測/未収録年/不正日付・旧schema停止のprotocol回帰を実行する。5suite160件PASS、型・lintを別確認する。

初回純検証時点では業務schema変更・価格列publishは0。Yahoo Chartの全OHLCV basis、法的効力日/市場権利落日/株式class、増資・消却・行使、旧保存の再資格を完了とはしない。

10/18の通常スキーマ移行は完了した。同main c747の通常`apply-schema`を使い、物理PRE・全定義CAS・1PATCH・全定義読戻し・物理POSTを113.04秒で閉じた。34プロパティの全ID/typeと、価格状態formula/description以外の全定義が不変。Notion19要求・hosted全文読戻し2・429/retry0、保有行の変更0。PREは`3fdd74ff-84cd-8123-b44a-dfb23f66e13a`、POSTは`3fdd74ff-84cd-815f-ad91-e1bba30fab31`。private closed receipt SHAは`254ba4e34ca343fa3a02a7b646243dceb6c47e0d7fbb8e655ce9deeb2d9730fa`。価格queueの実反映と全POSTは引き続き別受入。

## 2025年の週末決算日

[JPX「売買立会時間の変遷・半休日／休業日の変遷」](https://www.jpx.co.jp/equities/trading/domestic/tvdivq0000006blj-att/tradinghours_jp.pdf)は、1989-02-01以降の土日休業と2009-12-30以降の継続を明記している。2026-10-18T03:21:41.637Zに取得した1ページPDF（246,153 bytes、SHA256 `f6d90126fcbc85407d464044e434e79780f43d71ee3eb05d1b9e0699421ef006`）を通常一次保管ページ`3fdd74ff-84cd-81a6-ad11-fcdc4eaa4608`へ物理保存し、全文読戻しと表の目視を確認した。初回は環境指定漏れでNotion送信前に停止したため、その記録を保持し、原期限内に取得済み同一PDFの保管だけを続けた。再取得0、保管はNotion8要求・hosted読戻し1・再試行0・62.604秒。closed receipt SHAは`bbfd75fa90ac0ab165ada68168c7cd0b669d06e749f1cc3e8fbb0da05f2d16b9`。

共有資格関数は2025年の土日期末に限り、同じ検証済み価格原本に直前金曜の正の有効バーがある場合だけ、その金曜を採用する。金曜の欠測・祝日からさらに遡らず、年始1〜3日・平日の休日・他の未収録年は対象外。既存年末記録を優先し、2026/2027年と引数なしの既存callerは変更しない。株数・価格の時点分離、主体・英字名・通貨・全分割単位のguardは保持する。2025年全休日を確認した扱いにはしない。

同じ保存217文書・2,822行・価格113chunk（169,195,325 bytes）の純比較で、旧947行の全資格・価格・値・proofが同一、全原表factsと順序が同一だった。2025-08-31／11-30／12-20の16行だけ結果が変わり、8行が追加資格、8行は既存の分割／単位保留を明記する理由へ進んだ。全体は資格955・未資格1,840・英字名不一致27。9.922秒、HTTP・モデル・業務書込0。これは旧active registry `37202207552.1`の保存入力での見込みであり、最新registryでの実公開件数ではない。Nix5suite141件、全体型検査・対象lint・diff検査PASS、別agentの読取レビューでblocking0。private manifestは`weekend2025-review-ready-v1.json`、SHA `d834633c09cf237118012c5f8a57ddb042d10151601dc5cf4416594c2016be45`。
