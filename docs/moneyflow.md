# 008 moneyflow — 「お金の流れ」個人用 Notion ダッシュボード

日本市場のお金の流れを見える化する個人用 (自分だけが見る) 機能。対象は
①東証33業種のどこに流れているか (R1) ②株と株以外の上場商品の比較 (R2)
③先物・FX・商品・暗号資産を含む資産クラス比較 (R3) ④日本⇔各国＋世界の概況 (R4)。

ユーザー決定 (2026-09-27): 自分だけが見る個人利用・無料データのみ・近似でよいが
何を測っているか明記する。**今回実装したのは Phase 0 (準備) と Phase 1 (R1
33業種が見える。ただし信用残の日次化は含まない)** まで。設計の詳細な経緯は
承認済み計画 `notion-velvet-goose.md` を参照 (このファイルは取得元の恒久的な
インベントリと実装状況の記録)。

## 全体設計 (要点)

- 保存先は **Notion のみ** (D1 表・R2 は増やさない)。一次ファイル (PDF/xlsx/CSV)
  は `recordPrimaryData()` で実体アップロードする (ルール6)。
- 置き場所は他サービスと同じ (2026-09-27 ユーザー決定。当初の専用ページ
  「資金フロー（個人用）」案は廃止): 「バックアップ / 株式情報」ページ
  (`NOTION_STOCK_INFO_PAGE_ID`) の直下に DB 3 つ、原ファイルは「一次データ保管」
  (`NOTION_ARCHIVE_PAGE_ID`) 配下の「一次データ｜moneyflow」。
- Notion DB は 4 つ:
  1. 「資金フロー｜指標定義」— 指標ごとの定義 (Phase 1 は `services/moneyflow/lib/indicators.ts`、
     Phase 2〜5 は各アダプタ `services/moneyflow/lib/adapters/*.ts`)
  2. 「資金フロー｜観測ログ」— 縦長の事実テーブル。冪等キー `期間|指標|区分`
  3. 「資金フロー｜取込ログ」— 1 回の実行につき 1 行
  4. 「一次データ｜moneyflow」— 取得した原ファイル (`recordPrimaryData` が記録)
- 業種全体の「純流入」は二次市場では原理的にゼロ (買い手と売り手が同額)。
  そのため各指標の定義文で「純流入額ではない」ことを明示する
  (`services/moneyflow/lib/indicators.ts` 参照)。
- JPX の業種分類 (`core_stocks.sector`、personal-only) を使う。個人利用のため
  personal-only の列を使ってよい判断 (公開面の `sector33` とは別物)。

## 取得元インベントリ (要件ごと)

2026-09-27 の調査で取得元 71 件を裏取りした結果の恒久記録。「実装状況」列は
今回 (Phase 0/1) の実装結果。空欄は Phase 2 以降で判断する。

### R1: 東証33業種のどこにお金が流れているか

| 取得元 | URL | 何を測るか | 頻度 | 形式 | 無料/有料 | 利用条件 | 実装状況 |
|---|---|---|---|---|---|---|---|
| 業種別時価総額 | jpx.co.jp/.../misc/07.html | 33業種別の月末時価総額(残高)。プライムのみ | 月次 | PDF | 無料 | personal-only | **実装済み** (`jpx-sector-marketcap.ts`) |
| 空売り集計(業種別) | jpx.co.jp/.../short-selling/index.html | 33業種別の空売り比率(空売り売買代金/総売買代金) | 日次 | PDF | 無料 | personal-only | **実装済み** (`jpx-short-selling.ts`。月次集計に加工) |
| 東証上場銘柄一覧(data_j.xlsx) | jpx.co.jp/.../misc/01.html | 全銘柄コード・33業種区分(結合キー) | 月次 | Excel | 無料 | personal-only | 実装済み (既存 `src/shared/jpx/sectors.ts`、universe sync が使用) |
| 既存 D1 (swing_daily_ohlcv×sector) | (社内 D1) | 業種別売買代金・シェア・上昇/下落日売買代金 | 日次データを週次集計 | D1 | — | personal-only | **実装済み** (`GET /api/ingest/moneyflow-sector`) |
| 統計月報・売買代金/売買高(市場別) | jpx.co.jp/.../monthly/index.html | 市場別の月間/年間売買高(グロス)。33業種内訳は未確認 | 月次 | 不明 | 無料 | personal-only | 未実装 (D1 集計で代替済み) |
| 投資部門別売買状況(株式) | jpx.co.jp/.../investor-type/index.html | 投資部門別の買い越し額(業種別内訳なし) | 週次/月次/年次 | PDF/Excel | 無料 | personal-only | Phase 2 予定 |
| 東証33業種別株価指数・TOPIX-17 | jpx.co.jp/.../cal2_13_sector.pdf | 33業種の株価指数(騰落率)。時価総額の価格変動分を分離する用途 | 日次/リアルタイム | Web表示+PDF(算出要領)。無料の**バルク過去月末値配信は確認できず** | — | personal-only | **見送り** (下記「業種別指数の調査結果」参照) |
| J-Quants API/Pro | jpx-jquants.com | 上場銘柄一覧+四本値等 | 日次 | REST API | 個人:無料〜¥16,500/月、法人:個別見積り | **商用利用不可**(公開Web配信は規約違反) | 不採用 (kabulabは公開Webのため使えない) |
| 資金循環統計 | boj.or.jp/statistics/sj | 家計等の株式等保有残高(業種別ではない) | 四半期 | Excel/CSV/API | 無料 | attribution_required | Phase 3 予定 (R3/R4 補助) |
| BIS International Banking/Debt Securities Statistics | data.bis.org | 国際与信・国際債券発行残高 | 四半期 | SDMX API | 無料 | attribution_required | 対象外 (国際統計。R4寄り) |
| BIS Data Portal | data.bis.org | 同上 | 四半期 | API/CSV | 無料 | 不明 | 対象外 |
| J-Quants 利用規約 | jpx-jquants.com | 商用利用可否の確認用 | — | — | — | personal_only | (規約確認のみ。データ源ではない) |

### R2: 株と株以外の上場商品 (債券・投信・ETF/REIT等) の比較

| 取得元 | URL | 何を測るか | 頻度 | 形式 | 無料/有料 | 利用条件 | 実装状況 |
|---|---|---|---|---|---|---|---|
| JPX ETF月間売買状況 | jpx.co.jp/equities/products/etfs | ETF市場の月間売買高・売買代金(グロス) | 月次 | Excel | 無料 | personal-only | Phase 3 予定 |
| JPX 投資部門別売買状況(ETF) | jpx.co.jp/.../investor-type/02.html | ETF投資部門別買越/売越 | 月次 | Excel→xlsx(2026/10/13〜) | 無料 | personal-only | Phase 3 予定 |
| JPX REIT月間売買状況・投資部門別 | jpx.co.jp/.../investor-type/03.html | REIT投資部門別買越/売越 | 月次 | Excel+PDF | 無料 | personal-only | Phase 3 予定 |
| JPX インフラファンド月次レポート | jpx.co.jp/equities/products/infrastructure | 時価総額・売買代金・分配金利回り(投資部門別統計なし) | 月次 | PDF | 無料 | personal-only | 対象外 (代表性に乏しい。5銘柄のみ) |
| 資産運用業協会 資産増減状況統計(旧投信協会) | toushin.or.jp/statistics | 投信会社別の設定額-解約額=資金増減額(純流入に近い) | 月次 | Excel(xlsx/xls) | 無料 | 不明(要協会確認) | Phase 3 予定 |
| 資産運用業協会 D区分(REIT資産増減) | toushin.or.jp/statistics | 公募・私募REITの設定額・解約額・資金増減額 | 月次 | Excel | 無料 | personal-only | Phase 3 予定 |
| 投資信託ファクトブック | imaj.or.jp/statistics/factbook | 商品分類別純資産総額推移(編集済みサマリ) | 月次〜四半期 | PDF | 無料 | personal-only | 対象外 (生データでない) |
| QUICK資金流出入データ | corporate.quick.co.jp | 投信の日次/週次/月次資金流出入推計値 | 日次 | CSV | 有料(個別見積り) | 不明 | 不採用 (有料) |
| ARES J-REIT Databook | j-reit.jp/statistics | J-REIT時価総額・指数・資金調達実績 | 月次 | Excel | 不明 | personal-only | Phase 3 予定 (要確認) |
| 公社債投資家別売買高 | jsda.or.jp/shiryoshitsu/toukei/toushika | 投資家部門別の公社債売買高・差引 | 月次 | Excel | 無料 | 不明(429出やすい) | Phase 3 予定 (バックオフ要) |
| 公社債発行額・償還額等 | jsda.or.jp/shiryoshitsu/toukei/hakkou | 公社債の種類別発行額・償還額 | 月次 | Excel/PDF | 無料 | personal-only | Phase 3 予定 |
| 資金循環統計 | boj.or.jp/statistics/sj | 部門別×金融商品別の残高・フロー | 四半期 | Excel/API | 無料 | attribution_required | Phase 3 予定 |
| 国債等の保有者別内訳 | mof.go.jp/jgbs/reference | 国債保有者(日銀/銀行/海外等)構成比 | 四半期 | PDF | 無料 | ok | Phase 3 予定 |
| 個人向け国債発行額の推移 | mof.go.jp/jgbs/reference | 個人向け国債の発行額推移 | 発行都度 | Excel | 無料 | attribution_required | Phase 3 予定 |
| NISA口座の利用状況 | fsa.go.jp/policy/nisa2/survey | NISA口座数・買付額(個人資金の向かう先) | 四半期 | PDF(+Excel?) | 無料 | ok | Phase 3 予定 |
| 投資信託の資産増減状況統計 | toushin.or.jp/tws/toukei_dw | 設定額・解約額・資金増減額(月次) | 月次 | Excel | 無料 | 不明 | Phase 3 予定 (上の投信統計と重複要整理) |
| DefiLlama Stablecoins/TVL API | stablecoins.llama.fi | ステーブルコイン残高・DeFi TVL(世界計) | 日次 | REST API | 無料(Pro $300/月) | prohibited | 対象外 (再配布不可) |
| e-Stat API | e-stat.go.jp/api | 政府統計の共通アクセス層 | 統計次第 | API | 無料 | 不明 | Phase 3 予定 (アクセス層として利用検討) |
| 資産運用業協会(IMAJ)統計データ | imaj.or.jp/statistics | 投信会社別資産増減状況等 | 月次/四半期 | Excel/PDF | 無料 | prohibited | Phase 3 予定 (利用条件を要再確認) |

### R3: 先物・オプション・FX・商品・暗号資産を含む資産クラス比較

| 取得元 | URL | 何を測るか | 頻度 | 形式 | 無料/有料 | 利用条件 | 実装状況 |
|---|---|---|---|---|---|---|---|
| 空売り集計(市場全体・R3再掲) | 上記 | 市場全体の空売り比率 | 日次 | PDF | 無料 | personal-only | Phase 1 では業種別のみ実装 |
| 投資部門別売買状況(株式・R3再掲) | 上記 | 投資部門別買越/売越 | 週次/月次 | PDF/Excel | 無料 | personal-only | Phase 2 予定 |
| J-Quants API/Pro(R3再掲) | 上記 | trades_spec等 | 日次 | API | 有料/個別 | 商用不可 | 不採用 |
| 投資部門別取引状況(先物・オプション) | jpx.co.jp/.../statistics-derivatives/sector | 先物・オプションの投資部門別売買高・建玉 | 週次/月次 | PDF/CSV | 無料 | personal-only | Phase 4 予定 |
| インフラファンド(R2再掲) | 上記 | — | 月次 | PDF | 無料 | personal-only | 対象外 |
| 信用取引残高等 | jpx.co.jp/.../margin/04.html | 信用取引買い残・売り残(制度/一般信用別) | 週次 | PDF/Excel | 無料 | personal-only | **TODO (2026-09-28〜日次化)** 下記参照 |
| 自社株買いデータ(QUICK) | corporate.quick.co.jp/data-factory | 自社株買いの決議日・取得額等 | 不明 | 不明 | 有料 | 不明 | 不採用 (有料) |
| J-Quants(trades_spec/weekly_margin_interest) | jpx-jquants.com | 投資部門別・信用残週次 | 週次/月次 | API/CSV/Snowflake | 有料 | personal_only | 不採用 |
| インフラファンド月次(R2再掲) | 上記 | — | 月次 | PDF | 無料 | personal-only | 対象外 |
| 投資部門別取引状況(先物・オプション、詳細) | jpx.co.jp/.../sector/index.html | 商品ごとの投資部門別売買高・建玉 | 週次/月次/年次 | CSV/PDF | 無料 | personal-only | Phase 4 予定 |
| 取引総括表・月間統計資料 | jpx.co.jp/.../trading-volume | 先物・オプション・商品先物の出来高・建玉 | 日次/月次/年次 | PDF中心 | 無料 | personal-only | Phase 4 予定 |
| 取引参加者別建玉残高一覧 | jpx.co.jp/.../open-interest | 取引参加者別の建玉残高(週次) | 週次 | PDF/CSV(要確認) | 無料 | personal-only | Phase 4 予定 |
| JPXデータクラウド(有料) | dc.jpx-jquants.com | 先物・オプションのヒスト有償配信 | 不明 | 不明 | 有料 | 商用可(有償) | 不採用 (有料) |
| 店頭FX月次速報(FFAJ) | ffaj.or.jp/library/performance/fx_flash | FX会員合算の月次取引高・建玉・証拠金 | 月次 | Excel/Word | 無料 | 不明(要確認) | Phase 4 予定 |
| くりっく365/くりっく株365 過去データ | tfx.co.jp/historical | 通貨ペア別月次出来高・建玉 | 月次(直近7ヶ月+3年) | HTML表 | 無料 | personal-only | Phase 4 予定 (自前アーカイブ要) |
| 商品先物市場統計(JCFIA) | jcfia.gr.jp/study/statistics | 商品先物の出来高・建玉 | 不明(更新停止の疑い) | 画像PNG(機械可読でない) | 無料 | 不明 | 不採用 (機械可読でない・更新停止疑い) |
| CFTC COT (円先物) | cftc.gov/MarketReports | 米国上場円先物の投資主体別建玉(参考指標) | 週次 | CSV/API | 無料 | ok(public domain) | Phase 4 予定 (参考指標として) |
| JVCEA 会員統計情報 | jvcea.or.jp/statistics/information | 暗号資産の現物/証拠金取引高・口座数(月次) | 月次 | PDF | 無料 | 不明(要確認) | Phase 4 予定 |
| JVCEA 参考価格 | jvcea.or.jp/statistics/refer_rate | 暗号資産の参考価格(金額データなし) | 日次 | HTML | 無料 | 不明 | Phase 4 予定 (推定純増減の価格補正に使用) |
| JVCEA 年間報告 | jvcea.or.jp/information/statistics-reports | 年度集計サマリ | 年次 | PDF | 無料 | 不明 | Phase 4 参考 |
| 金融庁 暗号資産交換業者登録一覧 | fsa.go.jp/menkyo/menkyoj | 登録業者一覧(金額データなし) | 不定期 | PDF | 無料 | attribution_required | Phase 4 参考 |
| 金融庁 WG資料(口座数・預り資産) | fsa.go.jp/singi/singi_kinyu | 業界集計の口座数・預り資産合計 | 不定期 | PDF | 無料 | attribution_required | Phase 4 予定 |
| bitFlyer Public API | lightning.bitflyer.com/docs | Ticker/Board/Executions(価格・出来高) | リアルタイム | API | 無料 | prohibited | 不採用 (再配布不可) |
| Coincheck Public API | coincheck.com/documents/exchange/api | Ticker/Trades/OrderBook | リアルタイム | API | 無料 | 不明 | Phase 4 候補 (要確認) |
| CoinGecko API(Demo) | coingecko.com/en/api | 価格・時価総額・出来高(グローバル) | 日次〜リアルタイム | API | 無料(Basic $35/月〜) | attribution_required | Phase 4 予定 (推定の価格補正源) |
| CoinMarketCap API(Basic) | coinmarketcap.com/api/pricing | 同上 | 日次〜分単位 | API | 無料(上位有料) | attribution_required | Phase 4 候補 |

### R4: 日本⇔海外・世界の概況

| 取得元 | URL | 何を測るか | 頻度 | 形式 | 無料/有料 | 利用条件 | 実装状況 |
|---|---|---|---|---|---|---|---|
| 投資部門別売買状況(R1/R3再掲) | 上記 | 海外投資家の買越/売越(業種別内訳なし) | 週次/月次 | PDF/Excel | 無料 | personal-only | Phase 2 予定 |
| 海外投資家地域別株券売買状況 | jpx.co.jp/.../investor-type/04.html | 海外投資家の地域別(北米/欧州/アジア等)売買 | 月次/年次 | PDF/Excel | 無料 | personal-only | Phase 2 予定 |
| CFTC COT(円先物、R3再掲) | 上記 | 円先物の投資主体別建玉(参考) | 週次 | CSV/API | 無料 | ok | Phase 4 参考 |
| CoinGecko/CoinMarketCap(R3再掲) | 上記 | — | — | API | 無料/有料 | attribution_required | Phase 4 |
| 対外及び対内証券売買契約等の状況 | mof.go.jp/policy/international_policy | 海外投資家の証券取得-処分(真のネットフローに最も近い) | 週次(旬)+月次 | CSV | 無料 | attribution_required | Phase 2 予定 (R4-a 主軸) |
| 国際収支統計 | mof.go.jp/policy/international_policy/reference/balance_of_payments | 直接投資・証券投資の地域別内訳 | 月次 | CSV/API | 無料 | attribution_required | Phase 3 予定 |
| e-Stat API(R2再掲) | 上記 | 政府統計アクセス層 | — | API | 無料 | 不明 | Phase 3 予定 |
| IMF CPIS | db.nomics.world/IMF/CPIS | 国別対外証券投資残高(ストック) | 四半期 | SDMX API | 無料 | attribution_required | Phase 5 検討 |
| IMF COFER | data.imf.org | 外貨準備通貨構成(世界計のみ) | 四半期 | SDMX API | 無料 | 不明 | Phase 5 検討 |
| BIS統計(R1再掲) | data.bis.org | 国際与信・国際債券残高 | 四半期 | SDMX API | 無料 | attribution_required | Phase 5 検討 |
| 米財務省TIC | home.treasury.gov/data/treasury-international-capital | 海外投資家の米国証券月次純購入額(真のフロー) | 月次 | CSV/Excel | 無料 | ok(public domain) | Phase 5 検討 (対米国のみ) |
| WFE Statistics Database | statistics.world-exchanges.org | 世界の取引所別時価総額・売買代金等350+指標 | 月次/年次 | ポータル(要登録) | 無料 | attribution_required | Phase 5 検討 |
| ICI Weekly/Combined Fund Flows | ici.org/research/stats/combined_flows | 米国拠点ファンドの推定純資金流入出(週次) | 週次 | Excel | 無料 | **prohibited(再配布不可)** | 不採用 |
| FRB Z.1 Financial Accounts | fred.stlouisfed.org/release?rid=52 | 米国版資金循環統計(海外部門セクター有) | 四半期 | FRED API | 無料 | attribution_required | Phase 5 検討 |
| ECB Statistical Data Warehouse | data.ecb.europa.eu | ユーロ圏資金循環・国際収支統計 | 四半期/月次 | SDMX API | 無料 | attribution_required | Phase 5 検討 |
| Eurostat | ec.europa.eu/eurostat | EU統計(金融資産負債・国際収支等) | 月次/四半期/年次 | SDMX API | 無料 | attribution_required | Phase 5 検討 |
| World Bank(上場時価総額・国別) | data.worldbank.org/indicator/CM.MKT.LCAP.CD | 各国上場企業時価総額(年次) | 年次 | CSV/API | 無料 | attribution_required | Phase 5 検討 (既存 swing_market_context と併用) |
| EPFR Global | isimarkets.com/epfr | 世界のファンド資金フロー(国・地域・セクター別、業界標準) | 週次/月次 | SFTP/CSV | **有料(年$1万〜$65万規模)** | prohibited(個別契約要) | 不採用 (コスト超過。承認が要る規模) |
| IIF Capital Flows Tracker | iif.com/Products/Capital-Flows-Tracker | 新興国向け月次資金フロー推定 | 月次/半期 | PDF/Web | 有料(会員限定) | prohibited | 不採用 |

## 業種別指数の無料の過去月末値の調査結果 (2026-09-27 実地確認)

計画書の指示「取れる確実な無料経路があれば実装、無ければ実装せず記録」に基づき、
以下を実地確認した:

1. **JPX 公式ページ**
   (https://www.jpx.co.jp/markets/indices/line-up/files/cal2_13_sector.pdf):
   算出要領・ファクトシート PDF のみで、月末値の**バルク historical
   CSV/API配信は無い**。リアルタイム値のページ (`realvalues/01.html`) は
   その場の現在値表示であり、過去分の一括取得経路ではない。無料の
   API/CSV 配信は「有償ではデータベンダー経由」と明記されている。
2. **Yahoo!ファイナンス日本版**: 業種別指数コードでの historical ページを
   直接試したが 404 (コード体系が確認できず)。
3. **stooq.com**: 日本市場ページを取得したが業種別指数の内訳が見当たらず
   (取得できたページが極small で該当データなし)。
4. **investing.com**: bot対策で 403 (取得不可)。

**結論: 確実な無料のバルク historical 経路が見つからなかったため、
「価格変動を除いた時価総額の増減 (残差近似)」機能は今回実装を見送る。**
推測で作らない (ルール1/2)。Phase 2 以降で J-Quants Pro 等の有償契約や
日次スクレイピングによる自前アーカイブが必要かどうかを改めて判断する。

## 信用残 (銘柄別信用取引残高) の日次化 — TODO

JPX 告知 (2026-07-06)「信用取引残高の公表情報の変更日及び今後の公表スケジュール
について」により、**2026-09-28 (月) から「銘柄別信用取引残高」が毎日 16:00 に
公表され、週次の「銘柄別信用取引週末残高」(火曜16:30) は廃止される**。

- 新資料の様式は初回公表 (2026-09-28) まで確認できないため、**今回の実装
  (Phase 0/1) には信用残を含めていない**。
- 既存の週次信用残取込 (`scripts/vwap/ingest-margin.ts` → R2 `margin/{week}.json`、
  vwap-analysis が使用) は新資料へ切り替えないと 9/28 以降止まる。パーサは
  `services/vwap-analysis/lib/margin.ts` 側に共通化し、moneyflow の業種別集計
  (買い残・売り残の前日比) と両方から使えるようにする設計 (計画書 Phase 1 節)。
- **TODO (2026-09-28 以降に着手)**: 実ファイルをフィクスチャにしてパーサを作り、
  `sector_margin_balance` 系の指標を `services/moneyflow/lib/indicators.ts` へ
  追加し、日次で「資金フロー｜観測ログ」へ書く。9/28 に移行が延期された場合は
  延期中は週次のまま扱う (JPX が同日20時ごろに可否を告知)。

## 実装ファイル一覧 (Phase 0/1)

- `src/shared/notion-archive/archive.ts` — `parentPageId` 対応 (親ページを
  「一次データ保管」以外にも切替可能に。moneyflow 自体は既定の「一次データ保管」を使う)
- `src/shared/notion-archive/env.ts` — `NOTION_MONEYFLOW_*_DB_ID` (任意の DB ID 固定)
- `src/shared/notion-archive/moneyflow.ts` — 3 DB (指標定義/観測ログ/取込ログ)
- `src/routes/ingest-proxy.ts` (`GET /api/ingest/moneyflow-sector`)
- `src/routes/moneyflow-sector.ts` — D1 集計ロジック
- `services/moneyflow/lib/sector-names.ts` — JPX 33業種の正準リスト
- `services/moneyflow/lib/jpx-sector-marketcap.ts` — 業種別時価総額 (月次PDF)
- `services/moneyflow/lib/jpx-short-selling.ts` — 空売り業種別集計 (日次PDF+月次集計)
- `services/moneyflow/lib/indicators.ts` — 指標定義カタログ (Phase 1: 6指標)
- `services/moneyflow/lib/iso-week.ts` — ISO週番号ユーティリティ
- `scripts/moneyflow/ingest.ts` — 取込 CLI (`pnpm ingest:moneyflow`)
- `.github/workflows/moneyflow.yml` — 平日 17:30 JST 実行

## Phase 2 以降の予定 (計画書どおり)

- **Phase 2 (誰が買ったか・日本⇔海外)**: JPX 投資部門別 (株式・ETF・REIT)、
  財務省の対外・対内証券売買 (週次、日本全体)。
- **Phase 3 (国別・株以外・日本全体)**: 国際収支統計 (国・地域別)、投信・REIT
  の資金増減、公社債の発行・償還、日銀の資金循環統計。
- **Phase 4 (資産クラス横断)**: 先物・オプション (建玉・投資部門別)、店頭FX・
  くりっく365、暗号資産 (JVCEA＋CoinGecko推定)。
- **Phase 5 (世界の概況・任意)**: IMF CPIS・BIS・World Bank・主要指数。着手前に
  要否を確認する (すべて残高ベースの近似にとどまるため)。
