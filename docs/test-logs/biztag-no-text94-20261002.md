# 事業タグ「本文なし」94件の有限照合（2026-10-02 UTC）

Issue #102 の旧「原本あり28件・未観測64件」を現在の94件へそのまま転記せず、
残存する旧調査一覧と現在の保存索引、保存済みEDINET日次一覧を照合した。
初回観測時の対象94件はすべて active。最新有報文書・本文参照候補・確定した本文参照漏れは
各0件だった。その後、保存日次一覧から35ファイル行・28文書IDの資格を照合し、
有報の未取込候補4銘柄・4文書を特定した。観測文書が有報対象外の13銘柄、
TDnet索引のみ7銘柄、原本索引未観測70銘柄を分けて保持する。
有報4件は原本保管・D1文書と146節の索引・Notion本文全文・pointer・派生確認まで復旧し、
実行証跡の物理保管と全文読戻しも完了した。
後続の真正Mac通常処理は2026-10-02 18:56:56 UTCにexit0で完了し、4社の
機械タグ補完・全文/根拠・次回skipと既存判定済み3,618件の保持を独立確認した。
現在の本文なし保留は90件。AI呼出し0、POSTの実体保管・全SHA照合まで完了。
[後続Mac実受入](biztag-semif-new-stock-20261003.md)。
**未観測70件を「未提出」と認定しない。94件すべてのタグ判定・全文取得・本番補修完了は主張しない。**

## 現在94件の読取範囲

以下は `2026-10-02T14:15:52.353Z` の初回観測であり、有報4件の復旧前の状態を示す。

- 基準コードは main `55c87bfc3f9b400ac47c281dc9c6eed265725773`。
- Notion補足の「事業タグの状態=本文なし」を既存スキーマのプロパティIDで絞り、
  page_size=100 の単発queryを実施。94件、コード重複0、active94件、
  `has_more=false` / `next_cursor=null`。追加ページ・再送・更新0。
- 既存 `loadLatestDocs` と `loadNewStockEligibility`、94コードに限定した
  有報文書・本文索引と EDINET/TDnet原本索引を既存D1 HTTP helperでSELECTした。
  SELECT6回、すべて成功、rows_read計51,853、rows_written0、内部試行各1回。
  索引の上限5001行に到達していない。
- 最新有報文書0、有報本文索引0、Notion補足の文書参照0。
  `text_parse_status=ok` なのに本文pointerだけ欠ける補修対象、および本文pointerが
  既存で補足だけ古い候補は、それぞれ0件。
- EDINET原本索引35ファイル行・17銘柄、TDnet原本索引10ファイル行・7銘柄。
  これは索引の観測であり、文書本体やNotion本文の読了証明ではない。
- 初回観測完了は `2026-10-02T14:15:52.353Z`。
  Notion1 / D1 SELECT6 / hosted0 / publisher source0 / write0 / retry0。
  TypeSafeの呼出・設定変更0。

## 保存日次一覧による原資格の復元

まず既知11原本を照合し、その後に9月29日・30日の2原本を追加復元した。
以下の11原本による23行・20文書の結果は第一段階の観測であり、最終分類は表に示す。

旧証跡から残る11個の固定R2 keyは、日付・SHA prefix・bytesが旧索引出力と一致する。
full SHAの期待値は残存する旧readerに保持されていた。新しいpublisher GETで
埋め直さず、同じ保存原本を既存Wrangler OAuthの正規 `r2 object get --remote --file`
で復元した。CLIのアカウントは既存型付きアクセサの一致を必須とし、
GETのorigin/path/queryと1 key当たりnative1回を通信前に制限した。
OAuth原値は抽出せず、API/S3資格情報をCLIへ渡していない。

- 保存原本11個、9日付、計3,383,260 bytes。全ファイルのbytesとfull SHA完全一致。
- WranglerのR2読取11回、追加ページ・retry・publisher source・Notion・本番writeは0。
- その前の旧pipeline別名設定による停止はnative0、正規S3 readerの権限拒否はnative1。
  両停止を不変保存し、権限拒否を原本不存在に読み替えていない。
- EDINET一覧のstatus、件数、日付、type、文書schemaを検証し、既存
  `isAnnualSecuritiesReport` で判定。docTypeに加え、府令・様式・取下げ状態を要求する。
  対応する文書ID/日付を完全一致させ、非nullの証券コードも既存変換で一致確認した。
- 対象17銘柄の35ファイル行中、23ファイル行・20文書IDを原一覧へ照合できた。
  20文書の種別は大量保有15、半期3、訂正大量保有2で、すべて有報判定false。
  同じ日付の複数保存版における資格関係フィールドの競合0。
- 残る12ファイル行・8文書IDは9月29日・30日の原一覧が既知11個に含まれず、
  有報資格は未証明。同一銘柄に照合済み文書があっても、未証明文書を除外して
  銘柄全体を確定扱いにしない。
- 復元した日次一覧を94コード全体でも照合したが、この保存日付範囲での
  有報資格成立候補は0。対象外の日付・未観測の原本まで否定する証明ではない。
- PDF/CSVというファイル形式だけで有報認定しない。TDnetの文書を有報へ流用しない。

| 現在の有限分類 | 銘柄数 | 確定した範囲 |
| --- | ---: | --- |
| 正規の有報資格あり・本文復旧済み | 4 | 4文書IDがそれぞれunique、対象コード・府令・様式・取下げ状態・会計期末一致。D1文書・146節の索引・本文全文・pointer・派生確認・POST証跡保管完了 |
| 観測したEDINET索引文書がすべて有報対象外 | 13 | 保存原一覧で資格照合した文書のみ。過去の全提出を否定しない |
| TDnet索引のみ | 7 | 有報対象の一次文書には分類しない |
| 有報文書・EDINET/TDnet原本索引が未観測 | 70 | 今回の索引読取範囲で未観測。「未提出」とは認定しない |
| 合計 | 94 | この原本照合段階のタグ更新0。後続Mac通常処理で4件の機械補完を完了、残る90件は保留 |

追加の2原本は計901,305 bytesで全bytes/SHAが期待pinsと一致した。
9月29日には対象外の同一文書IDの異なる2行があり、様式等に差があるため
原文を統合せず保存した。対象94コード・原本索引45行との交差は0。
既存 `listDocuments` / `selectMissingDocs` は配列の各文書を資格判定するため、
対象文書IDが各unique1であることを別に要求して照合した。
9月30日は全文書ID unique。全原一覧が重複なしだったとは主張しない。
最終的にEDINET索引35ファイル行・28文書IDすべての資格を照合でき、
有報4文書の証券コード・会計期末・必要メタデータも確定した。

## 旧107件・92件との対応

旧107コードの一覧（文書なし92・判定不能14・補足ページなし1）、
旧92コードの対応一覧、旧EDINET原本43ファイル行・30文書ID・21コードは復元できた。
現在94件と旧92件の共通集合は82件、現在側だけの対象は12件。
旧92件のうち今回の集合から外れた10コードは、
[C107の有報10文書・364 section全文照合](c107-yuho-text-audit-2026-09-29.md)の
対象10コードと集合として完全一致した。

| 初回索引分類 | 現在件数 | 旧92件との共通 | 現在側のみ |
| --- | ---: | ---: | ---: |
| EDINET索引あり・有報資格照合前 | 17 | 16 | 1 |
| TDnet索引のみ | 7 | 7 | 0 |
| 原本索引未観測 | 70 | 59 | 11 |
| 合計 | 94 | 82 | 12 |

旧EDINET cached21コードとの現在の重なりは11コード。
旧「原本あり28」のうちTDnet7コードの個別原一覧は回収できていないため、
現在のTDnet7コードを旧7コードと同一だったと断定しない。
この境界により旧「未観測64」の個別集合も正確には復元できない。

## 原本物理保管と再開条件

復元raw11、元key/date/full pins、今回の回収receiptをlossless1 bundleにまとめた。
57 member、271,063 bytes、SHA
`cd153cd637f3343664d0badadbfcc4d8f3a3bc80d0ac2514e7bdc7d0f048a003`。
全memberを再解凍してbytes/SHA完全一致を確認した。
元publisherのfetchedAtはUNKNOWNとして保持し、今回R2から復元した時刻と
publisherのprocessDateTimeを分けた。source URLの秘密query、OAuth、.env、
資格情報は含めていない。

物理保管は既存 `recordPrimaryData(force:false)` と
`verifyArchivedAttachments` で実施済み。固定keyのmanifest書込と、
271,063 bytes / full SHAの物理ファイル全文readbackが成功した。
Notion8 / hosted1 / publisher source0 / D1R2write0 / retry0。
rootの独立offline照合でも、9 native応答がすべて2xx、hosted全bytesがbundleと一致し、
57 memberの全bytes/SHAも一致した（追加native0）。
この保管成功は11個の保存原本に限定し、有報本文取得やタグ更新には読み替えない。

7銘柄の資格不足をさらに切り分けるには、9月29日・30日の既存日次一覧の
固定key/bytes/full SHAを原本索引から限定SELECTで特定し、同じ保存原本を復元する。
追加の限定SELECT1（LIMIT7、追加ページ0）で、2日付の保存一覧2 key・
901,305 bytesの期待pinsを取得した。HTTP200 / D1 rows_written0。
初版ローカル処理のDrizzle tuple配列の扱いで停止した証跡を保持し、
同じ保存済みHTTP応答を既存 `assertD1SingleQueryResponse` でoffline再検証して
日付/key/bucket/full SHA/bytesを確認した（追加native0）。
この2 keyの最初の読取はCLI認証ゲートで停止し、R2 native0 / raw0 / 第2 key0。
正規CLIの別認証確認phase後、新しい不変planで9月29日をCF native1回だけ取得。
全bytes/SHA一致後のglobal重複検出でSTOPを保全し、対象外の重複の差異を
offline照合した。別phaseで未読の9月30日だけをCF native1回取得した。
同じ原文の再GET・publisher source・追加key・本番writeは0。
同じ非対話メッセージは資格情報不在・OAuth期限更新失敗の両方で生じるため、
原本不存在や有報資格不成立とは認定しない。R2以外のrouteを禁止したguardは
OAuth更新も許可しておらず、正規CLIのログイン状態確認・更新は別phaseで扱う。
索引pinsの存在を資格成立に読み替えず、原文の資格照合で判定した。
追加2原本と停止・回収・分類証跡35 memberをlossless bundleへまとめ、
127,370 bytes / SHA `b0fcd1e4f0943f4736845c34b1f1ab96d9a1b85cba8cf4bbe39c31d196b12076`
の全member bytes/SHAをoffline確認した。既存archive/verifyで
物理保管と全bytes/SHA readbackも完了した。実Notion8 / hosted1 /
publisher source0 / D1R2write0 / retry0、固定key・force:false・再送0。
完了時刻は `2026-10-02T15:58:22.633Z`。
rootの独立offline照合でも9 native応答成功・hosted全bytes一致・
35 member全bytes/SHA一致を確認した（追加native0）。

正規の有報資格、対象コード、対象会計期末、保存原本と全文保管が揃った場合だけ、
既存の個別 `processMissingDoc` または `backfill-text-sections --doc=... --force` の
適用条件に合う入口を選ぶ。D1に文書自体がない4候補は既存の本文だけの
backfill入口では拒否される。

有報4候補の既存CSV ZIPを固定keyからCF GET各1回で復元し、計335,264 bytesの
full SHA、ZIP CRC・entry、既存CSV parser・本文抽出を検証した。
3,523 CSV行から146 section、事業内容は各1 section、全本文非空・charCount一致。
追加publisher GET・Notion・D1R2write・retryは0。
この4候補には受注・海外語があるため、正規 `processMissingDoc` が扱う
全系統の補修には実type1原本が必要。CSV本文の成功を受注・海外の解析完了や
本番補修へ読み替えず、未観測の値・解析状態を代入しない。
CSVの物理保管と個別補修は別phaseで扱う。type1保存有無の限定照合は次のとおり。
4文書のtype1/type5計8 keyの完全一致OR query（page_size9、追加ページ0）を
保存済みDB schemaから実施し、`has_more=false` / `next_cursor=null`、一致行0。
旧bare文書IDの4 keyもpage_size5の単発OR queryで一致行0。
両queryともhosted・publisher source・本番write・retry・追加ページ0。
この結果は当該サービスの固定キー範囲に限定し、全Notion/R2原本不存在へ広げない。
不足するtype1は、資格確定4文書へ1秒間隔で各1回・順次GETを実施した。
取得先・type・リダイレクト・再送を制限し、HTTP200の原文4 ZIP・
3,572,578 bytesを受信完了時計とともに私有保存した。全bytes/full SHA、
ZIP CRC・entry一意性、公式form・提出者コード・対象会計期末の一致を確認。
受信完了時刻は `2026-10-02T16:29:45.657Z`〜`16:29:55.699Z`。
既存parserで受注4件は `no_order_table`、海外3件は `no_overseas_table`、
海外1件は `geo_present_unstructured`、構造化factsはともに0だった。
取得した実原本の解析結果であり、未観測の値や状態を補っていない。
publisher GET4 / Notion0 / D1R2write0 / retry0。rootの独立offline照合も
4原本の全bytes/SHA・CRC・公式資格・受信時計一致に成功した（追加native0）。
保存CSV4と今回のtype1 ZIP4の計8原本・3,907,842 bytesを、正準
`recordEdinetZip`・固定typeキー・force:falseで物理保管し、全8 ZIPの
全bytes/SHA readbackが完了した。最初の1件はNotionの日時欄が分単位に
なるため検証STOPとなったが、既知POST1・upload1・unknown0を保存し、
同じページのhosted1読取で全文を確認した（旧POST/upload再送0）。
残7原本は第一keyを除外した別固定planで保管・全文readbackを完了。
Notion日時欄は保存された正確な分切下げだけを照合し、Metadataの
元の受信・回収時計は秒・ミリ秒まで厳密一致を保つ。全phaseの実通信は
Notion52 / hosted8 / publisher source0 / D1R2write0 / retry0。
rootの独立offline確認でも全52 Notion応答・8 manifest・Metadataの元時計・
8 hosted全bytes/SHA一致を確認した（追加native0）。

補修直前の追加SELECT6でactive・一意4銘柄と、対象銘柄の既存文書・
受注・海外・本文索引・projectionがすべて0と確認した。対象4文書の
Notion本文DBもschema GET1＋exact OR query1で一致行0（全文未取得0）。
各HTTP原応答と型付きPREを私有保存し、rootが全bytes/SHAを独立照合した。
正準 `buildMissingDocStatements` と共有batch converterによる4文書・
146節の37文を、原D1 HTTPのnative列値を用いるfull PRE断定の後へ配置。
断定は全銘柄列と全6集合の件数・双方向EXCEPTで差異を検出する。
Nix標準Python SQLiteの実原本・実4銘柄検証で、全146節の索引、
全銘柄列不変、適用後の再送拒否、銘柄状態の競合時の全rollbackに成功した。
本文146節・211,178 codepointsにU+200B・astral文字はともに0、
文字除去・補作は0。Notion本文の資格は全文source一致とcodepoint数の
厳密照合を維持し、既知87件の別HOLDを理由に許容幅を広げない。

補修前原応答・source資格・全文候補・競合断定・37文・独立検証を
80 memberのlossless bundle（1,066,808 bytes）として物理保管し、
全文bytes/SHA readbackを完了した。実Notion8 / hosted1 / source0 /
D1R2write0 / retry0。rootの独立offline検証でも全9応答・80 memberの
全bytes/SHA一致に成功した（追加native0）。
この物理PREを保管後、改めて全6集合の一致をSELECT6回で確認し、
断定を先頭に置いた正準37文を単一batchで適用した。続くSELECT6回で
有報4文書・本文索引146節、全銘柄列不変、受注・海外・projection各0、
Notion本文pointer NULL4件を確認した。実D1 HTTP13回・batch1回、
Notion・publisher source・R2write・retryは0。全原応答のbytes/SHAと
本文索引のsource一致をrootが独立offline照合した（追加native0）。
続く最終phaseで、既存 `backupDocTextToNotion` と `readStockTextRow` により
Notion本文4件・146節・211,178 codepointsを全fieldで原文と完全一致照合した。
文字の除去・補作0、既存本文との競合や不足を許容しない。全4件の全文確認後にのみ、
実D1 POSTを基準とする全6集合の断定を先頭に置いたpointer更新4文を単一batchで適用。
全16文書列を再読し、pointer以外の値が復旧済み文書と完全一致することを確認した。
正準 `rebuildYuhoGrowthProjection` を同じ4銘柄に限定して実行し、
実原本の構造化facts0・最大提出日時・対象DELETE・POST projection0を照合した。
実D1 HTTP7 / Notion25 / hosted1 / publisher source0 / R2write0 / retry0。
原本ZIPの再POST0、既存タグの再判定・補足状態更新0。

文書補修と本文・pointer・派生の実原応答を163 memberのlossless POST bundleへ
まとめ、787,853 bytes / full SHAの物理保管と全文readbackが完了した。
全33 HTTP応答のbytes/SHA、全memberの元ファイルとの完全一致もoffline確認済み。
rootの独立offline検証でも、全33応答・本文146節と7プロパティ・pointer以外の文書15列・対象4銘柄の派生結果・POST全163 memberとhosted全文bytes/SHAの一致を確認した（追加native0）。
完了時刻は `2026-10-02T17:39:49.974Z`。
この完了範囲は資格を確定した有報4件であり、補足・タグの通常処理は別phaseで扱う。

調査で見つかった取得時計と提出日時の混同は[PR #277](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/277)で修正し、
通常取込・欠落文書回収・ZIP保管修復・海外再解析の受信完了clockをtypeごとに記録する。
Nixの型検査・lint・関連32試験とCI3 checksが成功し、独立レビュー後にmainへmerge済み。
修復PREPはこのmainを使い、既存原本の不明時計を書き換えない。
全体backfill・TypeSafeへの再送・既存タグの付け直し・不明POSTの再送は0。

## 証跡

原文・コード/文書/Notion ID・認証情報・R2 key一覧は公開Gitへ出さず、私有0600で保持。

- 初回94件観測結果SHA: `1463b330d3ff58e2d4a63f2d89909a99619bfeef4abb0a2ea06e5da2bc59a324`
- 初回94件分類SHA: `546d5ff9fbd9284cba261407abb53b093a453da99315c67cd950f65bfd9f80c7`
- 現在原本索引SHA: `c5dbe389217cf6a6732e30fa0e8b98475634bde77f9e68d6433e0750ac26e338`
- 第一段階の保存原一覧資格照合SHA: `50731051df60534ec12227ffe1ef600a02eb771794ce8bf3f13753bf2c3ceb5d`
- 旧107一覧SHA: `0ae2953a6375b38c196df604632c30e27a72ba2ea7fcf1d35338afd5c7891361`
- 旧EDINET43索引SHA: `f2214e396d9e03f9a595b0c70950051cb62651a77fee45bf92576bfb64e828a2`
- 旧92コード対応SHA: `8d3a5c6a2d9d40d5b34ef4f826dc7d9da08abda0e5699b359ddb1655b1be88e5`
- 11原本reader plan SHA: `52647f78a957fcba1a4bf5ae35fe870c7035d5726116415cba6d9eac4d66a0db`
- 物理保管writer plan SHA: `90925b2bebb43270e25e62449d98fde8082d9bbb4b5631ba95d2a8d4bb638632`
- 11原本の物理保管完了receipt SHA: `d30447f07b29fbe278376ce66783c08431936209d80661ca3bc03d86983b205e`
- 追加2日付の索引pins検証SHA: `0f0eaaacd5fe468879f6d55d19c6014cb58a754b212b73e58cbaa9a0587772cb`
- 最終35ファイル行・28文書資格照合SHA: `a68be710060228525f0b9bfa3b0f2d37b5c6ba9d663ac3165af5ce76f788c859`
- 追加2原本物理保管PREP plan SHA: `63cfe7c2cd9164f0a3cb6695493b0f997e443c9d500c9e4a585a2eeaf844d39c`
- 第一段階の有報CSV3保存復元plan SHA: `415f3cefb1a9a233abd5b90905a191439536baa4a1c9c8a3840a058f28f39fdd`

- 追加2原本の物理保管完了receipt SHA: `5527cc20078f3a060f4ea35c1ae75f31a4168c8c92bd8a61ccbda7b74011b7f0`
- 有報CSV4の本文抽出照合SHA: `70ff3dd9d00e7db40d845fd613ed3a911c9983e808191f99dcfd50fdb1715e40`
- 有報8 type別原本物理保管closure SHA: `5ede1a3130a67862714ed35d063f13fcbad4f66fb048fa7f6f68f5b0c03ac3da`
- 有報4補修前物理bundle SHA: `526e6213a202acd4e5f8637726a9fc3c6ae5c4a5fe1dec7a4a7e3108f15129c2`
- 有報4 type1原本取得完了receipt SHA: `c04e8e20dc13a57b9485b9ff08eb3b4e682ded9c8993f166907fbbaf86218743`
- 有報4旧bareキー診断receipt SHA: `414a51e8db9389e6a418cc4f5a296fbec36f6ebb7ae9d09e96169dd61416a97d`
- 有報4文書・146節索引の本番復旧receipt SHA: `54730f40df2725e1bb0bd273aa8a02682334d5233e0c19928f4d6f4256bf16f6`
- 有報4本文全文・pointer・派生・POST物理保管完了receipt SHA: `c177198dd7680e516051e21e9c974dbece2cfafef7d9f77d94a20772c45c1669`
- 有報4 POST物理bundle SHA: `dab602db717fc1d1546898c3097e3b577d5060dccf89c6e4ea1bf01c8dfb2a38`

CLI経路はインストール済みWrangler4.101.0のhelpと実装で確認し、
[Cloudflare公式R2 command docs](https://developers.cloudflare.com/workers/wrangler/commands/r2/)
も確認した。原本復元の成功と、本文取得・物理保管・本番補修は別の結果として追跡する。
