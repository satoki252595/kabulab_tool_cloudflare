# 海外売上: 減損損失TextBlockの誤採用防止 (2026-10-14)

7741 HOYA、訂正有報 `S100YD7J`、会計期末 `2026-03-31` の保存済み原本で、
地域別の減損損失を海外売上として採用する経路を確認した。地域別減損額の
総額54,405百万円、海外52,873百万円は算術検証を通過するため、金額の整合だけでは
売上であることを証明できない。表題が遠く、表頭にも減損の語がない一方、原文の
囲み要素は `NotesImpairmentLossesConsolidatedFinancialStatementsIFRSTextBlock`
と明示していた。

共通パーサの候補生成前に `NotesImpairmentLosses` の原典TextBlockを除外する
チェックを加えた。値・期・連結区分を推定する処理は追加していない。
本書はコード検証の記録であり、本番データへの適用記録ではない。

## 原本と本番状態の照合

- 保存済み `S100YD7J_xbrl.zip`: 900,565 bytes、SHA256
  `64702c66c7e4da25a4570f25b78b098aa68d635bf14113839c109a6cb5a9f124`。
  Notionの既存物理添付を読み、docID・提出者`E01124`・期末を保存metadataと照合。
- 対象本文は `XBRL/PublicDoc/0105010_honbun_jpcrp030000-asr-001_E01124-000_2026-03-31_02_2026-06-17_ixbrl.htm`。
  本文SHA256は `c20e15a60001597fe1de95a4f7471c9733c42c88a1603ca44e03c4b355e97a9c`。
- 原典の `CurrentYearDuration` は entity `E01124-000`、
  `2025-04-01` から `2026-03-31`。既存診断HTMLは原本8本文のLF結合と完全一致。
  単一本文と比較して停止した最初のread-only記録も保全し、別v2記録で来歴を確定した。
- D1文書ID35031は `geo_present_unstructured`、該当文書の海外factsは0件。
  この誤採用値は本番へ未保存だった。銘柄全履歴の海外facts20件を、この文書の
  factsと混同していない。
- 原本照合はv1/v2合計Notion2読取、D1 4読取、保存添付2 GET。
  取得元API GET・モデル・本番書込はすべて0。

## 実データの回帰と費用

2個のfixtureは原本TextBlockの連続区間をそのまま抜粋した。fixture頭注に
原本ZIP SHA・本文名・UTF-16区間を記録し、期・scope・金額を注入していない。

- 修正前: 減損除外テストが `ok_geo_rows` を返して失敗、対照2件は成功。
- 修正後: 海外parser・metric-heading・新TextBlock回帰の3 suites / 140 tests成功。
  save-rows・duration-context・split-body・fiscal-captionの4 suites / 41 testsも成功。
- 全体TypeScript型検査成功、変更した2コードファイルのESLint警告0。
- 同一原本ZIPの再実行: `ok_geo_rows` / 6 facts から
  `geo_present_unstructured` / 0 factsへ変化。通信0、186.037ms。
- 保存済み派生HTML113文書 / 446,469,779 bytesを通信0で再診断。
  修正前4.306秒、修正後4.665秒、後者peak RSS 467,320,832 bytes。
  海外診断が変わった文書は `S100YD7J` だけ。受注診断は不変。

HOYAの正規地域売上TextBlockは候補探索に残る。その表の
`中華人民共和国`・`大韓民国`・`その他`・`外部顧客からの売上収益` は現行reducerで
未分類のため、今回も正直に未構造化となる。未分類額を外国として補う変更はしていない。
この表の構造化は、全量署名分類後に原典で国名別名・総額・地理scopeを証明して
別の実fixtureで対応する残課題である。未対応表を最終的な完了件数に含めない。

private検証記録: `tmp/feature-audit-20261013/disclosures-recovery-finish/` 内の
`metric7741-source-v2/{qualified-original,diagnostic-cache-origin,fixture-derivation,fixed-replay}.json`、
`parser-cache-diagnostics-v{1,2}.json`、`metric7741-*.log`。
事業タグの既存13/3ファイルfreeze・source-repair35 v4入力pinsは変更していない。
