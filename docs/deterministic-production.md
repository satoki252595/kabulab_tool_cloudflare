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

## 保有株式の保存原本バックフィル

`yuho:backfill:holdings prepare <1..50> <afterCode|START> <privateDir> [valuation.json]` は最新有報の保存type1を原本照合し、株数・単位・当期・提出会社を共有parserで検査する。価格原本を指定しない準備と公開は原本列だけの段階で、価格を新たに確定しない。既存の照合済み価格も消さない。

`yuho:backfill:holdings apply <privateDir> <maxRows1..1000>` は通常定期取込と同じpublisherを使う。文書ごとに最大100行のwindowを進め、書込前に最新文書ID・発行体・期末・提出会社名を照合する。残windowは定期処理と共通の保存cursorから再開する。既知の資格HOLDはreceiptへ固定し、自動で再送しない。通信や書込の結果不明はpending journalを残し、別通の送信と自動再実行を止める。旧未検証行は共有publisherの物理PRE/POSTと全props照合を通す。

ローカルは `nix develop -c pnpm yuho:backfill:holdings ...`。同じNode CLIをActionsでも実行でき、追加依存はない。有限の過去補完を定時の全量成功とは数えず、原本確定件数・保留・残window・価格確定を分けて受け入れる。

## 事業タグの機械処理だけを実行する

通常CLIの`pnpm biztag run --mechanical-only --codes=<対象コード列> --limit=<件数> --budget-min=<分>`は、本番定期と同じ計画・本文同期・キーワード照合・共有publisherを使う。新規初回や実入力変更による再判定は明示HOLDとし、モデルの起動・原応答journal・較正の読込へ進めない。機械照合不能を別モデルで補わない。

旧タグ・根拠・判定日・未知の旧入力SHAを保持し、書込前の最新文書照合・物理PRE・単発更新・全property読戻しを通常経路で行う。初回判定や再判定のHOLDは`qualificationHeld`と専用件数へ残し、`remaining=0`だけで全件完了と判断しない。既定の20時処理は従来どおり、必要な対象だけローカルClefを使う。依存・上流取得・毎日の実行回数は追加しない。ローカルは同じlockのNix環境で実行し、main反映とMac専用runtimeへの配備は別に確認する。

## 優待の定型処理

通常入口は既存の`yutai:summary:local` / `run yutai-summary`。同じ`runLocalSummary`内で、全文が既知の優待種類と単一の円額面だけで構成される入力を`simple-face-value-v1`として処理する。表見出しに種類だけ、本文に額面だけがある形式も対象。金額は本文を既存`evaluateCompanyValue`で一意に認定したものだけを使う。

注記、未知の見出し、保有期間、抽選、申込、選択肢、複数商品・額面、未対応の表記を削って文法に合わせない。未対応分だけを別のprivate `model-tasks.jsonl`へ保存し、固定ローカルモデルへ渡す。定型分とモデル分の双方が同じ`planSummaryImport`、物理PRE、原子適用、全POST照合を通る。既存の有効要約を定型文に置き換える一括処理は行わない。

定型rule・対象IDと結果を保存し、モデルを起動しないbatchの来歴はmodel/revisionをnull、modelCalls/modelResidentsを0とする。定型処理を過去のモデル判定として記録しない。モデルを使うbatchは既存のpinと原応答を保持する。

この変更に追加の依存、取得元アクセス、有料モデルAPIはない。未対応分があるときのモデル常駐は従来どおり最大1個で、全体の速度改善は実運用で測る。ローカルの電力・時間を無料とは呼ばない。

## 配備と完了の判定

10/16 19:19:27 JST、Mac runtimeをmain27709ccfへ切り替えた。Nixの90テスト・通信0のpreflightを通し、共通writer lockを保持して変更した。旧049 runtimeのソース161件・入力1,752件・私有証跡320件を照合保全し、旧worktreeと元.env実体も保持している。原応答保存、優待定型処理、有限DNS読取の修正を通常入口へ反映済み。20時・21時のcalendarは同じ入口を指して待機し、当日の追加即時実行はしていない。以下の00時台の未配備・失敗は当時の観測であり、今夜の定時成功はまだ未確認。

Cloudflare main27709ccfはbuild76534ec8で通常deploy成功、10/16 00:55:57 JST/version d3d109efを確認。Workerの配備とMacの配備、各データの全量受入を区別する。権利イベントと価格系列の未完は[本番監査](test-logs/corporate-actions-20261016.md)に記録した。

ローカルはプロジェクトのNix、ソースと依存lockは通常本番と共通にする。本番にNixを必須とせず、必要なライブラリを本番側にも配置する。Nodeのpatch版やOS/GPUバイナリまで同一と主張しない。

Workerの配備はMacの専用runtimeを更新しない。2026-10-16 00:25 JST時点のMacは049e39a4固定で、このPRの定型経路も原応答永続化の#402も未配備。CI成功・mainへの反映後に稼働中writerを確認してruntimeを切り替え、実際の次回定時receiptまで受入する必要がある。Mac停止・未ログイン・スリープ中の定時完了は保証しない。

00:32 JSTの追加確認では、10/15のMac両jobが約14〜15分遅れて起動した後、R2の名前解決`ENOTFOUND`で本体開始前に停止していた。LaunchAgent終了code1・本体log0B・終了receiptなし。読取専用の実R2 GET2回/647Bで、両latestが10/14の正常終了receiptのままと確認した。10/15の定時成功には数えず、開始時の元結果不明も消さない。共有R2 GETの明示DNS失敗を既存最大3試行へ接続する修正と、Mac receipt読取の16KiB/60秒signalを追加する。PUTは再送せず、Mac runtimeの切替え・次回定時の受入は別途必要。

本番の成功は定時起動だけでなく、対象集合・原本・保存結果・欠測理由・完了receiptで確認する。原本未取得、429、期限切れ、同定不能、結果不明をLLMや別値で埋めず、理由と残件数を残す。単発の復旧成功を全量・通常定時の成功へ広げない。
