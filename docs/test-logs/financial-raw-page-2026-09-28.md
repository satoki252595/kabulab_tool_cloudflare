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
一列migration回帰追加後のwriter/監査修復テスト76件成功。PR #145のCIでは
全Python1,270件成功・58件skip、ruff・JSの型/lint/test・Worker Buildも成功。
merge `18d5939481dd931e6458b38f11a6760e8a4286f5`。

## 実反映結果（本番作業）

2026-09-28 08:48 UTCまでに、既存source D1へのnullable列追加と正本fresh全件同期を完了。
各DDL前の全33列snapshotは、既存修復完了証跡のafter33と完全一致した。
DDL直後の全34列では元33列不変・新列NULL34,659を確認したうえで同期した。

| 検証 | 隔離財務D1 | 既存source D1 |
| --- | --- | --- |
| 原本数 / 財務キー数 | 34,663 / 34,659 | 34,663 / 34,659 |
| 原本page ID / SHA組の一致 | 全34,659 | 全34,659 |
| 未知 / 不正page ID | 0 / 0 | 0 / 0 |
| 元33列 | 全件不変 | 全件不変 |
| 同じ入力の二度目同期 | 全34列不変 | 1回のみ、全34列が隔離結果と一致 |
| 実測秒（snapshot・DDL・同期・比較を含む） | 971.068（fresh同期2回） | 368.464（fresh同期1回） |
| D1応答数 / rows_read / rows_written | 1,419 / 608,270 / 69,318 | 784 / 379,238 / 103,977 |

rows_writtenはAPI返却の実測であり、挿入件数や請求額ではない。今回の履歴修復だけの処理。
通常直列2.5rps・parser・journal・receiptは不変、Notion再PATCHは0。
保護新値・未検証旧キー・旧キー退役は全て0。4衝突キー3911/5035/6071/7509も、
要約ページの最新relationではなく、canonical原本とreceiptの全項目一致から選んだ
各行自身の原本ID / SHAに一致した。

独立read-only検査でも、正本receiptから再構成した全34列が隔離・source両実結果と一致し、
元33列全不変・4衝突原本組・未知0・不正0を確認（追加API0）。

完了証跡のSHA256（原本値・ページID・秘密を含む実ファイルは0600の私有保存）：

- 元source33証跡：`e3ce0bc704fd6b2caa0244cdbcf08477d0830b2a1e73bc0cccc80d8dbbf4c619`（不変）
- 隔離34証跡：`05eb283963473e4f2ae48a69cddfb7bed13b23f71110d5ad78515e46cc9d176b`
- source34証跡：`bb49a3e48f7e955400d2d50d6d6126a7c00712b66345f51baa38a221bf06112f`
- cleanup証跡：`60d7bbd9ec0878f1bba61d8b04f9d6f0b9800ce0bdf28e04858a63f5179d23bb`

検証用 `kabulab-financial-repair-stage-20260928` は証跡保存後に削除。
削除前後のDB一覧で、この一時DBだけが無くなり既存sourceが残ったことを確認（他DB削除0）。
他11テーブルの114kコピー・アプリ側財務履歴複製・main kabulabAgentsの変更/デプロイは0。

### 到達できる原本と残る区別

TDnetのdoc_id欠損2,785行は原本iXBRL ZIPのSHAとNotion⑤関係を検証済みだが、
`jss_raw_files` 索引は0、PDF書類番号は未検証。新列で実在のNotion原本へ到達できるようにし、
架空のR2索引・推測PDFリンクは作っていない。EDINETも既存の書類IDとCSV/XBRL ZIP保管原本を維持。
Notion原本の閲覧権限が必要で、外部共有設定は変更していない。
表示側のリンク反映と新しい実レポート品質の検証は下流の別ゲートであり、本source完了と区別する。
