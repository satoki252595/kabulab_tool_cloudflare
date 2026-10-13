# 資金フロー失敗3取得元の修復（2026-10-14）

独立28取得元のrun38429178035は25成功/3失敗。全28の再取得・再書込はしない。本差分は3件の原因修正と失敗原本保全、read-only診断に限定し、業務更新はCI/merge後に運用者が行う。

| 取得元 | 観測した失敗/原因 | 修正と確認 |
|---|---|---|
| jpx-investor-equity-weekly | 実公表ラベル「2026年9月第5週(9月28日～10月2日)」を終了月不一致で拒否 | 取得元の共有期間パーサを一覧キー/新様式行/旧様式週次タイトルで使う。ラベル月は開始/終了のいずれかと一致、実暦日、週期間0～6日を検証し、終了日のISO週2026-W40へ対応。新様式ファイル名の明記期間一致は保持。月次旧様式の終了月guardは保持。年またぎも同じ共有検証を通す。 |
| jpx-derivatives-investor-futures-oi | 145行書込後queryにTOPIX先物/2027-03限月/買超7位/日産証券が見つからない | fresh exact-key/native行を保存原本再parseと全項目照合し一致。その後fresh分割queryでも145/145全行・全項目一致、重複0。再送/更新0。元query欠落の原因自体は未証明。将来はquery欠落が1行の場合だけACK同一pageIdのnative GETで所属/状態/キー/全値を検証し警告。2行以上欠落・重複・値違い・404は停止。 |
| global-indices (^STOXX50E) | Yahoo meta.currency=nullを文字列必須として取得内parseで拒否し、原本が未保管 | 既知symbolのINDEXだけNULLを型で保持する。指数ポイント同士の週次比率に通貨換算は使わない。未知symbol/別instrumentType/他商品の通貨欠損・異なる非NULL通貨は停止。既存週足のsymbol/timezone/1wk/session検証は保持。公式参照通貨EURをAPI観測通貨へ代入しない。 |

## 保存原本とreadback

OI原本は既存共有archive page `3f8d74ff-84cd-810f-ae32-c147c881f73f` の `jpx-futures-oi-indexfut-2026-10-09.xlsx`（31,590 bytes、SHA256 `93d614c5ad8955b105214abb041979351c275a3c870417cff07d802b7d012b37`）を一度読み戻し、manifestと全bytes照合した。私有 `moneyflow-oi-unknown-readback.json` と `moneyflow-oi-all-readback.json` に純計算期待値・全145保存行の照合を残す。上流GET0、業務write0。旧run失敗という履歴を成功へ書き換えない。

旧global-indices-2026-W41原本は保管されていなかった。今回^STOXX50Eだけ既存Yahoo clientで1GETし、他15symbolはGETしなかった。新しい実応答はcurrency=EUR、instrumentType=INDEX、timezone=Europe/Zurich、28barsだった。これは元runのNULL応答とは別の観測であり、NULLをEURへ補完した証拠には使わない。4,009 bytes、SHA256 `f0db8570f8f9df42d0b4650eb47c7e1e49ecaaa11a4b0d73706ea668e1bbe03c`、共有archive page `3f8d74ff-84cd-81cd-93ed-e9335719e4eb` で物理全bytes照合済み。私有 `moneyflow-saved/stoxx-capture-receipt.json` に実取得時刻と解析結果を保存した。

[STOXX公式factsheet](https://stoxx.com/index/sx5e/?factsheet=true)はSX5E/ISIN EU0009658145のPrice EURと基準値を明記する。[Eurex公式SX5Eオプション契約](https://www.eurex.com/ex-en/markets/idx/stx/euro-stoxx-50-derivatives/products/EURO-STOXX-50-Index-Options-69660)は同じunderlyingと指数point当たりのEUR契約額を区別する。[STOXX計算ガイド](https://www.stoxx.com/document/Indices/Common/Indexguide/stoxx_calculation_guide.pdf)はindex value/index currency/divisorを説明する。同一variantの指数level比率は無次元、という計算上の判断を採用し、API元のcurrency=NULLは未掲載として保全する。

## 解析失敗でも原bytesを失わない経路

通常のcallerは `scripts/moneyflow/ingest.ts → sources.ts → spec.resolve/fetch → runSpec → recordPrimaryData/fullSHA → toObservations → upsertObservation → verifyObservedBatch`。JPX週次キーのparseはresolve内、Yahoo週足のparseはfetch内だったため、共通runnerの従来archiveへ到達する前に失敗した。

`MoneyflowFetchError`は取得済み実bytesと取得元メタデータを共通runnerへ渡す。runnerは成功batchと異なる`failed-<source>-<SHA>`へshared archive/添付全SHA照合してから元例外を再throwし、観測を書かない。globalは途中失敗までに取得済みの先行symbolファイルも含める。HTTP/不正UTF-8でも元bytesを維持し、置換文字で原本を書き換えない。保管上限/保管失敗/照合不明でも成功扱いしない。dry-runは失敗原本も送信しない。

正常時の追加上流GET/Notion通信/保存は0。失敗時だけ取得済み小原本の保管と読戻し、OIのquery欠落1件時だけ最大1 native GETを増やす。観測再送・外部source追加・有料AI・追加依存は0。

## 検証

関連6test filesで145 PASS、129 private fixture不在による明示skip。共有期間パーサの実失敗ラベル・年またぎ・不正日付/期間、STOXXのNULL保持/非INDEX拒否/他通貨欠損停止、HTTP失敗/不正UTF-8の原bytes保持、resolve/fetch失敗原本の別SHA保管と再throw/dry-run無送信、ACK欠落1件の同一pageId照合・複数欠落停止を検証した。owned ESLintとdiff check PASS。全repo typecheckは同時編集中の別担当の型変更に依存するため、root統合時にも実行する。
