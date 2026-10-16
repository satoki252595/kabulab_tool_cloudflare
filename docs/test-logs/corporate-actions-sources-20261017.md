# 権利処理の残差と既存原本の再利用経路

2026-10-17。[#343](https://github.com/satoki252595/kabulab_tool_cloudflare/issues/343)の残差調査。通常診断は[#441](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/441)でmainへ統合済み。[共通診断の検証](stock-corporate-diagnostics-20261017.md)と[既存権利監査](corporate-actions-20261016.md)を補う。source HEAD `9c40ba85096eb5232fa2ce0e7ccc0a969ea7a107`。新source/Notion GET・モデル・業務書込0。以下は候補抽出と最小案であり、法的権利台帳の資格化、株数や価格への適用、全量完了を主張しない。

| 経路 | 既存で保存・抽出するもの | 今不足している契約 |
|---|---|---|
| TS TDnet `tdnet/client.ts`→`ingest.ts`→`ir_disclosures` | 同じHTTP bytes/SHA/実fetchedAt、pubdate(JST→ISO)、会社code/title/PDF/XBRL URL、全tags | 公開日時は効力日ではない。effectiveDate・株数/比率・訂正元/取消状態はD1にない。primary_tagだけでは複合開示を失う |
| TS 同じPDF→`pdf-sentiment/index.ts`/`ir_disclosure_texts` | 原PDF保存と同一bytesからの抽出全文、`official-pdf.ts`のcatalog/company/publishedAt/retrievedAt/PDF SHA照合 | センチメント結果は権利資格ではない。分割・併合はdispatch skipでも本文抽出は先に行う。画像/暗号化/破損/欠測はunknown |
| Python TDnet `collectors/tdnet_yanoshin.py`→`DisclosureRecord`→Notion④ | タイトルからsplit_ratio/split_factor/effective_dateを抽出。開示日時・原本relation/取得時計と別に保存 | 分割/併合/上場のみ。増資・新株予約権・会社分割の構造化はない。整数/先頭matchで、複数比率・小数・訂正取消・実施済み状態を証明しない。価格係数に直接使ってはいけない |
| TS EDINET `list-snapshot.ts`→`ingest.ts`→`recordEdinetZip` | 一覧のdate/type/全件数・rawSHA/実clock、type1/type5別ZIP・全SHA物理照合。docID/提出者/証券code/期末/提出日時を保存 | TS通常対象は有報120/130。Python対象も120/130/140/150/160/170/350/360で、すべての発行関連書類を収集する保証はない |
| EDINET CSV39項目 `text-sections.ts` | `issued_shares_total`, `changes_issued`, `rights_plan`, `mscb_exercise`, `subsequent_events`の本文とelement/context | 39平文はHTML/表境界を剥ぐ。1項目1行をscore先勝ちで選ぶ。複数時点・株式種類・数値/精度の権威には使えない。raw CSV HTML/type1へ戻る |
| Python `xbrl_to_csv.xbrl_zip_to_tidy` | 全factのelement/context/実instant/period/unit/dimensions/value（原文文字列） | tidyにはentity/decimalsがなく、全XBRL連結・context重複は辞書後勝ち。local `xbrl_facts` mirrorはbest-effortでdimsも非保存、PK重複はlast-wins。厳密な権利履歴の代用にしない |
| TS `duration-context.ts` / `verifySavedHoldingsSource` | 同一issuer/stem/期末/DEI、instance/header実定義の一致を検査 | 公開instant readerはFilingDateInstantだけ、既存duration readerはdimension-freeのみ。株式種類のdimensionと項目固有の時点意味は別途資格化が要る |
| `universe_official_events` | delist/listing/transferの3固定kind・effectiveDate・原SHA/clock | 汎用権利台帳ではない。このkindへ増資等を流用しない |

## 純localの実原本による確認

固定3666 manifest SHA `5fa05d6ce0245679af3ed0d22dba1a371420eb700ba0a4f494dd19a025af87aa`から、7373 Chart auditと重なる4374/7203/9252の保存済みtype1を選び、全ZIP SHA一致を検査。既存Python converterをNix＋既存venv（追加install0）で呼び、全4,643 tidy rows、unit=sharesの296 candidateを観測した。これは「296発行株数」ではない。大株主・自己株・役員・保有明細・単元株数が同じunitに混在している。

- 4374/S100XUUD ZIP SHA `028e1b9276d3414ca1df0dad809f64a6012589f590632587595c8d933c238346`: 884 tidy/45 shares候補。
- 7203/S100Y8NY ZIP SHA `92a2def7b0897a3b4c4346960c67cb943086a9c81199f619977b05a1654f2582`: 2,182 tidy/201 shares候補。
- 9252/S100X7D0 ZIP SHA `4b4f1d9fbe5cb6efd836c339020c2de0110ccc0368f23847d1a9f335a02472fc`: 1,577 tidy/50 shares候補。

7203の`TotalNumberOfIssuedSharesSummaryOfBusinessResults`は2026-03-31/value 15,794,987,000/decimals=-3。一方`NumberOfIssuedSharesAsOfFiscalYearEndIssuedSharesTotalNumberOfSharesEtc`は15,794,987,460/decimals=0で、raw contextはFilingDateInstant=2026-06-10。同じshares unitでも精度と項目の時点意味が異なり、summaryを厳密な株数へ代用できない。

9252の`NumberOfIssuedSharesAsOfFiscalYearEnd...`は2,762,891、`...AsOfFilingDate...`は2,774,926。両方のraw contextはFilingDateInstant=2025-11-28で、書類の期末は2025-08-31。同一context日付をすべての数値の経済的基準日に置くと誤る。OrdinaryShareMemberとdimension-freeの両方に同値があるが、別種類・別発行体の値を合算する根拠にはならない。株数変化から分割/増資の内訳や価格係数は逆算しない。

保存TDnet実projectionの5987/1283961は「第三者割当による新株式の失権、新株予約権の払込完了、主要株主異動の取り消し」の複合タイトル。TS全tagsはfinance+訂正取消、primaryはfinance、Pythonの単一doc_typeはその他・corporate attrs全None。これは発行完了だけを確定する入力ではない。元source取得時計とupdate_historyはこの派生fixtureではunknownで、archive/readback時刻へ代替しない。fixture SHA `d8b3f6b20e00766829b6caa9db11c9ce9c1525c396c51af2ed502551e9ea483d`、元prepared batch SHA `44ac3b3d5fcbd9ad845c3a3534ecfad7aff56c69fc304970522719481be36f14`。

`saved3.json` SHA `77145048af198057a4f69947e86ea46a2fef8270c07ef6ecf963319db6e1a151`は全candidate/context/entity/native attrs/原値と各source SHAを保持する。manifestの既存source verifiedを使った候補調査であり、原取得clockや全権利資格を新規確定したとは扱わない。

## 保存TDnet 717タイトルと通常callerの確認

既保管daily prepared batch717行/317,029B（SHA `44ac3b3d5fcbd9ad845c3a3534ecfad7aff56c69fc304970522719481be36f14`）を、物理読戻しreceiptへ全bytes/SHA照合してから既存Python `classify_title` / `corporate_action_attrs`へ直接渡した。元HTTP応答として再構成せず、元取得clock/update_historyはunknownのまま。新GET・本番書込0。

明示語による権利関連候補は27タイトル、既存doc_typeが併合のものは2件。split_ratio/split_factor/effective_dateの非NULLは全717件で0だった。この保存集合では実際の誤係数採用を確認していない。未記載をNoneで保持しており、この監査を理由に新しいタイトル分類器は追加しない。

具体的な未資格の境界:

- 5987/1283961: 新株式の失権・新株予約権の払込完了・主要株主異動の取り消しが同じ表題にある。複合の一部分だけを実行済み権利へ確定できない。
- 7162/1284456: 「子会社」の第三者割当増資。提出会社の普通株式数が増えたとは言えない。
- 4735/1284407、6432/1284554: 第三者割当による「自己株式の処分」。第三者割当という語だけでは新株発行や発行済株式数の増加を確定できない。
- 4320/1284314、8141/1284208: 併合の表題だが比率・効力日は未記載。公開日を効力日へ代用しない。

共有属性parserの通常入口は`collectors/tdnet_yanoshin.py:parse_list_payload`と`collectors/tdnet_official_fallback.py:parse_official_page`。結果はNotion④・local `disclosures`へ保存される。現コードでsplit_factorを通常株価へ適用する消費callerは0。TS IRの全tagsとPython単一doc_typeは用途が異なり、カテゴリを追加するとNotion select/schema契約・同値skip・既存列のNULLクリアへ影響するため、根拠なく種類を増やさない。

既存タイトルのratio/date regexは整数・先頭matchである。将来、価格や株数へ適用する資格を作るなら、分類語と日付/比率/株数の確定を別に扱い、複合・訂正・取消・第三者・複数候補・小数・未記載は原本へ戻してunknown/HOLDとする。現保存集合で0だった値を補って改善扱いにしない。監査結果SHA `e7629533570e963da53c53699e63d3e41b0cfe7af4479613f3a11174acd10858`。

## 原本資格化の最小案（未実行、タイトル分類器の追加なし）

1. **発行株数の原文観測だけを抽出する共通純関数**。既存type1が同じingestで既に取得/検証された場合だけ再利用し、保存原本replayも同じ関数を通す。DEI/単一PublicDoc/issuer/同一stemの既存資格を再利用し、原namespace・element・context実定義・unit・dimension・decimals・value・原ZIP/member SHAを保持する。候補elementは実3社の明示issued-share項目から限定し、summary/held/treasury/unit-sizeを混ぜない。新源GETなし。type1未提供/未取得はunknownを維持。
2. **時点と株式種類の厳格資格化**。公式taxonomyで項目意味を確認してから、期末株数/提出時株数/加重平均/自己株控除の有無を別kindへ分ける。FilingDateInstantをAsOfFiscalYearEndへ読み替えず、実表見出し/書類期末を項目意味と結ぶ。OrdinaryShareMemberの既知形だけを受理し、未知dimension/再束縛/同キー多値/精度不足は当該観測だけHOLD。既存local mirrorや39平文へ戻して埋めない。
3. **報告権利候補の診断（将来の資格化）**。既存TDnet全tagsと原PDF/抽出全文、EDINET changes_issued/rights_plan/mscb/subsequent原HTMLから、発表・予定・払込/行使・取消/訂正を分ける。明記された効力日/旧新株数/原単位/訂正元が一意で一致したときだけtyped evidenceを作る。タイトルregex/単一primaryTagは候補検出に限定。元開示関係が確定しない場合はunknown。最初は既存runの物理診断ファイルへ原本参照を追加し、DDL・株価値変更なし。
4. **指標への適用は別受入**。業務上の効力日/権利落ち日/払込日/行使期間、当該株式種類、EPS/BPS等の分母と基準日、Yahoo OHLC/volume/adj基準を証明してから必要成分だけ資格化する。増資・会社分割・新株予約権をsplit_factorへ一般化せず、株数差やadj/closeから係数を作らない。#441の111 splitを一括HOLDしない。価格/出来高/約定値の原値を保持する。

初期段階は同じ取得済み原本内のCPU解析と小さい証拠参照だけで源GET/モデル/依存/DDLを増やさない。全発行関連書類の収集、原本欠測の解消、原本/判定の持続索引を別途必要とするなら、その追加通信/保管量を実測してから承認済みの通常producerへ接続する。未観測期間を完全なイベントなしとは数えない。

#343はopenを維持する。#441のコード/CIと保存原本の再生は、次の正常定時runや全法的権利対応の受入とは別である。
