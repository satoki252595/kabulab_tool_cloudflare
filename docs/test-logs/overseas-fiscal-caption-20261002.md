# 海外売上の最寄り明示期間とcaptionの期語 — 2026-10-02

取得済み原本を通信0で診断したところ、S100Y53G/S100TYYRの単一行売上表は、最寄りの明示期間の開始・終了・当期/前期区分が同じ有報の一意な実XBRL contextと一致していた。一方、captionのその期間より前に残った反対の期語まで一律に判定していたため、文書全体を`single-row-fiscal-mismatch`で停止していた。

実contextを使う限定分岐で、期語の検査を最寄りの明示期間の先頭から表までに絞る。明示期間がない場合は従来どおりcaption全域を検査する。明示期間の後に現れる反対期語、開始/終了/区分の真矛盾、未知・重複・提出者・dimensionの未証明は停止を維持する。表の数値選択、地理未分類、連結範囲、丸め・集計照合、本文の選択は変更しない。

## 検証と限界

- 連続する実原文抜粋3件と同filingのactual context projectionを追加した。来歴・原本SHA・取得時刻とそのUNKNOWN境界・抜粋位置・fixture SHA・原典の権利は[fixtures README](../../services/yuho-quant/src/tests/fixtures/README.md)に記録した。全ZIP/全文診断/財務値のレポートは公開しない。
- 新9回帰と既存duration-context/parserの149回帰、計158件PASS。Y53G/TYYRの抜粋は前期/当期の2表が期間矛盾で止まらず、既存の地理未分類HOLDへ進むことを固定した。この最小抜粋自体を数値資格成立の証拠にはしない。期間より後の反対期語、開始/終了の不一致、rangeのないFHUHの当期/前期混在は停止する。
- Nix経由のyuho-quant全25suiteは396 PASS/14 conditional skip。typecheck/lintもPASS。
- 同じ保存ZIP15通の新PURE/OFFLINE再判定では、Y53Gは`ok_geo_cols`/4facts、TYYRは`ok_geo_rows`/7facts。両件は全factsの当期期末・連結範囲が既知で、共有save-set検証PASS。他13通のextractionは修正前と全項目一致し、元9通/57factsも不変。FHUHは`single-row-fiscal-mismatch`、本文選択未対応2件・contract曖昧1件もHOLDを保持する。
- 新全文比較の私有証跡SHA-256: `f19c0141c19aafc48038035dc0b809ac1b1a79c51e69f682d3c733980ba2c521`。元phase1の9資格/6HOLD、原本・資格・通信ledgerは変更していない。新source GET・Notion・D1・R2通信はいずれも0。本番のfresh PRE、全列CAS、POST全文保管は別にレビュー・実行する。

全母集団や過去のUNKNOWNの解消、既存D1値の誤り、修復完了は主張しない。
