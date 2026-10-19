# 決定的な処理を優先する本番運用

更新: 2026-10-18。取得・抽出・計算・照合・保存・検証を通常のCLI/共有関数で実装する。入力が同じなら同じ結果となる処理を優先し、未取得・主体不明・原本にない値は生成しない。LLMは意味判断が必要な残件へ限定する。

[10/17 16:00の全20機能の状況](test-logs/recovery-functional-status-20261017.md)に、本文950社・保有1,667行・受注40文書・VWAP1,399銘柄の別照合と、RAWの通常索引再開、優待READ停止、通常定時との通信枠の切替えを記録した。全量・価格/権利・実認証API・次定時の未受入は維持する。

[19:35の追加記録](test-logs/recovery-functional-status-20261017.md#1935-jstの追加受入と通常macへの配備)では、VWAP固定suffix1,854/1,856、保有原本列2,826行/218文書、受注固定112文書、海外140/166文書を別受入した。Mac通常版`4a66929c`の初回RunAtLoadはlocal/R2終了receiptまで確認したが、scheduledForは前日であり、当日の20/21時calendarは未受入。保存Clef104社との公開identity照合は37社、残67社は現在入力の再資格化待ちで、全20機能の完了時刻は未確定である。RAWの通常inspectはcursor20,411/残58,421、hosted独立枠の単発pilot69は速度改善未受入。全体受入件数とcursor、Worker最新版と凍結Mac版、原典HOLDと未実装ロジックを分けて追跡する。

[21:52の追加記録](test-logs/recovery-functional-status-20261017.md#2152-jstの追加受入と実行先の区別)で、実21時の通常終了、208Aの限定4行訂正、通常ツールでの本文50社・全39項目・物理PRE/POST・永続completionを追加受入した。本文50社はモデル0・618.965秒、D1実読取106,874行/書込0行。旧原値・未知結果・期限を保持し、独立物理1,500社と別の通常completion258社の暫定union1,758/2,417を区別する。

本体Cloudflare、独立JSS private、Macは別の配備先として確認する。#503のv4は本体と独立APIへ反映したが、1899の実1行移行とMac最新版はまだ未受入。#504のJPX保存コードも実設定・原本受入・権利の金融資格と分ける。RAW全量チェーンの停止と必要原本への範囲変更は[以下](#必要なraw原本だけの確認)を参照。旧見込み4〜5日は任意の全量ミラーを続ける場合の値で、全20機能の完了日ではない。

## 実行先と現在の例外

JPX配当落・権利落等の短期掲載原本は、既存18時 `scheduled-stocks` の金融主要write・完了記録後の通常共有collectorでindex1＋最大5 XLSを共通Notion archiveへ物理保持する。公開 `JPX_EX_RIGHTS_URL` を型付き設定から必須参照し、未設定・欠測・保管不明は独立した `officialRightsCustody` 診断に残す。Yahooの価格資格・既存guardは代用せず、権利の法的日付・比率・普通株・金融適用も確定しない。[実原本・費用・未受入](test-logs/jpx-ex-rights-custody-20261017.md)を参照。本番URL設定/実取得/物理受入は別途で、capture実装を全権利対応とは数えない。

| 処理 | 決定的な処理 | 実行先と制約 |
|---|---|---|
| 株価・需給・VWAP・資金フロー | 取得、原本資格、計算、保存、coverage検査 | Cloudflareで起動・監視、ActionsのNode/Pythonで実行。429・原本欠損・期限超過は未完として止める |
| 有報・適時開示・海外売上・保有株式 | ZIP/XBRL/PDF抽出、コード/期末/主体の照合、数値検査 | 主にActions。照合が一意でない原本は保留。画像のみのPDFなど、現行抽出器が読めない原本の全面対応は未完 |
| 原本保管・索引・復旧 | 原本全SHA、冪等キー、変更前後の保管・読戻し、集合照合 | 通常は共有ライブラリ/Actions。今回の有限復旧には個別の範囲・期限・結果不明記録があり、通常定時の成功とは分ける |
| 事業タグ | 原文抽出、入力差分、既存タグ再利用、keywords/excludesによる補足、結果検証 | 新規初回・実入力変更の意味判断だけCloudflare/clef-flashをMacのMPSで実行。毎日20時、詳細は[Mac運用](005-biztag-local-runtime.md) |
| 優待 | 受取条件DTO、企業提示の一意な1回分額面、今回追加する単純な額面優待の定型文 | 毎日21時のMac通常要約ハーネス。定型対象だけならPython/モデルを起動せず、未対応文章だけ固定Qwen/MLXへ渡す |
| 競合企業 | 候補の抽出・絞込み、保存出力の検証 | 最終的な意味判断は残る。定期のモデル判定は停止中。候補抽出完了を判定完了とは扱わない |
| 画面・API/MCP・監視 | 保存結果の検索・表示・鮮度/契約検査 | Cloudflare Workers。モデル推論は行わない |

ツール化とWorkers単独での実行は同義ではない。Workersの[Node API対応範囲](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)や[実行制限](https://developers.cloudflare.com/workers/platform/limits/)を踏まえ、Node/Python・大きなファイル・長時間処理はActionsへ置く。Mac専用のMPS/MLXをWorkersや通常Linux runnerで実行できるとは扱わない。

## EDINETの書類情報修正

通常`ingest:yuho-edinet`のpending再確認は、情報修正イベント（`docInfoEditStatus=1`）を対象有報だけで機械再資格化する。[EDINET API仕様書V2 §3-1-6](https://disclosure2dl.edinet-fsa.go.jp/guide/static/disclosure/download/ESE140206.pdf)では、修正は書類に付随するmetadataに対するもので、書類取得APIのファイルは前後で同一である。元提出日一覧の`=2`行には修正前metadataが残る。取下げ・不開示解除や訂正有報の親関係をこの経路で自動適用しない。

同じdoc/issuer/銘柄/FY・独立有報120・修正前後の同形式と業務metadataを必須とする。元日付の物理snapshotを再利用し、不足時だけ共有`captureListSnapshot`で固定元日付の一覧を取得・物理保管する。その一覧に含まれる他銘柄の変更観測・取込・投影は実行しない。Notionの既存type5を読み、通常CSV判定で受注/海外語がある場合だけ既存type1も要求する。両方なければ`no_order_table`/`no_overseas_table`・全facts0の一致を条件とし、CSVと全文だけで資格化できる。manifestがあれば長さ/SHAと自己整合を照合し、旧manifest不明はproofにも不明のまま残す。通常parser/serializerで再解析して既存受注/海外全facts・本文全索引・所属と7プロパティを含む全文readbackが完全一致した場合だけ、0034の`yuho_edinet_reported_resolutions`へ完了証拠を追記する。金融値や本文のwriterバイパス・上書き・LLMは追加しない。不一致や必要原本不足はHOLDとする。

作業中は共通のHOLDを維持し、既存catchupのinFlight/CASと60通・300秒の開始予算を使う。観測/issuer逆引き/株式/doc/facts/本文索引を同一D1 batchで照合してから、原観測PK/原本SHA/原観測JSON・seqを除くmetadata SHA・完了pinsを保存する。旧観測は変更しない。新たに同じイベントを観測した場合は既存完了のD1・保存ZIP SHA・全文を照合して解決行だけを追加し、同入力を再解析しない。完了送信や読戻しが不明ならinFlightを残して停止し、次回定期が盲目的に再送しない。旧海外/本文backfillにも共有前読取と同batchの保留guardを適用する。

0034は追加一表・一索引のみで、Workerの共通読取predicateも参照するため、通常の物理PRE/POSTとcatalog確認を伴う本番DDLの受入後にコードを配備する。Node/Actions/SSHはNixと同一lockで、Workerは既存bindingで同じ共有判定を使う。コード試験と、本番metadata取得・対象3776の解決は別の受入である。

## 株式日次の業種集計

通常Node入口`sync:daily:core`のPhase 5は、当日行の置換と30日より古い行の掃除を既存`createD1HttpBatchSender`の単一batchで送る。先に全SQL/束縛値を組み立て、1000文/各100bindを検査してから既存期限guardを一度通す。16行チャンク・集計値・順位・90%coverageによる無送信を維持する。結果不明はthrowして止まり、個別文や同じbatchを再送しない。

書込はNodeのD1 HTTP経路で、Workerは同じ保存表をbindingで読む。Worker書込adapterや新DDLは追加しない。公開画面は`macro.date`をキーに読むので、当日置換の途中状態がその日付で表示される問題を閉じる。[SQL protocol回帰と実受入の境界](test-logs/sector-daily-atomic-20261018.md)を参照。実D1の新再測定・本番定時の受入は未実施。

## RAW原本の有限継続

`raw_index_backfill.yml`の`execution_revision`は実行する完全40桁commit SHAを指定する。初回の空欄だけそのrunの`github.sha`を採用し、checkout前の形式検査とcheckout後のHEAD一致を依存準備・データ処理より先に行う。通常continuationは実HEADと明示入力の一致を確認し、同SHAを次dispatchへ渡す。これによりrawコード・依存lock・Nix定義を同じcommitから使う。

GitHubの[workflow dispatch仕様](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)が保証するrefはbranch/tagなので、dispatchは従来の`main`を使い、[checkoutのSHA指定](https://github.com/actions/checkout/tree/v4#usage)で実行ソースを固定する。次runのworkflow YAMLやGitHub action自体、runner OS、Secretsはcommit固定の対象ではない。workflowが互換性を壊して変更される場合は別途止めて再受入する。

固定manifest・元run pool・残run数・原本CAS/state・unknown停止・一度だけのdispatchは従来のまま。revision指定だけで別poolや古いunknownを回避できず、コード修正の受入を原本全量・最終anti-joinの完了と数えない。

## RAW転送・最終照合のSSH移行計画（2026-10-18）

**同日方針変更:** 全20機能の復旧に、Notion歴史原本78,832件の全量R2コピー・独立全量再GET・SSHへの実行主体変更は要求しない。元機能監査の「必要な歴史範囲から補う」に戻す。旧yfinance日足バッチCSVは[既設計](CF-CANONICAL-DESIGN.md#36-⑤原本のうち-r2-に置かないもの)でCF対象外であり、歴史財務のNotion原本参照を一律にR2欠測へ読み替えない。

専用手動workflow `raw_index_backfill.yml` は将来入場を無効化（HTTP204、`disabled_manually`を確認）。進行中run39083102703はcancelせず自然終端を待つ。原本・既copy・manifest・cursor・旧unknownは保持し、停止を全量完了とは表示しない。[判断・停止記録](https://github.com/satoki252595/kabulab_tool_cloudflare/issues/515#issuecomment-6243841500)。以下は変更前の移行準備記録であり、全量作業の続行指示ではない。

### 必要なRAW原本だけの確認

`raw:required` は本番が原本実体を読む最新JSF shinaだけを確認する。Notionでソース/種別/対象を先に絞り、取得日時降順の最大2件から最新を一意に選ぶ。D1でも本番`shinaLatest`と同じ最新選択を確認し、同SHAの索引とR2全文SHA/サイズを既validator、CSVを本番parserで検証する。最新候補の食違いはHOLDとし、別原本をコピーして埋めない。

```sh
nix develop --offline --command pnpm raw:required \
  --out=tmp/raw-required-new.jsonl --max-seconds=120
```

Node/Nix・依存lock・型付き`.env`はActions/SSHでも同じものを使う。Notionの全履歴棚卸し、原本の再取得、R2/D1/Notionへの書込、control/state/poolの更新、LLM起動はしない。出力は新規0600ファイルへ保存し、欠測や不一致を成功扱いにしない。APIで追加提供する原本や個別補完に必要な原本は、その明示対象に限って別に処理する。本確認の成功を、他APIや全20機能の完了へ広げない。

### 変更前の準備観測

ユーザー方針として、原本転送と独立した最終照合をSSH先PCの最新受入mainで実行し、照合にLLMを使わない。
以下は10/18 08:22 JST記録の[移行準備観測](../tmp/feature-audit-20261018/raw-ssh-migration-preflight-v1/remote-observation-v1.json)（SHA256 `4cfeed9012c198b0814585ca4b684c055011bdabadb031e25348d11f1ef1e3ec`）に基づく。完了tool出力の構造化記録でSSH native全文ではなく、本番転送・最終照合は未実施。

SSH alias `nipogi` はUbuntu 24.04.2 / x86_64、空き859.9GiB。GitHub mainの読取と `/home/sora/projects/kabulab-cf` の `55ab6d06` clone・cleanを確認した。
Nix / pnpm / gh / tmuxは未導入、`.env`なし、SSH agent forwardingと資格情報移送は0。
`sudo -n`は利用できず、Nix導入は管理者操作か正式なrootless運用を別途選ぶ。直接のglobal installへ切り替えない。
user systemdはlinger=yes / degradedで、常駐・再起動・切断後継続の正常性は未受入。cloneだけで依存・運用準備完了とはしない。

RAW78継続中のためSSH writerは0。全owned actorの自然終端、新dispatchの入場停止、同じR2 manifest / cutoff / cursor / inflightのfresh照合後だけ移行する。
GitHub workflowの排他はSSH processへ及ばない。同planの並行実行も許可せず、単一writerへ引き継ぐ。
新dispatch停止の候補は通常の[workflow disable/enable](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows)（2026-10-18確認）で、まだ実施していない。
実行中actorはcancelせず自然終端を待ち、step9の後続dispatch失敗とbusiness処理の成否を分ける。
元200回pool・origin・75/76を含む既消費を引き継ぎ、移行でresetしない。RAW推移依存10ファイルは`55ab6d06`と既存実行版`85261e3d`で同bytesを確認済み。

既存 `raw-index-backfill.ts` は固定manifestのSHA/page一意・件数を検査し、各原本の全body SHA256・サイズと15列索引を照合してcursorを進める。
既存の取得履歴・旧NULL/未検証doc_idは保持し、添付が一意でない場合や本文不一致を推測で埋めない。SHA原本の転送完了と文書identity結合完了は別にする。
最後のanti-joinはmanifest全SHAの登録漏れと9列metadataを再確認する。各転送時点の全body/15列検証の積上げであり、全原本を最後にfresh再GETした証明ではない。
`raw-object-check.ts` は1件・最大1MiB、`raw-index-plan.ts` はローカル標本1〜100件だけで、全量独立監査の代用にはしない。
全固定原本のfresh R2全SHA・サイズ＋D1全15列＋集合照合を行うstandalone read-only audit CLIは未実装。既存manifest解析・validatorを再利用する小CLIで閉じる方針で、新LLM・別business parserは不要。
RAW74は残64.382秒で次hosted GETを拒否した停止で、署名URL失効やprovider失敗とは認定しない。callback件数から完了prefixや旧ACKを再構築しない。
旧raw/index inflight unknownは別に保持し、fresh inspectだけで解除・再送しない。[停止境界](test-logs/raw-read-budget-partial-20261018.md)と[固定集合の契約](test-logs/raw-index-recovery-plan-20261014.md)を継承する。

実行hostを変えてもAPI接続/workspace共有枠・R2/D1操作数・保存量・料金は消えない。[Notion request limits](https://developers.notion.com/reference/request-limits)（2026-10-18確認）と既存共有予約を守る。
SSH移行による短縮幅は未実測。現行Mac/env、凍結本文observer、RAW実行sourceは変更せず、資格情報・実転送・全量監査は別の受入とする。

## 保有株式の保存原本バックフィル

`yuho:backfill:holdings prepare <1..50> <afterCode|START> <privateDir> [valuation.json]` は最新有報の保存type1を原本照合し、株数・単位・当期・提出会社を共有parserで検査する。価格原本を指定しない準備と公開は原本列だけの段階で、価格を新たに確定しない。既存の照合済み価格も消さない。

`yuho:backfill:holdings apply <privateDir> <maxRows1..1000>` は通常定期取込と同じpublisherを使う。文書ごとに最大100行のwindowを進め、書込前に最新文書ID・発行体・期末・提出会社名を照合する。残windowは定期処理と共通の保存cursorから再開する。既知の資格HOLDはreceiptへ固定し、自動で再送しない。通信や書込の結果不明はpending journalを残し、別通の送信と自動再実行を止める。旧未検証行は共有publisherの物理PRE/POSTと全props照合を通す。

共通publisherは再開前に既完prefixの原本列を既存の期末一覧で照合し、最後のwindow後は全原表をもう一度検索してから完了と価格queueを登録する。prefixのdriftは元cursorのHOLD、最終照合の失敗はunknownを保持する。CLIの文書別latest照合はwindow内を銘柄コードで絞り、外側も既存のcode索引を使う。100行の実適用とD1読取コストの比較は[検証記録](test-logs/holdings-source-verification-20261016.md)を参照。

ローカルは `nix develop -c pnpm yuho:backfill:holdings ...`。同じNode CLIをActionsでも実行でき、追加依存はない。有限の過去補完を定時の全量成功とは数えず、原本確定件数・保留・残window・価格確定を分けて受け入れる。

## 事業タグの機械処理だけを実行する

通常CLIの`pnpm biztag run --mechanical-only --codes=<対象コード列> --limit=<件数> --budget-min=<分>`は、本番定期と同じ計画・本文同期・キーワード照合・共有publisherを使う。新規初回や実入力変更による再判定は明示HOLDとし、モデルの起動・原応答journal・較正の読込へ進めない。機械照合不能を別モデルで補わない。

通常Macの既存行publisherはcanonical `.env` と同じwriter stateへfull PRE・intent・完了receiptをimmutableに保存する。全POSTと旧根拠退役の確認前に止まった処理は、次runが別PRE/別文書でもmetadata・モデル・HTTPより前に停止する。NodeだけがFS sinkを供給し、共有publisherにNode FS依存と追加API要求を入れない。既存NotionのPRE原本保管を維持する。初回createと語彙版だけのupdateも#464で同じjournal/共有publisherへ接続したが、進行中処理のMac runtimeはe4cを保持し、この追加経路のMac配備は終端後に別途受け入れる。[既存行](test-logs/biztag-sticky-publication-20261017.md)と[追加経路](test-logs/biztag-create-publication-20261017.md)の検証を分ける。

同じ文書の保存本文pointer更新は、共通processorで既知4節の実SHAを先に比較する。同値なら旧判定receiptを変えず、通常publisherで本文だけ同期する。実差はprocessorのprefilter・較正・journal・モデルより前に機械modeの資格HOLDとなる。通常CLI全体の既存metadata/語彙/schema読取が0になるという意味ではない。未知・壊れた旧入力を同値へ昇格しない。

旧タグ・根拠・判定日・未知の旧入力SHAを保持し、書込前の最新文書照合・物理PRE・単発更新・全property読戻しを通常経路で行う。初回判定や再判定のHOLDは`qualificationHeld`と専用件数へ残し、`remaining=0`だけで全件完了と判断しない。既定の20時処理は従来どおり、必要な対象だけローカルClefを使う。依存・上流取得・毎日の実行回数は追加しない。ローカルは同じlockのNix環境で実行し、main反映とMac専用runtimeへの配備は別に確認する。

## 競合入力の機械準備

`pnpm biztag competitors --prepare-only --judge=semif --codes=<固定コード列> --limit=<件数> --budget-min=<分> --out=<private-dir>`
は同じ唯一writerで、最新doc/現在タグ/実39本文・同期receiptを照合し、既存の候補・質問・全文SHAを
共有一次保管へ1gzipで保存する。モデル・TypeSafe認証・競合書込・schema変更は0。候補Bの資格不足や
原文未完を除外/空競合に変えず、AをHOLDにする。旧入力不明のタグは未検証来歴を保持する。
`--dry-run`はモデルを呼ぶ既存仕様のため準備modeには使わない。

新規読取はqueue/ペーシング/再試行待機後にも期限を検査し、取得済み入力の物理保管/照合は別に閉じる。
固定2社の保存実入力でモデル0を検証したが、現在本番の全量入力・定時stageは未受入。
保存3689社corpusの条件計算では5社準備だけでも0.3rpsの読取間隔143.33秒＋候補計算21.07秒を要し、
5件/2分は採用しない。任意の固定scopeを指定した場合だけ、20時biztag正常終了後に最大5件の同じ通常CLIを
新規読取6分/child7分/最大0.3rpsで実行する。after-codeは同入力skipでも進み、末尾後は巡回する。
stage-level pendingをchild前に固定し、unknownは別入力へも再送しない。実物理ACK/本文SHA/対象/保留を
照合後だけcursorを進める。startup receiptを含む既存全体30分・20/21時calendar/readcheckを維持する。
stageは10/17 04:16:47 JSTのMac runtime `65579f60`へ配備し、固定33社scopeと同一canonical.env/kernel writer stateを保持した。通常CLIの手動最初5社は物理保管/通常helper ACK/cursorまで受入したが、選出Bの資格不足でready0/5 HOLD。候補と質問を削らず、意味判定・次20時のstage receiptは未受入である。実child193.76秒/CPU27.43秒/RSS約2.38GBと保存入力の再生範囲を[受入台帳](test-logs/recovery-acceptance-20261016.md)へ記録する。

## 優待の定型処理

通常入口は既存の`yutai:summary:local` / `run yutai-summary`。同じ`runLocalSummary`内で、全文が既知の優待種類と単一の円額面だけで構成される入力を`simple-face-value-v1`として処理する。表見出しに種類だけ、本文に額面だけがある形式も対象。金額は本文を既存`evaluateCompanyValue`で一意に認定したものだけを使う。

注記、未知の見出し、保有期間、抽選、申込、選択肢、複数商品・額面、未対応の表記を削って文法に合わせない。未対応分だけを別のprivate `model-tasks.jsonl`へ保存し、固定ローカルモデルへ渡す。定型分とモデル分の双方が同じ`planSummaryImport`、物理PRE、原子適用、全POST照合を通る。既存の有効要約を定型文に置き換える一括処理は行わない。

定型rule・対象IDと結果を保存し、モデルを起動しないbatchの来歴はmodel/revisionをnull、modelCalls/modelResidentsを0とする。定型処理を過去のモデル判定として記録しない。モデルを使うbatchは既存のpinと原応答を保持する。

この変更に追加の依存、取得元アクセス、有料モデルAPIはない。未対応分があるときのモデル常駐は従来どおり最大1個で、全体の速度改善は実運用で測る。ローカルの電力・時間を無料とは呼ばない。

## 配備と完了の判定

10/17実20時はMac `4a66929c`で20:00:05〜20:23:40 JSTに全親子が正常終端し、local/R2の全receiptを照合した。通常本文148・保存済み意味判定8、競合prepare5社HOLD・新規モデル推論0だった。同版の優待RunAtLoadと両rolloutの全bytesを受入後、監視の既存accepted-revision secretを1回更新した。実21時は別受入で、Workerの#496優待文法をMacへ配備したとは扱わない。[20:35の機能別記録](test-logs/recovery-functional-status-20261017.md#2035-jstの実20時受入と後続補完)を参照。

RAW69の500件は3,185.120秒・追加attempt0で完了し、元pool内の70＋successor最大130へ通常継続した。履歴全体の完了は78,832件の正常anti-joinまで別に確認する。固定本文の独立物理照合1,450と、通常258件のjournal・39列交差は区別し、既存完了を二重更新しない。



10/17 14:34:11 JSTのCloudflare配信はmain `e97ef37f`、version `8c18bd63-ae07-48a4-876c-49fe50c049e0`。#479〜#483の通常CLI/共有資格・限定復旧を反映し、優待の選択19行、保有原本列1,563行/101文書、海外100文書/601数値、本文868社、VWAP1,199銘柄、RAW位置18,412を[午後の受入台帳](test-logs/recovery-acceptance-20261016.md)へ記録した。JSS privateはstrict v1/v2/v3をversion `8b67723a`へ配備し、6bindings/runtime/実コード/healthを確認。Mac e4cと有限実行sourceの凍結、旧STOP/unknown・価格/権利HOLD、RAW57の停止、次20/21時の定時未受入は別に保持する。

10/17 09:03:56 JSTのCloudflare配信はmain `d456bc0f`、version `8c9232a1-816f-4f8d-a4a1-1c7225dba273`。投影のas_ofはcaptured runStartedSecへ束縛し、全文1点選択は共通の厳格parser/DTO/UIで構造化する。結果未確定の保有sourceは原記録を保持し、同じ提出会社・期末への迂回を拒否して他社の通常処理を続ける。隔離による追加Notion読取と通常300秒内の実所要時間は[検証記録](test-logs/holdings-unknown-source-isolation-20261017.md)で区別する。進行中の凍結runtimeを途中変更せず、残受注92文書は同じ通常CLIのfresh PRE→原子apply→別inspectで補完する。[09:13の受入台帳](test-logs/recovery-acceptance-20261016.md)の保存件数を、全20機能・次20/21時の定時完了と混同しない。

10/17にユーザーがWorkers Paid/D1有料枠の利用を確認した。[D1公式料金](https://developers.cloudflare.com/d1/platform/pricing/)（同日確認）の読取包含枠は月250億行、超過は百万行あたり$0.001。1.3億行は包含枠の0.52%で、他の利用を含む月間合計が枠内なら追加読取料はない。包含枠を使い切った仮定でもこの読取分は$0.13。書込・保存容量・Workers/R2等は別で、月間使用済み量は未確認。旧契約API403をPaid未確認のまま扱わず、既存の有限実行cap・索引利用・実rows_read記録は維持する。

10/17 07:32:04 JSTのCloudflare配信はmain `7d938e38`、version `30a5f745-0de7-4d77-9779-5c21e5716d76`。受注は通常ingest/missingと同じ保存変換を共有する保存原本CLIを追加した。保有の不該当も通常CLI/共有publisherへ接続した。Mac e4c・保有b8等の稼働中sourceは固定し、Worker配備をMac配備や残cohortの適用完了と混同しない。通信の結果不明は再送せず保存済みintent/全値との照合へ進める。

10/17 07:10:15 JSTのCloudflare mainは`faaf65ca`、version `752bb081-6088-4ccd-8774-745c73c3dea4`。#463/#466の明示的な分割前期末株数基準、#464のcreate/version journal、#465のYahoo報告日診断を通常sourceへ反映した。進行中の本文・保有・海外・VWAPはそれぞれ受入済みsource/lock/入力を固定し、途中でruntimeや.envを切り替えない。Mac e4cとWorker mainの版差・次定時未受入を[台帳](test-logs/recovery-acceptance-20261016.md)へ記録する。源欠測・unknownのHOLDや価格未資格を、配備成功で解除しない。

10/17 06:02:20 JSTにMacをmain `e4c1a7e3`へ更新し、#461の既存補足publisherの未閉鎖intent停止を定期入口にも配備した。旧f3の1,560 source・旧.envと104社の保存観測source/依存を保全し、同calendar/kernel writer/state/依存lockを維持した。Cloudflareは同mainを06:01:27/version `4224e38d-a64e-47e5-8adc-7890de9322b9`へ通常配信。監視accepted revisionの更新ACKと次の20/21時の実receiptは別に受け入れる。本文2,417・意味再判定104・原本HOLD21と価格/権利等の未完は[受入台帳](test-logs/recovery-acceptance-20261016.md)で追跡する。

10/17 05:10:51 JSTにMacをmain `f3a7c738`へ更新し、既知4節の比較を先に行う通常経路も配備した。旧65579の1,549 source・旧.env bytesを保全し、同calendar/kernel writer/state/依存lockを保持した。先行776社と交差しない本文135社も全件の通常/物理PRE/POST照合を閉じてから切り替えた。Cloudflareの同mainは05:11:00/version `51915326-5f92-4428-9780-07810b3be514`、監視accepted revisionはCLI ACKと更新時刻まで確認した。これを次20/21時の定時receiptや全20機能の完了に数えない。

10/17 04:16:47 JSTにMac runtimeを`65579f60`へ更新した。Nix・同じ依存lockを使い、原文/Notion送信表現の別SHA照合と現在有報に束縛した有限競合準備を配備した。旧117bのsource1,542件と旧.env bytes、さらに旧43d/049/277の原本を保全し、旧実行入口の.envを無効化した。本文の固定776社は全件をcode/docId集合と物理PRE/POSTまで受入済みで、旧部分停止2社の業務更新は再送していない。監視側accepted revisionも同版へ更新したが、新しい20/21時の実receiptは未受入。Cloudflare側は同mainを04:16:09にversion `d61c452a-815e-4d12-be16-fa5bd738e330`として通常配信した。各実行先の版と受入範囲は[台帳](test-logs/recovery-acceptance-20261016.md)で追跡する。

10/16のMac定時はmain `27709ccf`で実行した。20時の事業タグは20:20:13に終了し、本文同期143・再判定5・skip49、資格HOLD23を記録した。21時の優待要約は21:00:09に終了し、現行pending・モデル起動とも0だった。訪問197社を全3,687社の充足率へ読み替えない。[当日の受入記録](test-logs/recovery-acceptance-20261016.md)に実receiptと原応答の検証範囲を残す。

23:27:12 JSTに共通kernel writer lockの下でMac runtimeをmain `43d563a3`へ切り替えた。プロジェクトNixで同じ依存lockをoffline/frozen installし、関連55テストと通信0のpreflightを確認した。旧277の追跡ファイル1,496件と旧.envの実体、さらに旧049の原応答・入力・私有証跡を保持している。20時・21時の登録済みcalendarと入口は同じで、追加の即時起動は行っていない。新runtimeの次回定時receiptは未受入。

Cloudflareはmain `c1ad90e2`（#430）の通常buildで23:44:59 JSTのdeployとversion `c6c7d65f-faa1-435b-9c79-f23bcc7b7dd8`を確認した。これはその時点の配信証跡であり、Mac runtimeの切替えや、次回18時の調整系列による全量再生成の成功を意味しない。権利イベントと価格系列の未完は[本番監査](test-logs/corporate-actions-20261016.md)で追跡する。

ローカルはプロジェクトのNixを使い、通常本番と同じソース・依存lock・入力契約を検証する。本番側にNixを必須とせず、必要なライブラリを配置する。OS/GPUバイナリまで同一とは扱わない。Mac停止・未ログイン・スリープ中の定時完了は保証しない。10/15の遅延起動とR2 DNS失敗、当時の未配備は[Mac運用記録](005-biztag-local-runtime.md)と受入台帳の過去観測として保持する。

本番の成功は定時起動だけでなく、対象集合・原本・保存結果・欠測理由・完了receiptで確認する。原本未取得、429、期限切れ、同定不能、結果不明をLLMや別値で埋めず、理由と残件数を残す。単発の復旧成功を全量・通常定時の成功へ広げない。


## 事業タグの新規作成と版更新の結果不明

通常Node/Macの`runBiztag`は、既存行に加えて新規補足行も同じcanonical stateのpublication journalで保護する。新規作成はpage IDがまだ無いため、DB・銘柄・次文書・全プロパティ/根拠の実入力を最初のPOST前に保存する。POST/残りのPATCHはsingle attemptとし、同DB・全文プロパティ・全根拠childrenを読戻した後だけ閉鎖する。旧replace記録と共存し、不完全/不正記録は次runのmetadata/model/HTTP前に停止する。

`version_bump`は既存`writeRowWithEvidence`を使い、最新文書guard・物理PRE・旧値CAS・全POST・永続journalを維持する。別文書への付替えはHOLD。現行normal plannerはこのkindを生成せず、既存の機械同期/意味判定の対象数は増えない。通常createにはページ/childrenの最小2 GETと長文property/根拠階層分の追加GETがある。追加取得元アクセス・モデル・依存・DDLは0だが、全量時間の改善や次定時成功は未受入である。

未閉鎖publicationを実PRE/target/source/fullPOST/根拠と照合する正規read-only CLIはまだ無い。journalからcompletionを自動生成せず、原記録を保持してoperator調査で止める。手動`master-dedup-3681-7129.ts`の`updateSupplementRow`は独自の保存snapshot/guardを使う旧経路で、このjournalへ移行していない。汎用update APIは今回変更しない。[回帰と未受入の範囲](test-logs/biztag-create-publication-20261017.md)を参照。


## PRE保管POSTだけが結果不明の場合の明示照合

通常`biztag run --reconcile-pre-archive`は固定1社・mechanical-only・明示15分以内budget・捕捉全送信baselineのSHAが必要。元intent以降がPRE query/upload/send/ページPOST応答欠測だけの4 nativeであり、業務未送信、Key一意1件、全PRE実体、現在target/根拠/source metadata/最新D1 pointerが一致した場合だけ、同key/inputの通常PATCH/readbackへ進む。原本再upload/page POSTは0、任意unknown businessは従来のglobal STOPを維持する。

once/資格phaseは別canonical sidecarへ保存し、元PRE/intentを変更せず通常completionの3ファイル/schemaを維持する。これにより凍結した旧E4 publisherとの互換を保つ。無指定定時の追加HTTPは0、明示照合ではKey/metadata/physical PREを資格時とpublish時、source metadataを資格時とPATCH直前に読む。全通信hard stop・native/bytes上限は有限実行側の別契約で、CLIのbudgetは新規着手budget。汎用のunknown business再開やcompletion生成は追加しない。[保存原本回帰と運用制約](test-logs/biztag-pre-archive-reconciliation-20261017.md)を参照。
