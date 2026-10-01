# 海外売上の可視metric見出し回帰（2026-10-02 JST）

長いHTML styleを含む実有報では、表題が可視13〜59文字前でもraw400文字の窓から落ち、非流動資産の地域表が売上候補として競合していた。既存の可視広窓の末尾160文字を近接`heading`へ使う変更で、直接の売上/非売上題名を保持した。caption・表stack・`prevTopEnd`・期/context・単位・地域・scope・選択scoreの判定処理は変更していない。期/単位だけのlayout表を推測分類するhelperは追加しない。

## 実原本による回帰

- S100GAYK/S100W2ZRの売上→unit layout→非流動資産を含む連続最小断片を、正式回帰fixtureとして固定した。原金額・期・scope・題名の注入/変更は0。取得日・元ZIP SHA・named honbun・UTF-16区間・fixture SHA・権利を[fixture provenance](../../services/yuho-quant/src/tests/fixtures/README.md#visible-metric-heading-regression)に記載した。全文ZIPはprivateのまま。
- 新6回帰では売上/資産の2候補を直接題名により売上1候補へ限定し、元売上集合を保持する。資産表だけから売上候補を作らない。資産題名を除いた明示的negative変換では`contract-ambiguity`/facts0/selected0を維持し、売上scoreで未知の競合を解消しない。
- 同じ保存済み15 ZIPの旧/新whole parse比較で、S100GAYKだけ`geo_present_unstructured`→`ok_geo_rows`/7 factsとなった。他14通のstatus/factsは全同値。TA7H/AI6T/AO7Mは非売上候補除去により`tablesScanned`だけ12→9/16→14/42→34となったため、extraction全項目の同値とは主張しない。
- S100W2ZRの旧whole parserは最初の説明本文を選ぶため、このmetric修正だけではwhole HOLD不変。実財務本文の単体probeはGAYK/W2ZRとも2候補→売上1候補/7 facts・保存集合検証PASSだが、本文単体をwhole資格と扱わない。本文pool/年度の別修正を統合した後の全15再資格は別artifactで行う。
- 旧phase1の原本保管、9資格/57 facts・HOLD6の実行結果、111予約/捕捉、source clock/legacy UNKNOWNは変更していない。新source GET、Notion/D1/R2通信・更新は全て0。本番修復・PRE/POST物理保管の完了は主張しない。

## 検証

Nixによる既存parser131＋duration18＋新metric6の155件を確認。yuho全25 suitesは393 PASS/既存private fixture条件の14 skip、typecheck PASS、変更2TypeScript filesのeslint PASS/0warning、diff check PASS。旧closed44のprivate fixtureがこの環境にないため、全44 source再解析の成功とは扱わない。

独立レビューでも本体・全caller・新6回帰・provenanceを確認し、155件をNixで再実行してPASS。2fixtureのcommentを除く全bytesが元honbunの連続区間と一致し、元ZIP/body/fixture SHA、source clockも照合した。

| private evidence | SHA-256 |
| --- | --- |
| 実metric位置・layout診断 | `cb8a6c95dfe4132a7576ed3199126397652251f0368cc06bb747fce06e10e60c` |
| 元/新whole15・実財務本文のpure比較 | `9f9798ac8f403014cf31ab9015866b4b9ca2bfa011c8f8bc36c44dff2e4c847c` |
| 実contiguous fixtureの導出 | `1c4ca9e6e77d7bcf13bbf816b21878e6dbb4ccc9d90bd4e0b83c928b5d1750d9` |
| 独立whole15比較 | `628ca475b3527bd6ed2eb4d2ea752bd9915814aa71c22e8b3a7ff71ce8bcaffe` |
| 独立fixture全bytes/provenance照合 | `03ead2702583230f9729cf33d7c70c7360060d945b938cdafbe4c5a30bbca196` |

原文・財務tuples・private HTTP本文はこの検証記録に含めない。正式実fixtureの用途はparser回帰に限定する。統合PR/本番修復の資格はそれぞれ別に検証する。
