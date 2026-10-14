# EDINETの走査0日と保存保留を区別する（2026-10-14）

通常run `38574602631`（main `34af2ccbade654128e05fab38c44af4d1e2eb9ea`）は走査0日・matched/ingested0・pending15・`holdings:requires_review=1`・cap=trueでexit1だった。開始13:46:32Zから約3.7秒でL2へ進み、投影1407銘柄を121.8秒で処理した。全126.448秒はsource開始予算300秒に達しておらず、manual target=edinetのため予定実行の絶対締切もない。一覧/取込例外は0である。

これはsource走査中の取得失敗ではなく、保存進捗の対象queueが空だった経路である。rootの14:00:36Z・D1単発読取は実15IDと全理由の一致、全finished=1/sealed=1/pending_checked_date=2026-10-14/inflight=NULL、active queue=0・pending recheck due=0を確認した。保留は同日の再送を避け、翌日へ残る。原一覧のpage/全SHA、docID、提出者コードも保存している。native response SHA `13dea87aabbe982c146079c955056ecd6f7ddd7260889d3077f3f66c2ddeb385`、root completed SHA `44e5308611669b4e00e00e812f5082489ff2dada307aede603597a288dbf11be`。これを全体成功へ読み替えない。

15件は `identity_unresolved` で、保存公式一覧の証券コードはNULL、現D1の提出者逆引き/stock/docも未観測だった。公式コードリストで現在非上場・証券コード空と確認できても、通常開示の母集団は上場中だけではなくinactiveも含むため、現在非上場だけを根拠に永久除外しない。15件のpendingや原本を消さず、理由付きHOLDを保持する。保有明細の `requires_review=1` はattention照会page_size1で観測した下限であり、要確認全件の件数とは扱わない。

修正は共通summaryの可観測性に限る。既存progressSummaryの1 SELECT内で、保留4理由、翌日再照合待ち、同日照合済み、未来のcheck日、当日未封印、in-flightの実件数を集計する。cronの `sourceProgress` に選択queue件数と同summaryを載せ、CLIとWorkerが同じ結果を返す。新fieldは旧serialized resultとの型互換のためoptionalだが、新callerは常に返す。追加HTTP/D1 query・schema・取得・モデル・除外は0。exit/cap/予算、進捗CAS、未確定の再送禁止、L2の通常再生成は変更しない。

実15IDを使う条件付きSQLite回帰では、同日照合済み/当日未封印の状態でqueue0・source/ingest0・pending15・保有HOLD・投影1407を再現し、HTTP500とcheckpoint全原値の保持を確認した。これは現在状態のnative読取そのものではなく、確定済み原因を固定する構造回帰である。別の共通helper回帰では同日待ちと翌日の再照合を区別し、summaryが1 queryだけであることも確認した。集計SQLの同形式4列は明示aliasを使い、SQLite/D1のobject行で列名が衝突して値を失うことを防いでいる。初稿失敗logはprivateで保持する。

通常の呼出はNode `scripts/sync/yuho-edinet.ts` とWorker `services/yuho-quant/src/routes/admin.ts` から `runYuhoEdinetCatchup` へ合流する。既存ingestのskip/保管/状態判定、母集団、未知結果の予約はそのままである。有限本文55の隔離runtime/controller、source5の凍結6ファイル、原native log/receiptは変更していない。

検証はNixの既存project shellで実行し、関連4suite・46test、root TypeScript、対象ESLint、対象diffcheckが全て成功した。追加依存0・本番通信0・業務書込0。通常のsource/ingest・CLI終了コード・投影境界の既存回帰も含む。
