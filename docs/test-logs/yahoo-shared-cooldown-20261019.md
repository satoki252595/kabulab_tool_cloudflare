# Yahoo取得制限のジョブ間共有（2026-10-19）

10/19のVWAP補完は18:19:28に429/503を受け、停止期限を18:34:28としたが、次の自然株式jobは18:19:56に取得を始めた。Actionsの共通`yahoo-source`排他は重複実行を防ぐ一方、共有Yahoo clientの停止期限はprocess/isolate内だけで、別job・別isolateへ渡っていなかった。

既存の認証付き`/api/ingest/yahoo`でD1の1行を主キー検索し、有効な期限内は上流取得を0回にする。実429/503の応答と認証時の型付きエラーの両方から、既存のRetry-After解釈で絶対期限を保存する。単一SQLのMAX更新で、遅れて届く短い期限が長い期限を縮めることを防ぐ。初期行の期限0・status NULLは「未観測」という運用状態で、架空の上流応答ではない。

表・初期行の欠落、壊れた状態、D1読取失敗では取得前に停止する。保存失敗時も429/503の原文streamは中継し、呼出元が原本を保管して停止できるよう専用markerと構造化logで故障を明示する。D1障害中の永続化成功や、既に開始した上流通信の取消は保証しない。

株式・VWAP・moneyflowの本番workflowは`YAHOO_PROXY_BASE`を設定する。VWAPの`daily_session_source=yahoo-direct`はbenchmark原本の選択で、共通proxy設定を迂回しない。設定のない手動のdirect取得・exportされた直接関数は共有停止の対象外。新しい外部サービス、認証値、依存、LLMは追加しない。定期receiptのrun IDや実行順は変えない。

## 追加負荷

- 正常時はproxy要求につき、1行表のPK SELECTが1回。全銘柄3687社として株式`1+2N=7375`、VWAPの正常全量passは最大約7375、保存済み日本市場を使うcontextは3、global-indicesは16。22株式日・13VWAP日なら月約258543回の追加SELECTという静的見積り。manual補完・対象日の切替による再取得は別。
- 書込は実429/503観測時だけの1行UPSERT。価格・財務・原本の書込や全市場読取は追加しない。
- D1の現行Paid読取付帯枠は月250億行。見積りはその約0.0011%で、枠を超過しても読取単価から月約0.00026 USD相当。ただし口座全体の利用量と実請求は未確認。根拠: [Cloudflare D1料金表](https://developers.cloudflare.com/d1/platform/pricing/)（10/19確認）。
- D1往復が1回増えるため遅延が0とは扱わない。取込全体の実測時間・レート制限発生頻度は配置後に別検収する。取得の並列数や1秒間隔は変更しない。

D1 bindingのprepared statementを使い、Sessionsを新設しない。Sessions未使用時はprimaryで実行されるため、別isolateが保存した停止期限をreplicaの遅延で見落とす経路は追加しない。根拠: [D1 Database API](https://developers.cloudflare.com/d1/worker-api/d1-database/#withsession)。

## 配置と検証

Nixの既存Node22とテスト環境を使う。SQLはDrizzleの通常generateで作り、表と初期行だけであることを読み、旧金融表のDMLを含まないことを確認する。コードをmainへマージする前に本番へ1回だけ適用し、旧catalog不変・新schema・運用初期行をPRE/POSTと共有Notionアーカイブで確認する。応答不明は再送しない。rollbackしても運用表をDROPしない。

10/19 18:39:28に本番D1の固定0033を通常senderから1回だけ適用し、物理PRE/POST・全旧catalog同値・新3列・PK1・追加索引0・未観測初期行1を確認した。既存表DML0・D1読取6回・DDL送信1回/再送0・Notion13要求/429/再送0・上流取得/モデル0。コード配置はこのschema受入後に行う。受入証跡SHA `a7d92f15da09705df09e94fc71ebf5eff84f6a0e5389b531e8a1cbc17e447f4c`。

関連5スイート85件、型検査、変更TSのlint、governance/license-mapの両suite、Drizzle再生成、Wrangler dry-runはNixで成功。実SQLiteで長い期限→短い期限の競合でもMAXを保持し、次の取得がYahoo0回となること、状態欠損/不正/DB読取障害、消失行の非再作成、保存障害でも元本文とmarkerが物理原本へ残ることを検査した。

別agentの読取レビューに加え、ユーザー指定のSonnetへソースだけを渡した単発レビューも指摘0件。実モデル`claude-sonnet-5-5`、1turn・22.448秒・0.16867 USD、モデル代替/ツール/Web/業務書込0。これは開発レビュー費用で、定期取込へのLLM追加ではない。入力・応答は私有ファイルに保全し、応答SHA `4770baecbd2167aeb2dc51088f010eee5d17f535a011d55ca371d535e4152665`。
