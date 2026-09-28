# kabulab 残作業実行計画 2026-09-28

## 境界・根拠

- 計画のみGPT-sol。実装・テストは `muse-spark-1.3-contributor/max`。最新origin/mainは9bf35d9531547d47a39d314fbeb3f89508ef9abe、open PRなし（読取時点）。
- CLAUDE.md/AGENTS.md、RSI/yuho-quant CLAUDE、財務test-logsを確認。nix develop内の既存pnpm/uvのみ利用、インストールなし。秘密値・署名URLをログ/PRへ出さない。
- JPX信用残日次化と株式/ETF/REIT投資部門新様式対応は9/29へ延期。現週次空PDFの根因修正は本日対象。
- 元checkout fix/financial-null-canonical は他セッション所有。financials.py/mappers.py/そのtests、reparse script、CF-CANONICAL-DESIGN、HANDOFF ledger、release-notes、financial-null-replacement記録に未コミット変更。変更・再実行・停止をしない。
- PID58797/58831は `/tmp/kabulab-financial-full-context-audit.jsonl` から `/tmp/kabulab-financial-full-instant-final-audit.jsonl` へcache全件再解析中（読取確認時）。先行799fresh再読停止の説明より最新である。既存担当の完了報告を待ち、二重起動しない。別Notion-backfill prepare-only PID20926もあり、共有writerの空きと所有者を確認する。
- #124は優先26原本/25正本キーの反映のみ成功。source D1は322→346、他321行不変、旧3463誤キー除去1。全34,663修復完了ではない。docs/test-logs/financials-stage-2026-09-28.mdと#124コメントが根拠。通常writerのNULL完全置換変更は別セッションの未完了作業。
- 共通Notion clientの制御はプロセス内。Notion/D1 writerを同時に走らせない。各worktreeはorigin/mainから独立し、元checkoutから未コミットdiffをコピーしない。

## 最初の最大3並列Museタスク

### A: #117 空信用残PDFと#98 EDINET接続断

所有: services/vwap-analysis/lib/margin.ts、scripts/vwap/ingest-margin.ts、services/yuho-quant/src/services/edinet/client.ts、直接caller/関連回帰のみ。

1. #117 run36245100733、#98 run36022119851/36156111106から実失敗経路と原因を確認。
2. margin fetchMarginはunpdfへ元bytesを直接渡す。moneyflow/lib/run-spec.tsはdetach防止で解析へsliceを渡している。実margin-2026-09-18.pdfの解析前後bytes/保管bytesを比べ、detachが原因なら同じ最小修正を再利用。HTTP/PDF検証が不足している実原因も確認。架空PDFや空成功禁止。
3. EDINETのlistDocuments/downloadDocumentおよび全callerを辿る。fetch failed/ECONNRESETを通信種別・タイムアウト・再利用条件まで特定。既存ヘルパを探し、必要なGET再試行は限定回数/対象で共通根因に置く。404/API/schemaエラーは既存の明示エラー維持、例外にAPIキーURLを含めない。

受入: 実PDF非ゼロbytes・解析行あり・元hash保持、EDINET問題経路の実GET成功と断時に失敗が残る回帰。対象テスト/typecheck/lint、PR/CI全緑。Notion/D1へ書かず共有writer待ち。#117/#98は後続の同一ジョブ成功と実体保管再読までcloseしない。

### B: moneyflow先物・オプション/IMF実データdry-run

所有: services/moneyflow/lib/adaptersとsourcesのjpx-derivatives-investor.ts/imf-cpis.ts、scripts/moneyflow該当経路、関連実fixture/記録。

既存scripts/moneyflow/sources.tsのweekly/futures-OI/IMF spec名を確認し、`nix develop -c pnpm exec tsx scripts/moneyflow/ingest.ts --dry-run --only=<対象名>`。runSpecのdry-runは取得・解析・validateDraftsのみでNotion未書込。株式/ETF/REIT新様式は触らない。

受入: 実取得URL・公表/対象日・key・bytes/hash・件数を記録。先物/オプションの商品・投資主体・売買符号・数量/金額/建玉単位、IMF対象国/資産/方向/期間を実原文と照合。失敗は根因修正後に再実行し、対象回帰/CI緑のPR（無修正なら記録PR）。dry-run成功は一次実体保管完了を意味しない。後続writer枠でrecordPrimaryData実体保管→Notion再読→観測冪等性を確認する。

### C: RSI新財務正本移行とATR%2%修正

所有: services/rsi-screening/src/services/{screening-service,stock-detail-service}.ts、src/shared/screener.ts、必要最小のblue-chip/共有財務読取点、対象回帰。

stock-detail-service.tsのstockAnnualFinancials読取、daily.tsの旧年次writerとevaluateBlueChip callerを全追跡。既存jss_financials schema/queryを再利用し、同じ原本の当期/本決算/連結区分/訂正最新版を明示して新正本へ移す。NULLは保持し、旧Yahoo値で埋めない。年次/四半期/中間を混ぜない。旧表/writer削除は全caller移行後。

daily.tsはatrPctRatio×100、screener.tsの0.02は実効0.02%。意図2%へ定数を2に修正し境界を回帰化。

受入: 1.99/2/2.01%の境界、欠損、期間と連結混入・訂正の回帰。8154原本年度値との照合、旧年度テーブル読取消失、UI専門用語はtermTip。PR/CI全緑。本番RSI切替とランキング再計算は#124全体source同期完了に依存する。

## 共有writerの後続順序

1. **既存財務担当の継続を優先**。新担当は原本再解析jobの終了・最終parser SHA・全34,663のjournal/失敗/差分を受け取る。旧journalの反映禁止。既存commandは `nix develop -c uv run --project pipeline python pipeline/scripts/reparse_financials_from_notion.py --reparse-cached-from <旧監査> --journal <最終監査> --cache-dir /tmp/kabulab-financial-raw-cache`。現jobの再起動は不要。
2. 財務PRのCI緑/最終parserと通常writerのNULL完全置換契約確定→全件監査差分確認→`--apply-journal --journal <最終監査> --receipts <fresh receipt>`→正本fresh再読。799など部分成功を全件成功としない。未確認原本/hash違い/失敗は件数と理由を明示する。
3. sourceの最新346行とcore ID/codeをsnapshotして隔離D1へ複製。`--sync-d1 --journal <最終監査> --receipts <fresh receipt>`を隔離設定で2回、全列diffと冪等を確認。新開示/厳しいライセンス/実doc ID保護、NULL完全置換、旧キー除去はhash/source/開示日時一致と新キー再読後のみ。source書込直前にsnapshot全列一致を再確認して同じ同期/再読。全件品質・正本/D1一致の証跡まで#124を閉じない。
4. Aの信用残実体保管/EDINETジョブ再実行、Bの実体保管/再読/観測冪等をwriter枠ごとに直列で実施する。一次ファイルはsrc/shared/notion-archive窓口、Pythonは既存Notion窓口を再利用する。
5. **#102重複3681/7129**: 別の後続Museタスク。既存master_syncとbiztagのマスタlookupを追跡し、両ページの全properties/本文/ファイル/全incoming relationをsnapshot。既存正本基準で保持先を確定、相補データとrelationsを損失なく移行しfresh再読。衝突値は勝手に選択せず出典/日時で確定できない場合停止・報告。不要元はmoveToTrash等既存窓口で理由/元page/実体を退避、再読成功後にarchive。再実行無変更、両コード有効1件/全relation保持、次biztag run重複0でclose。Notion財務writerと同時実行不可。
6. #124全体同期後にCのRSI本番切替/原本一致/市場母集団と選定差分の実データ検証。旧財務経路の残callerを監査して必要箇所だけ撤去。欠損を成功値に変えない。
7. **#89/#92/#129整理**: 各失敗runと同じworkflow/jobの後続成功run、現在mainの修正commit/PRを照合してIssueへ根拠リンク→close。親からの後続成功済み情報のみで機械的closeせず、別障害が残る場合追記してopen維持。

## 共通完了条件

変更は個別branch/PR、main直push禁止。実装担当がnix経由で必要対象回帰/typecheck/lintを実行、CI全緑を見届ける。利用/運用変更と本番作業はdocs/release-notes.md、検証はdocs/test-logsへ記録（release-notes共有ファイルは各worktreeで変更しマージ時に整合）。Issueは実運用成功/データ再読の根拠で完了させる。全件を実施できない状態では残件数/理由と安全な再開点を明示して未完了のまま追跡する。
