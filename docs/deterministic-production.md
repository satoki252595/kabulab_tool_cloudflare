# 決定的な処理を優先する本番運用

更新: 2026-10-16。取得・抽出・計算・照合・保存・検証を通常のCLI/共有関数で実装する。入力が同じなら同じ結果となる処理を優先し、未取得・主体不明・原本にない値は生成しない。LLMは意味判断が必要な残件へ限定する。

## 実行先と現在の例外

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

## RAW原本の有限継続

`raw_index_backfill.yml`の`execution_revision`は実行する完全40桁commit SHAを指定する。初回の空欄だけそのrunの`github.sha`を採用し、checkout前の形式検査とcheckout後のHEAD一致を依存準備・データ処理より先に行う。通常continuationは実HEADと明示入力の一致を確認し、同SHAを次dispatchへ渡す。これによりrawコード・依存lock・Nix定義を同じcommitから使う。

GitHubの[workflow dispatch仕様](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)が保証するrefはbranch/tagなので、dispatchは従来の`main`を使い、[checkoutのSHA指定](https://github.com/actions/checkout/tree/v4#usage)で実行ソースを固定する。次runのworkflow YAMLやGitHub action自体、runner OS、Secretsはcommit固定の対象ではない。workflowが互換性を壊して変更される場合は別途止めて再受入する。

固定manifest・元run pool・残run数・原本CAS/state・unknown停止・一度だけのdispatchは従来のまま。revision指定だけで別poolや古いunknownを回避できず、コード修正の受入を原本全量・最終anti-joinの完了と数えない。

## 保有株式の保存原本バックフィル

`yuho:backfill:holdings prepare <1..50> <afterCode|START> <privateDir> [valuation.json]` は最新有報の保存type1を原本照合し、株数・単位・当期・提出会社を共有parserで検査する。価格原本を指定しない準備と公開は原本列だけの段階で、価格を新たに確定しない。既存の照合済み価格も消さない。

`yuho:backfill:holdings apply <privateDir> <maxRows1..1000>` は通常定期取込と同じpublisherを使う。文書ごとに最大100行のwindowを進め、書込前に最新文書ID・発行体・期末・提出会社名を照合する。残windowは定期処理と共通の保存cursorから再開する。既知の資格HOLDはreceiptへ固定し、自動で再送しない。通信や書込の結果不明はpending journalを残し、別通の送信と自動再実行を止める。旧未検証行は共有publisherの物理PRE/POSTと全props照合を通す。

共通publisherは再開前に既完prefixの原本列を既存の期末一覧で照合し、最後のwindow後は全原表をもう一度検索してから完了と価格queueを登録する。prefixのdriftは元cursorのHOLD、最終照合の失敗はunknownを保持する。CLIの文書別latest照合はwindow内を銘柄コードで絞り、外側も既存のcode索引を使う。100行の実適用とD1読取コストの比較は[検証記録](test-logs/holdings-source-verification-20261016.md)を参照。

ローカルは `nix develop -c pnpm yuho:backfill:holdings ...`。同じNode CLIをActionsでも実行でき、追加依存はない。有限の過去補完を定時の全量成功とは数えず、原本確定件数・保留・残window・価格確定を分けて受け入れる。

## 事業タグの機械処理だけを実行する

通常CLIの`pnpm biztag run --mechanical-only --codes=<対象コード列> --limit=<件数> --budget-min=<分>`は、本番定期と同じ計画・本文同期・キーワード照合・共有publisherを使う。新規初回や実入力変更による再判定は明示HOLDとし、モデルの起動・原応答journal・較正の読込へ進めない。機械照合不能を別モデルで補わない。

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
stageのruntime配備・現在入力の実受入は未実施。親processのgzip検証費用も未測定として[記録](test-logs/competitor-finite-stage-20261017.md)へ残す。

## 優待の定型処理

通常入口は既存の`yutai:summary:local` / `run yutai-summary`。同じ`runLocalSummary`内で、全文が既知の優待種類と単一の円額面だけで構成される入力を`simple-face-value-v1`として処理する。表見出しに種類だけ、本文に額面だけがある形式も対象。金額は本文を既存`evaluateCompanyValue`で一意に認定したものだけを使う。

注記、未知の見出し、保有期間、抽選、申込、選択肢、複数商品・額面、未対応の表記を削って文法に合わせない。未対応分だけを別のprivate `model-tasks.jsonl`へ保存し、固定ローカルモデルへ渡す。定型分とモデル分の双方が同じ`planSummaryImport`、物理PRE、原子適用、全POST照合を通る。既存の有効要約を定型文に置き換える一括処理は行わない。

定型rule・対象IDと結果を保存し、モデルを起動しないbatchの来歴はmodel/revisionをnull、modelCalls/modelResidentsを0とする。定型処理を過去のモデル判定として記録しない。モデルを使うbatchは既存のpinと原応答を保持する。

この変更に追加の依存、取得元アクセス、有料モデルAPIはない。未対応分があるときのモデル常駐は従来どおり最大1個で、全体の速度改善は実運用で測る。ローカルの電力・時間を無料とは呼ばない。

## 配備と完了の判定

10/16のMac定時はmain `27709ccf`で実行した。20時の事業タグは20:20:13に終了し、本文同期143・再判定5・skip49、資格HOLD23を記録した。21時の優待要約は21:00:09に終了し、現行pending・モデル起動とも0だった。訪問197社を全3,687社の充足率へ読み替えない。[当日の受入記録](test-logs/recovery-acceptance-20261016.md)に実receiptと原応答の検証範囲を残す。

23:27:12 JSTに共通kernel writer lockの下でMac runtimeをmain `43d563a3`へ切り替えた。プロジェクトNixで同じ依存lockをoffline/frozen installし、関連55テストと通信0のpreflightを確認した。旧277の追跡ファイル1,496件と旧.envの実体、さらに旧049の原応答・入力・私有証跡を保持している。20時・21時の登録済みcalendarと入口は同じで、追加の即時起動は行っていない。新runtimeの次回定時receiptは未受入。

Cloudflareはmain `c1ad90e2`（#430）の通常buildで23:44:59 JSTのdeployとversion `c6c7d65f-faa1-435b-9c79-f23bcc7b7dd8`を確認した。これはその時点の配信証跡であり、Mac runtimeの切替えや、次回18時の調整系列による全量再生成の成功を意味しない。権利イベントと価格系列の未完は[本番監査](test-logs/corporate-actions-20261016.md)で追跡する。

ローカルはプロジェクトのNixを使い、通常本番と同じソース・依存lock・入力契約を検証する。本番側にNixを必須とせず、必要なライブラリを配置する。OS/GPUバイナリまで同一とは扱わない。Mac停止・未ログイン・スリープ中の定時完了は保証しない。10/15の遅延起動とR2 DNS失敗、当時の未配備は[Mac運用記録](005-biztag-local-runtime.md)と受入台帳の過去観測として保持する。

本番の成功は定時起動だけでなく、対象集合・原本・保存結果・欠測理由・完了receiptで確認する。原本未取得、429、期限切れ、同定不能、結果不明をLLMや別値で埋めず、理由と残件数を残す。単発の復旧成功を全量・通常定時の成功へ広げない。
