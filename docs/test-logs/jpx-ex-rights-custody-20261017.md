# JPX配当落・権利落等の原本保持（2026-10-17）

既存18時の `scheduled-stocks` で、JPXの現在掲載indexと、その唯一の添付表にある最大5版のXLSを保存する。これは証拠を失わないための追加であり、権利イベントの金融資格・価格/株数の補正・全権利ledger完成ではない。本番取得、Notion実体、定時受入、新URLの本番設定はまだ実施していない。

## 一次根拠と日付の境界

- [JPX配当落・権利落等情報](https://www.jpx.co.jp/listing/others/ex-rights/index.html)は13時頃更新、当日分と過去4営業日分を掲載する。保存した実indexには10/16・15・14・13・09公表分の5リンクがある。休日や失われた過去版を計算で補完しない。
- 実10/16添付はindexのhrefから取得した `nlsgeu000004rws9-att/20261016.xls`。index 27,121B/SHA `c583791ea619206f91fdb53f708b0321e7821afdbca91bb2d734c759f0ebb43a`、XLS 62,464B/SHA `e5bb8034f993b5a9e664edfe2ea646d577b35e7fb7902cabdd9f197307e3cd0a`。indexの元CRLF/空白もgzipで全bytes保全し、出典は[実fixture](../../src/shared/jpx/__fixtures__/ex-rights-20261016/provenance.json)に保持する。
- 実XLSの列は基準日・実質上基準日・普通取引/その他取引の権利落日・5文字銘柄コード・略称・市場・備考・更新フラグ。これらを法的効力日や普通株資格へ読み替えない。ratio列はない。更新フラグの意味と画像等の利用注意書きは未資格。
- `announcedDate`はindexに明記された**公表日**だけ。厳密実在日・href末尾との一致・一意な降順を検査する。XLSのイベント日、株式種別、係数、コードの短縮は今回解析しない。

## 通常経路と失敗方針

`src/scheduler/stock.ts` → 既存 `stock-sync.yml` の `scheduled-stocks` → `scripts/sync/daily.ts` → `runDailySync` → `collectOfficialRightsCustody`。新scheduler・ジョブ・依存は追加しない。通常手動 `stocks`/`daily` や `scheduled-context` は新取得を行わない。

URLは既存 `sharedEnv.JPX_EX_RIGHTS_URL()` から必須取得し、同名の公開Actions repository variableをworkflowへ渡す。.env.exampleにキーだけを追加した。公式origin・index path・query/hash/認証情報なしを要求する。未設定をURL既定値で補わない。canonical .env、Mac/Workersの実設定は変更していない。

source GETはindex1件＋唯一表のXLS最大5件、直列・各30秒・redirect/retry0。index 1MiB/XLS各4MiBは**保持payload**上限で、wire受信量の事前上限ではない。異常HTTP・format不明・途中切断・容量超過を区別し、受領prefixは全原本と呼ばない。失敗後の残りXLSは取得しない。

取得物は `recordPrimaryData(service="universe", requireExistingDatabase=true, force=false)` と `verifyArchivedAttachments` だけで保存/全SHA読戻しする。DB自動作成をしない。正常HTML/XLSは元bytes、失敗/空/部分bodyはlossless gzipとしてmanifestにencodingとfull/prefix SHAを明記する。bodyを全く受領しなかった通信失敗は原本なしのまま。

keyは全掲載版のURL・公表日・HTTP状態・受領bytes/SHA・完全性から決める。同日訂正や版の入替えは新SHAのkeyで保持し、旧原本を上書き/trashしない。fetchedAt/Last-Modified/Content-Typeは取得metadataに残すが、揮発時計で同じ原本を別keyにしない。既存keyもmanifest一致だけで完了せず全添付を読戻す。

source/設定/表/保管不明は `officialRightsCustody.status="incomplete"` と具体的reasonで日次ログ・完了/中断バッチの双方へ残す。JPX欠測をイベント0や権利資格成功へ変換せず、独立したYahoo/母集団の通常guardは継続する。正常保持でも `financialQualification="unqualified"` のまま。archive unknownはそのrunで再送しない。既存common archiveのkey照合を使うため、別runも含む新しい永続unknown latchを追加したとは主張しない。

## 保存再生と増分費用

Nixで4 suites/80 tests、全体 `tsc --noEmit`、対象eslint、diff check PASS。実indexの5版と全SHA・date/href不一致・未来日・別URL・HTTP429/redirect・過大prefix・transport・偽XLSを確認した。collectorは実indexの最初の1行だけを明示したtransport projection＋同日実XLSで、共通archive/物理読戻し・同日訂正別key・incomplete/unknownを確認する。投影テストを本番5版の取得成功とは呼ばない。

既存日次回帰はJPX不完全でも元N225資格まで進み、元失敗理由と原本診断を一緒に保存することを確認する。既存非定時モードの値/SQL/取得契約は変更しない。

保存index 100回の同条件parseは8.595ms、CPU user9,164µs/system312µs。5版・入力全SHA不変、HTTP0。旧経路にこの取得はなかったため、実ネットワーク短縮率はない。

条件付き冷間正常値（既存DB発見search1page、7添付即uploaded、retry0）はJPX6 GET、Notion20 API、hosted7 GET＝計33 HTTP/新archive1行/15 mutation（添付create+send各7、page1）。DB/WS cache済みの新keyはNotion17 API＋hosted7＋JPX6、cache済みの既存key完全一致はNotion2 API＋hosted7＋JPX6。5 XLSが実10/16と同程度なら原本約0.34MB＋manifest。search pagination、provider待機、既存client再試行で増えるためhard native/time保証ではない。1.6rps合算枠の27 starts間隔下界16.25秒も完走保証ではない。最大source保持は1MiB＋5×4MiB。全体archive deadline/call capの新設はしていない。

本番設定・次18時の原本物理受入はrootの別確認事項。将来イベント資格化には普通株/主体・該当基準日/市場日・版/訂正来歴・必要な法的根拠を別に要求し、このcaptureだけでOHLCV/配当/株数を適用しない。
