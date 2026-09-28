# moneyflow 取得元フィクスチャ (実ファイル)

このリポジトリは **PUBLIC**。取得元の利用条件に応じて置き場所を分ける
(規約は `services/moneyflow/lib/adapters/README.md`「フィクスチャ」節)。

- `private/<key>/` — **commit しない** (`.gitignore` 済み)。personal-only・利用条件要確認・
  再配布不可の取得元。未取得の環境 (CI) では該当テストが `describe.skipIf` で skip する。
  下表の手順で取得して置けば手元でテストが走る
- `public/<key>/` — commit 済み。再配布が明示的に許される取得元のみ (出典表示は下表)

## 出典表示 (public/)

- CFTC Commitments of Traders (米国商品先物取引委員会。米国政府著作物・パブリックドメイン)
- 財務省「対外及び対内証券売買契約等の状況」(政府標準利用規約 第2.0版 / CC BY 4.0 互換)
- World Bank, World Development Indicators: CM.MKT.LCAP.CD (CC BY 4.0)
- BIS Locational Banking Statistics (BIS「Terms of permitted use of BIS statistics」— 出典明記で再利用可)

JPX 先物・オプション投資部門別 CSV と指数先物建玉 xlsx (`private/jpx-derivatives-investor/`) は
2026-09-28 に取得 (下表)。置いた手元では該当テストが実行され、CI では skip する (取得方法は
`services/moneyflow/lib/sources/jpx-derivatives-investor.test.ts` 冒頭)。

## public/

再配布が明示的に許される取得元のみ (commit 済み)。出典表示を兼ねる。

| ファイル | 取得元 URL | 取得日 | バイト | sha256 (先頭16桁) |
|---|---|---|---|---|
| `public/bis-banking/bis-lbs-claims-jp.csv` | https://stats.bis.org/api/v2/data/dataflow/BIS/WS_LBS_D_PUB/1.0/Q.S.C.A.TO1.A.5J.A.JP.A..N?format=csv&lastNObservations=2 | 2026-09-27 | 17,412 | `99c359c8f4bfd717` |
| `public/bis-banking/bis-lbs-liabilities-jp.csv` | https://stats.bis.org/api/v2/data/dataflow/BIS/WS_LBS_D_PUB/1.0/Q.S.L.A.TO1.A.5J.A.JP.A..N?format=csv&lastNObservations=2 | 2026-09-27 | 17,289 | `a9fbd5ed0d58cea5` |
| `public/cftc-cot-jpy/cftc-cot-jpy-legacy-futures-only.json` | https://publicreporting.cftc.gov/resource/6dca-aqww.json?%24where=cftc_contract_market_code+in+%28%27097741%27%2C%27240743%27%29&%24order=report_date_as_yyyy_mm_dd+DESC&%24limit=16 | 2026-09-27 | 75,209 | `b813b57d0108c96e` |
| `public/mof-portfolio-flows/mof-montha1.csv` | https://www.mof.go.jp/policy/international_policy/reference/itn_transactions_in_securities/montha1.csv | 2026-09-27 | 73,511 | `c3ca908f708f70e9` |
| `public/mof-portfolio-flows/mof-week.csv` | https://www.mof.go.jp/policy/international_policy/reference/itn_transactions_in_securities/week.csv | 2026-09-27 | 255,655 | `de9ba9847fdc8beb` |
| `public/worldbank-marketcap/worldbank-country-meta.json` | https://api.worldbank.org/v2/country/all?format=json&per_page=400 | 2026-09-27 | 113,590 | `d29d57f8adf954c5` |
| `public/worldbank-marketcap/worldbank-marketcap-2020-2026.json` | https://api.worldbank.org/v2/country/all/indicator/CM.MKT.LCAP.CD?format=json&per_page=20000&date=2020%3A2026 | 2026-09-27 | 398,531 | `25b4a1457cfd2788` |

## private/

commit しない (gitignore)。手元でテストを走らせる場合は下表の URL から取得して同名で置く。

| ファイル | 取得元 URL | 取得日 | バイト | sha256 (先頭16桁) |
|---|---|---|---|---|
| `private/boj-flow-of-funds/boj-sj-index-2026-09-27.html` | https://www.boj.or.jp/statistics/sj/index.htm | 2026-09-27 | 67,372 | `c979d29b25015866` |
| `private/boj-flow-of-funds/boj-sjpre-2026q2.xlsx` | https://www.boj.or.jp/statistics/sj/sjpre.xlsx | 2026-09-27 | 220,647 | `8140783b4a4362f5` |
| `private/bop-regional/boj-dload-excerpt.html` | https://www.stat-search.boj.or.jp/info/dload.html | 2026-09-27 | 1,400 | `a7c56cfd115fd9a3` |
| `private/bop-regional/regbp-q-jp-sample.zip` | https://www.stat-search.boj.or.jp/info/regbp_q_jp.zip | 2026-09-27 | 38,796 | `0041dcc824a4fc27` |
| `private/coingecko-global/categories-stablecoins-2026-09-27.json` | https://api.coingecko.com/api/v3/coins/categories?order=market_cap_desc | 2026-09-27 (02:25 UTC ごろ) | 4,019 | `2a48d8b84c6675dd` |
| `private/coingecko-global/coins-markets-jpy-2026-09-27.json` | https://api.coingecko.com/api/v3/coins/markets?vs_currency=jpy&ids=bitcoin,ethereum,ripple,solana,dogecoin&order=market_cap_desc&price_change_percentage=24h | 2026-09-27 (02:25 UTC ごろ) | 5,136 | `d2d81c9871c1ebe2` |
| `private/coingecko-global/global-2026-09-27.json` | https://api.coingecko.com/api/v3/global | 2026-09-27 (02:19 UTC ごろ) | 4,519 | `e2bf5c0e5a36c4c4` |
| `private/ffaj-otc-fx/ffaj-deposit_amount_information.xls` | https://www.ffaj.or.jp/wp-content/uploads/2026/09/deposit_amount_information.xls | 2026-09-27 | 84,992 | `a77e0319585a082b` |
| `private/ffaj-otc-fx/ffaj-index-2026-09-27.html` | https://www.ffaj.or.jp/library/performance/fx_flash/ | 2026-09-27 | 100,180 | `9185c846c2b3492b` |
| `private/ffaj-otc-fx/ffaj-open_position_with_mc.xls` | https://www.ffaj.or.jp/wp-content/uploads/2026/09/open_position_with_mc.xls | 2026-09-27 | 134,656 | `02d2f648b7c94135` |
| `private/ffaj-otc-fx/ffaj-trading_vol_and_position.xls` | https://www.ffaj.or.jp/wp-content/uploads/2026/09/trading_vol_and_position.xls | 2026-09-27 | 358,912 | `2e90a31f38956258` |
| `private/ffaj-otc-fx/index-page.sample.html` | (取得元モジュールのテスト冒頭コメント参照) | 2026-09-27 | 4,670 | `51eebb422d411794` |
| `private/global-indices/global-indices-bsesn-2026-09-27.json` | https://query1.finance.yahoo.com/v8/finance/chart/%5EBSESN?range=6mo&interval=1wk | 2026-09-27 | 3,491 | `edc01d580da60948` |
| `private/global-indices/global-indices-crudeoil-2026-09-27.json` | https://query1.finance.yahoo.com/v8/finance/chart/CL%3DF?range=6mo&interval=1wk | 2026-09-27 | 3,989 | `8a60ce883a437155` |
| `private/global-indices/global-indices-eurusd-2026-09-27.json` | https://query1.finance.yahoo.com/v8/finance/chart/EURUSD%3DX?range=6mo&interval=1wk | 2026-09-27 | 4,165 | `9a7737c7c9bd7316` |
| `private/global-indices/global-indices-ftse-2026-09-27.json` | https://query1.finance.yahoo.com/v8/finance/chart/%5EFTSE?range=6mo&interval=1wk | 2026-09-27 | 3,898 | `508c50895351b1e0` |
| `private/global-indices/global-indices-gdaxi-2026-09-27.json` | https://query1.finance.yahoo.com/v8/finance/chart/%5EGDAXI?range=6mo&interval=1wk | 2026-09-27 | 3,839 | `6009515f2402fb01` |
| `private/global-indices/global-indices-gold-2026-09-27.json` | https://query1.finance.yahoo.com/v8/finance/chart/GC%3DF?range=6mo&interval=1wk | 2026-09-27 | 3,600 | `1744c3bd4fab76bd` |
| `private/global-indices/global-indices-gspc-2026-09-27.json` | https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?range=6mo&interval=1wk | 2026-09-27 | 4,015 | `932813fa99df9037` |
| `private/global-indices/global-indices-hsi-2026-09-27.json` | https://query1.finance.yahoo.com/v8/finance/chart/%5EHSI?range=6mo&interval=1wk | 2026-09-27 | 3,935 | `5cd1f193bc1f4c89` |
| `private/global-indices/global-indices-ixic-2026-09-27.json` | https://query1.finance.yahoo.com/v8/finance/chart/%5EIXIC?range=6mo&interval=1wk | 2026-09-27 | 3,935 | `547a679623da192a` |
| `private/global-indices/global-indices-jpy-2026-09-27.json` | https://query1.finance.yahoo.com/v8/finance/chart/JPY%3DX?range=6mo&interval=1wk | 2026-09-27 | 4,095 | `2b5b63a112b04a22` |
| `private/global-indices/global-indices-ks11-2026-09-27.json` | https://query1.finance.yahoo.com/v8/finance/chart/%5EKS11?range=6mo&interval=1wk | 2026-09-27 | 3,900 | `748000dd68ecaca0` |
| `private/global-indices/global-indices-n225-2026-09-27.json` | https://query1.finance.yahoo.com/v8/finance/chart/%5EN225?range=6mo&interval=1wk | 2026-09-27 | 3,682 | `f4d1f316bad02bb9` |
| `private/global-indices/global-indices-sse-2026-09-27.json` | https://query1.finance.yahoo.com/v8/finance/chart/000001.SS?range=6mo&interval=1wk | 2026-09-27 | 4,131 | `7bd932033c8981c3` |
| `private/global-indices/global-indices-stoxx50e-2026-09-27.json` | https://query1.finance.yahoo.com/v8/finance/chart/%5ESTOXX50E?range=6mo&interval=1wk | 2026-09-27 | 4,022 | `65e9e9ccfc7b3fe7` |
| `private/global-indices/global-indices-symbol-not-found-2026-09-27.json` | https://query1.finance.yahoo.com/v8/finance/chart/%5ETOPX | 2026-09-27 | 108 | `f0b5f9feeac9f1fc` |
| `private/global-indices/global-indices-tnx-2026-09-27.json` | https://query1.finance.yahoo.com/v8/finance/chart/%5ETNX?range=6mo&interval=1wk | 2026-09-27 | 4,061 | `007892cf8b8d62e3` |
| `private/global-indices/global-indices-topix-etf-2026-09-27.json` | https://query1.finance.yahoo.com/v8/finance/chart/1306.T?range=6mo&interval=1wk | 2026-09-27 | 4,051 | `e76c4706d59616cf` |
| `private/imaj-fund-flows/F00B21_pub.xlsx` | https://www.toushin.or.jp/tws/toukei_dw/F00B21_pub.xlsx | 2026-09-27 | 25,503 | `26a5fab03a2cc7a8` |
| `private/imaj-fund-flows/I0112B_pub_m.xlsx` | https://www.toushin.or.jp/tws/toukei_dw/I0112B_pub_m.xlsx | 2026-09-27 | 430,536 | `979ce1515cad3910` |
| `private/imaj-fund-flows/imaj-fund-flows-b1.xlsx` | https://www.toushin.or.jp/tws/toukei_dw/I0112B_pub_m.xlsx | 2026-09-27 | 50,578 | `3089b5d992a80e56` |
| `private/imaj-fund-flows/imaj-reit-flows-d1.xlsx` | https://www.toushin.or.jp/tws/toukei_dw/F00B21_pub.xlsx | 2026-09-27 | 24,707 | `4582fb885708336e` |
| `private/imf-cpis/imf-cpis-full-20260928-01.json` | https://api.db.nomics.world/v22/series (IMF/CPIS 99系列のうち60系列・`observations=1`) | 2026-09-28 | 142,539 | `2ec7e974ddbe607b` |
| `private/imf-cpis/imf-cpis-full-20260928-02.json` | https://api.db.nomics.world/v22/series (IMF/CPIS 99系列のうち39系列・`observations=1`) | 2026-09-28 | 95,525 | `58f0c10887e867a9` |
| `private/imf-cpis/imf-cpis-jp-assets-equity-debt.json` | https://api.db.nomics.world/v22/series?series_ids=IMF%2FCPIS%2FB.JP.I_A_E_T_T_BP6_USD.T.T.US%2CIMF%2FCPIS%2FB.JP.I_A_D_T_T_BP6_USD.T.T.US&observations=1 | 2026-09-27 | 24,818 | `e3309cd2e4665a2b` |
| `private/imf-cpis/imf-cpis-jp-assets-total.json` | https://api.db.nomics.world/v22/series?series_ids=IMF%2FCPIS%2FB.JP.I_A_T_T_T_BP6_USD.T.T.US%2CIMF%2FCPIS%2FB.JP.I_A_T_T_T_BP6_USD.T.T.KY%2CIMF%2FCPIS%2FB.JP.I_A_T_T_T_BP6_USD.T.T.W00&observations=1 | 2026-09-27 | 26,870 | `c6fdda86926811f2` |
| `private/imf-cpis/imf-cpis-jp-liabilities-equity-debt.json` | https://api.db.nomics.world/v22/series?series_ids=IMF%2FCPIS%2FB.JP.I_L_E_T_T_BP6_DV_USD.T.T.US%2CIMF%2FCPIS%2FB.JP.I_L_D_T_T_BP6_DV_USD.T.T.US&observations=1 | 2026-09-27 | 24,720 | `6a0b93cfd7e2b8b5` |
| `private/imf-cpis/imf-cpis-jp-liabilities-total.json` | https://api.db.nomics.world/v22/series?series_ids=IMF%2FCPIS%2FB.JP.I_L_T_T_T_BP6_DV_USD.T.T.US%2CIMF%2FCPIS%2FB.JP.I_L_T_T_T_BP6_DV_USD.T.T.KY%2CIMF%2FCPIS%2FB.JP.I_L_T_T_T_BP6_DV_USD.T.T.W00&observations=1 | 2026-09-27 | 26,826 | `a72baf9169993206` |
| `private/jpx-derivatives-investor/jpx-deriv-investor-week-20260907_20260911.csv` | https://www.jpx.co.jp/markets/statistics-derivatives/sector/t13vrt000001yi1d-att/Tousi_DV_W_20260907_20260911.csv | 2026-09-28 | 117,179 | `6258b0877d10ee68` |
| `private/jpx-derivatives-investor/jpx-deriv-sector-index-20260927.html` | https://www.jpx.co.jp/markets/statistics-derivatives/sector/index.html | 2026-09-27 | 36,049 | `ce2f85a3fce41273` |
| `private/jpx-derivatives-investor/jpx-futures-oi-20260918-indexfut.xlsx` | https://www.jpx.co.jp/automation/markets/derivatives/open-interest/files/2026/20260918_indexfut_oi_by_tp.xlsx | 2026-09-28 | 31,425 | `9f1802b3362604d5` |
| `private/jpx-investor-equity/monthly-index-2026-09-27.html` | https://www.jpx.co.jp/markets/statistics-equities/investor-type/00-01.html | 2026-09-27 | 41,696 | `225914c90ef07b30` |
| `private/jpx-investor-equity/monthly-unified-sample-jpx-official.xlsx` | (取得元モジュールのテスト冒頭コメント参照) | 2026-09-27 | 15,299 | `65610195e7fdc174` |
| `private/jpx-investor-equity/monthly-value-2026-08.xls` | https://www.jpx.co.jp/markets/statistics-equities/investor-type/t13vrt000001vcuo-att/stock_val_1_m2608.xls | 2026-09-27 | 89,088 | `806915e62a9fba7d` |
| `private/jpx-investor-equity/monthly-volume-2026-08.xls` | https://www.jpx.co.jp/markets/statistics-equities/investor-type/t13vrt000001vcuo-att/stock_vol_1_m2608.xls | 2026-09-27 | 92,672 | `a1479dc3c2ff7452` |
| `private/jpx-investor-equity/unified-format-sample-jpx-official.xlsx` | https://www.jpx.co.jp/markets/statistics-equities/investor-type/tvdivq00000014fy-att/stock_1_w_YYYYMMDD_YYYYMMDD.xlsx | 2026-09-27 | 15,086 | `003dd103d34a3216` |
| `private/jpx-investor-equity/weekly-index-2026-09-27.html` | https://www.jpx.co.jp/markets/statistics-equities/investor-type/index.html | 2026-09-27 | 39,782 | `56aa444fbeaec057` |
| `private/jpx-investor-equity/weekly-value-2026-w1-0831-0904.xls` | https://www.jpx.co.jp/markets/statistics-equities/investor-type/t13vrt000001y0ho-att/stock_val_1_260901.xls | 2026-09-27 | 99,840 | `35fd17daa9b7f075` |
| `private/jpx-investor-equity/weekly-value-2026-w2-0907-0911.xls` | https://www.jpx.co.jp/markets/statistics-equities/investor-type/t13vrt000001yhs9-att/stock_val_1_260902.xls | 2026-09-27 | 99,840 | `0203d8e7cec672fe` |
| `private/jpx-investor-equity/weekly-volume-2026-w1-0831-0904.xls` | https://www.jpx.co.jp/markets/statistics-equities/investor-type/t13vrt000001y0ho-att/stock_vol_1_260901.xls | 2026-09-27 | 97,792 | `10c13abdfdc932c7` |
| `private/jpx-investor-equity/weekly-volume-2026-w2-0907-0911.xls` | https://www.jpx.co.jp/markets/statistics-equities/investor-type/t13vrt000001yhs9-att/stock_vol_1_260902.xls | 2026-09-27 | 97,792 | `b311878debf0a414` |
| `private/jpx-investor-etf-reit/etf_m2608.xls` | https://www.jpx.co.jp/markets/statistics-equities/investor-type/t13vrt000001xy39-att/etf_m2608.xls | 2026-09-27 | 52,736 | `0ab50183e6fa7b0b` |
| `private/jpx-investor-etf-reit/etf_mYYYYMM_sample-new-format.xlsx` | (取得元モジュールのテスト冒頭コメント参照) | 2026-09-27 | 11,973 | `d3689b9bae6b8149` |
| `private/jpx-investor-etf-reit/investor-type-02-links-excerpt.html` | https://www.jpx.co.jp/markets/statistics-equities/investor-type/02.html | 2026-09-27 | 3,452 | `f3cfc469b03f6260` |
| `private/jpx-investor-etf-reit/investor-type-03-links-excerpt.html` | https://www.jpx.co.jp/markets/statistics-equities/investor-type/03.html | 2026-09-27 | 3,468 | `18dd0a7ae4aa797b` |
| `private/jpx-investor-etf-reit/reit_m2608.xls` | https://www.jpx.co.jp/markets/statistics-equities/investor-type/t13vrt000001xyd5-att/reit_m2608.xls | 2026-09-27 | 50,688 | `5d16514f97286dab` |
| `private/jpx-investor-etf-reit/reit_mYYYYMM_sample-new-format.xlsx` | (取得元モジュールのテスト冒頭コメント参照) | 2026-09-27 | 11,749 | `0d0375f1d434cc1c` |
| `private/jsda-bonds/jsda-hakkou-2026-07.xlsx` | https://www.jsda.or.jp/shiryoshitsu/toukei/hakkou/hakkougakushoukanngaku.xlsx | 2026-09-27 | 430,235 | `2e9cf3616d96642d` |
| `private/jsda-bonds/jsda-hakkou-index-2026-09-27.html` | https://www.jsda.or.jp/shiryoshitsu/toukei/hakkou/index.html | 2026-09-27 | 45,149 | `088ee70f8800bb43` |
| `private/jsda-bonds/jsda-toushika-index-discontinued-2026-09-27.html` | (取得元モジュールのテスト冒頭コメント参照) | 2026-09-27 | 43,688 | `7ebab36d6c8b698f` |
| `private/jvcea-crypto/jvcea-crypto-202607-koukai-01-full-8p.pdf` | https://jvcea.or.jp/cms2026/wp-content/uploads/2026/08/202607-KOUKAI-01-FINAL.pdf | 2026-09-27 | 1,238,546 | `ec16877d5fcce895` |
| `private/jvcea-crypto/jvcea-crypto-202607-koukai-01-p1-2.pdf` | (取得元モジュールのテスト冒頭コメント参照) | 2026-09-27 | 683,966 | `f38b4a98c67c7fe4` |
| `private/jvcea-crypto/jvcea-statistics-information-20260927.html` | https://jvcea.or.jp/statistics/information/ | 2026-09-27 | 101,789 | `25c9365786f03df6` |
| `private/tfx-click365/tfx-click365-fx-2026-09.html` | https://www.tfx.co.jp/historical/fx/transit_fx.html | 2026-09-27 | 57,643 | `5e801c11589cf6f8` |
| `private/tfx-click365/tfx-clickkabu365-cfd-2026-09.html` | https://www.tfx.co.jp/historical/cfd/transit_cfd.html | 2026-09-27 | 31,381 | `a224a9f2f0f86a3a` |

