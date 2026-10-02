# 新規初回事業タグのSemIf切替・実データ評価（2026-10-03）

今後の新規銘柄の初回事業タグをローカルSemIfへ切り替える。公式上場日・現世代・active・初回未完の資格と本文候補が揃った項目だけ、常駐モデルを遅延起動する。開始日 `BIZTAG_NEW_LISTING_FROM=2026-10-03` の資格は維持する。既存の保存済みタグと根拠は銘柄コードで再利用し、未設定・失敗だけをkeywords/excludesで補完する。有報・語彙更新による既存再判定、TypeSafeへの切替、有料API、語彙審査・競合判定の定時再開は行わない。

## 実装境界

- `calibration.semif.json` を新規事業タグ専用に用意し、旧Jevと競合他社の較正値を流用しない。
- `run` はMac/Nix・承認済みclean main・同じ `.env` 実体のkernel排他を通る。Linux catchup/backfillのタグ処理は取得前に停止する（先行PR276）。main取り込み後のMac LaunchAgent登録・真正実行・保持確認は下記の実受入で確認した。
- 1runに1residentを使い、正常・例外終了ともcloseする。起動応答のモデル・revision・backend・入力上限・SemIfソース・MLX版・MLX-LMソースpinが違う場合は入力送信前にSTOP。timeout後は同じrunで再起動しない。
- 資格なし、保存済みタグの再利用、機械補完、dry-runの新規初回はモデル起動0。新規初回の失敗だけ専用履歴による既存の上限付き再試行を使い、旧課金エラーをSemIf初回へ分類し直さない。
- ローカル計算費用とトークン数の合計は未計測。互換形式のJevカウンター0を実測費用とは呼ばず、`judge.costMetering=not_metered_local`、費用・トークン数null、外部判定API0を別記する。

## 本文と評価範囲

既存の実ゴールデンセットv1（87社・858ラベル）と既存語彙v1を使った。D1索引1SELECTでexact87を固定し、既存Notion本文を読取った。計Notion237（本文232＋診断5）・既存添付hosted2・D1読取1＝240 native読取。旧レスポンスを再利用し、既取得URLの再GET、Yahoo/EDINETの新規取得、保存結果の書込は0。

85通は保存本文の全節・正規codepoint文字数とメタデータが一致した。残る2通は保存本文のサステナビリティ節にU+200Bの欠落1文字・3文字があり、実CSV添付を回収し全ZIP CRC・全34節を照合した。両方とも判定入力の4節は保存本文と実CSVが完全一致した。評価では実CSV全節を `SOURCE_RECOVERED` と明示して使い、本文の補作・長さの許容・評価対象の削減は0。**保存Notionの全87通一致ではない。欠落2通は未修復HOLD、旧manifest・本文SHA・取得時計の来歴はUNKNOWNを維持する。**

本文map SHA256: `0e6ed4a866773c0a64de66f8e0a78e71e3cf1ec559147c56ea6548043b6c422b`。本文・法人の財務値・Notion私有URL・認証情報・モデル入力は公開Gitへ保存しない。新たなAPI原レスポンスとモデル測定の一次保管は下記の実受入で閉鎖した。

## 一次測定原本の物理保管

2026-10-02 17:23:35.225〜17:23:46.896 UTC（JST 10/3）に、既存 `recordPrimaryData(force:false)` と `verifyArchivedAttachments` で1添付を保管・全文再取得照合した。実APIのrequest/response原bytes・取得時計・本文資格・モデルinput/output/実測を、全1218members・151320170原bytesのlossless tar.gzへ格納。添付は29708183bytes、SHA256 `b924b7c97556af9b216ed13cb90fb68a2ffeced907ee0963d21411e8bdb541ad`。全memberの元bytes/SHA roundtripとhosted添付全bytes/SHAが一致した。組立時計は原取得時計へ代用せず、旧UNKNOWNと欠落2通HOLDを維持する。

初回は検索/queryの2読取後、空GET bodyの私有guard検証で通信前に停止（upload/page POST0・結果不明mutation0）。最小修正を別phaseで受け入れ、実11Notion＋hosted1で成功した。計13Notion＋hosted1＝14 native。OFFLINE検証のmock通信は含めず、本文取得240 nativeとの合計は254。推論・tar・市場原本の再取得/再作成、D1/R2・本番タグwriteは0。rootは実12HTTPの原response全bytes/SHAを独立照合した。実receipt SHA256: `0ecb869a224b0d8c44dc9341604ec6995aca32b504a77ae628df11b4330a85c4`。

## 実SemIf推論

Apple Silicon/MLX、既存キャッシュのみ（HF/Transformers offline）。Qwen/Qwen3.5-4B revision `851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a`、SemIf `23cf1f39fc9534fe81437200959b6dfc7106e45a`、MLX0.32.2、MLX-LM `a63e24c389382619eb6d9af656e3b46024be217a`、非量子化、入力上限16000、batch20。追加インストール・モデルdownload0。

最初の66社を1resident/73callsで測定し、その後の87通datasetから同じstate/questionsを生成して全input SHA・actual output・全ラベル結果をPURE照合し再利用した。残る21社は別residentで21callsを実行。研究計測は2resident phase合計94calls・全候補881問・183180ms（各phaseの経過時間の和）。全858期待ラベルに欠落なく対応し、外部判定API・本番タグwriteは0。既存質問文・抜粋・フィルタ・語彙は変更しない。

評価全文SHA256: `5e7b174bee4c116b888c5830d27b5b447e3fb02498c853fc76bc80f050bb251b`。

## 閾値と測定限界

| yesMin | 「はい」精度 | 再現率 | mustHit再現率 | はい件数 |
| --- | ---: | ---: | ---: | ---: |
| 0.50 | 0.8159 | 0.7956 | 0.9524 | 353 |
| 0.80 | 0.8939 | 0.6519 | 0.8095 | 264 |
| **0.85** | **0.9157** | **0.6298** | **0.7619** | **249** |
| 0.90 | 0.9355 | 0.5608 | 0.7619 | 217 |
| 0.95 | 0.9675 | 0.4116 | 0.6190 | 154 |

採用値はyesMin0.85/noMax0.20。0.80〜0.83は精度0.9未満、0.84〜0.85は同じ249件だったため、0.85で精度と再現率を折衷する。noMax0.20では「いいえ」正解347/381（0.9108）、正例の断定的除外34。0.25では同376/417（0.9017）・除外41となるため、追加7件を要確認として残す。

この閾値で858ラベルは、はい249・要確認227・いいえ381・候補なし1。TP228/FP21/TN475/FN134、mustHit16/21、mustNot誤検出0、filterMiss0。FNは要確認も含む二値の「はい」取りこぼしであり、134件を断定的な「いいえ」とは扱わない。旧Jevの測定（精度0.962/再現率0.760/mustHit0.905）と同等ではない。現在停止中の語彙変更ゲートの同版非劣化条件を、新モデル採用と混同しない。

SemIfの値は提示したyes/noオプション間の条件付きsoftmaxで、較正済み信頼度ではない。上記はこの実ゴールデンセットでの測定であり、新規銘柄すべてに同じ精度を保証しない。要確認を自動的な「はい」や別モデルで埋めない。

公式根拠（2026-10-03読取）: [SemIf公式repo](https://github.com/TheoLeeCJ/SemIf-OpenJev)、[固定ソースのMLX運用・モデルpin](https://github.com/TheoLeeCJ/SemIf-OpenJev/blob/23cf1f39fc9534fe81437200959b6dfc7106e45a/docs/MLX.md)。旧URL `TheoLeeCJ/SemIf` は同repoへredirectする。

## 検証状況

専用較正の回帰を含む関連7suites150/150 PASS、typecheck/変更TS17files ESLint（0error/0warning）/Python compile PASS。Wrangler4.101.0 `deploy --dry-run` PASS、1734.42KiB/gzip365.72KiB/15assets、upload0。独立コードレビューはlazy起動・保存結果保持・provider pin・timeout/close・Mac共通writer境界でblocking0。rootと独立レビューで全858ラベルの集計・専用較正・本文85＋2の区分を照合した。

[PR278](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/278) の最終head `78452cc5e1a6b470ab32b1b9570dcb94f67b301c` は3CI SUCCESS、17:07:30 UTCにsquash merge（main `f115f0658b04afe5d45649cae0c682d1aa7b4d78`）。CFの自動反映はversion `17f427ee` が100% activeとroot認証済み確認。

## Mac定時処理の実受入

専用のclean main worktree・同じ実体の0600 `.env`・Nix環境で厳密preflightを確認した。
補修後のPREでは全補足3712行、現役3689銘柄を読み、判定済み3618行
（現役3595＋対象外23）のタグ・AI根拠・マスタrelationを含む所管24列と
実更新時刻を保存した。正準planの作業は機械補完4件、新規初回SemIf0件、
保留90件。保留を完了へ置き換えていない。

初回は所管外の競合relationの部分返却を検出しSchema1/query1でSTOP。
原応答を再GETせず完全replayし、続きのquery37＋D1SELECT4で所管列を全件確認した。
所管外の39本文列・競合relation論理全文の全件確認は行っていない。
最後の件数検査は「現役3595」を全DB件数へ当てたためHOLDとなり、
保存済みrawだけで3595＋23と分類して独立受入した。追加のreadやwriteは0。

PREの一次保管は2026-10-02T18:13:18.593Zに全文readbackまで完了。
154members・100623598原bytesのlossless gzip12563117bytes、SHA256
`5967e27b2485ec17b989f80f2132140e504ed5b77eec16522eff623833f22042`。
実Notion8＋添付GET1、secret混入0、タグ/D1/R2write0。
原受信clockを組立clockで代用せず、最初の全rawも保持した。

GH queued/in_progressの固定metadata GET2で双方0を確認し、kernel排他が空いている
ことと既存登録なしを確認後、daily20:00 JST・RunAtLoadの実LaunchAgentを作成した。
実plist1072bytes、SHA256
`672970d4d994548f5e2941e1c77514cd601fff864c0fded9c9b461bc9815f7c0`。
18:20:40.512Zにbootstrap1回で真正PIDを確認したが、18:24:47.671Zの読取では
not running/last exit1。Nix devShellは開始できたものの、最初のHEAD検証で
`git rev-parse HEAD`が`tool 'git' not found`となり、wrapper receipt・CLI・
kernel writer開始前に終了した。タグ本番write・モデル起動は0。

project NixへGitを追加した[PR279](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/279)は3CIすべて成功。
main `ecf9fd8d45ae273e3111dbbde91245934d23554f` に取り込み、専用runtimeをclean ffした。
GUI相当の最小環境でNix Git 2.51.2の実体と厳密preflight成功を確認した。
失敗済み登録だけをbootout1回で解除し、旧plistを完全退避して同じ正規入口でinstall1回。
fresh GH queued/in_progress GET2は双方0、kernel空き・新plist全文SHA一致を確認した。

新しい承認範囲のbootstrap1回は18:55:26Zに真正PIDを返し、CLIは18:55:27.195Zから
18:56:56.334Zまで実行してexit0。処理3689件は既存再利用3685＋機械補完4、
判定済み現役3599／本文なし保留90、失敗0・残作業0。SemIf呼出0／外部AI呼出0、
実Notion109件／429制限0／内部再試行0。wrapper再run0、CLI writerのPID/start identityと
終端後のkernel解放・登録not-running/last exit0を確認した。20:00 JSTの次の予定実行は未来。

19:01:12.449ZのPOST全文readbackで、旧判定済み3618行の所管24列（タグ・AI根拠・
マスタrelation）を厳密一致で保持し、他3708行の更新時刻も不変、更新は対象4行だけだった。
対象4行は復旧済み146節・211178 code pointsを正準39本文列へ機械射影した値と全文一致し、
機械照合入力・最新doc参照・キーワード根拠8 childrenの全文も確認した。
次の正準planは3689全件skip、初回SemIf0、本文なし保留90を維持。
実Notion48（schema1/query38/対象4query1/evidence8）＋D1SELECT4、再試行・新source・
モデル・追加data write・dispatchは0。所管外の競合relation論理全文を取得済みとは主張しない。

実運用・POST・修正後Cloudflare配信確認の239ファイル（70387565原bytes）は
19:09:17.354Zに物理保管と全文readbackまで完了。lossless gzip8172965bytes、SHA256
`43ad491e35edc9886cd6e4b8aed995c0d964702af2e8ee87cb5b3e367f9d7d0c`。
実Notion8＋添付GET1、Metadata/manifest/全文SHA一致、新source・タグ/D1/R2write・retry0。
正常runの元全文・POSTの独立照合記録・PRE物理保管証跡を保持した。
保存済み9応答の全status200・request/response SHA・Metadata/manifest・添付全bytesと
tar全239membersを、追加通信0で独立照合した（証跡SHA256
`21b141925b2203eadab5b1de4fc74044833ff1378970eca6a3c5c750fade1393`）。
追加kickstart・手動run・未知結果の再入は0。
通常jobの外部source GETの実回数は未instrumentであり、code policyと実観測を分ける。
ローカル計算費用・トークン数は未計測で、互換カウンター0を実測した総費用と扱わない。

## 本文2通の後続修復結果

較正時にSOURCE_RECOVEREDと区別した2通は、[後続の保存実験](yuho-text2-roundtrip-hold-20261003.md)で
第一1通のU+200B1文字消失が実応答でも再現し、旧行復旧・新行退避を確認してHOLDを維持した。
第二は未送信、参照・索引・銘柄タグは変更0。公式資格・元CSV・現行PREと復元POSTの物理保管は
完了しているが、保存本文の全文一致は未達。較正時の85 saved whole / 2 source-recoveredと
原CSV取得時計UNKNOWNを後から書き換えず、全文保存を確認できる方法の実証を待つ。
