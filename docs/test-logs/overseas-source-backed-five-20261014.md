# 保存原典を使った海外売上の5境界修正（2026-10-14）

本変更は通常の `parseOverseasData` / 共通保存前検証を修正する。企業コード・書類IDの特例、別原典へのフォールバック、欠損を0にする処理は追加しない。本番の数値・Notion・原本への適用はこの検証には含めない。

## 原因と採用条件

| 銘柄 / 書類 | 原典の事実と境界 | 修正後の読み方 |
| --- | --- | --- |
| 1379 / S100YKAZ | 当期連結の収益分解。地域行と報告事業列の行列で、地域「その他」33と非地域「その他の収益」は別。地理見出しはない。 | 唯一Japan・複数実外国地域・Other1、全事業列、全行列の印刷小計閉包、contractとexternalの同値、OtherRevenue全dash、nativeと印刷自至の同値を要求する。構造証明 `closed_geographic_rows_business_columns` を別axisとして記録。海外8,524 / 総額85,915百万円。 |
| 4290 / S100YFPN | 適格2表は同じ千円値・external行。旧判定は表全体のcontract/company語と、採用しない資産行に引かれた。 | 実採用traceの値行がexact「外部顧客への売上高」の場合だけmetric契約を揃える。異なる値行契約や地域別原額の矛盾はHOLD。海外5,005,700 / 総額70,911,322千円。 |
| 6345 / S100YBY2 | 当期連結の明示「主たる地域市場」のOther行2,339,838と、business Other列は別。 | native/印刷期・総額列・Japan一意・外国行・external総額を要求する。非地域OtherRevenue52,871を調整脚として維持し、海外へ配賦しない。海外5,371,832 / 総額59,613,734千円。 |
| 6484 / S100YH48 | 旧本番4値はMDA「生産実績」に一致。「販売価格」は評価単価であり売上実績ではない。別の販売実績とexternal行には日本30,413,597 / 中国486,164 / フィリピンdash / 計30,899,762千円。 | 可視・非continued MDAの当連結年度に「当該地域はグループ間のみ」の直接原文があり、同entity/native期間・financial連結segment表の印刷期・exact external行・同地域dashが一致した場合だけ、その地域を外部売上対象外として証拠化する。フィリピン0factは作らない。海外は印刷中国486,164のみ。生産実績は拒否を維持。 |
| 7085 / S100X61U | 当期連結の収益分解には国内親額と財・サービスの字下げ子行が併存。 | 同期native・印刷自至、external集計、全階層の親子原額区間照合を満たした場合だけ子を二重計上せず印刷親額を読む。国内36,993 / 海外572 / 総額37,566百万円。 |

金額はいずれも印刷額または明示外国地域leafの合算で、`total − Japan` による海外生成や丸め差の配賦を行わない。地域軸の構造資格は顧客所在地・販売元所在地というbasisの証明と異なる。1379について所在地basisを追加しない。

1379の独立market読解は、明示caption/note欠測を理由に保守的HOLDとした。ROOTは全row/column印刷小計閉包という上記の限定構造証明を受入条件とした。この判断差を保持し、Otherという語だけの採用には広げない。

4290の旧private分類にあった「前年同期比%列が原因」という仮説は撤回済み。実traceでは%列は除外され、問題は同scoreのfinancial2表の全表metric契約差と、非採用資産行による拒否であった。旧receiptは変更しない。

## 実原典回帰と通常経路

実保存type1 ZIPのTextBlock全文・実native contextを抜粋した修正対象5社と、異なるbasisが併存する6877の回帰fixtureを使用する。ZIP全体の代用品とは扱わず、元ZIP/member/抜粋位置・SHA・公式URL・既保管行・取得時計の既知/不明をprovenanceへ保持する。旧6484生産実績値は歴史的誤採用を示す証拠であり、正しい売上期待値ではない。

`overseas-source-backed-five.test.ts` の15テストは実5社のpositiveに加え、同値で別contract・外国leaf矛盾・地域/事業軸欠測・Other二重・非external・小計不整合・OtherRevenue正数・native期間欠測・内部限定原文の欠測/前期/別entity/hidden/comment/continued・dash以外/正数/0を拒否する。関連6suite合計189tests、root TypeScriptと対象eslintはPASS。原典メンバーの抽出位置が不完全だった6877 fixtureの失敗版とログもprivateに保全し、実親TextBlockの年度見出しを含む原文で再固定してから全回帰を通している。

通常ingest、海外backfill、missing backfillは同じparserと `validateOverseasSaveSet` に到達する。既存保存境界はstatusとfactsを同batchで更新するため、HOLDを旧source-backed値の誤値証明として扱って削除する復旧は行わない。旧本番値の変更はfresh PRE・原本資格・全既存値CAS・派生物理保全・独立POSTを伴う別の有限計画とする。6484は旧metric誤採用の訂正対象、他4社は旧原典支持値の保持・構造対応として区別する。

## 別basisの併存を区別する回帰

全3642件の初回paired replayでは旧559件の数値資格に対して新規18件が資格化した一方、6877 / S100XB5NだけがHOLDへ退行した。旧v1のコード・全receipt・classificationは保全した。原典の当期連結には、地域注記直後の「売上高は顧客の所在地を基礎とし、国又は地域に分類しております。」と、別の収益分解行列直後の「外部顧客への売上高は、当社グループ各社の所在地を基礎とし、国又は地域に分類しております。」がそれぞれ実在する。単位・年度が同じでも、別basisの印刷原額を同じ測定値の矛盾として扱わない。

原表直後の可視・非continuedな実注記が双方の異なるbasisを直接証明した場合だけ競合比較から分離する。既存の当期連結地域注記優先順位は変更せず、旧customer-locationの8factsを保持する。同basis・不明basis・コメント/hidden/CDATAだけの語は引き続き矛盾HOLDで、構造axisからcustomer-locationを生成しない。6877のprivate一次診断は `6877-independent-basis-collision-v1.json` SHA `9691c015d824dc32e7ad0b380fa10eb6829ee010fd7db43efda1c71bbc5c80cc`。marketの独立読解も両ZIP/memberの全SHAと同じ当期連結native期間を照合し、旧customer8facts保持・別basisを合算/交換しない判断を支持した。独立receipt `6877-independent-primary-review-market-v1.json` SHA `cae27cef096db2bf136583d9a8b29a52ccc59ac181462aa7fc31b8d226b3245d` を束縛する。

## 全保存原本の再対照

`source-backed-five-all3642-replay-v1/` はsource-qualified3642件をaccepted496fとv1 draftの双方で実解析して終端した。accepted parse610.458秒、draft parse611.273秒、原本資格・保存を含むwall1273.416秒、peak RSS1,807,319,040B。旧numeric559→draft576、新規18、旧numeric変更1(6877 HOLD)、955省略理由差0。旧数値退行を解消前にfreeze/PR完了とは扱わない。

`source-backed-five-all3642-replay-v2/` はbasis分離修正後の全3642件を再解析して終端した（classification SHA `2931b430ff704eceb1dcc8480a3e55e43d17d49151c85229921a54bbeaf3fd5b`）。旧559件のnumeric/status/proofは全件同値、新577件、新規資格18件、旧numeric変更0、955省略理由差0。原本全3,112,349,201Bとmetadata/DEIを再検証した。source-held24件は未証明のまま別に保持する。

18件の保存本番statusは既OK14件（rows8/cols6）、旧未対応2件、旧no_table2件だった。旧未対応731件からの追加資格は2件であり、18件全てを本番の欠測解消とは数えない。旧本番factsとの金額・主体・基準差や反映済み20との重なりは、保存D1全値と実受入POSTによる別分類・fresh PREの適用計画へ進める。数値/proof差18は新規資格18とexact同集合であり、既適格559件にbasisの付替えや根拠変更はない。

| 実測の範囲 | 秒 / メモリ |
| --- | --- |
| v2原本全SHA・metadata/DEI資格 | 42.788秒 |
| v2新parser全3642解析 | 634.771秒 |
| v2全wall（資格・保存を含む） | 689.974秒 |
| v2観測peak RSS / resource maxRSS | 1,565,900,800B / 1,534,224KiB |
| v1で実測したaccepted baseline解析 | 610.458秒 |

accepted before値/captureは同じ原ZIP/item/全SHAに束縛されたv1の実receiptを3642件全件再検証して再用し、旧baseline parseを二重実行していない。v2のbaselineParseSeconds=0は今回の省略を表し、旧処理が無償だったという意味ではない。新parser634.771秒は以前のaccepted610.458秒に対し+3.98%だが別runの比較で、同時pairedベンチマークではない。heap増量・新依存・通信・モデルを使用せず、50件checkpointと開始終了code pinsを保持した。実測/effect receipt `full3642-effect-final-v2.json` SHA `ffba8b501d7d5b6d5706aeb75972d569a6387fb6fba52943791947f715ad1a2d`。

元source集合は `source-all3666-accepted7513-20261014-v1/source-manifest.json` SHA `139357c60251364af346d225f4ba54cc93c9538d068c095b676a2e7af1926fb6`。保有表readyと原本資格は別であり、最新kind/cap版への旧parserSHA付替えは行わない。

## 証拠の可視性を共有境界で修正

独立fault検証では6484の唯一の内部取引限定文、6877の別basis注記を `display:none`・HTML `hidden`・`visibility:hidden` で包んだ6例が、旧v2で可視原文として採用された。元6fixture/ZIP・旧v2全receiptは保全した。新しい同長maskをmember全文に1回適用し、表直後注記と省略TextBlockの両入口で共有する。既知非表示subtree・コメント・CDATA・`ix:hidden`を除き、元offset/member/TB SHAと可視siblingは保持する。証拠window外からの親wrapperと入れ子も拒否する。一般stylesheet・class selector・CSS cascade全般の可視性は保証しない。新DOM依存は追加しない。

独立afterfixは同14input ZIPと同runnerで、直接6hiddenの採用6→0、通常と可視spanの4例はfacts完全同値を確認した。private `overseas-css-hidden-independent-afterfix-v1/FREEZE.json` SHA `0507446a5373f31483e97e5eb508ba0d0a65dfea71138bcb9cce273d8cccfa63`、`CHECKED_ROOT_RECEIPT.json` SHA `770fdb6c8b9e8f729221757a16a4f59c90f17d404ef3a380daf0820f6c4afe21` を束縛する。

v3は全3642原本を再検証・解析して13:29:01Zに終端した。accepted559件の数値/status/proof、955省略理由は全て同値で、v2に対する数値/proof/省略も全差0だった。新規資格18件は維持。実解析651.113秒、全wall710.088秒、peak RSS1,588,051,968B。classification SHA `46e03788be5004757a43b4f74165899c1c7b8d89ba78611fdf8e1e16555652e1`。このv3は下記MDA期間の既知穴が残るため、本番release対象にしない。全6sourceのコピーと `preserved-v3-freeze.json` SHA `111ae39d4da090865bd9b02e5d0e2c3f0082172598c51ad7b6afdfd56dd11c38` を別namespaceに保持した。

## MDAが実参照した期間・提出日時点の資格

独立fault検証では、6484のMDA opening `contextRef`だけを元の `FilingDateInstant` から実 `Prior1YearDuration` へ変更しても、旧v3はCurrentの証拠で同じ4factsを採用した。実前期2024-04-01〜2025-03-31を、当期2025-04-01〜2026-03-31へ読み替えていたことが原因である。元ZIP/runner・3caseと旧v3結果を保持する。

既存の同issuer/同filing-stem/namespace/一意宣言/header-instance一致readerを再用し、MDA参照は実durationがnative Currentのentity/start/endと完全一致する場合、または実 `FilingDateInstant` が原filenameの提出日と一致する場合だけ資格化する。6484の元実宣言はE01434-000・2026-06-23で同stemの公表日と一致するため保持する。参照名だけ、`null`だけ、別期・未知参照・欠測・不正日・別entity・namespace再定義・重複・header矛盾では資格を生成しない。`sourceContext`に元の実instant/durationを保持し、financial表の `contextPeriod` と区別して保存前検証する。提出日時点をCurrent durationへ偽装しない。

旧 `readFilingDurationContexts` の公開Mapはinstantを引き続きnullとして返す。実6社の84条件（instance/header片側・両側・欠測・矛盾等）で、旧v3とキー・値・順序が全同値である。互換receipt SHA `5b3030a65021c592d758499e67aef47a9a16292b01737b7e0ba585610e58cd3a`。actual source5の21tests＋duration18tests、受注の通常callerを含む関連10suite252tests、root tsc・対象eslint・diffcheckはPASSした。

独立MDA afterfixは元3input ZIP/runner bytesを再用し、元instant/currentは修正前後4facts同値、実priorだけHOLD/0facts、実sourceContextを確認した。`overseas-mda-context-independent-afterfix-v1/FREEZE.json` SHA `d2397ba8da6fa34651fc282674f9764a6762e61639fa15fae017d36fc240e0c0`、`CHECKED_ROOT_RECEIPT.json` SHA `774e215d3b5e8732f168b03211eefe60770b14fd626efcdb3636bf55b1261069`。

v4は全3642原本を実再解析して13:44:45Zに終端した。classification SHA `ad054d90a3cf03e31c28d0a6ce2853c56b22dc13edb0795b0c634c6daf49d13f`。accepted559件の数値/status/proofは全同値、955省略理由も全同値、新規資格18件（合計577）は実測結果として維持した。v3に対する数値/status差0・省略差0、proof差は6484の実 `sourceContext`追加1件のみ。別プロセスで旧accepted/V3/V4の全個票SHAを再照合し、559件と955件の原値同値、6484原fullZIP内の実instant宣言と追加証拠の一致を確認した（receipt SHA `c474ef8857b364e33120f8e79a59c216b5e7f76424daf3b335fac8cbe43532e6`）。新18の件数をguardで強制していない。

| v4実測の範囲 | 秒 / メモリ |
| --- | --- |
| 原本3,112,349,201Bの全SHA・metadata/DEI資格 | 42.093秒 |
| 新parser全3642解析 | 652.820秒 |
| 全wall（資格・個票保存を含む） | 711.549秒 |
| 観測peak RSS / resource maxRSS | 1,584,300,032B / 1,558,544KiB |

v3実解析651.113秒に対し+0.26%、別runのaccepted610.458秒に対し+6.94%。いずれも同じ保存集合だが同時pairedベンチマークではなく、他のローカル処理・cache状態を同一とは主張しない。v4でも旧baselineを二重parseせず、旧全SHA付き個票を実再検証して再用した。heap増量・依存追加・上流GET・Notion・モデル・本番書込は0。source-held24件を未資格のまま分離し、旧receipt/parserSHAを新しいものへ付け替えていない。

次の有限反映は本文保護済み955件とsaved189+新18のexact集合交差に限り、既受入safe20と重複しない候補15社を準備する。2695は原表の公表計245,109百万円とleaf合計245,108の丸め差1を維持し、旧writerがleaf合計から導いたとまでは断定しない（market一次読解receipt SHA `89126fa8dd5505c9ef8e028a07c4c2870e372ef9561c2b6d907fe8c010ae7afc`）。未保護本文・主体不明・未受入parserのまま適用せず、新accepted main・fresh全6表/本文props/保存原本資格・物理PRE/POST・atomic CAS・別プロセスPOSTを別gateで必要とする。
