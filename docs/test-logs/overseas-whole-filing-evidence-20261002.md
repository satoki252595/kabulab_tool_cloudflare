# 海外売上の全本文・年度・可視見出し統合検証（2026-10-02 JST）

[原本確認](overseas-next15-custody-20261002.md)で保存・全文照合した同じ15 ZIPに対し、本文選択・年度の判定範囲・見出し抽出の3修正を統合して検証した。**新しい全文資格は13文書・84明細、HOLD2文書**。新source GET・Notion・D1・R2通信は0で、本番数値の更新はまだ行っていない。元の9資格/57明細・6HOLDと111通信の記録は保持する。

## 共通処理の変更

- [分割本文](overseas-split-body-20261002.md): 説明本文の地域語で打ち切らず、同一原本の全本文を既存の候補判定へ通す。本文ごとのcaption・期/contextを分離し、別本文の証拠を借りない。結果と診断には実採用本文と本文内offsetを保持する。
- [年度](overseas-fiscal-caption-20261002.md): 最寄りの明示期間より前の古い期語だけを判定対象から外す。その期間以後の矛盾、開始/終了の不一致、期間未証明は停止する。
- [見出し](overseas-metric-heading-20261002.md): 既存の可視窓の末尾160字を使い、長いHTMLタグで直前の売上/資産題名が落ちる原因を修正する。新しいlayout分類や曖昧な集計範囲の採用は追加しない。

共通取込・backfill・missing-backfill・修復prepare・745-prepareは同じ公開parser入口を使う。caller、原本の取得・保管順序、地域の推測、数値の補完は追加していない。

## 最終の全文判定

| docId | 全文資格・HOLD | 明細数 |
| --- | --- | ---: |
| S100Y53G | ok_geo_cols | 4 |
| S100W0AF | ok_geo_cols | 5 |
| S100W179 | ok_geo_rows | 6 |
| S100W1LQ | ok_geo_rows | 7 |
| S100W1Q5 | HOLD: multi-group | 0 |
| S100W20H | ok_geo_cols | 8 |
| S100W2ZR | ok_geo_rows | 7 |
| S100TYYR | ok_geo_rows | 7 |
| S100TA7H | ok_geo_cols | 7 |
| S100R9AG | ok_geo_rows | 7 |
| S100OH0Q | ok_geo_rows | 7 |
| S100GAYK | ok_geo_rows | 7 |
| S100FHUH | HOLD: single-row-fiscal-mismatch | 0 |
| S100AI6T | ok_geo_rows | 6 |
| S100AO7M | ok_geo_cols | 6 |

資格13通は選択候補1件、stopReasonなし、明示当期期末・連結範囲true、全factsの同期期末/連結true、共有save-set検証を満たす。原ZIP内の対象本文のfiling stemは一意で、実採用本文の存在・提出者/期との一致も確認した。修正前の資格集合からW1Q5を除外し、元HOLDの5文書を追加した結果であり、件数だけの更新ではない。

W1Q5の収益認識とセグメント情報は異なる集計範囲の同点競合、FHUHは明示期間のない当期/前期混在で停止する。両文書のfactsを作らず、現時点の13文書の条件付き修復範囲へ含めない。

## 検証と証跡

Nixで統合27 suites・406 tests PASS、既存のprivate fixture条件による14 skip。型検査、変更TypeScriptのlint、Worker deploy dry-runもPASS。各修正の独立レビューでは実fixtureと原ZIPの連続区間・context投影・全bytes/SHA・来歴を照合した。

root独立全文再判定は全15原ZIPのSHAを元manifestと照合し、同じ共有parserと保存validatorで検証した。私有結果SHA-256は `e1d2ff9fd3d38721e852225f51c31334768bfbf4f2bf3dd8a7bd8a0ae27e0bf5`、統合parser SHA-256は `119f35382407418821c5edbbf41a2ce1340e41695d5b82bd046f8bcbcec95186`。原文・財務tuples・private HTTP本文・認証情報は公開記録へ含めない。

この検証は保存済み15文書に限定する。旧inventory所属・原本来歴のUNKNOWN、全母集団の完了は主張しない。本番反映は、資格13文書のfresh全16/all12 PREと物理保管、全列条件付きCAS、stock限定全32列POST、同文書処理の再入送信0、POST物理保管を別に検証する。
