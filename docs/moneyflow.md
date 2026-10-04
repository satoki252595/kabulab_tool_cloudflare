# 008 moneyflow — 「お金の流れ」Notion ダッシュボード

日本市場のお金の流れを見える化する機能。対象は
①東証33業種のどこに流れているか (R1) ②株と株以外の上場商品の比較 (R2)
③先物・FX・商品・暗号資産を含む資産クラス比較 (R3) ④日本⇔各国＋世界の概況 (R4)。

ユーザー決定 (2026-09-27): 非公開運用・無料データのみ・近似でよいが
何を測っているか明記する。Phase 0/1 (R1 33業種) に続き、2026-09-27 に Phase 2〜5 の
取得元 17 件を実装した (信用残の日次化は実装済み — 下記「信用残」節)。設計の詳細な経緯は
承認済み計画 `notion-velvet-goose.md` を参照 (このファイルは取得元の恒久的な
インベントリと実装状況の記録)。

## 全体設計 (要点)

- 保存先は **Notion のみ** (D1 表・R2 は増やさない)。一次ファイル (PDF/xlsx/CSV)
  は `recordPrimaryData()` で実体アップロードする (ルール6)。
- 置き場所は他サービスと同じ (2026-09-27 ユーザー決定。当初の専用ページ
  「資金フロー」案は廃止): 「バックアップ / 株式情報」ページ
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
- JPX の業種分類 (`core_stocks.sector`、personal-only) を使う。非公開の内部面のため
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
| 信用残高(業種別) | jpx.co.jp/.../margin/01.html | 33業種別の信用売買残高(株/円・一般/制度・前日差・売買比率の14指標) | 日次 | PDF→R2 snapshot replay | 無料 | personal-only | **実装済み** (`jpx-margin-sector` spec。JPX 再取得なし) |
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
| IMF pip (旧称 CPIS) | data.imf.org/en/datasets/IMF.STA:PIP | 国別対外証券投資残高(ストック) | 半期 | SDMX API | 無料 | attribution_required | Phase 5 検討 |
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

## 信用残 (銘柄別信用取引残高) の日次化

JPX 告知 (2026-07-06)「信用取引残高の公表情報の変更日及び今後の公表スケジュール
について」により、**2026-09-28 (月) から「銘柄別信用取引残高」が毎日 16:00 に
公表され、週次の「銘柄別信用取引週末残高」(火曜16:30) は廃止される**。

- 日次取込は実装済み: `scripts/vwap/ingest-margin.ts` (`--date=YYYYMMDD`・
  未指定は最新) → Notion 一次データ保管 → R2 `margin/daily/{基準日}.json` +
  `margin/dates.json`。パーサは `services/vwap-analysis/lib/margin-daily.ts`
  (純粋・14 セル・合計ガード)。API/UI は日次 schema へ直接切替済み。
  旧週次オブジェクト・週次コードは残すが通常経路は読まない (旧互換なし)。
- 33 業種集計も実装済み (同 scope): moneyflow spec `jpx-margin-sector`
  (日次)。resolve が R2 の実 latest 基準日を決め、snapshot replay +
  D1 join (`activeEquityCondition` 述語・id/code/sector のみ SELECT) の
  mapping/coverage を固定 capture し、toObservations が純粋に 14 指標
  (売買残×株円・一般/制度内訳・前日差・売買比率) × 33 業種 (+ 未分類) の
  drafts を作る。組込は eligible (普通株) かつ一意ティッカーかつ activeEquity
  の行のみ。非普通株・同一ティッカー複数行 (ISIN 同一性の根拠が無い合算不可)
  は派生から除外する (raw 全行は snapshot に保存したまま)。
  33 業種行は新内訳 dims を未設定 (publicationDate のみ)
  にして既存 `期間|指標|区分` キーを維持する (key 契約)。公式数量/金額 SUM、
  公式率の SUM 禁止、派生率は式・分母を明示 (`売/(売+買)`・分母 0 は失敗)、
  NULL 前日比は 0 埋めせず null 伝播、分類不明・coverage 不足は成功にしない。
  JPX 原本への再取得なし (初回取込・readback は別途 grant 待ち)。

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
- `.github/workflows/moneyflow.yml` — stock-sync の株式 sync 成功後に workflow_call 連鎖 (独立 cron は #160 で廃止)。`trade_date` 固定入力で sector-turnover の as-of を pin 留めする

## Phase 2〜5 取得元 (2026-09-27 実装)

計画書の Phase 2〜5 の取得元 17 件を、共通の取込フロー (`MoneyflowSourceSpec`) に載せた。
各取得元は「取得・解析 (`services/moneyflow/lib/sources/<key>.ts`)」と「Phase 1 の Notion
DB へのつなぎ (`services/moneyflow/lib/adapters/<key>.ts`)」の 2 層で、取込 CLI への登録は
`scripts/moneyflow/sources.ts`。統一規約 (単位・期間ラベル・区分表記・行数上限) は
`services/moneyflow/lib/adapters/README.md`。

### 取込の流れ (`scripts/moneyflow/lib/run-spec.ts`)

1. `resolve()` で公表済みの最新バッチの冪等キーを決める (一覧ページ等の軽い取得)
2. 未保管のキー → 本体を取得 → **先に** `recordPrimaryData()` で原ファイルを実体保管
   (解析が様式変更で失敗しても原本は残る) → 解析・検証 (`validateDrafts`) → 観測ログへ upsert
3. 保管済みのキー → 取得元へは行かず、Notion の保管ファイルから再解析し、全観測行を照合する。
   同値の行は書かず、途中欠落や値・relationの不一致だけを修復する。

Notionの書込結果不明や成功応答の不正ACKは、共有の `NotionUnknownResultError` で
通常入口から停止する。以前は取得元ごとのエラー集計がこの型も捕捉して後続へ進んでいた。
設定不備や不正な読取応答の `NotionConfigError` も、保存不能な後続取得を止める。
結果不明後は後続取得元・取込ログも追加送信せず、取得済み原本と実行ログを保持する。
既知の原本品質不足は従来どおり全取得元の成否を集計し、一部失敗として記録する。

平日の定時実行では、大半の取得元が 2〜3 リクエストでスキップになる。**初回だけ** 全取得元の
最新期間 (合計 約 5,300 行) を書くため 1 時間強かかり、ワークフローがタイムアウトしても次回が
途中から再開する。

### 取得元一覧 (spec 名 = `--only=` に指定する名前)

| 取得元 | spec 名 | 要件 | 頻度 | 1回の行数 | 利用条件 |
|---|---|---|---|---|---|
| JPX 投資部門別売買状況 (株式) | `jpx-investor-equity-weekly` / `-monthly` | R1/R4 | 週次/月次 | 240 | personal-only |
| JPX 投資部門別売買状況 (ETF・REIT) | `jpx-investor-etf-reit-etf` / `-reit` | R2 | 月次 | 29 | personal-only |
| JPX 先物・オプション投資部門別 / 指数先物建玉 | `jpx-derivatives-investor-weekly` / `-futures-oi` | R3 | 週次 | 484 / 上位建玉 | personal-only |
| 財務省 対外及び対内証券売買 | `mof-portfolio-flows-weekly` / `-monthly` | R4 | 週次/月次 | 286 / 264 | attribution-required |
| 国際収支統計 地域別 (日銀) | `bop-regional` | R4 | 四半期 | 最大470 | attribution-required (商用は日銀へ事前相談) |
| 資産運用業協会 公募投信・REIT 資産増減 | `imaj-fund-flows` / `-reit` | R2 | 月次 | 120 / 24 | 要確認 |
| JSDA 公社債発行額・償還額 | `jsda-bonds` | R2 | 月次 | 240 | 要確認 |
| 日銀 資金循環統計 (速報) | `boj-flow-of-funds` | R2/R3 | 四半期 | 282 (上限432) | attribution-required (商用は日銀へ事前相談) |
| FFAJ 店頭FX月次速報 | `ffaj-otc-fx` | R3 | 月次 | 384 | 要確認 |
| TFX くりっく365 / くりっく株365 | `tfx-click365-fx` / `-fx-annual` / `-cfd` / `-cfd-annual` | R3 | 月次/年次 | 462 / 186 / 154 / 22 | 要確認 (personal-only 運用。公開面へは出さない) |
| JVCEA 会員統計 (暗号資産) | `jvcea-crypto` | R3 | 月次 | 156 | 要確認 |
| CoinGecko グローバル | `coingecko-global` | R3 | 日次 (取込日) | 13 | 要確認 (表示時「Powered by CoinGecko」必須) |
| CFTC COT 円・日経平均先物 | `cftc-cot-jpy` | R3/R4 | 週次 | 10 | public-domain |
| IMF pip (公式API直接) | `imf-cpis` | R4 | 半期 | 最大396 | attribution-required |
| BIS 国際銀行統計 (所在地ベース) | `bis-banking` | R4 | 四半期 | 約450 | attribution-required |
| World Bank 上場企業時価総額 | `worldbank-marketcap` | R4 | 年次 | 127 (最大154) | attribution-required (CC BY 4.0) |
| 世界の主要指数・為替・金利・金・原油 (Yahoo) | `global-indices` | R4 | 週次 | 最大221 | personal-only |

TFX の通常取込は、期間・数量の解析前に HTTP 原文と実受信時刻・status・SHA を実体保管し、Notion 添付を全文照合する。同じ原文は SHA キーで再利用し、月次・年次の期間キーは従来どおり維持する。非200原文も lossless gzip で残し、保管結果不明・設定不備・照合不一致では後続取得を停止する。数量の「-」は意味を推測して 0 にしない。dry-run は取得・解析のみで Notion へ送信しない。

IMF CPIS・BIS・World Bank・日銀ストック表は **残高 (ストック)** であり、流れそのものではない
(指標定義の「限界」に近似であることを明記)。各指標の定義・限界の全文は Notion「資金フロー｜指標定義」。

### 検証の記録 (2026-09-27)

前任セッションの実データ照合で見つかった 35 件の問題について、17 取得元それぞれで
「検証 → 反証」の 2 段で再検証した。全取得元でテスト・型検査・lint が通り、当日取得した
実ファイル (取得元サイトへの接続は作業環境のネットワーク制限で不可だったため、同日取得済みの
ファイル) との突き合わせは延べ約 500 項目で一致した (不一致として記録されたものは、修正前後の
差を示す回帰検証)。再検証で新たに見つかった不具合 (冪等キーの衝突、黙った取りこぼし、単位・
列ずれの素通り、定義文の誤り等) も修正済み。

### 運用上の注意・未解決事項

- **JPX 様式変更 (2026-09-29 user決定: 旧方式互換・移行要件なし、新様式ファースト)**:
  投資部門別 (株式) の週次は 2026-09-29 掲載分から 1 ファイルの新様式
  (`stock_1_w_YYYYMMDD_YYYYMMDD.xlsx`) になった。実ファイル
  (`stock_1_w_20260914_20260918.xlsx`、2026年9月第3週 9/14〜9/18 分) で検証済み
  (単位は見出しどおり千株/千円、14部門×4市場×2指標=112件全件で買い-売り=差引・
  売り+買い=合計が一致)。月次 (2026-10-08 掲載分〜) と ETF・REIT (2026-10-13
  掲載分〜) は未公表のため unknown-reject を維持し、公表後に実ファイルで検証する。
  観測は各公式セル1件・旧系列へ無言合流なし・派生値は公式値と区別。新specの
  セル粒度 (side/tradeType 等) に要る指標カタログ追記は A 担当へ Root 経由で依頼。
- **JPX 先物・オプション**: 2026-09-28 に `--dry-run` で初回実データ確認済み
  (weekly 2026-W37・484行、futures-oi 2026-W38・134行。値・単位・符号を原本と照合)。
  実ファイルは private cache に保持し、手元では実フィクスチャのテストも合格
  (CI では規約どおり skip)。詳細は `docs/test-logs/moneyflow-derivatives-cpis-2026-09-28.md`。
  dry-run 成功は一次実体の保管完了を意味しない — 後続の writer 枠で実体保存する。
- **IMF CPIS**: 2026-09-28 の `--dry-run` で `"NA"` が DBnomics の欠損マーカーであることを
  確認し (Derived 5系列・計42点)、`null` と同じ欠損として読み飛ばすよう修正
  (0埋めなし・`"NA"` 以外の文字列は従来どおり停止)。387行で成功。
  DBnomics 側のミラーは 2024-S1 (更新日 2025-04-08) で止まったまま。
  同日、取得元を IMF 公式 SDMX API (pip, 旧称 CPIS) 直接へ移行し、
  ミラー経由の実装は削除した。改訂差分と系列ごとの最新期のずれは応答の実測で扱う。
- **JSDA**: 「発行額は払込日ベース」の根拠 PDF (hako.pdf) は 2026-09-27 に取得・目視確認済み
  (`jsda-bonds.ts` の解説資料コメントどおり)。負値 (△表記) が現れると解析が止まる
  (現状のデータには無い)。
- **財務省**: 指標定義から未確認の「速報値で確報改定を反映しない」断定を除去し、原資料の版
  (最終更新日) と直近CSV窓の upsert に従う説明へ修正 (アダプタの版キー契約どおり)。
  速報/確報の区別は原本で確認していないため断定しない。
- **利用条件「要確認」** の取得元 (TFX・FFAJ・JVCEA・資産運用業協会・JSDA・CoinGecko) と
  日銀 (商用は事前相談) は、非公開の Notion に限って使い、公開面へは出さない。
- 実データのフィクスチャは `services/moneyflow/lib/sources/fixtures/{private,public}/` (このリポジトリは
  PUBLIC のため private/ は commit しない。一覧・取得元・sha256 は同ディレクトリの README.md)。

## Phase 2 以降の予定 (計画書どおり)

Phase 2〜5 は上記のとおり 2026-09-27 に実装した。残りは信用残の日次化 (上記 TODO、A担当) と、
JPX 新様式への追従 (投資部門別株式の週次は 2026-09-29 実ファイルで検証済み・新spec適用中=C担当、
月次/ETF・REIT は公表待ちで unknown-reject 維持)、JPX 業種別指数の過去値 (見送り中) の再判断。
