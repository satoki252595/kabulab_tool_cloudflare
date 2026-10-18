# FSA原本保管の時刻検証（2026-10-18）

通常のFSAコードリスト保管は成功したが、後続readerの時計検証で不整合が見つかった。通常producer/readerの時刻契約を修正し、Nixの関連4suite66件・全体型検査・対象lintを確認した。修正後の再捕捉と価格台帳のactivationは、この記録時点では未実施である。

## 実観測

main `f3aac29352ccc4e5d326c2bbc1e20119f2b02440` の通常 `sector33_sync --archive-only` は15.6秒でexit 0となり、既存の共通物理archiveがZIPとmanifestを同一key・一意page・全バイトで検証した。観測した所有親子プロセスも全て閉鎖した。業種UPDATE・価格書込・activation・モデル呼び出しは0で、実行記録用DMLはopsのprune DELETEとrun INSERTの2文だけである。業種同期の成功時計は進めていない。

collector呼び出しは1回。上流のnative取得試行は独立計測しておらず、既存設定上の最大3回を上限として記録する。Notion/hosted通信の総数、D1のnative試行数、全料金も未計測である。

原本のsource completedAtは `2026-10-18T04:21:10.501981+00:00`。追加の通常page GET 1回（HTTP 200）では、Fetched At・created_time・last_edited_timeがいずれも `04:21:00` と返った。source完了時刻より約10.5秒前に見えるため、表示時計だけでsource完了以後の保管を判定すると正常な新原本が拒否される。この追加診断はhosted取得・上流取得・D1・書込・モデルすべて0だった。

## 修正する通常契約

producerは実際のarchive要求開始時刻をISOで生成し、Metadataの`archiveRequestedAt`とFetched Atへ同じ値を保存する。readerは以下を機械的に検証する。

- source completedAtが記録した実archive要求開始時刻以下である。
- Notionの表示Fetched Atが実archive要求開始時刻と一致するか、その同一分の先頭と厳密一致する。
- 後続処理のfinishedAtが実archive要求開始時刻以後である。
- queryとpage GETの精密時計が一致し、同じ分の候補競合は停止する。

元のsource requestedAt/completedAtは保持する。Pythonのマイクロ秒は、同じミリ秒内では小数部を等価正規化して比較し、ミリ秒へ切り捨てて順序を通さない。Notionとの同値、前世代との順序にも同じ比較を使う。新しいarchive時計を持たない旧pageを、表示時計から推定して資格化する経路は追加しない。既存の一意な単一ZIP bootstrapと、原本全文SHA・来歴・基準日の検証を保持する。

時刻fieldと比較は既存の通常producer/reader内に置き、日常処理へ追加HTTP・LLM・依存ライブラリを導入しない。producerの実時刻と入力上書き拒否、readerの実観測と同じ分精度、精密時計の欠落・不正形式・未来時刻・取得順序逆転・読戻し変化を検証した。旧単一ZIP、同時計競合、旧HOLD拒否も保持する。修正後の実保管・通常reader・activationの結果は、別の受入証跡で追記する。

## 保存証跡

- 通常原本保管・所有親子閉鎖: `tmp/feature-audit-20261018/sector33-archive-only-execution-preparation-v1/normal-generation-custody-acceptance-v1.json`
  - SHA256: `75d5338cd919a24b275659485dbedbdb545e70c6a5f0b47d3c8f3879c28f90e0`
- 正常page GET 1回の時計観測: 同directoryの `generation-clock-read1-result.json`
  - SHA256: `24f9d263d4a0ed74c2dfcbd408aea71ed878a5555ec8d9ae7326719665cd1d59`

本記録は保存証跡の読取から作成した。原本・署名URL・秘密情報を公開資料へ含めず、新たな取得や業務処理を起動していない。
