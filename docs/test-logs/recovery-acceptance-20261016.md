# 2026-10-16の追加受入

追跡は[#348](https://github.com/satoki252595/kabulab_tool_cloudflare/issues/348)。この記録は以下の対象の実測であり、全20機能・全空欄の完了を意味しない。

## 10月17日06:30 JSTの追加確認

保有株の次22文書383行も通常処理・全60実ファイル・全POST・旧原本/旧値の保護をroot別実行で閉じ、累計59文書703行を受け入れた（価格は別）。本文2,417社の先頭50社も全1,213 native、通常publisher物理PRE、保存済み全POSTと永続closureをrootで独立照合し、残2,367社。海外20文書105数値の受入は維持する。私有root最終SHAは保有`a9c9f96685df4e738a3a40eaa88e48b7ebb1cf58211f89dafa73108d3398c15a`、本文先頭50`b1239b629a17bad6322bf8e5f3f5ba1ef279a5a848aa7f082d7c6c3bbe8bb29d`。

Clefは06:27:22に104社/106 exchange/580問の保存を完了し、単一owned子の終了と全6ファイルのSHA・実wire・通常client再生をrootで確認した。新forward104・旧同入力replay2、ピークRSS20,721,287,168B・swap増0・HTTP0。生成のroot最終SHAは`406e7366319e3e8180574e6da9b6368ba13770e8e27cee3d0aeef90ad617a85c`。全本文処理後のfresh入力資格と意味結果の通常公開は未受入であり、104社公開済みとは数えない。

#462の初回CIは実4502の跨run回帰2件が5秒超過で失敗した。1.3MB PREをassertionライブラリで要素ごとに比較していたため、同じ全文バイト一致をNode標準`Buffer.equals()`で検証する。timeout・全原本・中断/再送禁止のassertion・本番コードは変更しない。同Nix/依存lockの単独29件は6.38秒から0.190秒、対象3件は2,544/2,531/1,240msから39/37/42msとなった。CI全体と本番処理速度の削減率へは転用しない。

## 10月17日06:18 JSTの追加確認

| 対象 | この時点の受入・確認 | 残件 |
|---|---|---|
| 補足DBの全体計画 | active3,687社・latest年報3,666・補足3,712行を、43読取/書込0で通常plannerへ渡した。本文同期2,417・再判定104・skip1,165・新規1へ分類し、固定776＋135社との交差0を独立確認 | skipには原本HOLD20が含まれ、新規648Aも原本HOLD。原本HOLD計21を完了にしない。1,145のmetadata skipも旧意味判断の再検証完了ではない。全量の同時snapshotではない |
| 本文同期2,417社 | #461の通常publisher修正をmainとMac定期入口へ反映。海外20の通常適用と別normal inspectを閉じ、06:16:56に49組の通常機械処理を一度開始 | 受入への加算0。各組の物理PRE/CAS/全POSTと独立保存監査、local closureを閉じる。19時の絶対期限・同じ実入力・再送禁止を維持 |
| 事業タグ104社 | 保存原本・全旧props・原時計を855読取で再確認し、全native SHAと通常readerをrootで通信0再生。全104が実入力変更。新旧consumerで全入力・580質問/106 exchangeのwireとtoken layoutが一致し、06:11:26に単一ローカルClef子で生成開始 | 意味結果の公開0、部分出力を104社完了に数えない。旧102社の不明な判定入力SHAは補わない。生成はHTTP0・最大106 forward/8時間/RSS32GiB/swap増1GiB/19時で停止し、通常公開は本文chain全閉鎖後 |
| 保有株式の原本列 | 最初9文書91行の全通常/物理PREPOST・原本49の保護・旧prefixを閉鎖し、歴史受入は計37文書320行 | 次22文書383行は通常`applyLatestHoldings`一回で進行中、受入への加算0。旧312/新71・保護旧39行・原本58・原本HOLD19を保持する。価格の受入とは別 |
| 海外売上 | #460の通常保存cohort CLIで先頭20文書105数値を反映。全6表PRE/POST、20 ZIP/本文、20原子SQL、PREPOST2実体、20 claimsを全947 nativeと別normal inspectまでroot独立照合 | 次after3779、残146数値文書と主体HOLD10。残146は既存上限20で8組・約5時間＋変動の条件計画。次保有0.75枠への切替え前は追加HTTP0 |
| 株価41銘柄 | 実10/16 batchと38gzip/118,249,845B・全7,375 member・41 Chart＋41 Quote＋N225を保存全文から照合。通常parser拒否0、N225はfresh、41社の当日OHLC/調整値/出来高は全NULL | 41社の最新正値は10/15。公式の同日売買なし・停止・廃止分類は不明。前日値や0で埋めず、8303の過去RSI245本HOLDとも分ける |
| 歴史RAW索引 | failed46の原ACK不明を保持。normal inspect48と追加D1一行読取で、現state位置14,412/残64,420、inflightなし、直前原本/実15列の履歴、active/state前後同値を照合。通常run38966887308を単発dispatch/204 ACKで再開 | failed46の処理件数をcursor差で作らない。元pool起点・最大200を保持しop49/continue151、実行指定9cdfを継承。workflow head e4cとは分けて終端logで確認する。新coverage加算と最終78,832件anti-joinは未受入 |
| 本番配備 | #460はmain2bac、05:32:30/version442dddec。#461はmain e4c1a7e3、06:01:27/version4224e38d。Macは06:02:20に同e4cへ更新し、旧f3の1,560 source/旧.env、104観測の31source/6依存を全SHA保全 | 同calendar/kernel writer/state/依存lockを維持。監視accepted revisionは06:03:05更新/CLI ACKまでで、次20/21時の定時receiptは未受入 |

#461は物理PRE archiveの最初のmutationより前に、canonical stateへfull PRE/intentを0600・排他的作成・fsyncで保存する。全読戻しと旧根拠退役後だけclosureを追記し、未閉鎖・不正stateは次runのmetadata/model/HTTPより前に停止する。追加API・依存・モデル0。実135のPRE分布を循環した2,417件規模の測定storeは1,452,878,631B、初回scan4,073.54msで、4GiBを超えれば停止する。将来の分布・最悪scan・全量完走を保証しない。測定用storeだけを測定器が削除し、実source・証跡・測定器・結果は保持した。初回createと版更新の未保護経路は[別の残件](biztag-sticky-publication-20261017.md)として残す。

同時Notion枠は、現在の保有1.0＋本文1.7＋RAW0.25＝2.95 req/sを上限案とし、海外20のinspect終了までは本文を開始しない。次の保有計画を0.75へ切り替えた後だけ、海外0.25も同時に予約できる。GPU生成はHTTP0で並行し、事業タグの通常公開は本文chain全終端後に行う。今回だけの全件照合を毎日の定期処理へ追加したものではない。

海外20の3段階は947 requests/Notion585/SELECT318/atomic20/hosted24、retained response79,041,024B・D1 read174,616行・実1,494.80秒（Notion0.4rps）。新源取得・モデル・価格/補足更新0。残146の20件上限を拡張せず、全146/888数値の8組計画を保存した。約1.275M reads/3,533 writesの条件費用は[公式D1単価](https://developers.cloudflare.com/d1/platform/pricing/)で約$0.005だが、契約・含有枠・当日残枠は未確認。全targetsのfresh資格、各1800秒/caps/独立inspect後のadvanceを維持し、完走保証にしない。

private root receipt SHAは、全体planner `abf57183e7026525140b4bbde23cf1b3e74d3754e87a542476d8be9ec48bb1f8`、104原本 `958e971fc93cc66a2ab742feb18e4beaa3628108e65d4280acdeeda8ba1cb9fe`、保有91 `09c67096871fe666e36dcadad2a374933d798bf57aa0faadd73734d14cb65f5c`、海外20最終 `740e963da2a6e95ba5c8c91453dae8ef2cf059b76f686eb4cdf5a01e64e6fa86`、stock38物理 `4b5409af3554678d527c276bd3bab0c29c8ec5a694f6365c07f429b785b89b06`、RAW48 `a45fde1da4b051f7d08706791bd19de61235b5b50a3ff6088ba5799d60cc25a3`、Mac新配備 `78cdfda2e51cf1e7f83a70825068717b1007604797fc9dc9cd5ed350164713c4`。本文root releaseは`0b26b08cb30f9812fbf64d567baab78191c8fd5f4f4ed38f4737b953c5caf77a`、GPU root releaseは`2731d2ac57a3453913c66434e1bc3ff1088619a35d34d15e9eab8ad955286c1f`で、開始許可を結果受入へ読み替えない。原文・秘密値・署名URLはGitへ入れない。

株価41の次原典候補は[JPX日報の相場表](https://www.jpx.co.jp/markets/statistics-equities/daily/01.html)で、公式手引きは翌営業日掲載と、数値なし・未上場/制度上なしの記号差を定める（10/17確認）。当日相場表をまだ取得しておらず、41社を売買なしと分類しない。

VWAP残1,656・日足3原本HOLD、優待の条件意味対応/公式照合、競合の意味判断、原TDnet PDF1件、権利処理#343の単位/増資/併合等、次の通常定時全量は引き続き未完。保有の法的株数基準不足5,362件は欠測理由を保持し、5,362件すべての誤価格が確定したとは扱わない。全20機能の最終受入へ広げない。

## 10月17日05:12 JSTの追加確認

| 対象 | この時点の受入・確認 | 残件 |
|---|---|---|
| 競合候補の本文 | 先行776社と交差しない固定135社すべてを通常`--mechanical-only`で同期し、原39列・Notion表現SHA・旧判定/根拠・source・物理PRE/POSTをrootで独立照合 | 固定135の残0。業務PATCHは139で、社数と分割PATCH数を混同しない。意味判定と全市場の充足は未証明 |
| 海外売上の追加15文書 | 82数値factを共通parser/原子D1で反映し、全6表POST・原本文・現原本・2実体PRE/POSTを別のfresh POST読取とroot再生まで受入 | 固定候補の残176は連結数値166/主体HOLD10。本文3,666の歴史受入と166のmembershipは一致するが、現在latest/source/全6表PREは未資格化 |
| 保有株式の次50文書 | 通常prepareの実50ZIPと199 nativeを独立照合し、31 ready/474行・19 HOLD。最初9文書91行は通常resolverで旧83/新8/保護旧3行をfresh確認 | 本文全writer終端後、05:11に91行の通常反映を1回開始。完了へ未加算。続く22文書383行は計画のみ。価格の新規確定とは別 |
| 入力比較と権利処理 | #457は04:53:22に配信。#458はmain `f3a7c738`、05:11:00/version `51915326-5f92-4428-9780-07810b3be514`へ配信 | 同じ既知4節SHAならモデル0。価格の法的日付/株数単位が不明ならunavailableを保持。5362件の単位証拠不足は別の残件 |
| Mac通常環境 | 05:10:51にmain `f3a7c738`へ更新。旧65579の1,549 source/旧.envと本文135の34 runtime証拠を全SHAで保全。同lock/calendar/state/依存lockを維持 | accepted revision監視はCLI ACKと更新時刻まで確認。新20/21時の通常receiptは未受入。全体metadataと24対象の実原文再確認は別工程 |
| 歴史RAW索引 | run38953333099の500 verified（既完22/新RAW・index478）を保存manifest・全実ログ・正常継続payloadでroot独立再生。cursor14,055/78,832・残64,777 | 元pool45番目から46番目へ継続。全遠隔raw/state/index bytesはexportされておらず、最終anti-joinと全量完了は未受入 |

海外15のroot最終SHAは`615c89ba95627611d48f86574cd693264050cb2308f360845d68637489c69bd0`。v5適用347 native/299.958秒と、別fresh POST105 native/265.488秒で、旧本文・全6表・1379のcanonical原本lineage・2物理添付を照合した。適用はD1 read210/atomic batch15、Notion read114/archive mutation6、hosted2、要求3,879,662B/応答9,701,926B。別POSTはNotion67/D1 36/hosted2、要求4,601B/応答11,502,774B。元v3 STOP123要求とv4 PRE160要求も含む復旧全体は735 nativeで、上流API・モデル・補足更新・価格更新0。v4 writer observerの同SQL異paramsがMapで上書きされる問題は送信前の純検査で発見し、exact SQL+params集合へ修正したv5だけを一度実行した。旧manifest/停止を保持する。

本文135のroot最終SHAは`96ac165747d4c3a3a01eefc8cc99abfe52a67962e77612fb3a3708f14a8a21f8`。全3batchの原code/docId集合・重複0・先行776とのcode/doc交差0・親process正常終端を確認し、05:10:26に閉鎖した。実3,867 native/Notion3,309・応答640,346,725B・業務PATCH139、モデル/上流API0。135社分の通常publisher物理PREと外側PRE/POSTを全bytesで再生した。runtime変更後も原source/dependency/env証拠を安定private pathで保持し、合計911社を同時全市場snapshotとは呼ばない。

保有の通常prepareは492.583秒、D1 SELECT1/2,430 rows_read/4.0976ms、Notion148/hosted50、要求8,902B/応答45,576,082B。原ZIPは44,371,908B。first91資格は197.830秒/69 native（Notion60/D1 9）、要求14,859B/応答760,725B・D1読取420行、業務書込0。異なるafter/limitの旧実測との削減率比較はしない。HOLD19と余剰旧3行を成功へ足さず、先行受入28文書229行も保持する。

権利処理は[分割単位の実原本と影響](holdings-split-legal-basis-20261017.md)を参照。rootでも22,755候補/116 gzipを同じ共通資格で21.978秒・HTTP0に再生し、旧qualified12,209のうち同値6,847/新unavailable5,362が全結果一致した。新たな誤価格5,362件を確定した値ではない。追加792 issuer読取案は採用せず、canonical splitは既存の資格済みrun-cacheだけ再利用する。cold時の追加issuer D1/Notion ZIPは0。原価格・株数への係数補正と今回の新規本番価格受入は0である。

RAW45は2,404.338秒・原本観測転送292,152,673B・Notion10要求・D1 read1,456/index INSERT478、上流GET/モデル/Notion mutation0。実workflow headとcheckout実行版は共に`9cdf4f04`、checkout markerと全guard成功を確認した。通常continuationは同実行版・残154枠を維持し、新child46のworkflow head `a7de918e`とは区別する。root replay SHAは`f345d5c2e6fef548b13de746a94496235bf9f5900349ddbee026c8c8029a51aa`。child終端のcheckout実ログはまだ未受入であり、追加dispatchはしていない。

株価の残41社は、10/16通常logの全membership・受信時計・当日bar NULLと、10/14保存済みChart/Quoteを共通parserで純照合した。41社とも10/16対象日とlatestBarDateが一致し、受信は18:18〜19:12 JSTで、日付跨ぎバグを示す証拠はなかった。10/14の33社取得/8社NULLを16日の取引有無へ転用しない。16日の原応答・公式売買/停止事実が未確認なのでsource HOLDを維持し、前日値/0/生成値で補わない。

追加private証跡は10/17 audit rootの`B135-first5-mechanical-v1`、`B135-first5-finite-runner-v1/root-final-acceptance.json`、`mac-mechanical-input-rollout-v4`、`holdings-prepare50-after1719-b8fb-v1`、`holdings-pilot91-{qualification,apply}-b8fb-v1`、`holdings-rights-date-investigation-v1/impact-v1`、`stock41-saved-diagnostic-v1`、RAWの`raw-ordinary-after-repair-38947608942-v1/bulk45`、10/13 audit rootの`overseas-next15-protected-{read-v4,apply-v5,independent-post-v5}`。#456の実deployは04:34:45/version `c4c4dbf9-0c96-4c97-812b-d80805703160`。定時receipt・全20機能は引き続き未完である。

## 10月17日04:25 JSTの追加確認

| 対象 | この時点の受入・確認 | 残件 |
|---|---|---|
| 事業タグ本文 | 固定776社の全件を受入、残0。新runtimeの残169社を48/50/50/21の通常機械処理で反映し、原計画のcode/docId全集合・重複0・83証跡の全SHAを04:03:10にrootで閉鎖 | 意味判定・競合判定とは別。各時点の個別PRE/POSTの合算で、同時全市場snapshotではない |
| 保有明細原本列 | 追加5文書16行を通常publisherで反映し、04:07:48にrootで全250 native・全POST・10実ファイルを独立照合。計28文書229行、今回の旧9/新7・保護旧2行は不変 | 価格は未受入。原表HOLD12文書を保持し、次50文書/最大91行はまだ本番反映していない |
| 保有prepare SQL | #451の通常prepareでafter1515/limit17を実行。1 SELECTは631 rows_read/6.4575ms、5 ready/16行・12 HOLDを原本17ZIPと照合 | 旧paired after145A/limit20とは選択範囲が違うため削減率を比較しない。全量の所要は未受入 |
| Mac通常環境 | 04:16:47にmain `65579f60`へ切替え。旧117bの1,542 source・旧.envを全SHAで保全し、旧入口だけ無効化。同calendar/kernel writer/state/依存lockを保持。監視側accepted revisionもCLI ACKと更新時刻を確認 | 新版の次20/21時通常receiptは未受入。旧定時receiptを新しいSHAへ書き換えず、監視の欠測条件も緩めない |
| 競合入力の最初の5社 | 通常CLIで130A/138A/145A/153A/155Aの入力を準備・物理保管し、通常helperでcursor155Aまで閉鎖。候補・qids・資格不足を保存 | 5社とも選出Bの資格不足でHOLD、ready0。候補を削って成功扱いせず、モデル・競合relation/確率更新・定時receipt作成は0 |
| 事業タグの残分類 | 固定145社を通常readers/plannerで04:23:55に読取確認。旧B23は文書変更再判定候補22/資格済みskip1、定時資格HOLD23は本文不足HOLD20/同文書入力確認2/本文未取得1、旧skip99は全99 skip | metadata照合のみ。資格済みskip100も原4対象節・business・全39値は今回未観測で、判定入力の全検証済みとはしない。本文不足HOLDは計21社 |
| 海外売上の次15文書 | 現原本15ZIP/12,767,433B・最新doc/主体/期末/本文を通常読取で再資格化。160 native（Notion109/D1 36/hosted15）、273.058秒、書込/モデル/上流API0 | 数値反映・全6表POST・物理PRE/POSTの受入はまだ。旧v3の12件途中STOPを全15の受入へ流用しない |
| 歴史RAW索引 | 同一poolの明示1回修復→通常apply1→inspectを受入。cursor13,555/78,832・残65,277。#454の実行commit固定後、run38953333099を元pool45番目として1回起動 | 500/2GiB/新規受付3600秒・continue155・元最大200枠を保持。実行中の件数や最終anti-joinは未受入 |

本文最終集合のroot受入SHAは`788b60f2ad2754701fdf30f5c8f7a8b63803819a5c35467e4a2c04476c023359`。先行155＋450＋停止2件の読取閉鎖＋新169＝776で、実入力変更211Aのモデル判定1社は重複加算しない。本文の全writerは終端し、旧STOP/unknown/原文は保持した。

保有16行は154.484秒、Notion215/hosted15/D1 SELECT20、D1読取1,168行/12.347ms、要求3,912,392B/応答11,703,575B。実mutation56・新record17・物理10ファイル3,644,167B、通常receiptのSHAは`b4df56886d0749f3f3d89c307d4cf37a210c92aeb023648b7c4cee720d96ad7a`。通常終了値1は計画済み12 HOLDを表し、成功文書へ加算していない。準備・資格確認の読取はこの適用の250 nativeとは別に保存する。

競合準備は193.76秒・CPU27.43秒・child peak RSS2,378,465,280B、Notion52要求（全HTTP数ではない）。gzip18,326,463B/展開JSON68,343,379B、全3,712選定metadata/151除外と3,561 corpus、消費238件の39本文を保存した。5社自身は資格を満たすが、選出Bの135 uniqueがHOLDである。通常CLIの物理検証receiptと保存gzipの別process再生を区別し、追加のremote物理GETは行っていない。全33社や毎日の所要への換算はしない。

145社の読取は8 native（Notion4/D1 SELECT4）、応答9,126,985B・D1読取51,706行、モデル/業務・schema・原本保管書込0。同文書入力確認の6038/9344は既知4対象節の実SHA比較を先に行い、意味変更がある場合だけローカルClefへ渡す。20社の`kind=skip`にも`qualificationHeld=true`/doc=nullがあり、通常完了skipとは区別する。648Aと合わせた本文不足21社は生成で補完しない。旧skip99のうち保存receiptがあるものも未検証来歴を保持する。競合候補Bの135社は保存入力の通常計画ですべて本文同期対象であり、モデル必須とは証明されていない。別の有限通常機械処理で同期後に再資格化する。

海外v3読取は13件目1379/S100YKAZの前でSTOPした。先行の保有移行で正しくtyped一次保管へ移った原本IDを、今回の読取guardが旧legacy IDへ固定していたことが原因だった。通常resolverは変更せず、exact keyの一意query・旧IDへのsource lineage・同ZIP SHA/size・同主体/期末・唯一添付を保存応答で証明したcanonical IDだけ許可するv4に修正した。v3の123 native/12途中結果・元manifest・停止原本は保持し、v4は別namespaceで一度だけ実行した。

RAWのinspectは11 read/4.953秒、R2 payload31,716,688Bで前後state全文SHA/ETag一致、直前原本とindex15列一致、現在位置のraw/index両欠測を確認した。正常CLIが遠隔全payloadを検証した証跡であり、その全payloadはActionsからexportされていない。rootの保存manifest/期待値/実ログの結合を独立した全prefix遠隔再生と呼ばない。実行コードは`9cdf4f04`へ固定し、次runのworkflow head・runner OS・Secretsとは分ける。

通常mainの実deployは#453が03:55:00/version `82b5cded-0121-47a9-b02c-75b2de714f28`、#454が04:11:26/`79b29e5c-4ce1-468d-8ec8-8050378fbaca`、#455が04:16:09/`d61c452a-815e-4d12-be16-fa5bd738e330`。#455は原39のSHAとNotion送信表現のSHAを分け、既知の旧4節/businessと同値を証明できる固定有限scopeだけreceiptを再資格化する通常CLIを追加した。原文・旧判定receiptのbytesを保持し、39本文の再送・一括再判定・新モデル依存は増やしていない。実receipt再資格化の本番適用はまだ行っていない。

実10/16 18時stock run38877553046は当日足3,646/3,687、完全成功3,645・失敗42。41社の当日足欠測と8303の過去RSI245本HOLDを分けて保持する。最新VWAP成功run38903045497はmargin-onlyであり、日足/5分足全量成功ではない。03:15監視の旧Mac版差は設定を直したが、株価coverage欠測と原TDnet PDF1件の取得不能は継続する。配信成功を全20機能の成功に変えない。

残RAW宣言payloadは約20.05GB。仮に全て新規・Standard・丸1か月なら[公式R2価格](https://developers.cloudflare.com/r2/pricing/)のGB単位切上げでraw payloadだけ約$0.315/月となる条件計算で、storage class・他object・操作の百万単位切上げ・account全体無料枠は未確認。[D1無料枠](https://developers.cloudflare.com/d1/platform/pricing/)は書込10万行/日等の制限があり、Paid契約は照会403のため未確認。公開repoの標準ubuntu runnerは[Actions compute minutes無料の対象](https://docs.github.com/en/billing/concepts/product-billing/github-actions)だが、全storageやローカル電力まで0円とはしない。追加有料LLM/原本APIはない。

追加私有証跡は`continuation/fixed776-root-final-acceptance.json`、`mac-notion-receipt-rollout-v3/{SUCCESS,root-verification,monitor-secret-ACK}.json`、`holdings-pilot16-apply-b8fb-v1/actual-v1/root-independent-acceptance.json`、`manual-competitor-prepare-first5-v2`、`manual-competitor-prepare-first5-v2-post-audit-v1`、`biztag-remaining-fresh-plan-read-v1/actual-v1`、`overseas-next15-protected-read-v4`、RAWの`raw-ordinary-after-repair-38947608942-v1`、`continuation/cf-main-{453,454,455}-logs.txt`。10/16と10/17のprivate audit rootを分けて保全し、秘密値・原本文・署名URLはGitへ入れない。

## 10月17日03:20 JSTの追加確認

| 対象 | この時点の受入・確認 | 残件 |
|---|---|---|
| 事業タグ本文 | 固定776社中607社。停止した3179/9273の2社を19要求の読取だけで照合し、旧386要求・通常publisher・全39値・他props・原本・物理3ファイルを別processで再検証 | 未着手169社を新runtime・新しい有限名前空間で準備中。旧停止・原文・未知状態は保持し、同じ業務更新は再送していない |
| Mac通常環境 | 03:14:14に`117b2133`へ切替え。canonical.env・同kernel writer state・依存lockを保持し、競合準備の固定33社を設定。旧43dの1,503 sourceと旧.env bytesを保全、旧入口の.envだけ無効化 | 競合準備5件の実行と次20/21時の通常receiptは未受入。モデル競合判定も停止中 |
| 保有DB行数 | 295要求の原応答・cursor・9完了区間の全域・ID一意を独立再生し、cutoff `2026-10-16T17:56:00.000Z`前のqueryable active page 27,674行を受入。上限に達した親8区間800行は集計から除外 | transaction snapshotやworkspace全体容量の証明ではない。保有原本213行/23文書・価格未受入という業務上の状態は変わらない |
| 保有prepare SQL | #448の実2 SELECTは旧171,241読取行/400.8285ms→83,678行/95.7946msで、全21行・順序・選択20行・moreが一致。#451では本番の既存code UNIQUE索引とcode範囲検索・外側rowid検索を3 readで確認し、03:20にmainへ統合 | #451の本番SELECT読取量と通常prepare全体は未測定。ローカルの中央値2.171→0.231msを本番性能へ換算しない |
| RAW索引 | cursor13,554/78,832・残65,278、永続raw_inflightを保持。明示1回修復の共通CLIは#450で準備、Actionsの型・試験は成功 | CloudflareのPR buildはasset APIエラーで失敗。変更をmainへ統合しておらず、実修復・再送・cursor変更は0 |

#447/#448/#449はmainへ統合し、通常Cloudflare buildログの実配信を確認した。各versionは`2e5e4962-9153-4d09-82c8-cb9703f551cf`（02:55:22）、`ee405253-e7c3-4ba2-9dac-bcb657f764ec`（03:01:23）、`b1c1f2e0-c199-4607-b493-93ca27ad45b2`（03:07:49）。#449はNotionが除去するU+200Bだけを送信本文で正規化し、原文・同期/判定入力SHAは保持する。新旧runtimeと旧proofの版を混同しない。

部分2社の読取閉鎖は16.565秒、Notion13/D1 SELECT6、要求4,182B/応答1,555,355B、D1読取150行、業務書込・モデル・原本取得API0。旧STOP SHA `bfd7c807c7a45762a358b6655f336cdadffe634da168a6dedf676f8bad7094e5`は不変。root最終受入SHAは`333bd1fba4d297889ba22191bc4e88c60b31b7b62fd48b132dec6946e6470373`で、未送信48社を含む残169社は別計画へ分離した。

保有countの実時間は980.825秒、要求本文103,624B/応答本文27,628,804B。元SUCCESSの`nativeWireBytesMeasured=true`という表記は採用せず、独立監査でdecoded body bytesへ限定する。全headers/wireは未計測。DB行数に残19,783行を全て新規と仮定した保守的投影は47,457行であり、全金融行の原本資格・workspace全容量・外部同時writer不在を推定で証明する値ではない。単一DBの行数上限とは[Notion公式仕様](https://www.notion.com/help/optimize-database-load-times-and-performance)の条件で比較する。

#451の3 readはPRAGMA index_listと旧/新EXPLAINだけで、実SELECTを実行していない。要求2,869B/応答3,424B、rows_read/writeとも0、追加DDL・Notion・モデル0。必須索引欠落時は同じ1問い合わせが失敗し、別計画へ切り替えない。全量保有公開は通常原本資格・Notion要求時間と有限予算が別途必要である。

追加私有証跡は`mac-competitor-stage-rollout-v2/{SUCCESS,root-verification,legacy-preservation}.json`、`.runtime/biztag-notion-text/source-v1/tmp/biztag-partial-closure-20261017/closure2-readonly-v2/root-final-acceptance.json`、`tmp/feature-audit-20261017/holdings-count-v4-independent-audit-v1/{root-replay,root-final-acceptance}.json`、SQLの`tmp/code-index-native-plan-v1/root-independent-acceptance.json`。元readのSTOPを保存し、追加モデル・有料APIによる補完は0。全20機能の最終受入は引き続き未完。

## 10月17日02:54 JSTの追加確認

| 対象 | この時点の受入・確認 | 残件 |
|---|---|---|
| 事業タグ本文 | 固定776社中605社。追加13組の先頭9組450社を共通通常処理で同期し、全39値・他props・根拠・sourceと外側/通常publisherの物理原本をrootまで照合 | 残171社。10組目の2社は更新ACK200後に照合停止、未受入。うち9273の本文はNotionがU+200Bを1文字落としていた。元停止・全要求/応答・原文を保全し、通常builder修正と読取専用の閉鎖後に未着手169社へ進む |
| 保有明細原本列 | 追加10文書36行を02:25:43にrootまで独立照合し、計23文書213行。追加36は旧12・新24、全476 native要求/応答、実22ファイル・添付1件ずつ・全読戻しSHAを確認 | 価格はこの23文書とも未受入。原表HOLD17文書・未照合の保護旧25行を保持し、全市場完了とは数えない |
| RAW索引 | 同じmanifest/cutoffの通常inspectでcursor13,554/78,832、残65,278と直前原本/15列indexを確認 | run38940600004の原本PUTが結果不明で停止。cursor位置の原本とindexは実欠測、永続raw_inflightを保持。別plan・自動再送をせず、明示1回CAS修復の共通CLIを準備中 |
| 本番保有SQL | 候補銘柄を先に限定する同1SQLの修正を検証中。保存済み2,945株・30,569文書で旧新3,170 caseの選択/order/moreが一致 | corpusは株ごとの保存時点で、同時全市場snapshotではない。純SQLite中央値36.07→2.19msは本番D1 rows_readの実測ではない。少量のpaired readとPR/CIが必要 |
| 発行株数 | #447で通常Actions/Nodeの既存type1展開Mapから2項目を観測し、普通株/単位/主体/経済日を資格化するコードをCI確認中 | 原文観測であり、分割・増資等の法的原因/係数や財務・価格への適用完了ではない。WorkerはDEI gateと理由付き未観測で、未測定full解析を有効化しない |

保有36行の通常実行は1,009.208秒、Notion404・hosted32・D1 SELECT40、要求6,098,230B/応答16,503,576B、D1読取2,000行/34.2525ms・書込0。原ファイル名の監査側期待値を共通命名へ直しただけで、業務更新は再送していない。旧監査停止とv1/v2を保持し、rootの別process純再計算で22実upload・22一意ID・各添付1件まで確認した。

RAWの正常inspect run38942280144は読取12要求、R2 payload31,605,805B、6.123秒、Notion/上流/モデル/PUT/INSERT0。原state全SHA `4dc53ee36af09314387e78efe7b45a191fa1930a155d125d72413f9f63a2384f` とETagは前後同値で、unknownを解除していない。既存正常inspectが検証した遠隔raw/indexの全payloadはworkflowからexportされず、rootは保存manifest全bytes・期待state SHA・直前index全15列の期待SHAを戻り値へ結合した。全prefixの独立再生や最終78,832件anti-joinとは区別する。

全市場の保有準備を旧SQLで繰り返すとD1読取が約2,200万〜1.3億行になる計算のため、先に共通SQLを軽くする。Cloudflare契約照会は403、既存ブラウザはログイン画面で、Workers/D1プランとR2実storage classは未確認。推定有料枠を根拠に全量を開始しない。原本/欠測のLLM補完・追加有料APIは0。

Macは旧`43d563a3`のまま、旧body chainは停止・全process終端。不可視文字の通常修正を受け入れ、部分2社の読取専用照合が閉じた後に、同一canonical.env・同kernel writer state・同依存lockで新mainへ切り替える。旧sourceと.env bytesを保全して実行入口だけ無効にし、残169社を新しい有限名前空間で処理する計画である。競合準備stageの実配備/5件準備/次20・21時の定時receiptはまだ受入へ加えない。

私有証跡は`A621-mechanical-remaining-v1/batch-{01..09}/{SUCCESS,independent-acceptance,root-physical-acceptance}.json`、同`batch-10/STOP.json`、`A169-new-runtime-proposal-v1/proposal.json`、保有`apply36-after1417-v1/{independent-acceptance-v3,root-independent-acceptance}.json`、`tmp/feature-audit-20261017/raw-inflight-38940600004-inspect-v1/{summary,root-independent-acceptance}.json`。全20機能の最終受入は引き続き未完。

## 10月17日02:18 JSTの追加確認

| 対象 | この時点の受入済み | 残件 |
|---|---|---|
| 事業タグ本文 | 固定776社中455社。有限13組の先頭6組300社を共通通常CLIで反映し、全39値・他props・旧根拠・原本と外側/通常publisherの物理PRE/POSTを独立照合 | 残321社を同じ有限計画で継続。実入力変更211AのClef判定1社は別受入で、この455へ重複加算しない |
| 保有明細 | 13文書177行を受入済み。次10文書36行は最新原本・全period PREを照合して通常source-only publisherで反映中 | 反映中の36は未加算、価格も未受入。保護旧行・原本HOLDを保持 |
| 優待条件の表示 | #446をmain `8faf8c57`へ統合、02:10:38にversion `2884af91-ccd9-4854-ae1f-5f81ba8de136`を配信。実4881/7372画面でも申込・併用・期間を確定条件と断定しない表示を確認 | 公式照合・株数/期間・選択群の意味対応は未完。保存5,748群の追加厳密全文文法で新候補は0で、曖昧文を削って定型へ入れない |
| 保有価格の名称資格 | #444をmain `3b8effc0`へ統合、02:03:13にversion `7710febd-d125-484b-ad3c-aa960464b334`を配信。必要なissuerだけ保存有報の公式英字名集合を通常価格資格へ渡し、同じ期限/bytes予算を守る | 保存入力33社289行の再生は価格の新規受入ではない。主体・同日bar・単位のHOLDを維持 |
| RAW索引 | 同一pool run38925685573が01:38:21に500検証（新482・既存18）、cursor13,182/78,832・残65,650まで成功 | 次run38933527247は02:03:28にreceipt PUT結果不明で停止。状態の読取検査は継続中で、失敗runの部分進捗やcursorを未検証のまま受入へ加算しない |

先頭6組300社は01:17:27〜02:10:33の通常反映で、モデル・上流API0。02:11:32までにrootの追加純監査も全300社の通常publisher物理PREと外側PRE/POSTの全文SHAを確認した。通常機械処理と追加の今回限りの受入読取を混同しない。

#442のMac末尾競合準備stageは既存20時処理の正常終了後だけ固定5件を通常CLIで準備するコードとしてmainへ統合済み。現在runtimeは旧`43d563a3`のまま。候補runtime `8faf8c57`をNix・同lock・offline 274再利用/追加download0で準備し、関連4 suite/37 testを確認した。本文の全writerと監査が閉じるまで切替えず、配備・実入力の準備・次回20/21時定時receiptを別に受け入れる。競合モデルの停止は維持する。

保有明細全体の純計画は、現在177行と反映中36行を除く1,718文書19,783行。旧12,576行と新7,207行の通常行操作だけでもNotion64,718要求、1.6rpsの間隔下限約11.24時間で、原本保管・準備・独立照合込みの条件計算は約18〜24時間＋通信である。8時間の有限範囲案と最初の100行pilotを用意したが未開始。実36の既存users/me応答から単一ファイル上限5,368,709,120Bを確認した一方、DB現在行数や全workspace容量の充足は未確認として残す。原本/欠測のLLM補完・追加有料APIは0。

RAWのlocal読取検査は既存正常CLIを使ったが、raw bucket GETが403で停止した。receipt全文と原例外を保全し、同じlocal GETを再送せず、既存Actions Secretsの正常inspectへ切り替えた。PUT/INSERT/Notion/モデル0、unknown解除や通常apply再開は検査後の別判断とする。

追加私有証跡は`A621-mechanical-remaining-v1/batch-{01..06}/{SUCCESS,independent-acceptance,root-physical-acceptance}.json`、`continuation/cf-main-{444,446}-logs.txt`、`continuation/yutai-446-public-ssr-v1`、`continuation/job-117083220211.log`、`tmp/feature-audit-20261017/holdings-bulk-finite-plan-v2`。全20機能の最終受入は引き続き未完。

## 10月17日01:37 JSTの追加確認

| 対象 | 受入済み | 残件 |
|---|---|---|
| 事業タグ本文 | 固定776社中255社。新しい固定13組の先頭2組・100社は01:17:27/01:28:00に全39値・他props・旧根拠・最新source・物理PRE/POSTを独立照合 | 残521社を同じ通常機械処理で継続。旧判定の未知SHAは補わない |
| 保有明細 | 追加6文書31行を照合し、計13文書177行。全332 native要求/応答SHA、旧値、全period、物理5組10ファイルを01:31:27にrootが独立照合 | この13文書の価格は未受入。原表HOLD計7文書・原本未照合の旧22行を保持。全市場の原本列完了ではない |
| 通常競合の機械準備 | #440をmainへ統合し、01:28:04にversion `115fca7d-ca24-43d7-b043-b4dfb0a0ccb2`を配信。現在doc/実39列・候補・質問を照合し、モデル0で物理保管するCLI | Mac定時stageの配備・実行は未受入。競合の意味判定を完了扱いにしない |
| 株式の報告権利診断 | #441をmainへ統合し、01:34:04にversion `2679f017-10b7-4d54-8126-4df1cdb0fa37`を配信。同じ原本のイベントと実計算窓を既存batchへ保存 | 次の通常runは未受入。増資等の網羅性・OHLC/出来高基準は未確認のまま |

本文の追加100社は2,634 native要求（Notion2,222）・349,688,121 response bytes。業務PATCH100、モデル・上流APIは0。別の保存原本監査で全100の通常publisher物理PREと外側PRE/POSTを全文SHA照合した。保有明細31行は旧25・新6、D1 SELECT18/924 rows/11.5667ms、Notion294・hosted20、実mutation85。元wrapperは715.877秒で保護原本の署名URL更新を差分とみなして停止した。更新を再送せず、既存共有file比較で署名query/expiryだけを正規化し、残7ページを7GET/15.209秒/書込0で確認して閉じた。元停止記録と全原値・時計を保持する。

株式診断は保存済み7,373応答を同じ共通資格化で再生し、全3,686 raw/3,639金融snapshotが診断以外同値、当日足欠測47と8303のRSI履歴HOLDを保持。追加source/Notion要求・モデル・業務書込0、診断約8.09MB、単回比較のparser差は約0.734秒だった。通常環境の全量性能保証ではない。海外売上の次候補15文書も現在main `9c40ba85`のparserで保存原本を純再生し15/15抽出同値を確認したが、fresh PRE・atomic反映・本番受入は別途必要。

私有証跡は`A621-mechanical-remaining-v1/batch-{01,02}/{SUCCESS,independent-acceptance,root-physical-acceptance}.json`、保有明細`apply31-after137A-v1/{independent-acceptance,root-independent-acceptance}.json`と`protect-post7-readonly-v1`、`continuation/cf-main-{440,441}-logs.txt`、`tmp/feature-audit-20261017/overseas-next15-current-main-pure-v2/result.json`。全20機能の最終受入は引き続き未完。

## 10月17日01:10 JSTの追加確認

本文は固定776社中155社を独立受入、残621社。追加50社は通常機械処理で更新・全POST確認後、見直し台帳の送信日時がNotionで分単位になったため検証側が停止した。業務更新は再送せず、現在の全文・最新source・全39値/他props/根拠を読取確認し、01:05:29に物理POSTを閉じ、01:05:58にrootが全SHAと通常builderで独立受入した。残621社は別の固定13組で開始し、停止したrunnerの名前空間は再開していない。

追加50社の初回は1,297 native応答、業務PATCH50、194,558,826 response bytes。追加読取専用は401要求/書込0（監査のDB ID表記差で停止）と410要求/証跡保存3操作・業務書込0。合計2,108要求・Notion1,702要求の今回限りの復旧費用であり、通常定時へ同じ再読取を追加した設定ではない。モデル・上流APIは全0。独立監査では全50の通常publisher PRE、元全native、最終全nativeと物理PRE/POSTを照合した。生データと元停止記録を保持し、旧判定入力SHAの不明は変更しない。

通常処理の#436は00:40:20にmain `c75be568`、version `65cd3ec5-5bb7-42bd-a7ec-ce6b99e21deb`を配信。非Yahoo27取得元を先行させ、同runの両summary・全source成功を結合する。#438は00:49:58にmain `8dfe0e05`、version `57896b13-29fa-43b3-bfd0-f6bbb3826067`を配信。追加300ms待機を省き、実Yahooの共通1秒制御と10年取得・権利原値・期限を保持する。通信削減と待機条件は[容量監査](yahoo-shared-capacity-20261016.md)へ記録し、次回定時全量の完走・実料金は未受入。

#439の保有株価格の事前主体資格もmain `080cf156`へ統合し、01:09:15にversion `67e59d11-4dda-482f-bc99-63fbae6104a5`を配信した。有限windowを価格書込前に資格化し、確定する商号不一致を既知HOLDとして残す。ACK不明・原本破損は従来の停止を維持する。[実原本2例と検証](holdings-price-preflight-20261017.md)を参照。これを価格公開の完了に数えない。

RAW同一poolは00:39:23にrun38919797532が成功。500検証（新483・既存17）、cursor12,682/78,832・残66,150、上流GET0、Notion10要求、elapsed2,501,889ms。次の同一pool run38925685573へ継続した。全範囲anti-join・全20機能の最終受入は未完。

私有証跡は`A671-mechanical-remaining-v1/batch-01`、`A671-batch01-post-readonly-v2/{SUCCESS,root-independent-acceptance}.json`、`A621-finite-runner-v1`、`continuation/cf-main-{436,438,439}-logs.txt`、`continuation/job-117036506509.log`。最終POST gzip SHAは`310faa940044cffd6371d8450c204e92cf3211fa4c19f6ff4c61fe857755f0d7`。

## 10月17日00:36 JSTの追加確認

211Aの有報がS100WW30からS100Z7YEへ変わった1社だけを、配備済みmain `43d563a3`の通常writer/pipelineとローカル`Cloudflare/clef-flash`で00:32:39〜00:34:40に再判定した。公式重み・processor・較正と同じ入力7,395 tokens／6問に束縛し、spawn1・Noul1・実forward1、既存1行のPATCH1・判定済。native138（Notion128・hosted3・D1読取7）、121.829秒。外部LLM・上流API・D1書込・再forwardは0。

全67propsと本文39項目・旧根拠の退役・source原文と時計を確認し、外側PRE/POSTおよび通常publisher PREの3ファイルを実体読戻しした。00:35:45にrootが全native要求/応答のSHA、6 journal原本、通常replayと別の`processStock`による保存応答再計算を追加通信・forward・業務書込0で検証した。peak RSSは20,674,904,064 bytes、swap増分の表示上限は約0.31MiBで、32GiB／1GiBの実行予算内。ローカル電力・金額は未計測。この1社は本文同期776件に含めず、105受入・残671件を維持する。未知の旧判定入力SHAは後付けしていない。

実行前のcontroller v2は.env取得順で停止し、native・model・業務書込・新journalすべて0を確認した。通常writerのpreflight後にD1を構築するv3で単発実行し、元停止記録を保持する。私有証跡は`211A-clef-normal-once-v3/{SUCCESS,independent-acceptance,root-independent-acceptance}.json`。これは固定1社の受入であり、全20機能の完了ではない。

## 10月17日00:32 JSTの追加確認

| 対象 | 追加で受け入れた範囲 | 残件 |
|---|---|---|
| 事業タグ本文 | 現在の原文から追加50社を00:05:53〜00:17:34に通常機械処理で同期。固定776件中105件を受入 | 残671件は固定14組の計画のみ。211Aの入力変更再判定と旧skip99の判定入力検証は別 |
| 保有株式の原本列 | 通常CLIで残46行を00:10:06〜00:17:11に反映し、先行100行と合わせて固定7文書146行を検証 | 価格7文書は未受入、原表不在3文書をHOLD。原本と未照合の旧16行は全値・時計を保持し、146行へ含めない。全市場の公開完了ではない |
| 通常処理の負荷 | #435で銘柄指定を最新文書照合SQLの内部へ渡し、済みprefix・全完了時の原本再照合を追加。#437で資金フローの同一値確認を50キーずつに集約 | 資金フローPhase1への接続・Yahoo共有排他の範囲調整は#436で確認中。次の定時全量の成功は未受入 |

本文の追加50社は2.0rpsでnative1,324応答・184,537,573 bytes、業務PATCH50、上流API・モデル0。00:18:25に全応答のSHA、39列・他props・根拠・source版と物理PRE/POSTを通信0で独立照合した。保有明細46行は旧37・新9、native277（Notion254・hosted10・D1読取13）、425.240秒、要求1,334,832／応答7,721,633 bytes、実mutation73。全7文書146行の最終照合、物理3組、未照合旧16行の不変を00:20:55に独立確認した。価格・上流取得・モデル・D1書込は0。

銘柄指定7件の最新文書照合は同じ結果のままD1 rows_readが1,199,527から330へ、durationが2,193.21から7.3868msへ減った。資金フローは保存済み実669行を通常比較関数で純ローカル確認し、同値の週次448行の論理照合を448回から9回へ削減した。過去221行のうち異なる187行は通常の個別再確認へ戻す。これは通信回数の計算であり、実HTTP成功や当日の全量受入を作っていない。新依存・追加モデル・有料APIは0。

Cloudflareの通常main配信も確認した。#433は00:05:12にversion `cc832d6f-fd99-46fb-9df8-5284d297d0f3`、#435は00:11:25に`d7c9b3a5-9e4f-419c-9de9-34a02c501a34`、#437は00:24:51に`411d6c88-b2ab-4767-a0e4-aa15dd1d0443`。CI成功と実deployを区別し、新しい定時全量の受入は継続する。

私有証跡は`A50-current-source-mechanical-common-v1/{SUCCESS,independent-acceptance}.json`、保有明細の`apply46-v1/{independent-acceptance,root-independent-acceptance}.json`、`continuation/cf-main-{433,435,437}-logs.txt`。全20機能の最終受入は未完。

## 10月17日00:06 JSTの追加確認

- 本文は追加50社を23:47:54〜00:05:03に共通`withBiztagWriter`/`runBiztag`で反映し、先行5社と合わせて固定776件中55件を受入、残721件。追加50社は全1,300 native応答・198,853,194 bytes、39列・他props・根拠・最新sourceと物理PRE/POSTの全SHAを00:05:34に通信0で独立再検証した。全工程はNotion上限1.2rps、通常pipelineは694要求・653.853秒、モデル/上流API0。次の50社は現在の実source原文とメタデータから検証する有限実行中で、55件へ加えていない。
- #433をmain `241f06ed`へ統合。生成SQL `0031_stock_adjusted_point.sql`を23:49:22に1回だけ適用し、旧3,767行の全38列・全索引を保持、新39列目は全行NULLと確認した。物理PRE/POSTとnative8読取/1DDLの全文SHAを独立照合、再送・指標値更新・取得元・モデル0。保存済み8303の同一Chart/Summaryから、通常parser→snapshot→indicatorの同一adjclose/SMA→月次MA比較/scoreをacceptedmainで純local確認した。列追加を過去値の充填や次回定時/月次全量の成功に数えない。
- #432のCron分精度修正はmain `c983d7b1`の通常build `cfe5e679`で23:57:15に実deploy、version `2a60e9c6-f885-45f0-b908-21a302d79176`を確認した。予定17:00:52を同じ17:00分として扱い、実受付17:10と新規開始23:30の期限を保持する。元の17時失敗と次回定時全量未受入は変更しない。
- RAWの同一pool run38914482437は23:56:10に終了。500検証（新規484・既存16）、cursor12,182/78,832・残66,650、上流GET0、Notion10要求、38分弱。次run38919797532が進行中。元manifest・起点・上限・結果不明は保持する。

残権利の追加確認では、保存済み7203/8303の各1,221本を通信0で読み、双方の直近130本中119本でcloseとadjcloseが異なり、配当原イベントを確認した。差だけから通常OHLC/ATRを無効化したり、価格へ係数を再適用したりしていない。8303の2023年9月28日の併合原値は直近窓外。現Chart OHLC/volumeの株数基準、直近の分割をまたぐ原本、増資・新株予約権・会社分割の効力日/株数履歴との連結は未証明で[#343](https://github.com/satoki252595/kabulab_tool_cloudflare/issues/343)を継続する。参照: [Yahooの調整済み終値の説明](https://in.help.yahoo.com/kb/adjusted-close-sln28256.html)、[JPXの権利処理](https://www.jpx.co.jp/equities/trading/margin/rights/02.html)（確認日2026-10-17）。

追加の私有証跡は`A50-normal-mechanical-common-v1/{SUCCESS,independent-acceptance}.json`、`continuation/cf-main-c983-logs.txt`、`continuation/job-117018352250.log`。0031は`.runtime/yutai-ma-basis/source-v1/tmp/yutai-ma-basis/{pre-schema-v1,apply-schema-v1,final-main-replay.json}`に全原本と元の監査停止を保持する。全20機能・全欠測の最終受入は未完。

## 23:50 JSTの追加確認

| 対象 | 追加の受入 | 残件・制限 |
|---|---|---|
| 保有株式の原本列 | main `59dd527e`の通常CLI/publisherで先行100行を23:33:32〜23:45:56に反映。旧59行と新規41行、全467 native応答・要求のSHA、全POST、旧5列・他props保持、4組の物理PRE/POSTを検証 | 固定10銘柄の準備範囲は原本HOLD3・残46行。価格は未確定で、全市場の公開完了ではない |
| 事業タグ本文 | main `43d563a3`の通常`--mechanical-only`で先行5社の39項目を同期。旧タグ・根拠・判定日・未知の旧入力SHAを保持し、全233 native応答と物理PRE/POSTの全SHAを確認 | 固定776件の残771件。続く50件は実行中で、完了数へ加えない。旧skip99は旧判定入力の検証完了ではなく、211Aの実入力変更判定も別途必要 |
| VWAP 5分足 | [有限通常CLIの200件](vwap-finite-start-budget-20261015.md)で原本・旧履歴・全R2 POSTを独立照合 | 固定残1,656件と日足3件のHOLD。次30件はPREのみで、期限後のsource/PUTは0。定時全量の受入は未完 |
| 共通株価計算 | #430をmain `c1ad90e2`へ統合し、Cloudflareの通常deploy/versionを確認。移動平均とトレンド・モメンタムの比較を同じ受領調整済み終値へ統一 | 次回定時の再生成は未受入。月次優待MA成分の同一snapshot対応と権利処理全体は別途追跡 |
| Mac配備 | 23:27:12にmain `43d563a3`へ切替え。既存calendar・共通排他・同一依存lockと旧049/277原本を保持 | 新runtimeでの次回20時・21時の実receiptは未受入 |
| 歴史RAW索引 | run38906853023が23:16:47に500件検証（新規486・既存14）、cursor11,682/78,832・残67,150。次の同一pool run38914482437が進行中 | 全範囲anti-joinは未完。元pool起点・最大200run・結果不明記録は保持 |

保有株式100行の実測は743.05秒、Notion440要求・hosted17GET・D1 SELECT10、要求9,019,320 bytes／応答21,357,935 bytes、実mutation146。内部guardのwrites148には検索POST2件も含むため、業務mutation数と区別する。原本取得API・モデル呼出しは0。文書ごとの全母集団走査を、銘柄コードを内部CTEへ渡す最小修正で軽くし、残windowの済みprefixと全完了時の再照合を補強してから次へ広げる。

本文5件は通常CLIの成功サマリ後に`process.exit(0)`が親controllerも終了させたため、保存を再送せず別の読取専用処理で全39値・旧props・根拠・最新sourceを照合し、23:46:45に物理POSTの全文読戻しを閉じた。元200応答と追加33応答の全bytes/SHAを通信0で再検証した。続く有限補完は同じCLI option契約・`withBiztagWriter`・`runBiztag`を直接使い、終了後の独立検証を行う。別の取得・抽出・更新ロジックは作らない。

私有証跡は`tmp/feature-audit-20261016/A5-normal-mechanical-pilot-v1`、`A5-normal-mechanical-post-readonly-v1/{SUCCESS,independent-acceptance}.json`、`continuation/mac-mechanical-rollout-v1/SUCCESS.json`、`continuation/cf-main-c1ad-{build,logs}.txt`。保有明細は`.runtime/holdings-production-finish/source-v1/tmp/holdings-pilot-20261016/apply100-v1/{SUCCESS,independent-acceptance,root-independent-acceptance}.json`。秘密値・原文・署名URLはGitへ入れない。全20機能の最終受入は引き続き未完。

## 22:55 JSTの追加確認

| 対象 | 確認結果 | 残件・制限 |
|---|---|---|
| 固定955件の海外売上省略理由 | 21:09:22〜22:22:06に残945件を32回のNULL専用atomic batchで反映。先行10件を含む955件の最終D1再読込で、同一理由955・NULL0・差異0・latest active955を確認。22:55の追加検査でも全17列のPOST、他16列の保持、原manifest不明860件の保持を確認 | 固定955文書の理由列の完了。海外売上の数値全体・全市場の欠測解消とは区別 |
| VWAP日足4銘柄 | 5271・6092・7075・8303を21:17:01に復旧。保存済み10月14日原本を使用し、各R2オブジェクトのETag条件付き単発PUT、全POST、原本の観測時計・株式イベント、物理PRE/POSTを確認。21:18の追加検査も合格 | 当日16日の履歴完了ではない。株式指標・RSIは変更していない。残3銘柄の日足HOLDと5分足の残件は維持 |
| 旧A876件の新しい読取専用計画 | 21:20:33〜21:24:29に本番共通planWorkで固定876件を再確認。skip99・機械的本文同期776・入力変更確認211Aの1件。63要求（Notion59・D1 4）、応答約17.6MB、書込・上流取得・モデル呼出し0 | 776件は同期未反映。skip99は旧判定の入力SHA検証済みを意味しない。期限切れ旧Aの名前空間は再開せず、211Aの再判定も未実施 |
| 資金フロー | [本番実行38879272134](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/38879272134)が21:25:41に28取得元すべてokで完了 | 未公表の区分・期間へ値を生成しない。全履歴の充足とは区別 |
| 歴史RAW索引 | [同一poolの実行38900645519](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/38900645519)が22:18:29に500件検証（新規485・既存15）、cursor11,182/78,832・残67,650、上流GET0。次の同一pool実行38906853023が進行中 | cursorは既存確認も含む進行位置であり新規登録件数ではない。全範囲anti-join未完。元のpool起点・最大200runを変更していない |

945件の反映と最終955件読取の合計は7,154要求、うちNotion5,993要求、hosted本文718,702,277 bytes。最大11,000要求・Notion10,000要求・3時間の元予算内で終了した。各batchは実対象のSQLiteによる通常成功と提出者変更・既保存・文書削除のrollbackを確認してから単発反映した。追加有料API・モデル推論・上流原本再取得は0。これは通常の差分取込に加えた今回の復旧コストであり、毎回955件を再走査する設定ではない。通信headers・ローカル電力・金額は未計測。

追加検査は保存済みsourceのnative応答4,711件、D1反映時のnative応答132件、最終D1応答24件の全本文SHA・bytes、32batchの個別差分と累積計数、全PRE/POST gzipのSHA・内容を通信0で照合した。物理hosted proofの実体読戻しは各writerで検証済み。Notion応答の全件がローカルへ保存されているとは主張しない。追加検査の初回は行順比較、2回目は累積計数の二重加算で監査側が停止し、元の監査と停止理由を保持した。行の一意キー・全件数・全値と個別IOの累積照合へ修正した3回目で合格し、この追加検査で業務書込は行っていない。

私有証跡は`omission-rest945-finite-v1/independent-acceptance.json`（SHA256 `3671536408ce68a54e7c724c04328feadb206436eeb4f14c4238476df38cf45d`）、`omission-rest945-final955-readonly-v1`、各`omission-rest945-v1-source-bNNN`／`write-bNNN`、`vwap4-saved-cas-v1`、`A876-live-plan-readonly-v1`、`continuation/latest-workflow-acceptance-2255.json`に保持する。いずれもGit対象外の`tmp/feature-audit-20261016/`配下。保有明細の全量公開・事業タグ同期・VWAP残件・[権利処理](corporate-actions-20261016.md)・全20機能の最終受入は未完。

## 21:02 JST時点の記録

| 対象 | 受入済み | 残件・制限 |
|---|---|---|
| Mac 20時の事業タグ | 承認済み`27709ccf`で実20時に起動し20:20:13にexit0。197社を訪問、本文同期143・既存再判定5・skip49。Clefの7交換は共通journal replayで入力・request/raw responseの全SHA、文書・モデル・較正・qids・確率・時計を追加forward0で検証 | 197/3,687は今回の訪問数。全体の判定充足率へ転用しない。資格HOLD23と停止中TypeSafeを保持 |
| Mac 21時の優待要約 | 実21:00:06.541起動、21:00:09.163完了、exit0・再試行0。pendingBefore/Afterとも0、モデル呼出し・常駐モデルとも0。R2の最終receiptを1GET/327 bytesで独立確認 | pending0は現行要約タスクの充足。優待情報モデルの全条件対応とは区別 |
| 海外売上の理由表示 | #414のmain `2a4b376b`を20:48:49に本番配信（version `686e7bf5-1d87-474c-8e75-238a4a4df7dc`）。実3画面でHTTP200・海外節の表示を確認 | 過去の理由列は別途反映が必要 |
| 955件の省略理由の機械再処理 | 保存済み物理原本955件の全SHAを確認し、現在の共通parser/serializerで955件すべて合格。上流GET・Notion読取・LLM・業務書込み0、約169秒、原本約724MB。保存列の合計867,636 bytes、1件最大914 bytes。D1の24読取で955件の文書・提出者・期間・latest active・旧NULLを確認 | これは固定母集団の資格確認。全市場の現在値や全欠測の解消を意味しない。原manifest不明860件を不明のまま保持 |
| 最初の10件の本番反映 | 原本をNotionから実体読戻し、全SHA・native期間・提出者・添付版を確認。21:01:15に理由列だけを単一D1 batchで反映。全17列のPOSTと物理PRE/POSTを検証し、既存16列を保持。実3画面に理由原文・文書IDを表示し、内部SHAは非表示 | 固定955件の残945件は未反映。数値・parse status・補足DB・原本manifestを変更していない |
| 権利処理の範囲 | #423の調整後終値必須化と#424の機能別監査をmainへ反映 | [権利監査](corporate-actions-20261016.md)の残件と#343を維持。18時runは旧`27709ccf`であり、新ロジックの定時受入ではない |
| 当日株式 | [18時実行38877553046](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/38877553046)の当日更新3,646、完全成功3,645、失敗42。8303の過去RSI HOLD 1を含む | 残41の当日足欠測を0や前日値で補わない。部分成功を全量成功へ変更しない |
| 歴史RAW索引 | [同一poolの実行38891434050](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/38891434050)で500件検証（新規473、既存27）、cursor10,182/78,832 | 残68,650・全範囲anti-join未完。次の同一pool実行38895798947が進行中。元結果不明・既存pool起点と上限を維持 |

## 費用・変更範囲と証跡

10件のsource資格確認はNotion読取37＋hosted10、約6.46MB・約72秒。理由反映はNotion読取26／mutation6／hosted2、D1読取3／atomic batch1。反映時の実測request body約40KB・response body約631KBで、headersや転送オーバーヘッドの総量ではない。PRE/POSTのgzip合計15,723 bytesを実体保存・全SHA読戻しした。追加有料API・追加モデル推論・数値の一括再計算は0。ローカル電力・ハードウェア費用は未計測であり、0円と断定しない。

NULL専用CASは実10文書の全17列で検査した。提出者名変更・既存理由の同時保存・文書削除の3負例でatomic rollbackを確認し、ネイティブD1応答4件と全列の変化を追加通信0で独立検証した。曖昧な応答を再送する経路は追加していない。

証跡はGit対象外の`tmp/feature-audit-20261016/`配下の`mac20-clef-journal-audit.json`、`mac-scheduled-final21-readonly-v1`、`omission-saved955-prepare-v2`、`omission-d1-scope-readonly-v1`、`omission-source10-readonly-v1`、`omission-reason10-apply-v1`、`omission10-live-ui-readonly-v1`に保持する。raw本文・signed URL・資格はGitへ追加しない。本文固定3,666件の受入と0030移行は[既存台帳](feature-recovery-20261014.md)を参照。
