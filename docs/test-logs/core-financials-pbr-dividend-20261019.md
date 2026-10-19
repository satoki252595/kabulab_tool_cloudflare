# core_stock_financials の PBR・配当利回りの検算（2026-10-19）

`core_stock_financials` の `pbr` / `bps` / `dividend_yield` は、日次株式同期（`sync:daily:core` → `src/cron/daily.ts`）が Yahoo QuoteSummary の値を `src/shared/yahoo/client.ts` の `parseQuoteSummaryResponse` で取り出し、そのまま保存していた。
単位の誤り（%と比率の取り違え）や、分割前の BPS・配当を kabulab 側で使う処理はない。配当利回りは Yahoo の小数（0.0234）を100倍した % 値で保存し、financial-math は100で割って小数に戻す。いずれも単位は一貫している。

ずれの原因は**取得元の値そのもの**にある。2026-10-16 の Yahoo 原本（Notion「一次データ｜stock-sync」、run `38877553046.1`、stage `stocks-first`、37 part、SHA256 照合済み）で確認した。

## 指摘2銘柄

| 銘柄 | 保存値 | Yahoo 原本の該当値 | 検算値（公式） | 原因 |
|---|---|---|---|---|
| 6016 ジャパンエンジン | PBR 15.52 / BPS 794.877 | `bookValue` 794.877、`mostRecentQuarter` 2022-03-31、`lastSplitFactor` 3:1（2024-09-27） | 決算 BPS 2,193.51（2026-03期 EDINET）→ PBR 12,340÷2,193.51 ≒ **5.63** | Yahoo の BS 系列が 2022-03 で止まっており、その BPS を分割で割り直した値が返る |
| 6016 ジャパンエンジン | 配当利回り 0.42% | `dividendYield` 0.0042、`dividendRate` 欠損、`trailingAnnualDividendRate` 7.333 円 | 予想配当 100 円（2026-06 1Q TDnet）÷12,340 ≒ **0.81%** | Yahoo の利回りが予想・実績のどちらとも合わない |
| 6871 日本マイクロニクス | 配当利回り 5.4% | `dividendYield` 0.054、`dividendRate` 欠損、`trailingAnnualDividendRate` 95 円 | 実績配当 95 円（2025-12期 EDINET）÷13,450 ≒ **0.71%**（予想配当は jss 未収載） | Yahoo の利回りが同じ応答の実績配当と 7.6 倍食い違う |

6871 の PBR 5.71 は、`price ÷ bookValue`（BPS 2,355.421、`mostRecentQuarter` 2026-06-30）と一致する。決算期末 BPS（1,703.95）より新しい四半期の値で、今回は除外対象にしない。

## 全銘柄の乖離（data_date=2026-10-16、3,687銘柄）

`pbr` と `price÷bps` の乖離は 0 件だった（`pbr` は Yahoo の `priceToBook` で、応答内では必ず `price÷bookValue` に一致する）。ずれは BPS 自体にあるため、公式値（`jss_financials`）と比べた。

| 比較 | 比較できた件数 | 乖離の件数 |
|---|---:|---:|
| `pbr` と `price÷`最新本決算BPS（2025-06期以降） | 3,618 | 20%超: 367 / 2倍超: 144 |
| `dividend_yield` と最新予想配当÷`price`（2025-10以降の開示） | 2,648 | 0.5pt超: 302 / 1pt超: 191 / 2倍超: 80 |

PBR の2倍超 144 件の内訳は次のとおり。

- Yahoo の `mostRecentQuarter` が株価日から1年超古い: 40 件、欠損: 6 件（1年超古い PBR は全体で 133 件。公式 BPS と比べられた 132 件のうち 91 件が20%超の乖離）
- 本決算後の株式分割で、公式 BPS 側が分割前のまま: 69 件
- 増資・赤字・新規上場などで、新しい四半期の BPS が決算期末と違う: 29 件。Yahoo 側の誤りとは断定しない

Yahoo の `dividendRate` は 3,687 件中 3,675 件で欠損していた。そのため `dividendYield` を応答の中で `配当÷株価` に割り戻せない。

## 修正（この PR）

`src/shared/yahoo/client.ts` に検算できない値を欠損にする guard を足した。推定値で補完はしない（ルール1・2）。

- **BPS/PBR**: `defaultKeyStatistics.mostRecentQuarter` が株価日（chart の dataDate）から 365 日を超えて古いか、欠損している場合は `bps`・`pbr` を null にし、警告ログを出す。
- **配当利回り**: 同じ応答の実績年間配当（`trailingAnnualDividendRate ÷ financialData.currentPrice`）との比が 0.5〜2 倍の範囲（半減〜倍増）にある場合だけ採用する。実績配当・現在値の欠損、片方だけ 0 の場合も null にする。両方 0 は無配の一致として 0 を保存する。

10/16 原本にこのルールを当てた場合の影響（予測）:

| 列 | 採用 | 欠損化 | 欠損化のうち公式値と大きく乖離していたもの |
|---|---:|---:|---|
| `bps`/`pbr` | 3,521 | 145 | 46（2倍超）。指摘の 6016 を含む |
| `dividend_yield` | 3,117 | 570 | 97（0.5pt 超）。指摘の 6016・6871 を含む |

## 残る問題（取得元の限界）

配当利回りの検算相手は、同じ Yahoo の実績配当になる。そのため、2倍以内のずれ（分割を跨いだ配当の取り違えなど）は残る。新ルールで採用されたもののうち、205 件は公式の予想配当と 0.5pt 超ずれている。許容幅を 1.25 倍まで狭めても 106 件残り、正しく見える 522 件まで欠損になる。幅を狭めて解決できる問題ではない。

根本的に解決するには、利回りを公式の予想配当（`jss_financials.dps_forecast`、TDnet 短信・EDINET）÷株価で作る必要がある。ただし予想配当がある銘柄は 2,648/3,687 件にとどまる。TDnet 由来の値（license_tag=`factual-cite`）を公開画面に出せるかの判断も要るため、この PR では扱わない。

既存の 10/16 の保存行は書き換えていない。次回の日次同期で新ルールの値に置き換わる。
