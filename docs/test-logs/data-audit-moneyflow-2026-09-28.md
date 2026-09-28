# moneyflow 全取得元・R1業種集計の実データ照合 (2026-09-28)

Issue #146。担当C: moneyflow 全spec (25) + R1業種売買/時価総額/空売り。
`muse-spark-1.3-contributor/max` で実施。Branch `audit/moneyflow-2026-09-28`
at origin/main `18d5939` (#145)。検査日 2026-09-28 (JST)。

結論: 取得誤りなし。全25specの原表→parser→観測行を全件構造検査し、
原本標本を独立再読で照合した (許容誤差0・実差分0。ただしMOF内訳の
出典側丸め残差1件は注記)。Notion 4 DBは0行 (一次実体・観測とも未保管)
のため保存値との突合せは対象なし。アーカイブ完了ではない。

## 検査の境界 (必読)

- read-only: ingest/dry-run・recordPrimaryData・moveToTrash・D1/R2書込は
  未起動。新規依存installなし (nix既存のみ)。JPX新様式parser変更と
  信用残日次化は9/29延期のまま (本検査の対象外)。
- 全件構造検査 (母集団=当該バッチの全観測行) と原本標本照合 (標本=下表の
  field) を区別する。未検証は「未検証」と明記し、0埋め・推測をしない。
- 秘密値・署名URL・原本全文は本記録に含めない。ファイル特定は
  バイト数+sha256先頭16桁 (全文ハッシュは再現手順で各自算出)。

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

## 全件構造検査 (母集団=各バッチ全行・計5,633行)

方法: 保存済み原本 (commit済みpublic 7 + worktree private 5 + /tmp履歴
32・いずれもsha256照合済み) またはbounded fresh取得 (4spec・下記) の
バイト列を `toObservations` に通し `validateDrafts` で全行検証。
冪等キー `期間|指標|区分` の一意性・有限数・期間順序・単位/区分の
既知値・0行拒否を全行で確認。結果: 25specすべて合格・行数は上表どおり
(docs/moneyflow.mdの期待値と一致)。冪等重複0・検証違反0。

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
- fresh etf_m2608 52736 0ab50183e6fa7b0b (文書記録と同一バイト)
- fresh F00B21 25503 26a5fab03a2cc7a8 (文書記録と同一バイト)

## 原本標本照合 (独立再読・許容誤差0)

adapter外の読取 (python csv/json/re/zip+xml/xlrd・curl再取得) で
原表セルを直接読み、観測値と比較。通貨換算・符号・stock/flow・
NAと0・内訳合計・訂正を標本化。結果: 全標本一致 (実差分0)。
唯一の残差はMOF週次の出典側丸め (下記・parserの誤りではない)。

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
| etf | 海外純 129,341,724千円→129,341,724,000 (freshバイトが文書記録とsha同一→決定的に同一parse) | 千円×1e3 | 0 |
| reit | 海外純 -66,009,392千円→-66,009,392,000 / 市場全体 2,163,190,582千円→2,163,190,582,000 | 千円×1e3 | 0 |
| imaj | 2026-08 総合計 純流+1,939,503百万円→1,939,503,000,000・残高364,285,531百万円→364,285,531,000,000 / 前期比あり | 百万円×1e6 | 0 |
| imaj-reit | fresh 24行・文書記録とsha同一→同一parse / 2026-07残高 12,341,269百万円→12,341,269,000,000 | 百万円×1e6 | 0 |
| jsda | 国債2026.07 発行14,524,109償還8,048,861百万円→円 / CB発行0は実0 (欠損行なし) | 百万円×1e6 | 0 |
| ffaj | 2026-08 売買825,716,490百万円→825,716,490,000,000 / JPY買越-2,877,141百万円→-2,877,141,000,000 / 必要証拠金残高1,920,655,895,456 (円そのまま) | 百万円×1e6・円 | 0 |
| tfx-fx | 米ドル/円2026-08 売買376,532建玉347,485 (表頭2026.08〜2026.02の7か月) | 枚そのまま | 0 |
| tfx-fx-a | 米ドル/円2025 年間売買6,003,872 / 空欄3ペアの2023・2024年は行なし | 枚そのまま | 0 |
| tfx-cfd | 日経225 2026-08 売買728,991建玉34,495 | 枚そのまま | 0 |
| tfx-cfd-a | 2025年のみ22行 (2023・2024全空欄は行なし) / 日経225年間2,364,089 | 枚そのまま | 0 |
| jvcea | 2026-07 現物674,240証拠金627,529預託計2,872,363百万円→円 / 口座14,280,598・1,015,983 (PDF抽出テキストに5値の存在を確認・同経路) | 百万円×1e6・口座 | 0 |
| bop | 中国直接net 2026Q1 -1,631.38201514億→-163,138,201,514 / 地域別合計 +40,673.64563458億→4,067,364,563,458 / NA16系列は行なし (174=190-16) | 億円×1e8 | 0 |
| boj | 家計株式等フロー37,452億→3,745,200,000,000 / 家計現預金残高11,315,943億→1,131,594,300,000,000 / 中央政府上場株フロー0は実0 / 対外証券フロー資産合計=負債/海外 -10,738,100,000,000 | 億円×1e8 | 0 |
| coingecko | BTC 12,977,231円 (再取得で同一値・tol0) / 支配率0.587…比率 | 円・米ドル・比率 | 0 |
| global-idx | 221=17指標×13週・単位比率/%ポイント・期間W27-W39連続 (fresh) | 比率そのまま | 0 (個別値の再計算は未実施・下記) |

前期・訂正・NA: MOF版キー(最終更新日)と原表見出しの一致を実ファイルで
確認 (W37版2026-09-17・M08版2026-09-08)。訂正版の実例は保管0件のため
未観測 (重複なし)。NA系は上表のとおり行なし・0埋めなし。
jpx-equity-W36 (前期) は数量ファイル欠のため金額側のみ前週欄で照合
(数量側は未検証)。global-indices fresh値の週次変化率の再計算は未実施
(構造のみ検証)。

## R1 業種集計の照合

- 母集団/分母: D1 read-only集計 (2026-09-28) で active×内国普通株 3,700件・
  sector NULL 0・distinct sector 33。分母漏れなし (値の一覧は出さない)。
  swing_daily_ohlcv 最新日 2026-09-25 (直近営業日・鮮度正常)。
- 集計ロジック (src/routes/moneyflow-sector.ts 読査): 売買代金=close×volume
  合算・share=業種/全体 (全体0ならnull)・上昇/下落は前日比 (7日lookback・
  同値と前日なしは不算入)・欠損は不算入 (0埋めなし)・時価総額は取得時点
  snapshot (marketCapAsOf明示・寄与銘柄数付き)。定義と指標説明の整合OK。
- 時価総額PDF (2026年8月分・上記hash): 33業種・基準日2026-08-31・
  電気機器123社279,083,685百万円・プライム1,549社1,368,732,387百万円・
  全体3,887社1,414,461,142百万円が一致。33業種社数合計=プライム社数に
  厳密一致。時価総額33合計はプライム計と-14百万円 (出典側丸め・文書化済み)。
- 空売りPDF (2026-09-25分・上記hash): 33業種・電気機器
  1,971,606/902,200/416,524/3,290,330百万円・比率 (902,200+416,524)/
  3,290,330 の再計算差分0・その他33業種外 309,956百万円が一致。
  月次集計は加重平均 (単純平均なし・テストで境界確認済み)。
- R1のNotion観測は0行 (未取込) のため保存値との突合せは対象なし。

## Notion persist確認 (read-only・1rps以下・2026-09-28)

「一次データ｜moneyflow」「資金フロー｜指標定義」「資金フロー｜観測ログ」
「資金フロー｜取込ログ」はいずれも0行。一次実体の保管も観測のpersistも
未実施 (#133の484/134/387を含む全spec)。raw→parser確認とpersist確認は
別評価とし、本記録は前者のみを証跡とする。アーカイブ完了ではない。
後続writer枠での保管・再読・冪等upsertは本検査の範囲外。

## 一次公表の鮮度 (2026-09-28実測・推測なし)

- IMF CPIS (DBnomics鏡): updated_at 2025-04-08 のまま・最新期2024-S1・
  米国対外合計2,072,394,613,197で不変 (API再取得で一致)。
- MOF週次: week.csvが文書記録とバイト同一 (255,655・de9ba984…)・
  最新週2026-W37 (9/6-12)。月次も2026-08が最新 (9/27記録どおり)。
- JPX投資部門別週次: 一覧が文書記録とバイト同一 (39,782・56aa444f…)・
  最新は9月第2週 (W37・旧様式xls)。新様式・W38掲載は未確認
  (9/29以降・延期どおり)。
- CoinGecko: /globalと/marketsが無keyで200・BTC 12,977,231円を再取得一致。
- Yahoo: ^GSPC等17銘柄が200・W39 (9/21-27) が最新週。
- ETF月次: 2026-08が最新 (文書記録と同一バイト)。IMAJ-REIT: 2026-07が
  最新 (文書記録と同一バイト)。

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
保管未実施) で再現できる。

## 未検証・限界 (明示)

1. Notion保存値との突合せ: 対象なし (4 DBとも0行)。
2. jpx-equity-W36数量側: 原本欠 (vol w1) のため未検証 (金額側は前週欄で照合)。
3. JVCEA標本の独立tool再読: pymupdf不在・strings不発のため同経路抽出のみ
   (5値一致)。別toolでの再読は未実施。
4. global-indices fresh値の変化率再計算: 未実施 (221行構造のみ)。
5. 日銀資金循環の確報改定・財務省確報の追跡: 当期速報のみ (版キーで区別)。
6. 訂正版の重複事例: 未観測 (保管0件)。
7. 新様式 (9/29〜) と信用残日次化: 対象外 (延期どおり)。

## 実行証跡

- vitest services/moneyflow: 40 files passed・852 passed・366 skipped
  (skipはprivate欠の規約どおり)。tsc --noEmit: 合格。
- Notion API送信: 09a 4req・09b 27req・09c 2req・09d 6req (各1200ms間隔・
  書込0)。D1: SELECT 2件 (rows_written 0)。外部GET: bounded計30弱
  (CoinGecko 4・Yahoo 18・DBnomics 2・MOF 1・JPX 2・toushin 1・/global重複1)。
  新規install 0。

