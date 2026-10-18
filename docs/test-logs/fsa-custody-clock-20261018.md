# FSA原本保管の時刻検証（2026-10-18）

通常のFSAコードリスト保管後に見つかった時計検証の不整合を、通常producer/readerで修正した。Nixの関連4suite66件・全体型検査・対象lintを確認し、main526での新規捕捉・通常物理保管・価格台帳のactivationと保存物の独立照合まで完了した。保有明細への価格反映と将来の自然calendar成功は別の受入である。

## 実観測（修正前）

main `f3aac29352ccc4e5d326c2bbc1e20119f2b02440` の通常 `sector33_sync --archive-only` は15.6秒でexit 0となり、既存の共通物理archiveがZIPとmanifestを同一key・一意page・全バイトで検証した。観測した所有親子プロセスも全て閉鎖した。業種UPDATE・価格書込・activation・モデル呼び出しは0で、実行記録用DMLはopsのprune DELETEとrun INSERTの2文だけである。業種同期の成功時計は進めていない。

collector呼び出しは1回。上流のnative取得試行は独立計測しておらず、既存設定上の最大3回を上限として記録する。Notion/hosted通信の総数、D1のnative試行数、全料金も未計測である。

原本のsource completedAtは `2026-10-18T04:21:10.501981+00:00`。追加の通常page GET 1回（HTTP 200）では、Fetched At・created_time・last_edited_timeがいずれも `04:21:00` と返った。source完了時刻より約10.5秒前に見えるため、表示時計だけでsource完了以後の保管を判定すると正常な新原本が拒否される。この追加診断はhosted取得・上流取得・D1・書込・モデルすべて0だった。

## 修正した通常契約

producerは実際のarchive要求開始時刻をISOで生成し、Metadataの`archiveRequestedAt`とFetched Atへ同じ値を保存する。readerは以下を機械的に検証する。

- source completedAtが記録した実archive要求開始時刻以下である。
- Notionの表示Fetched Atが実archive要求開始時刻と一致するか、その同一分の先頭と厳密一致する。
- 後続処理のfinishedAtが実archive要求開始時刻以後である。
- queryとpage GETの精密時計が一致し、同じ分の候補競合は停止する。

元のsource requestedAt/completedAtは保持する。Pythonのマイクロ秒は、同じミリ秒内では小数部を等価正規化して比較し、ミリ秒へ切り捨てて順序を通さない。Notionとの同値、前世代との順序にも同じ比較を使う。新しいarchive時計を持たない旧pageを、表示時計から推定して資格化する経路は追加しない。既存の一意な単一ZIP bootstrapと、原本全文SHA・来歴・基準日の検証を保持する。

時刻fieldと比較は既存の通常producer/reader内に置き、日常処理へ追加HTTP・LLM・依存ライブラリを導入しない。producerの実時刻と入力上書き拒否、readerの実観測と同じ分精度、精密時計の欠落・不正形式・未来時刻・取得順序逆転・読戻し変化を検証した。旧単一ZIP、同時計競合、旧HOLD拒否も保持する。

## 修正後の本番受入（13:45 JST）

main `1c0931ba9d86f6c3f3fa09f5a6d50cb80562d8e8` のCI・実配備受入後、通常 `sector33_sync --archive-only` を新しい20分の有限枠で1回実行した。通常CLIは15.6秒で終了コード0、観測した全所有親子も閉鎖した。取得開始は `04:43:07.987704+00:00`、完了は `04:43:08.167399+00:00`。ZIP573,281Bとmanifest714Bの全SHA・世代key・原時計を確認し、物理保管後のファイルをprivate保存先へバイトを変えず保全した。旧page・旧原本・旧STOPは変更していない。

続いて通常publisherを1回呼び、新しい精密metadata・Notion日付・取得順序・前世代の基準日を、書込前に通常readerで検証した。価格台帳 `local-9fe26841-activation1`（対象session10/16）は有効化され、通常の完全読戻しでstate完了・active pointer・registry全文SHAの一致を確認した。全3,687件のcoverageは採用3,685件・error2件（523A/641A）。元の日足原本123part・参照・受領時計を維持し、日足の再取得・再gzip・保有価格行の書込は0である。

独立FS照合でも元入力127pins・実行source13pinsの全SHA、3,685件の全参照値・3,687件のcoverage・新FSA原本参照・既知の親子閉鎖が一致した。追加GETは0。activationのNotion/hosted通信は合計7要求で、R2 native要求数・全料金は独立計測していない。これは通常の完全読戻しを保存物から受け入れたもので、全価格原本を独立して再GETした監査ではない。

## 保存証跡

- 通常原本保管・所有親子閉鎖: `tmp/feature-audit-20261018/sector33-archive-only-execution-preparation-v1/normal-generation-custody-acceptance-v1.json`
  - SHA256: `75d5338cd919a24b275659485dbedbdb545e70c6a5f0b47d3c8f3879c28f90e0`
- 正常page GET 1回の時計観測: 同directoryの `generation-clock-read1-result.json`
  - SHA256: `24f9d263d4a0ed74c2dfcbd408aea71ed878a5555ec8d9ae7326719665cd1d59`
- main526の新規捕捉・通常物理保管: `tmp/feature-audit-20261018/sector33-archive-only-main526-execution-v1/normal-generation-custody-acceptance-v1.json`
  - SHA256: `eb59497e765960899e6a467d089b7d79ba1c39598376b79352df3886a62ad272`
- 通常activation・完全読戻し: `tmp/feature-audit-20261018/holdings-rights-needed-current-v1/daily-activation-source-read-v2/activation-SUCCESS.json`
  - SHA256: `ab03a42e74120fa77870ede96bac68caf8d6a489cb87f9c02c52525feffe1c76`
- 独立FS受入: 同directoryの `delegate-saved-activation-acceptance-v1.json`
  - SHA256: `02495109e915d1e4037401fdc2801b8b007319f286388e4ac0b7c3aaf89a9585`

本記録の更新は保存証跡の読取による。原本・署名URL・秘密情報は公開資料へ含めない。台帳の有効化を、保有価格queueの完了や全20機能の完了へ読み替えない。
