# 受注表の分割本文選定修復 — 2026-10-14

261A / S100XTPW の実 type1 原ZIPでは、先頭の 0101010 本文に受注語だけがあり、受注表は 0102010 本文にある。旧 `pickHonbunHtml` は先頭の受注語で本文を選び、`no_order_table` になっていた。

`parseOrderData` で全分割本文・全 native table を先に検査し、当期・連結区分・受注/残高列を資格化してから単一の factset を選ぶ。明示された前期表は当期候補から除き、同じ scope の適格表で値が矛盾する場合、または期間/scope が不明な数値候補がある場合は `table_unrecognized` と `holdReason` を返す。同一 factset の複数掲載を合算しない。連結表と個別表が両方ある場合は、全検査後に連結 contract に限定する。本文名は順序に依存しないよう整列する。

建設業B表の全行が印刷された絶対「至日」に束縛されて採用期を含む場合は、その実日付で資格化する。前/当年度という相対ラベルだけを持つB表は、同じZIPの当期 duration が一意のときだけ採用する。reducer が呼出引数から生成した facts を期間証拠にしない。実1812からdurationを除去し誤った期末を与えた回帰で0factsを確認した。

相対表題「当連結会計年度の受注実績」は、同一 filing stem の実 duration 定義が当期について一意の場合だけ日付へ結ぶ。`FilingDateInstant` など contextRef の名前、呼出元の期末だけで当期を推定しない。直前の「提出会社単独/個別」「当社単体」や提出会社の明示行を、別の前段落の連結説明で上書きしない。

実原ZIPの SHA は `df58b791f3d9f35df9fa77a32e6e6576f2d611e0c2f1cec3aae882568b10e4c5`、1,129,985 bytes。原本 custody / native DEI / 会計期末と member SHA は fixture provenance に記録した。原本 manifest が歴史的に無い状態は unknown のまま保持した。採用結果は当期 2025-12-31・連結・千円の4行（水道 / 下水道 / 河川その他 / 合計）。合計の受注高26,518,720、受注残高24,759,735は原表の印字値であり、別表の合算ではない。

1431 / 1815 / 1925 / 1812 / 1803 は実 PublicDoc header と 0102010 honbun member の原バイトから作った gzip fixture を使用する。これは member subset と明記し、原ZIPの代用原本とは扱わない。原ZIP SHA と member SHA を provenance で固定し、テストでも検証する。破損・矛盾テストは実 member の明示的な変形入力で、EDINET原本とは主張しない。

`tablesWithHeading` は既存 overseas-parser の traversal を html-table に移設した。元の html-table モジュール全文が新ファイルの byte-identical prefix、移設関数本体は export 以外 byte一致。既存保有表 parser の意味を変えていない。market 担当へ依存/source pin を連絡済み。

全本番 caller は `services/ingest.ts` と `data-scripts/lib/missing-backfill.ts`。両方が同じ `parseOrderData` を呼ぶ。単独 HTML の診断/既存 fixture 用 `parseOrderHtml` と reducer の金額選択は維持した。

検証: order / ingest atomic / missing backfill / backfill atomic / overseas / shareholdings / text sections の14 suites・294 tests PASS。full TypeScript / 対象4ファイル ESLint warning0 / diffcheck PASS。

保存済み資格済み type1 128 原ZIPを offline 実測で再解析（23.292秒、通信・model・本番write 0）。16差分の内訳は、261Aの4facts新規取得、13社の金額/期同値の scope 確定、1938の `orders_only` 明示、1435 / S100XSYDの期間未知HOLD。1435は実表がある未対応残課題であり、非開示や復旧完了とは扱わない。この変更を理由に既存本番factsを消す適用は行っていない。残り原本の署名分類・parser対応・fresh PRE/適用は別の固定 cohort として進める。

本作業は保存原本の offline 修正・検証のみ。本番 Notion/D1 書込、原典 API GET、モデル呼出し、新依存は0。source35 v4 の事業タグ本体/共有 writer の code pin は変更していない。実適用には受入 main の source pins、最新 D1、完全 PRE の物理保全、未知結果 latch、旧値照合が別途必要。

本番D1の15対象・200 rowsを2 SELECTで確認（0.156秒、Notion/source/model/write 0）。12社は既存54factsの金額/期同値でscopeのみ要訂正。1815は現本番未対応/facts0から6個別facts、261Aは0から4連結factsへ回復候補。1435は旧2factsの期間資格が未成立であり、資格確定または完全PRE付きの明示保留訂正が必要。通常ingestは既存・forceなし・本文pointerありならDB置換をせず、raw custody不足だけの再取得でも旧factsを保持する。ただしforceまたは欠損pointer回復のDB作業は、未知HOLDの空factsも文書upsert＋旧facts DELETEと同一atomic batchで確定する。missing CLIもforceなしなら既存docを入口で除外するが、processMissingDoc/buildMissingDocStatements自身は置換契約である。全量force実行を本修復の代用にせず、対象別に完全PRE・原本資格・期待payloadを固定する。
