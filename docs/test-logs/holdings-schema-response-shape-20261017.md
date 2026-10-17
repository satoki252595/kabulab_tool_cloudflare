# 保有明細schemaの宣言値とNotion応答envelope（2026-10-17）

実208Aの読取PREは全16応答を受領した後、Notion databaseの全応答を3項目の保存schemaと比較して停止した。`readHoldingsSchema(): Promise<HoldingsSchema>`は型で宣言した`id`・`properties`・`description`に加え、`request_id`や作成時計等の応答envelopeもそのまま返していた。明示quarantineの次回GETでも応答ごとに異なる`request_id`を比較するため、読取observerだけの変更では解消しない。

共有読取関数は、この3項目を明示して返す。全property ID・定義・選択肢・formulaとdescriptionの各原値を保持し、raw応答は既存native captureへ全バイト保存する。HTTP要求、原表parser、schema PATCH、業務PATCH、物理原本、価格、永続onceの処理は変更しない。schema ID・description・property IDの差は、通常quarantineの既存比較で書込前STOPする。

全callerを確認した。`applyHoldingsSchema`は移行前後の3項目を比較し、`replaceUnknownHoldingPatch`はjournalの同じ3項目を比較する。`quarantineSavedHoldingSource`は全schema比較、`publishVerifiedShareholdings`はschema移行判定と全行処理に使用する。通常CLIの`apply-schema`・保存原本publisher・定期resumeもこの共有経路を使用し、宣言外のdatabase envelopeを必要とするcallerはなかった。

Nixで共有writer・置換・quarantineの3 suites/127 tests、型検査、対象lintを確認した。実208A fixtureの全schema値に異なる`request_id`を持つHTTP応答を付け、通常readerとpublisherの成功を検証した。schema ID・description・property IDの変更3例は業務/物理0でSTOPする。

実READのdatabase応答6は6,466B、SHA256 `cccc5c9b4b8484db8320af4603ee84de2ecb23916797d6d9adba17b88a83f178`。私有の独立再生で、この19項目の実応答から返した3項目が既存fixtureと全文同一で、原応答が不変であることを確認した（1 test/405ms、共有関数のテスト内処理3ms、HTTP0）。新しい金融値やschema定義を生成していない。追加要求0・追加DB処理0で、入力rawを複製せず3項目の参照を返すだけである。

元READは失敗のまま保持する。rootの既知読取閉鎖SHA256 `9de6a87a9f1d7534deb6990b3b3613973c21726dfc33533c68cd2c7f3af78de2`は全16応答、13 API/1 hosted/2 D1 SELECT、24 rows read、mutation0/claim0と原STOPを結合した証拠であり、正常collector完了とは扱わない。新実行の資格・元1800秒と消費の控除・明示APPLY release・4行訂正の本番受入は別途。旧read source・全原本・`.env`・stateは変更していない。
