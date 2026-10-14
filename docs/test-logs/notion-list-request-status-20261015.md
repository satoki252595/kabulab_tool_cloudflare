# Notion list の未完statusを通常読取境界で拒否する

保存済みholding inventory suffix002の最後のquery応答（2026-10-14T15:46:09.207Z、全文SHA `5d85397dfe1379e733f1515f0cb538dcc181332b321363ce157e82c3362297a5`）は100行・`has_more=false`・`next_cursor=null`だが、`request_status.type=incomplete`だった。元の10,000件集合と旧completedはそのまま保全し、全量網羅の証明には使わない。これは既存個票の原本資格や事実値が誤りだったという判定ではない。

[Notion公式Pagination limit](https://developers.notion.com/reference/query-a-data-source#pagination-limit)は、1 queryの上限10,000件、上限集合のすべてのpageに未完markerが付くこと、末尾の`has_more=false`だけでは全量にならないことを説明する。全件読取にはcreated_time窓等でqueryを分割する。公式資料は現行data source API、保存nativeは既存database APIから得た同じmarkerであり、本修正でAPI version/DB schemaを変更しない。

[公式SDKのRequestStatusResponse](https://github.com/makenotion/notion-sdk-js/blob/main/src/api-endpoints/common.ts)ではtypeはcomplete/incompleteの2種で、incomplete_reasonはincomplete時だけの任意項目。[QueryDataSourceResponse](https://github.com/makenotion/notion-sdk-js/blob/main/src/api-endpoints/data-sources.ts)ではrequest_status自体がoptional。確認日は2026-10-15 JST、公式本文とSDK原文は私有ディレクトリへ取得時計/全文SHAとともに保全した。 API頁の生成例にはcompleteとreasonを併記する形もあるが、公式SDKの明示条件に基づき矛盾する形は拒否する。

共通`notionRequest`の既存`assertListEnvelope`で、markerが存在するときだけ、own type=completeだけを持つobjectを許可する。null/配列/型不正/未知type/incomplete/completeとreasonの併存/未知項目は`NotionConfigError`で即停止し、次cursorやwriteへ進めない。旧APIや既存mockでmarkerが欠ける場合は原値をそのまま返し、completeを補完しない。この許容は旧APIのcursor pairingを保持する互換動作であり、marker不在だけを全量網羅の証明とはしない。

検証は全collectorへ返す前、HTTP retryループの外で行うため、該当応答1回の後に同queryを再送しない。search/database-query/block-children/page-propertyの既存境界を再用し、singular property_itemでも存在する未完markerは無視しない。ID/cursor/本文値をエラーに含めない。個別collectorやiteratorを追加しない。

実nativeの末尾envelope metadataだけをfixtureへ投影し、行本文/署名URLを除外した（元応答435,571B、実100行、上記全SHAへ束縛）。実metadataが末尾false/nullでもSTOPする回帰、最初のhas_more=trueでもSTOP、complete原値保持・旧marker不在・malformed/unknownのfetch1/再送0を検証する。query窓分割の実装と全量の再資格は別対象であり、このguard成功を全機能復旧完了には数えない。

本番Notion/D1/R2/source/vendor/model/業務writeは0。公式資料の公開GETだけを用いた。稼働中の本文/事業タグ/保有runnerやPR408のfreezeを変更せず、別isolated branchへ準備した。

Python通常経路も同じ技術metadataを再用する。`_require_read_list_envelope`とscalar境界で、小さな共通status検証をretryの外から呼ぶ。既知incompleteは既存`QueryTruncatedError`、malformed/unknown/complete+reasonは既存`NotionConfigError`で停止し、strict=Falseの警告だけによる部分list返却を許可しない。約18のquery call site（master/disclosures map、原本照合、再解析、保存ROA等）の個別設定変更ではなく、通常clientで保証する。

旧numeric10,000件保険は廃止せず、marker不在でも自然終端で取得>=10,000なら既定full queryを停止する。complete markerがあり正確10,000件だけだった場合も保守的に拒否する境界を残す。明示max_pagesかつhas_more=trueの部分読取は従来どおり返し、numeric上限時は警告・strict=Trueなら停止する。既知incomplete markerは明示部分読取でも最初から停止する。strict引数・既存小さいmax_pages lookupは互換を維持し、大きなiterator刷新や取得範囲変更を行わない。

組合せ検証: accepted main d90725afへ通常mergeし、408のpacing/observerコードを保持した関連9suite242tests、全体TypeScript tscと変更TS2fileのeslintがPASS。Pythonは既存Nix Python3.12.13/uv環境・frozen lock・offline/no-syncでクライアント147tests、ruff、uv lock --check --offlineがPASS。isolated sourceのimport実pathを確認し、ライブラリ追加/lock変更/本番native通信は行わない。

Python全体もsocket/DNSの実接続を拒否した別processで1746件PASS・114件skip・failure/error0（22.242秒）。skipは既存の未取得/私有全原典がisolated環境にないケースであり、架空fixtureや追加取得で埋めない。skipを本番原典の検証成功には数えない。
