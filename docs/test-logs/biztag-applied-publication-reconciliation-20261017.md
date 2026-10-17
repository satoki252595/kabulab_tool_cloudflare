# 適用済み事業タグの旧根拠退役・完了記録の明示照合

2026-10-17。コード・保存原本の検証。本番の退役・完了記録は未実行。

固定104社の保存済みClef結果を通常publisherへ渡す操作が、最初の3625/S100Z468で停止した。全229送信の応答は200。新根拠appendと全列PATCHはACK・全文読戻し済みだが、旧根拠DELETEの前に私有observerがContent-Type application/jsonの空bodyをJSON解析して失敗した。退役のnative intentは0件で、元intent/pre・STOPを保持している。18:22の別読取11件でも全列、新旧根拠全文、source39列・最新doc・元PRE336,883bytesを照合した。104社の完了とは扱わない。

既存の`reconcileSupplementPreArchive`は機械本文のPRE保管だけを扱うため、semantic snapshotを従来どおり拒否する。新しい通常CLI `pnpm biztag reconcile-applied --proof=<path> --proof-sha256=<SHA> --code=3625 --budget-min=10` は、同じ受入revision・canonical state・kernel writerを通る明示入口である。

- 元journal/pre・原本archive・主体・完全なnative要求/応答/開始記録SHAを資格化する。全応答200・全在庫一致・退役のnative試行0件・限定した15段階のpublisher末尾に限る。欠落、別PATCH、未知応答は通信前に停止する。
- 共有publisherの全列・全子ブロック・実体PRE検証を再利用し、書込直前に最新docとsource全props/時計を確認する。適用済みの新根拠やpropertiesは再送しない。旧根拠だけsingleAttemptで退役し、全POSTと最新sourceを再確認する。
- 元journalは通常の`reserve/complete`から閉じる。完了hashは通常publisherと同じ「properties適用後・旧根拠退役前」の全pageを使う。元intent/preは不変。一度だけのsidecarは別outでも再送を防ぎ、退役ACK不明・読戻し不一致・ファイル書込失敗はpendingを保持する。

通常定期処理への追加I/Oは0。明示修復だけが元PREの再検証・対象行/根拠/sourceの全読取を行う。モデル・新原典取得は0。CLIの15分以内budgetは書込前に期限を検査する。今回の実操作では別の有限observerで各native直前の期限・総HTTP/bytes・レートも制限する。原本全量を新たに一般公開したり、他の103社を同じ停止済み操作へ再入場させない。

回帰は実3625の保存値を使う。公開fixtureは原native215..229の15件を1..15へ明示投影し、署名URL query/expiryだけを削除、応答JSONの転送bytes/SHAと投影カウンターを再計算したもの。元229件の全raw SHAは私有証拠、公開fixtureの変更箇所と元SHAは同梱provenanceへ区別して記録した。これは原native全量の代用ではない。

正常退役・既退役の読取だけでの完了・全列/根拠/保持本文/時計/source/latest/物理PREの変化・退役結果不明・別out再送・応答SHA不一致・隠れた送信・開始記録欠落・既存DELETE・別pendingの停止を検証する。既存PRE保管照合と通常publisherの回帰も継続する。
