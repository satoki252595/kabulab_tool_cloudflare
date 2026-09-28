# 財務原本ページの参照契約 — 2026-09-28

Refs #124。全原本再解析と正本→source D1の数値修復証跡は
`financial-context-unit-2026-09-28.md` にある。本変更は数値修復のやり直しではなく、
検証済み原本への到達に必要なメタデータの欠落を直す。

## 契約と最小経路

- `jss_financials.raw_page_id TEXT NULL` を既存33列の末尾へ追加する。主キー・索引・財務値は変更しない。
- 値は `FinancialSummaryRecord.provenance.raw_page_id` の実Notion⑤ UUID。原本SHAを持つ記録からのみ渡し、UUIDを正規化する。未知・SHAなし・dry-runはNULL、不正IDは拒否する。
- 通常 `CloudSink.financial_summary` と監査修復 `sync_d1` は同じ `record_to_row` を利用する。後者は元原本SHA・キー・parser SHA・正本の新鮮な全項目一致（原本relationを含む）を要求する。同じキーでも他原本のIDを借りない。
- 既存Notion原本ページへのリンクを利用できる。TDnetはiXBRL ZIP、EDINETはCSV/XBRL ZIPの保管原本。ZIP由来の財務値を検証したことと、PDF書類番号の検証は別。リンク閲覧にはNotionログインとその原本ページの閲覧権限が必要で、公開共有は変更しない。
- `jss_raw_files` に索引の無いNotion原本へ架空のR2 keyを作らず、新endpoint・新しい財務複製は増やさない。

## マイグレーションと反映ゲート

Python所有のjssスキーマの追加DDLは `pipeline/scripts/financial_raw_page_id.sql`。
列が存在しないことをPRAGMAで確認して一度だけ適用する。既存の33列snapshotを先行し、
隔離財務D1で正本のfresh全件同期→全33列不変・原本ID完全一致→再同期不変を確認する。
sourceも同じ順で追加DDL→正本fresh同期→隔離との全34列一致・元33列不変を確認する。
監査journal・receipt・parser SHAは既存完了証跡と同じものを使用する。

## 回帰と処理量

実EDINET7384原本で、既存33列のまま一列ALTERできること、正しい原本IDのみ追加されること、
未知へ戻ればNULLになることを検証。fresh Notionの原本relationだけが別の実原本へ変わった場合は、
数値が同じでもD1書込前に拒否する。

34列は通常VALUES writerの100bind上限で2行/要求（以前3行）になる。
監査修復の既存JSON100行/要求は不変。追加索引・Notion書込・常設レート変更はない。

ローカル全Pythonテストは1,269件成功・58件は未取得実fixtureによるskip。
一列migration回帰追加後のwriter/監査修復テスト76件成功。実D1反映結果は反映後に追記する。
