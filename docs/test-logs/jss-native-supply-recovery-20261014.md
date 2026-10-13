# JSSのJPX日次信用残・逆日歩の正式提供回復

JSSは3種類の需給を宣言していたが、`jss_supply_latest` の現物は日証金貸借残高のみだった。JPX日次は既存VWAP R2、逆日歩は原本R2と既存seriesに保管されていたため、定期producerが更新する既存実体へprivate REST/MCP readerを接続した。

- JPX: `scripts/vwap/ingest-margin.ts` → 共有Notion原本保管/全文SHA → `vwap-data/margin/daily/<basis>.json` / `margin/dates.json` → JSS共通reader。既存の純粋 `validateDailyMarginSnapshot` / `selectDailyMarginRows` を再利用する。
- 日証金: `pipeline/.../jobs/supply_daily.py` → 原本Notion/R2/D1索引、`_shina_points` → 既存R2 series。latestのみ既存索引を1SELECTし保存CSVを1GET/全文SHA照合、CP932 fatal復号、16列のnativeDTOへ渡す。
- privateだけに `VWAP=vwap-data` をbind。publicのR2は従来RAWだけで、公開面へ個人用需給を追加しない。既存APIキーを保持する通常appの本番配置と、無配分probeによる受入はrootが別途行う。

JPXの買売・株数・円金額・一般/制度信用の意味を保持し、JSFの貸借残高へ読み替えない。基準日と公表日を区別し、存在しない取得時計は `null`。逆日歩は全取引所を保持し、当日料率（品貸日数込み）と単日最高/前日料率を区別する。最高/前日が1日1株・口当り、当日が品貸日数乗算済みという単位の根拠は、同SHA実CSVの2行目注記である。一般的なWeb表示仕様からCSV列単位を推論しない。CSVの申込日と索引取得日も別フィールドで返す。空欄・マスク・対象外を0補完しない。

20基準日cursorをREST/MCP共通readerへ入力接続し、全ページの終端はnullとする。JPX index128KiB、日次snapshot8MiB/10,000銘柄、CSV2MiB、既存series8MiBを上限にstream読取し、size/shape/原本同定/SHA/JPX全体総計を検証する。未知schema、破損、同時刻複数の最新原本、index外cursorは成功として黙殺しない。

実原本はGit対象外の `tmp/feature-audit-20261013/jss-{jpx,shina}-native/` に保全。JPX2026-10-09は3,592,859B/4,247銘柄/19総計、原本PDF SHAとNotion保管ページを含む。逆日歩は88,593B/SHA `f51cdaea8a03b059b9cb892ce6f79e89d4e78b42724f10f5f7b2f03e0277b512`/943行（東証942、名証1）、申込2026-10-09・取得2026-10-13である。初回S3 GET403と、Wrangler3.99が未対応の`--remote`をCLI入口で拒否した記録も保持した。既存OAuthの対応コマンドで固定keyを1GETし、元D1索引の全文SHA/sizeを照合した。新しい公式source GETは0。

[Workers Encoding API](https://developers.cloudflare.com/workers/runtime-apis/encoding/)の説明だけではCP932互換を断定せず、installed Wrangler3.99のMiniflare/workerdで実88,593Bをfatal復号した。HTTP200・置換文字0・Node復号全文SHA一致をローカル実測した（通信はlocal1POST、remote/source/本番書込0）。

検証はstandalone191pass/既存3skip、standalone/root typecheck・owned ESLint、再利用元MOF/JPX3files75pass。既存MOF純CSV parserはexportと未閉引用符拒否、Worker型互換の既定ignoreBOM=falseを明示した。JPX純parserへの変更は、既存長さguardに対応するstrict TS型注釈のみ。個人用原本はGitに複製しないため、CIでは新7件の実原本試験は保存原本不在skipとなるが、cursor20+1、bad index/暦日/body上限、要求前filter拒否、偽索引/同時刻競合、encoding/別様式拒否の機械的契約試験は実行される。ローカルでは全実原本回帰と20+1 REST/MCP全文同値/終端を実行した。

追加負荷は新しい外部source GET/保存/有料API/ライブラリ0。latestはJPX2R2 GET（実body約3.6MB）、逆日歩1SELECT＋1R2 GET（約89kB）。seriesはJPX index＋最大20snapshot GETを逐次処理し、全snapshotを同時保持しない。Nix Node実測（stubの直列化/stream/JSONparse/厳格検証込み、Worker CPU/R2 latencyではない）10回中央値はJPX40.78ms、逆日歩1.79ms。Node試験プロセス最大RSS約204MiBは繰り返しstub生成込みであり、Worker使用メモリの実測とは区別する。

最終private probeは既存24ケース＋逆日歩REST/MCP対4件の28ケース・全8tools。JPX/逆日歩のseriesは保存native基準日1日に固定し、独立した保存原本DTO期待digestとREST/MCP相互digestを両方検査する。raw-contentを含む全非health応答はbody読前にX-Surface privateを検証する。nonce256bit/15分expiry/固定宛先・case/値非露出/単発durable latch/unknown STOPを維持し、通常appのCI/main/deploy後にroot承認されたfresh namespaceだけを1回起動する。現段階では本番配置・無配分upload・本番probeは0。

最終28-caseの静的監査内訳:

| case群 | 件数 | 成功境界 |
| --- | ---: | --- |
| health / missing・invalid auth / licenses | 4 | 固定status、health private、401 unauthorized、非health X-Surface |
| MCP initialize / tools-list | 2 | 規定protocol、8toolsの名前・3需給enum・cursor型、controlにdata digestを要求しない |
| JPX latest / series × REST・MCP | 4 | native株数/円・原本来歴の固定期待digest、series1基準日、updated null、相互digest一致 |
| JSF shina latest / series × REST・MCP | 4 | native CSVと既存seriesの項目・全取引所・1基準日、固定期待digest、相互digest一致 |
| OHLCV / freshness / indicators / valuation / jobs / raw-file × REST・MCP | 12 | 既存型/件数/資格、RESTとMCPの実際の共通fieldを正規化して相互digest一致 |
| raw-content / yutai | 2 | body読前surface、186Bの固定SHA、条件DTOと原文非公開・集計不可 |

全早期returnを確認し、非healthは401/rawを含めbody読前header検査を通る。core/runnerは固定case identityを検査する同じdata-pair判定関数を共有する。ローカルharness18checks（workerd manual200/302・nonce/expiry・値非露出・raw header negative・native期待1field破損拒否）と、通常appへ保存実原本を与えた6REST/MCPケースの期待digest一致がPASS。逆日歩seriesの本番既存R2読取は最終liveで検査し、localで架空seriesへ置換して完了扱いしていない。

root最終レビュー後、CSV2行目の単位定義をNFKC正規化して最高/前日の日次単位・当日の品貸日数乗算が両方明示されることを必須にした。注記欠落/改変はSTOP。JPX公表日もISO形式だけでなく実在する暦日との一致を必須にした。どちらもnative原値・DTO・期待digestは不変、actual note/calendar明示改変とCI常時のnote境界試験を追加した。
