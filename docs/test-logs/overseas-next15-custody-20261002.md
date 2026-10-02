# 海外売上・固定次15通の原本保管と全文資格（2026-10-02 JST）

[候補固定・metadata読取](overseas-candidate-freeze-20261002.md)で固定した15通について、単独writerの限定grantで原本確認を1回実行した。**15通の原本全文照合が完了し、数値資格は9通・57 facts、HOLDは6通**。本段階のD1/R2通信・更新、投影更新、dispatchは全て0であり、本番factsの修復完了を示さない。

## 実行範囲と結果

- 現在recordedの2通は既存pageのmetadataとhosted ZIP全文を読取り、既観測のbyte数・SHAと照合した。source再GET・原ZIP再POSTは0。legacy metadataの`_fileManifest`欠落と元source clock **UNKNOWN**は変更していない。
- 欠落13通は固定IDごとにsource GETを1回だけ行った。original HTTP request/response全bytes・実時刻をprivate保存し、共有`recordEdinetZip(force:false)`による`recorded`/`written`、actual GETのpersisted manifest、hosted全文byte数/SHAの照合を全件で確認した。13通のoriginal ZIPは合計16,940,276 bytes。別key・別source・再試行は0。
- 全文照合後の同じZIP bytesを共有`parseOverseasData(..., {capture})`へ渡し、保存集合・当期・連結true・選択候補1件・issuer/期・実単位/地域ラベルを検証した。資格9通の内訳は`ok_geo_rows`5通、`ok_geo_cols`4通、factsは57行（最大8行/文書）。部分fixtureのpositiveを全文資格に代用していない。
- HOLD6通は全てfacts 0/selected 0。保存済み同ZIPの追加通信0による診断では、`geo_present_unstructured`5通（`single-row-fiscal-mismatch`3、`unstructured`1、`contract-ambiguity`1）、`no_overseas_table`/`no-signal`1通。この実行の資格結果は保存して保留する。
- 実native通信は **111回**：source13、Notion83、hosted15。予定上限159回（13/131/15）以内。reserved111/captured111/known111を全原request/response bytes・SHAと照合し、未知結果0、protocol STOP 0、body上限超過0。Notion mutationは新原本13通のupload/page作成だけ。
- 実native時刻は`2026-10-01T19:50:12.723Z`〜`2026-10-01T19:51:56.325Z`。各新sourceのsent/header/body完了時刻は個別receiptに保持した。終了後writerを返却し、同runnerの再起動は行っていない。

| docId | custody | 全文資格・HOLD理由 | facts |
| --- | --- | --- | ---: |
| S100Y53G | existing / 全文readback | HOLD: single-row-fiscal-mismatch | 0 |
| S100W0AF | new / 原bytes保管・全文readback | ok_geo_cols | 5 |
| S100W179 | new / 原bytes保管・全文readback | ok_geo_rows | 6 |
| S100W1LQ | new / 原bytes保管・全文readback | HOLD: no-signal | 0 |
| S100W1Q5 | new / 原bytes保管・全文readback | ok_geo_rows | 5 |
| S100W20H | new / 原bytes保管・全文readback | ok_geo_cols | 8 |
| S100W2ZR | new / 原bytes保管・全文readback | HOLD: unstructured | 0 |
| S100TYYR | new / 原bytes保管・全文readback | HOLD: single-row-fiscal-mismatch | 0 |
| S100TA7H | new / 原bytes保管・全文readback | ok_geo_cols | 7 |
| S100R9AG | new / 原bytes保管・全文readback | ok_geo_rows | 7 |
| S100OH0Q | new / 原bytes保管・全文readback | ok_geo_rows | 7 |
| S100GAYK | new / 原bytes保管・全文readback | HOLD: contract-ambiguity | 0 |
| S100FHUH | new / 原bytes保管・全文readback | HOLD: single-row-fiscal-mismatch | 0 |
| S100AI6T | new / 原bytes保管・全文readback | ok_geo_rows | 6 |
| S100AO7M | existing / 全文readback | ok_geo_cols | 6 |

## 証跡

私有682 filesをmanifestで固定し、全file mode 0600、dir 0700、original/hosted bytesとreceipt SHAの一致を確認した。本文・財務値・private API response・認証情報はこの公開記録に含めない。

| private evidence | bytes | SHA-256 |
| --- | ---: | --- |
| exact single-run module | 23,302 | `7d45b3f0542933e3108b248806c4236f31a000f46e1f705f764b50b6ca04b5f7` |
| 56-pin final PLAN | 37,066 | `4a095565dd469e84699b1c035c8fecb1a32b414f3d076e3efc40fd09c52a6c37` |
| actual result / 111 receipts | 106,601 | `f2646f92f982960213aaf00696f942837c225ee9d7f192fcd70899c5d4d1430a` |
| whole private evidence manifest | 118,638 | `4f55483c5dd70f9b6775ec100953511255f2019406a94e62ea66864ab99f97f8` |
| offline whole-ZIP HOLD diagnostic | 35,792 | `56b00d6a2f5ca94696937e3a0bb5c97113c0d0d1a7c46bc62336e57a4a42aad9` |

## 残る境界

後続の通信0の診断で、S100Y53G/S100TYYRは最寄りの明示期間と実contextが一致しているのに、周辺captionの当期/前期語を一律に優先して停止する判定を確認した。またS100W1LQ/S100W2ZRは最初の海外語入り説明本文だけが選ばれ、同ZIP後続の財務本文を解析していなかった。後続本文の単体probeでwhole資格成立とは扱わない。共有処理を修正・検証した後、同じ保存原本を全文再判定する。本記録の9資格/6HOLDはその修正前の実行結果であり、原本に表が存在しないことを示さない。

旧closed59 membership、旧raw inventory所属・来歴、旧の未知予約の復元は**UNKNOWNのまま**。今回の未知結果0はこの111予約に対する証明であり、全過去のunknown不存在へ拡張しない。旧inventory総数から15を差し引いた件数や、全残件の完了は主張しない。

資格9通のD1修復は別段階である。fresh documents全16列/all facts全12列の限定PRE読取、operational PRE物理保管/readback、実PREに対する全列条件付きatomic CAS、必要なstock限定全32列投影POST、同producer再入sender0、operational POST物理保管/readbackを別grantで閉じる。本段階ではその通信・更新を実行していない。
