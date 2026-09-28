# moneyflow 全取得元・R1業種集計の実データ照合 (2026-09-28)

Issue #146。担当C: moneyflow 全spec (25) + R1業種売買/時価総額/空売り。
`muse-spark-1.3-contributor/max` で実施。Branch `audit/moneyflow-2026-09-28`
at origin/main `18d5939` (#145)。検査日 2026-09-28 (JST)。
2026-09-28 追補: レビュー指摘5点を反映し、件数訂正・R1独立再計算・
global独立再計算・JVCEA独立再読・代表標本再現表を追加した。

結論: 全spec（集計ID:MF-specs）・計行数（集計ID:MF-rows-total。旧版ヘッダの「5,633行」は集計誤記。下記訂正記録）
の原表→parser→観測行の全件構造検査に合格し、原本標本の照合では
誤りを検出しなかった (実差分0・許容誤差0。MOF内訳の出典側丸め残差
1件は注記どおり)。ただし「取得誤りなし」「全件独立差分0」とは断定
しない — 下表の検証レベルを区別すること。Notion DB（集計ID:MF-notion-rows。
一次実体・観測とも未保管）のため、保存値との突合せは不能
(対象なしではなく未確認)。アーカイブ完了ではない。

<!-- audit-report:BEGIN moneyflow -->
## 生成集計ブロック: moneyflow（機械生成・手編集禁止）

生成元 `docs/test-logs/data-audit-2026-09-28.results.json`（contract v1・Issue #151）。本文の要約層は数値を再入力せず集計ID参照にすること。
自動 checker は語義・源泉の正確性を保証しない。原因解釈は本文と証拠項目IDで人がレビューすること。

監査スナップショット日 2026-09-28 / 最新確定営業日 2026-09-28 / 保存系列最新 2026-09-25
日付注: R1の保存最新は09-25。9/28営業日分は未反映（次回日次jobで反映見込み）。

### 母集団

| 項目ID | 内容 | n | 備考 |
|---|---|---:|---|
| MF-specs | moneyflow検査spec数 | 25 | — |
| MF-r1-universe | R1母集団（active×内国普通株） | 3700 | — |
| MF-notion-dbs | Notion確認DB数 | 4 | — |

### 内訳集計（合計は内訳から計算）

| 項目ID | 内訳 | 合計 | 状態 | 出所 |
|---|---|---:|---|---|
| MF-rows-total | coingecko-global13＋jpx-investor-equity-weekly240＋mof-portfolio-flows-weekly286＋jpx-derivatives-investor-weekly484＋jpx-derivatives-investor-futures-oi134＋cftc-cot-jpy10＋global-indices221＋jpx-investor-equity-monthly240＋jpx-investor-etf-reit-etf29＋jpx-investor-etf-reit-reit29＋mof-portfolio-flows-monthly264＋imaj-fund-flows120＋imaj-fund-flows-reit24＋jsda-bonds240＋ffaj-otc-fx384＋tfx-click365-fx462＋tfx-click365-cfd154＋jvcea-crypto156＋bop-regional174＋boj-flow-of-funds282＋bis-banking453＋imf-cpis387＋tfx-click365-fx-annual186＋tfx-click365-cfd-annual22＋worldbank-marketcap127 | 5121 | 確認済み | 報告書記載値 |
> MF-rows-total: 旧版ヘッダの5633は集計誤記。正は内訳合計5121
| MF-notion-rows | 一次データ｜moneyflow0＋資金フロー｜指標定義0＋資金フロー｜観測ログ0＋資金フロー｜取込ログ0 | 0 | 未検証 | 報告書記載値 |
> MF-notion-rows: 一次実体・観測とも未保管のため保存値との突合せは不能。対象なしではなく未確認
| MF-r1-cap | 非NULL3695＋欠損（不算入）5 | 3700 | 確認済み | 報告書記載値 |
> MF-r1-cap: 欠損5は不算入（0埋めなし）
| MF-r1-range | 9/25行あり3698＋9/25行なし2 | 3700 | 確認済み | 報告書記載値 |

### 照合カバレッジ

| 項目ID | 内容 | 一致/母数 | 状態 |
|---|---|---:|---|
| MF-r1-sectors | R1業種集計の独立再計算＋API照合（turnover/share/up/down/cap・差分0） | 33/33 | 確認済み |
| MF-global-idx | global-indices W39・17指標の独立再計算（差分0） | 17/17 | 確認済み |
| MF-jvcea-cells | JVCEA 2026-07行のpdftotext独立再読（5値一致） | 5/5 | 確認済み |
| MF-imf-official | IMF原典最新期との照合 | 0/1 | 未検証 |
> MF-imf-official: 原典直結は到達不可。鏡（DBnomics・2024-H1）のfreshnessのみ主張

### 隔離候補・保留

隔離候補・保留ともに該当なし。C所掌に隔離表はない

### 証拠

| 項目ID | path | sha256 | bytes | 時刻state | 備考 |
|---|---|---|---|---|---|
| EV-mf-mof-w | `fixtures/public/mof-portfolio-flows/mof-week.csv` | de9ba9847fdc8bebebdb8f7ee2adcc572a899296c5555d540b58a110c0f9744b | 255655 | 未確認 | 一次公開URLは財務省証券売買統計ページ |
| EV-mf-deriv-w | `fixtures/private/jpx-derivatives-investor/jpx-deriv-investor-week-20260907_20260911.csv` | 6258b0877d10ee68adfd6c50029f6a88014c616efb721a29173b9925adff0244 | 117179 | 未確認 | 一次公開URLはJPXデリバティブ投資部門別ページ |
| EV-mf-cftc | `fixtures/public/cftc-cot-jpy/cftc-cot-jpy-legacy-futures-only.json` | b813b57d0108c96ec9adc8adb61b259b3b2e12d9605b16f80c8532cf2c692697 | 75209 | 未確認 | 一次公開URLはCFTC publicreporting API |
| EV-mf-bop | `/tmp/regbp_trimmed.zip` | 0041dcc824a4fc279c6949955fcc0c64dddcd8ca79933d602588975834ce1bcc | 38796 | 未確認 | 一次公開URLは日銀stat-searchダウンロードページ |
| EV-mf-jvcea | `/tmp/jvcea-full.pdf` | ec16877d5fcce8953c86a350d0a6601a3c12cd02e111804f963ca0a0cda04657 | 1238546 | 未確認 | 一次公開URLはJVCEA統計ページ。PDFバイトとサイト現物の突合せは未実施 |
| EV-mf-etf | `/tmp/mf-fix-jpx-investor-etf-reit-etf-etf_m2608.xls` | 0ab50183e6fa7b0b4ce94e962a131fb4128789ed9836b76853cb747445affea0 | 52736 | 未確認 | 追補で再取得し同一バイトを確認 |
| EV-mf-imaj-reit | `/tmp/mf-fix-imaj-fund-flows-reit-imaj-fund-flows-reit-2026-07.xlsx` | 26a5fab03a2cc7a871c498d786fe5c81abc048fc294aaea9a589afbb42ea1122 | 25503 | 未確認 | 追補で再取得し同一バイトを確認 |
| EV-mf-equity-w-val | `/tmp/stock_val_1_260902.xls` | 0203d8e7cec672fe24a4c12126a38ee395ffdc62db34f2d0d81518a99720f998 | 99840 | 未確認 | 一次公開URLはJPX投資部門別ページ |
| EV-mf-equity-w-vol | `/tmp/stock_vol_1_260902.xls` | b311878debf0a414820210007bc7a3f7d3f2262a55cec6178d59bd15689bb08f | 97792 | 未確認 | 一次公開URLはJPX投資部門別ページ |
| EV-mf-imf-01 | `fixtures/private/imf-cpis/imf-cpis-full-20260928-01.json` | 2ec7e974ddbe607bc01f7be9ff1967768f4092250dbbd2506517933ee291a1c0 | 142539 | 未確認 | DBnomics鏡。原典IMF直結は到達不可 |
| EV-mf-imf-02 | `fixtures/private/imf-cpis/imf-cpis-full-20260928-02.json` | 58f0c10887e867a9bbd4723122cc08d73922522ff81720cfbc417960a4a49582 | 95525 | 未確認 | DBnomics鏡。原典IMF直結は到達不可 |
| EV-mf-global-gspc | `/tmp/mf-global-raw/global-indices-gspc-2026-W39.json` | ef3467955ce6851ce306430d7b131ee5e934b243246d4922ffa546643d210055 | — | 未確認 | 同一batch再取得物の代表。9/28初回fresh値との突合せはraw未保存のため不能 |
| EV-mf-global-tnx | `/tmp/mf-global-raw/global-indices-tnx-2026-W39.json` | 098b9f010e6975def5408d031488e1a9ec87db4d65f75f97f0d7396379c4df57 | — | 未確認 | 同一batch再取得物の代表。代表URLはYahoo chart API（^TNX・6mo・1wk） |
| EV-mf-fix-r1 | `/tmp/mf-fix-r1.mts` | e2a92115d94c642b568fb210f8a3ec0d5e7caa33c6f1eef0e46fb3bf05aabaf9 | 7722 | ファイルmtimeのみ（観測時刻ではない） | R1独立再計算＋API照合（COMPARE mismatched_sectors=0） |
| EV-mf-fix-etf-reit | `/tmp/mf-fix-etf-reit.mts` | e7702f1539bf2d45493664a70f5b6d90b8abe690f05b9bd73944a59d1020e3e3 | 1588 | ファイルmtimeのみ（観測時刻ではない） | etf/imaj-reitのPARSE-OK再現 |
| EV-mf-fix-global | `/tmp/mf-fix-global.mts` | 4fccd52c0eec740e471f89e82d8068ffc714579ae0bf188dd289c5d3703f5ee8 | 5236 | ファイルmtimeのみ（観測時刻ではない） | global W39・17指標の独立再計算（MISMATCH=0） |

### 未検証範囲（合格に数えない）

- Notion保存値との突合せ不能（4DB 0行・D1観測未取込）。保存照合の完了とは言わない
- jpx-equity-W36数量側未検証（原本欠。金額側は前週欄で照合）
- JVCEA PDFバイトとサイト現物の突合せ未実施
- 9/28初回fresh値との突合せ不能（raw未保存。再取得batchで代替）
- coingecko-global当日batchの同一再照合未実施（再取得は別batch）
- 月次空売り加重平均の実データ集計例未観測（単体テスト境界のみ）
- R1の9/28当日分未反映（保存最新9/25）
- IMF原典最新期との照合未実施（鏡のfreshnessのみ主張）
- 訂正版の重複事例未観測（保管0件）
<!-- audit-report:END moneyflow -->

## 検査の境界 (必読)

- read-only: ingest/dry-run・recordPrimaryData・moveToTrash・D1/R2書込は
  未起動。新規依存installなし (nix既存のみ。JVCEA独立再読に使った
  pdftotextは /nix/store 既存の poppler-utils 25.10.0)。JPX新様式parser変更と
  信用残日次化は9/29延期のまま (本検査の対象外)。
- 検証レベルを区別する (詳しくは「検証レベルの定義」):
  A=全件構造検査、B=原本標本の独立再読、C=同一抽出テキスト照合、
  D=保存実データ未確認。未検証は「未検証」と明記し、0埋め・推測をしない。
- 秘密値・署名URL・原本全文は本記録に含めない。ファイル特定は
  代表標本のみ全文sha256 (それ以外はバイト数+sha256先頭16桁)。

## 検証レベルの定義

- A 全件構造検査: 当該バッチの全観測行を `toObservations` に通し
  `validateDrafts` で検証 (冪等キー一意・有限数・期間順序・単位/区分の
  既知値・0行拒否)。parserの自己整合性は保証するが、原表との一致は
  別途B/Cでしか見ない。
- B 原本標本の独立再読: adapter外の読取 (python csv/json/re/zip+xml/xlrd、
  curl再取得、pdftotext等) で原表セルを直接読み、観測値と比較。
- C 同一抽出テキスト照合: parserと同じ抽出経路のテキスト内での存在確認
  に留まるもの (独立toolなし)。本記録では当初JVCEAのみ該当したが、
  追補のpdftotext再読によりBへ格上げ済み。残存なし。
- D 保存実データ未確認: Notion/D1の保存値との突合せができないもの。
  本検査では全25spec+R1が該当 (Notion 4 DB 0行・D1観測未取込)。
  原表標本に問題なし ≠ アーカイブ・実運用完了。

## 件数訂正記録 (5,633→5,121)

旧版ヘッダの「計5,633行」は、25spec表の合計5,121行と矛盾していた。
同一検証batch/spec/periodで実数を再照合した:

- 保存済み原本21spec: `mf-audit-01.mts` (8spec)・`mf-audit-03.mts`
  (13spec) を再実行し、全21specで表の行数どおり `ROWS-OK`
  (idem一意・期間連続も再確認)。
- bounded fresh 4specのうち3spec: 同一batchを再取得し同数を確認
  (global-indices W39→221行・etf 2026-08→29行・
  imaj-reit 2026-07→24行。etf/imaj-reitはバイト同一
  sha16 `0ab50183…`/`26a5fab0…` で決定的に同一)。
- 残るcoingecko-global (日次・batchが日付で進む) のみ9/28記録の13行。
  当日再取得は別batchになるため実施せず。

512 (=5,633−5,121) の差を生む二重計上・異batch混在の組合せは再現
できなかった (単独2specの和で512に一致するものなし。近傍は
484+29=513・384+127=511)。よって5,633は旧版ヘッダの集計誤記と断定し、
正しい合計5,121行に訂正する。PR本文の同数も訂正する。

## 25spec inventory (scripts/moneyflow/sources.ts SPEC_SOURCES)

| # | spec名 | 指標数 | 頻度 | バッチ行数 (本検査の実測) | 単位 | stock/flow |
|---|---|---|---|---|---|---|
| 1 | coingecko-global | 5 | 日次 | 13 (2026-09-28・bounded fresh) | 円/米ドル/比率 | 価格・残高 |
| 2 | jpx-investor-equity-weekly | 4 | 週次 | 240 (2026-W37) | 円/株 | 純買越・売買代金 |
| 3 | mof-portfolio-flows-weekly | 3 | 週次 | 286 (W25-W37の13週) | 円 | 純・グロス |
| 4 | jpx-derivatives-investor-weekly | 4 | 週次 | 484 (2026-W37) | 枚/円 | 純・グロス |
| 5 | jpx-derivatives-investor-futures-oi | 1 | 週次 | 134 (2026-W38) | 枚 | 建玉(残高) |
| 6 | cftc-cot-jpy | 10 | 週次 | 10 (2026-W39) | 枚 | 建玉(残高) |
| 7 | global-indices | 17 | 週次 | 221 (W27-W39の13週・bounded fresh) | 比率/%ポイント | 価格変化率 |
| 8 | jpx-investor-equity-monthly | 4 | 月次 | 240 (2026-08) | 円/株 | 純買越・売買代金 |
| 9 | jpx-investor-etf-reit-etf | 3 | 月次 | 29 (2026-08・bounded fresh) | 円 | 純・売買代金 |
| 10 | jpx-investor-etf-reit-reit | 3 | 月次 | 29 (2026-08) | 円 | 純・売買代金 |
| 11 | mof-portfolio-flows-monthly | 3 | 月次 | 264 (2025-09〜2026-08) | 円 | 純・グロス |
| 12 | imaj-fund-flows | 2 | 月次 | 120 (2025-09〜2026-08) | 円 | 設定解約・残高 |
| 13 | imaj-fund-flows-reit | 2 | 月次 | 24 (2025-08〜2026-07・bounded fresh) | 円 | 設定解約・残高 |
| 14 | jsda-bonds | 2 | 月次 | 240 (2025-08〜2026-07) | 円 | 発行・償還 |
| 15 | ffaj-otc-fx | 8 | 月次 | 384 (2024-09〜2026-08) | 円 | 売買代金・建玉・残高 |
| 16 | tfx-click365-fx | 2 | 月次 | 462 (2026-02〜2026-08) | 枚 | 売買・建玉 |
| 17 | tfx-click365-cfd | 2 | 月次 | 154 (2026-02〜2026-08) | 枚 | 売買・建玉 |
| 18 | jvcea-crypto | 13 | 月次 | 156 (2025-08〜2026-07) | 円/口座 | 売買代金・残高・建玉 |
| 19 | bop-regional | 10 | 四半期 | 174 (2026-Q1) | 円 | 純 (資産/負債) |
| 20 | boj-flow-of-funds | 24 | 四半期 | 282 (2026-Q2速報) | 円 | フロー・ストック |
| 21 | bis-banking | 2 | 四半期 | 453 (2025-Q4+2026-Q1) | 米ドル | 残高 |
| 22 | imf-cpis | 6 | 半期 | 387 (2022-H2〜2024-H1) | 米ドル | 残高 |
| 23 | tfx-click365-fx-annual | 2 | 年次 | 186 (2023〜2025) | 枚 | 売買・年末建玉 |
| 24 | tfx-click365-cfd-annual | 2 | 年次 | 22 (2025のみ) | 枚 | 売買・年末建玉 |
| 25 | worldbank-marketcap | 1 | 年次 | 127 (2020〜2025) | 米ドル | 残高 |

利用条件 (指標定義どおり): personal-only=JPX系7・TFX系4・Yahoo系1、
public-domain=CFTC、attribution-required=MOF/BOJ/BIS/IMF/WB、
要確認=IMAJ/JSDA/FFAJ/JVCEA/CoinGecko (非公開Notion限り・公開面へ出さない)。

## 全件構造検査 (レベルA・母集団=各バッチ全行・合計は集計ID:MF-rows-total)

方法: 保存済み原本 (commit済みpublic 7 + worktree private 5 + /tmp履歴
32・いずれもsha256照合済み) またはbounded fresh取得 (4spec) の
バイト列を `toObservations` に通し `validateDrafts` で全行検証。
冪等キー `期間|指標|区分` の一意性・有限数・期間順序・単位/区分の
既知値・0行拒否を全行で確認。結果: 全spec（集計ID:MF-specs）合格・行数は上表どおり
(合計は集計ID:MF-rows-total。docs/moneyflow.mdの期待値と一致)。冪等重複0・検証違反0。

原本バイトの特定 (代表: 名称 bytes sha16):

- mof-week.csv 255655 de9ba9847fdc8beb / montha1.csv 73511 c3ca908f708f70e9
- bis claims 17412 99c359c8f4bfd717 / liab 17289 a9fbd5ed0d58cea5
- cftc json 75209 b813b57d0108c96e
- wb marketcap 398531 25b4a1457cfd2788 / country-meta 113590 d29d57f8adf954c5
- imf full-01 142539 2ec7e974ddbe607b / full-02 95525 58f0c10887e867a9
- jpx-deriv csv 117179 6258b0877d10ee68 / oi xlsx 31425 9f1802b3362604d5
- equity w2 val 99840 0203d8e7cec672fe / vol 97792 b311878debf0a414
- equity m08 val 89088 806915e62a9fba7d / vol 92672 a1479dc3c2ff7452
- reit_m2608 50688 5d16514f97286dab
- imaj B1 430536 979ce1515cad3910
- jsda xlsx 430235 2e9cf3616d96642d
- ffaj trading 358912 2e90a31f38956258 / open 134656 02d2f648b7c94135 /
  deposit 84992 a77e0319585a082b / index 100180 9185c846c2b3492b
- tfx fx html 57643 5e801c11589cf6f8 / cfd html 31381 a224a9f2f0f86a3a
- jvcea pdf 1238546 ec16877d5fcce895 / index 101789 25c9365786f03df6
- boj sjpre 220647 8140783b4a4362f5 / index 67372 c979d29b25015866
- bop zip 38796 0041dcc824a4fc27 / dload 1400 a7c56cfd115fd9a3
- R1 marketcap pdf 48387 fb3c05b7af005ad2 / short pdf 100090 10797e85b09d098c
- fresh etf_m2608 52736 0ab50183e6fa7b0b (追補で再取得し同一バイトを確認)
- fresh imaj-reit 25503 26a5fab03a2cc7a8 (追補で再取得し同一バイトを確認)

## 原本標本照合 (レベルB・許容誤差0)

adapter外の読取 (python csv/json/re/zip+xml/xlrd・curl再取得・pdftotext)
で原表セルを直接読み、観測値と比較。通貨換算・符号・stock/flow・
NAと0・内訳合計・訂正を標本化。結果: 全標本一致 (実差分0)。
唯一の残差はMOF週次の出典側丸め (下記・parserの誤りではない)。
差分0の範囲は「標本化したセル値の一致」であり、標本外の行・保存値・
表示値の一致を意味しない。

| spec | 標本field (原表→観測) | 単位換算 | 実差分 |
|---|---|---|---|
| mof-W | 9/6-12週 対内合計ネット -4,995億→-499,500,000,000 / W25対外株式取得 36,945億→3,694,500,000,000 / net=取得-処分・小計/合計の内訳一致 | 億円×1e8 | 0 (内訳1件は出典丸め残差1億・備考②「合計に合わないことがある」どおり) |
| mof-M | 2026-08 対内合計ネット -58,239億→-5,823,900,000,000 / net=取得-処分 | 億円×1e8 | 0 |
| bis | 2025-Q4 世界計(5J)与信 5,098,591.486→5,098,591,486,000 / 1C(国際機関)除外で行数 reconciliate (期毎1行) / Zambia 0.296→296,000 | 百万米ドル×1e6 | 0 |
| cftc | 円先物OI 378,701 (換算なし) / noncomm net=long-short=71,982 / 日経OI 21,974 | 枚そのまま | 0 |
| worldbank | 世界計2020 94,968,574,460,000 (換算なし) | 米ドルそのまま | 0 |
| imf | 米国対外合計2024-S1 2,072,394,613,197 / AU対内2023-S1・2024-S1欠スロット・SG対内2024-S1欠スロットは行なし (0埋めなし) / "NA" 42点が窓外に存在し読み飛ばし | 米ドルそのまま | 0 |
| jpx-deriv-W | 日経225先物/自己 売161,521買153,856純-7,665合計315,377 / 個人代金純+48,281,984,900 (換算係数1) | 枚・円そのまま | 0 |
| jpx-deriv-OI | 日経225先物12月限 売超HSBC 31,500/買超野村 33,866 (xlsx生XML) / TOPIX 53,241/63,708 | 枚そのまま | 0 |
| equity-W | プライム海外 売28,570,404,573買28,295,470,330純-274,934,243千円→-274,934,243,000 / 前週欄にW36値 (二市場総計+10,649,727千円) が一致 | 千円×1e3・千株×1e3 | 0 |
| equity-M | プライム自己純 +469,885,364千円→469,885,364,000 / 二市場総計 407,516,356,670千円→407,516,356,670,000 | 千円×1e3・千株×1e3 | 0 |
| etf | 海外純 129,341,724千円→129,341,724,000 (追補再取得で同一バイト→決定的に同一parse) | 千円×1e3 | 0 |
| reit | 海外純 -66,009,392千円→-66,009,392,000 / 市場全体 2,163,190,582千円→2,163,190,582,000 | 千円×1e3 | 0 |
| imaj | 2026-08 総合計 純流+1,939,503百万円→1,939,503,000,000・残高364,285,531百万円→364,285,531,000,000 / 前期比あり | 百万円×1e6 | 0 |
| imaj-reit | 追補再取得で同一バイト (24行) / 2026-07残高 12,341,269百万円→12,341,269,000,000 | 百万円×1e6 | 0 |
| jsda | 国債2026.07 発行14,524,109償還8,048,861百万円→円 / CB発行0は実0 (欠損行なし) | 百万円×1e6 | 0 |
| ffaj | 2026-08 売買825,716,490百万円→825,716,490,000,000 / JPY買越-2,877,141百万円→-2,877,141,000,000 / 必要証拠金残高1,920,655,895,456 (円そのまま) | 百万円×1e6・円 | 0 |
| tfx-fx | 米ドル/円2026-08 売買376,532建玉347,485 (表頭2026.08〜2026.02の7か月) | 枚そのまま | 0 |
| tfx-fx-a | 米ドル/円2025 年間売買6,003,872 / 空欄3ペアの2023・2024年は行なし | 枚そのまま | 0 |
| tfx-cfd | 日経225 2026-08 売買728,991建玉34,495 | 枚そのまま | 0 |
| tfx-cfd-a | 2025年のみ22行 (2023・2024全空欄は行なし) / 日経225年間2,364,089 | 枚そのまま | 0 |
| jvcea | 2026-07 現物674,240証拠金627,529預託計2,872,363百万円→円 / 口座14,280,598・1,015,983 (追補: pdftotext独立再読で2026-07行の値を直接確認（集計ID:MF-jvcea-cells）。レベルC→Bへ格上げ) | 百万円×1e6・口座 | 0 |
| bop | 中国直接net 2026Q1 -1,631.38201514億→-163,138,201,514 / 地域別合計 +40,673.64563458億→4,067,364,563,458 / NA16系列は行なし (174=190-16) | 億円×1e8 | 0 |
| boj | 家計株式等フロー37,452億→3,745,200,000,000 / 家計現預金残高11,315,943億→1,131,594,300,000,000 / 中央政府上場株フロー0は実0 / 対外証券フロー資産合計=負債/海外 -10,738,100,000,000 | 億円×1e8 | 0 |
| coingecko | BTC 12,977,231円 (再取得で同一値・tol0) / 支配率0.587…比率 | 円・米ドル・比率 | 0 |
| global-idx | 221=17指標×13週・単位比率/%ポイント・期間W27-W39連続 (fresh) / 追補: W39の全指標を独立再計算し全差分0（集計ID:MF-global-idx。定義は下記） | 比率そのまま | 0 |

前期・訂正・NA: MOF版キー(最終更新日)と原表見出しの一致を実ファイルで
確認 (W37版2026-09-17・M08版2026-09-08)。訂正版の実例は保管0件のため
未観測 (重複なし)。NA系は上表のとおり行なし・0埋めなし。
jpx-equity-W36 (前期) は数量ファイル欠のため金額側のみ前週欄で照合
(数量側は未検証)。

global-indices独立再計算 (追補・レベルB): 9/28 freshのraw bodyは
メモリのみで未保存だったため、同一batch (target W39) を再取得
(16 Yahoo週足chart・/tmp保存) し、`toObservations` のW39・17指標を
素朴JS (現地暦週グルーピング・スナップショット除外・前週比) で独立再計算。
定義: pct指標は `((c-p)/p*100)/100` を単位「比率」で記録
(TNXのpctも同様)、TNXのpt指標は `c-p` を単位「%ポイント」で記録。
結果: 集計ID:MF-global-idx の全指標で差分0 (例: TNX W39 close 5.184/前週4.998→pt
0.18599987030029297・pct比率0.03721485892470648。GSPC W39比率
0.012144324717338737)。前週は16銘柄すべてW38と隣接。
9/28初回fresh値との突合せはraw未保存のため不能 (再取得batchで代替)。

JVCEA独立再読 (追補・レベルB): parser (unpdf/pdfjs系) とは別エンジンの
pdftotext (poppler 25.10.0・/nix/store既存) で同一PDFを抽出し、
2026-07行に標本値（集計ID:MF-jvcea-cells。値は 674,240 / 627,529 / 2,872,363 / 14,280,598 /
1,015,983）が同一行に存在することを直接確認。PDFバイト自体の真正性は
index突合せ (URL・ファイル名) の範囲であり、サイト現物とのバイト比較は
未実施。

## 代表標本の再現表 (追補)

各行は「spec→period→artifact→一次公開URL→全文sha256→期待値/取得値→
再現command→出力件数」。全文hashはGit可 (秘密なし)。raw大JSON・
Notion private IDはGitに入れない (hash+集計のみ)。

| spec | period | artifact (非secret名) | 一次公開URL | sha256 (全文) | 期待値/取得値 | 再現command→出力 |
|---|---|---|---|---|---|---|
| mof-W | 2026-W37 | fixtures/public/mof-portfolio-flows/mof-week.csv | https://www.mof.go.jp/policy/international_policy/reference/itn_transactions_in_securities/ | de9ba9847fdc8bebebdb8f7ee2adcc572a899296c5555d540b58a110c0f9744b | 対内合計net -499,500,000,000 / 取得値一致 | vitest run …/adapters/mof-portfolio-flows.test.ts → rows=286 |
| equity-W | 2026-W37 | /tmp/stock_val_1_260902.xls + /tmp/stock_vol_1_260902.xls | https://www.jpx.co.jp/markets/statistics-equities/investor-type/index.html | 0203d8e7…99720f998 / b311878d…689bb08f (全文は下記注) | プライム海外純 -274,934,243,000 / 一致 | tsx /tmp/mf-audit-03.mts → ROWS-OK rows=240 |
| deriv-W | 2026-W37 | fixtures/private/jpx-derivatives-investor/jpx-deriv-investor-week-20260907_20260911.csv | https://www.jpx.co.jp/markets/statistics-derivatives/sector/index.html | 6258b0877d10ee68adfd6c50029f6a88014c616efb721a29173b9925adff0244 | 日経225先物/自己純 -7,665枚 / 一致 | tsx /tmp/mf-audit-01.mts → OK rows=484 |
| cftc | 2026-W39 | fixtures/public/cftc-cot-jpy/cftc-cot-jpy-legacy-futures-only.json | https://publicreporting.cftc.gov/resource/6dca-aqww.json | b813b57d0108c96ec9adc8adb61b259b3b2e12d9605b16f80c8532cf2c692697 | 円先物OI 378,701 / 一致 | vitest run …/adapters/cftc-cot-jpy.test.ts → rows=10 |
| imf | 2024-H1 | fixtures/private/imf-cpis/imf-cpis-full-20260928-01.json (+02) | https://db.nomics.world/IMF/CPIS (鏡。原典IMF直結は到達不可・下記) | 2ec7e974…ee291a1c0 / 58f0c108…60a4a49582 (全文は下記注) | 米国対外合計 2,072,394,613,197 / 一致 | tsx /tmp/mf-audit-01.mts → OK rows=387 |
| jvcea | 2026-07 | /tmp/jvcea-full.pdf (+/tmp/jvcea-info.html) | https://jvcea.or.jp/statistics/information/ | ec16877d5fcce8953c86a350d0a6601a3c12cd02e111804f963ca0a0cda04657 | 現物674,240百万円→674,240,000,000 / 一致 | pdftotext /tmp/jvcea-full.pdf → 2026-07行に5値 (+audit-03でrows=156) |
| bop | 2026-Q1 | /tmp/regbp_trimmed.zip (+/tmp/dload_trimmed.html) | https://www.stat-search.boj.or.jp/info/dload.html | 0041dcc824a4fc279c6949955fcc0c64dddcd8ca79933d602588975834ce1bcc | 中国直接net -163,138,201,514 / 一致 | tsx /tmp/mf-audit-03.mts → ROWS-OK rows=174 |
| etf | 2026-08 | /tmp/mf-fix-jpx-investor-etf-reit-etf-etf_m2608.xls | https://www.jpx.co.jp/markets/statistics-equities/investor-type/ (ETF月次) | 0ab50183e6fa7b0b4ce94e962a131fb4128789ed9836b76853cb747445affea0 | 海外純 129,341,724,000 / 一致 | tsx /tmp/mf-fix-etf-reit.mts → PARSE-OK rows=29 |
| imaj-reit | 2026-07 | /tmp/mf-fix-imaj-fund-flows-reit-imaj-fund-flows-reit-2026-07.xlsx | https://www.toushin.or.jp/statistics/ (資産運用業協会統計) | 26a5fab03a2cc7a871c498d786fe5c81abc048fc294aaea9a589afbb42ea1122 | 2026-07残高 12,341,269,000,000 / 一致 | tsx /tmp/mf-fix-etf-reit.mts → PARSE-OK rows=24 |
| global | 2026-W39 | /tmp/mf-global-raw/16 files (例 gspc/tnx) | https://query1.finance.yahoo.com/v8/finance/chart/^TNX?range=6mo&interval=1wk (代表) | gspc ef346795…643d210055 / tnx 098b9f01…396379c4df57 (全文は下記注) | TNX pt 0.18599987030029297 / 一致 | tsx /tmp/mf-fix-global.mts → ROWS=221・CHECKED=17 MISMATCH=0 |
| R1 sector | 2026-09-25 | D1実保存+内部API (ファイルなし) | GET /api/ingest/moneyflow-sector?from=2026-09-25&to=2026-09-25 (認証付) | (クエリ+endpointで特定。D1書込0) | 33/33sector turnover/share/up/down/cap一致 / 差分0 | tsx /tmp/mf-fix-r1.mts → COMPARE mismatched_sectors=0 |

注: 表中で省略した全文sha256は以下のとおり (いずれも秘密なし)。
equity-W val `0203d8e7cec672fe24a4c12126a38ee395ffdc62db34f2d0d81518a99720f998` /
vol `b311878debf0a414820210007bc7a3f7d3f2262a55cec6178d59bd15689bb08f`。
imf-01 `2ec7e974ddbe607bc01f7be9ff1967768f4092250dbbd2506517933ee291a1c0` /
imf-02 `58f0c10887e867a9bbd4723122cc08d73922522ff81720cfbc417960a4a49582`。
global gspc `ef3467955ce6851ce306430d7b131ee5e934b243246d4922ffa546643d210055` /
tnx `098b9f010e6975def5408d031488e1a9ec87db4d65f75f97f0d7396379c4df57`
(他14銘柄のrawは /tmp/mf-global-raw/ に保存・再取得で再現可)。
/tmp証跡は配布外の手元記録であり、第三者の手動検証は「同一URLから取得→
sha256突合せ→上記command」の順で再現できる。

## R1 業種集計の照合 (追補: 独立再計算+API照合済み)

- 母集団/分母: D1 read-only集計 (2026-09-28再測) で active×内国普通株
  3,700件・sector NULL 0・distinct sector 33。分母漏れなし。
  `swing_daily_ohlcv` の保存最新日は 2026-09-25。**「直近営業日」ではない**:
  9/28 (月) は営業日だが9/28分は未反映。次回反映は stock-sync.yml の
  日次job (平日17:13 UTC=翌02:13 JST) による (保存最新9/25・9/28未反映・
  想定翌jobを区別して記録する)。
- 独立再計算 (追補・/tmp/mf-fix-r1.mts): `moneyflow-sector.ts` をimportせず、
  同一universe (is_active=1 AND instrument_type='equity')・同一範囲
  (from=to=2026-09-25・前日比用7day lookback)・同一NULL除外仕様
  (close/volume NULLは不算入・同値日は騰落どちらにも不算入) で素朴JSにより
  33sectorを再集計。D1 SELECT 11件 (MAX日・母集団・日別OHLCV 8件・時価総額
  1件)。書込0。
- API照合 (追補): 認証内部API
  `GET /api/ingest/moneyflow-sector?from=2026-09-25&to=2026-09-25`
  (200・marketCapAsOf=snapshot_at_fetch・33sectors) の表示値と突合せ。
  結果: 集計ID:MF-r1-sectors で全一致 (turnover/share/upTurnover/downTurnover/marketCap/
  stockCount/marketCapStockCount の turnover/up/down/cap 絶対差分0、
  share絶対差分0、件数一致)。分母 (全業種売買代金合計) 8,201,126,776,418.613円。
  除外件数: 範囲内NULL行66・sector NULL 0・同値日294・前日なし0。
  範囲内行 (集計ID:MF-r1-range)。
  時価総額は取得時点snapshot (集計ID:MF-r1-cap。欠損は不算入)。
  代表: 電気機器 turnover 3,298,799,326,939.7275・share 0.40223732870768947・
  up 3,097,622,705,839.7275・down 198,644,300,000・cap 276,024,434,793,600
  (API値と桁一致)。
- B担当のD1 snapshot (/tmp/audit-b/d1/ohlcv.json) は20銘柄標本
  (9/25は14行) のため33sector再計算には転用不能と実測で確認した。
  重複取得を避けるため内容確認のみ行い、本検査は最小11 SELECTで実施した。
- 集計ロジック定義の追跡: 売買代金=close×volume合算・share=業種/全体
  (全体0ならnull)・上昇/下落は前日比 (7日lookback・同値と前日なしは不算入)・
  欠損は不算入 (0埋めなし)・時価総額は取得時点snapshot
  (marketCapAsOf明示・寄与銘柄数付き)。空売り比率のweight定義は
  `aggregateMonthlyShortSellingRatio` の加重平均
  (当月売買代金合計に占める空売り売買代金合計。日次比率の単純平均ではない)。
  日次空売りPDFの再計算差分0は下記のとおり。月次加重平均の実データ集計例は
  未観測 (単体テストの境界確認のみ)。
- 時価総額PDF (2026年8月分・上記hash): 33業種・基準日2026-08-31・
  電気機器123社279,083,685百万円・プライム1,549社1,368,732,387百万円・
  全体3,887社1,414,461,142百万円が一致。33業種社数合計=プライム社数に
  厳密一致。時価総額33合計はプライム計と-14百万円 (出典側丸め・文書化済み)。
- 空売りPDF (2026-09-25分・上記hash): 33業種・電気機器
  1,971,606/902,200/416,524/3,290,330百万円・比率 (902,200+416,524)/
  3,290,330 の再計算差分0・その他33業種外 309,956百万円が一致。
- R1のNotion観測は0行 (未取込) のため保存値との突合せは不能 (レベルD)。

## Notion persist確認 (read-only・1rps以下・2026-09-28)

「一次データ｜moneyflow」「資金フロー｜指標定義」「資金フロー｜観測ログ」
「資金フロー｜取込ログ」はいずれも行なし（集計ID:MF-notion-rows）。一次実体の保管も観測のpersistも
未実施 (#133の484/134/387を含む全spec)。raw→parser確認とpersist確認は
別評価とし、本記録は前者のみを証跡とする。アーカイブ完了ではない。
後続writer枠での保管・再読・冪等upsertは本検査の範囲外。

## 一次公表の鮮度 (2026-09-28実測・推測なし)

- IMF CPIS (DBnomics鏡): 追補で再測。dataset updated_at 2025-04-08 のまま・
  最新期2024-S1・米国対外合計2,072,394,613,197で不変 (系列再取得で一致)。
  原典IMF直結は到達不可 (data.imf.org該当dataset 404・旧SDMXはDNS不通・
  新APIは登録制。以上はimf-cpis.tsの到達確認記録どおり) のため、
  鏡のfreshnessのみを主張し、原典最新期との照合は未実施と明記する（集計ID:MF-imf-official）。
- MOF週次: week.csvが文書記録とバイト同一 (255,655・de9ba984…)・
  最新週2026-W37 (9/6-12)。月次も2026-08が最新 (9/27記録どおり)。
- JPX投資部門別週次: 一覧が文書記録とバイト同一 (39,782・56aa444f…)・
  最新は9月第2週 (W37・旧様式xls)。新様式・W38掲載は未確認
  (9/29以降・延期どおり)。
- CoinGecko: /globalと/marketsが無keyで200・BTC 12,977,231円を再取得一致。
- Yahoo: ^GSPC等16銘柄が200・W39 (9/21-27) が最新週 (追補再取得で再確認)。
- ETF月次: 2026-08が最新 (追補再取得で同一バイト)。IMAJ-REIT: 2026-07が
  最新 (追補再取得で同一バイト)。

## 最小再現手順 (read-only・repo内)

```sh
git fetch origin && git checkout audit/moneyflow-2026-09-28
# 全件構造検査相当 (実フィクスチャskip分は下記の手元配置で実行化):
nix develop -c pnpm exec vitest run services/moneyflow
# 個別specの実ファイル検査 (例・要原本):
#  - public完結: bis-banking / cftc-cot-jpy / mof-portfolio-flows / worldbank-marketcap
#  - 要private/tmp: 他17spec (adapter testの実ファイル節・キー名は本記録の表)
nix develop -c pnpm exec vitest run services/moneyflow/lib/adapters/mof-portfolio-flows.test.ts
nix develop -c pnpm exec tsc --noEmit
```

/tmp原本の配置対応 (read-only利用・repoへコピー不要): data.xlsx→B1・
stock_val/vol→equity・reit_m2608→reit・jsda_hakkou_v2→jsda・
ffaj-*.xls/html→ffaj・tfx_fx/cfd.html→tfx・jvcea-full/info→jvcea・
boj-sjpre-check→boj・regbp/dload_trimmed→bop・jpx_202608/jpx_g_sample→R1。
fresh 4specは各specのresolve/fetch直呼び (ingest経路外・/tmpのみ・
保管未実施) で再現できる。追補の再現commandは代表標本の再現表を参照
(/tmp/mf-fix-*.mts・/tmp/mf-global-raw/・pdftotext。いずれも私物証跡)。

## 未検証・限界 (明示)

1. Notion保存値との突合せ: 不能 (4 DBとも0行)。D1観測のpersistも未取込
   (レベルD)。保存照合の完了とは言わない。
2. jpx-equity-W36数量側: 原本欠 (vol w1) のため未検証 (金額側は前週欄で照合)。
3. ~~JVCEA標本の独立tool再読~~ → 追補で解消 (pdftotextで5値を直接確認)。
   PDFバイトとサイト現物の突合せは未実施。
4. ~~global-indices fresh値の変化率再計算~~ → 追補で解消
   (同一batch再取得のW39・17指標を独立再計算し差分0)。
   9/28初回fresh値との突合せはraw未保存のため不能。
5. 日銀資金循環の確報改定・財務省確報の追跡: 当期速報のみ (版キーで区別)。
6. 訂正版の重複事例: 未観測 (保管0件)。
7. 新様式 (9/29〜) と信用残日次化: 対象外 (延期どおり)。
8. coingecko-global当日batch: 9/28記録13行のみ。再取得は別batchのため
   同一batch再照合は未実施。
9. 月次空売り加重平均の実データ集計例: 未観測 (単体テスト境界のみ)。
10. R1の9/28当日分: 未反映 (保存最新9/25。次回日次jobで反映見込み)。

## 実行証跡

- vitest services/moneyflow (9/28記録): 40 files passed・852 passed・
  366 skipped。skipはprivate欠の規約どおりだが、skipは検証成功に数えない
  (未実行)。追補では全suite再実行なし (最小検証のみ)。
  tsc --noEmit: 合格 (9/28記録)。
- Notion API送信: 09a 4req・09b 27req・09c 2req・09d 6req (各1200ms間隔・
  書込0)。D1: 初回SELECT 2件 + 追補SELECT 11件 (rows_written 0)。
  内部API: 認証GET 1件 (200)。
  外部GET: 初回bounded計30弱 + 追補 (Yahoo 16・DBnomics 2・IMF-meta 1・
  JPX etf 2弱・toushin 2弱)。新規install 0。
