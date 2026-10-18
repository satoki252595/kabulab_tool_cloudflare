# 5分足の取得状況と保存済み最終有効日

2026-10-18、通常 `ingest-intra --codes=7531,9311 --range=60d` を一度実行した。2社ともR2更新と全本文POSTは成功したが、10/13–16の応答各312行には、正のOHLCと出来高が揃う採用可能な行が0だった。7531は全NULL235行、9311は311行を含む。保存済み最終有効日は7531が10/8、9311が10/7。これは取得元の欠測であり、公式の無取引・売買停止の認定ではない。追加の源取得で埋まると推定しない。

通常writerの `sourceStatus` は同じHTTP原本の実受領時計・SHA・最終原応答日・最終採用日を保持する。timestamp空配列は `source_empty`、最終原応答日まで採用barがない場合は `source_unavailable`。`source_available` も、未観測の営業日や期間の完全性を保証しない。通常summaryの `written` はR2操作件数であり、最新期間の回復件数ではない。銘柄別結果に取得状況と保存済み最終有効日を併記する。

形状・実価格検査を通った全NULLだけを型付き欠測に分離し、正常なraw保管後、既存バーを変えず取得状況だけCASする。全NULLはerrors=1・empty=0・銘柄outcome=error、終了コードは非0のまま。metadata CASのACKは別の操作件数written=1として数え、bodyShaを残す。これらは相互排他counterの和ではない。真正emptyも取得状況を保存する。429/503・不正値・未知形式・原本保管不明・R2不明を成功やemptyへ変換しない。別の原本や推定値による補完、同runの源再取得はない。

バー全値と取得状況の意味が同じなら、既存の証拠SHA・時計をそのまま残してPUTを省略する。新応答は通常raw batch archiveとsummaryへ保持し、古いR2証拠時計を新しいものに偽装しない。未知のtop-level fieldを含む既存全objectの比較は従来どおり厳密。取得状況の形状は既存daily proof同様、存在時の必須fieldを検証し、未知キーだけを理由に欠測へ変換しない。

APIは取得状況と保存バーから求めた `lastValidDate` を返す。既存objectに診断がない場合は `sourceStatus: null` とし、画面に最新取得状況は未確認と最終有効日を表示する。有効な古いバー、日足、既存zero-split価格basis判定は変更しない。取得状況の欠測と価格basisのHOLDは別の理由として表示する。

実2社のfull raw再生は私有原本が存在するlocalで実行し、CIでは不在時skipする。Gitの実7531の2行fixtureは「最終有効行＋最終全NULL行」の明示transport投影であり、full native原本ではない。CIはその文法・空/全NULL/不正価格の分離、APIの旧バー保全、同値証拠保持を検査する。全NULLへの変更や出来高変更は宣言faultで、追加の実観測とは呼ばない。

原本gzip SHAは `ca47b94e7b7daee55b1d07ad4997f7a8bf213e90f6a4cb8e92c3be25c2200234`。私有根拠は `tmp/feature-audit-20261018/holdings-rights-needed-current-v1/`、分類receipt SHAは `231019bfcd82a69b05199d2c21fefc3f62c428c39f09804d60d921ec126fb4c8`。今回sourceStatus付きwriterを本番へ再実行したとは主張しない。反映と次の定時受入は別であり、今回の保存済みrawを再取得しない。依存・DDL・金融数値補正・モデル追加は0。

Nix関連7 suitesは172 PASS・26 skip（既存private依存を含む）、全TypeScriptと対象eslint PASS。今回full2raw local回帰は実行されている。dailyの全NULL例外型は変更しておらず、intraだけ型付き診断を使う。新ケースに既存証拠時計保持・metadata変更時だけPUT・全NULLの旧バー保全を含む。
