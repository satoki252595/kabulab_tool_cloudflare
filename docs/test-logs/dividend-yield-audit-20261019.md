# 予想配当利回り (`core_stock_financials.dividend_yield`) の監査と是正 — 2026-10-19

## 発端

本番 D1 (`kabulab-cf`) で 6871 の `dividend_yield` が 5.4 (data_date 2026-10-16、price 13,450)。
株価から逆算すると 1 株配当 ≈ 726 円相当で、会社予想と整合しない。

## 1. 書込経路と原因

- 書込: `sync:daily:core` → `src/cron/daily.ts` `buildStockSnapshot()` → `buildFinancialsRows()` → upsert
  (`dividend_yield = excluded.dividend_yield`)。月次 `src/cron/monthly.ts` は core の値を
  `otakara_stock_financials` へ写すだけ。
- 取得元: Yahoo QuoteSummary `summaryDetail.dividendYield` (小数) を `src/shared/yahoo/client.ts`
  `parseQuoteSummaryResponse()` で ×100 して 2 桁丸め。**kabulab 側の計算値ではなく、Yahoo の値を検算なしに保存していた。**
- 単位: % 換算は正しい (大半の銘柄で会社予想 ÷ 株価と一致)。分割前配当を kabulab が掛けている経路は無い。
- 6871 の 5.4 は Yahoo が 0.054 を返したことを意味する (保存経路が ×100 の丸めだけのため)。
  Yahoo 原本の再取得はこのセッションのネットワーク制限で未実施 (原本は Notion の Yahoo 原本 gzip に保管済み)。

## 2. 6871 の検算

| 項目 | 値 | 出典 |
|---|---|---|
| 2026年12月期 年間配当予想 | 178 円 | kabuyoho / Yahoo!ファイナンス (日本版) の予想欄 |
| 2025年12月期 年間配当実績 | 95 円 | `jss_financials` (EDINET 有報) |
| 株価 (2026-10-16) | 13,450 円 | `core_stock_financials.price` |
| 予想配当利回り | **178 ÷ 13,450 = 1.32%** | |
| 保存値 | 5.4% (≈ 4.1 倍) | Yahoo `summaryDetail.dividendYield` |

→ **保存値 5.4% は誤り。** 正しくは約 1.32%。
6871 は TDnet 短信 (2026-08-12 中間) が `ir_disclosures` には在るが `jss_financials` に未取込で、
本是正後は `no-forecast-row` として NULL (未確定) になる。短信 XBRL の取込漏れは別件 (pipeline 側)。

## 3. 乖離銘柄の洗い出し (是正前、2026-10-16 断面)

比較: `dividend_yield` vs `jss_financials` の最新 `dps_forecast` (>0) ÷ `price` × 100。

| 区分 | 件数 |
|---|---|
| 比較可能 (予想 >0 かつ price >0) | 2,308 |
| 差 0.3pt 以内 | 1,914 |
| 差 0.3pt 超かつ 1.5 倍超 / 0.67 倍未満 | 148 |
| **2 倍以上 / 0.5 倍以下** | **82** |
| うち 5 倍超 | 1 |

2 倍以上ずれの内訳 (目視):

- **Yahoo 過大 (ちょうど 2 倍前後が 30 銘柄超、他に 3〜6 倍)**: 会社予想で検算すると Yahoo 側が誤り
  (例: 9414 年間 30〜35 円 / 株価 954 円 → 3.67% に対し Yahoo 7.42%、7818 年間 31〜35 円 / 1,341 円 → 2.61% に対し Yahoo 5.35%)。
- **Yahoo 過小 (0.5 倍以下)**: 多くは短信の後に「株式分割 + 配当予想の修正」の開示がある銘柄
  (8174 / 5805 / 8388 等)。短信の予想が分割前基準で、こちらは Yahoo が正しい。残りは増配・初配・DOE 方針変更で、
  会社予想 (将来) と Yahoo (実績寄り) の定義差。
- Yahoo が 0 だが会社予想 >0: 4 銘柄。

Yahoo の値は会社予想 ÷ 同時刻株価と 0.01pt 以内で一致するのが 379/2,302 銘柄に留まり、定義 (実績/予想) も
一定しないため、検算に使えない。

## 4. 是正 (この PR)

`dividend_yield` = **会社予想の年間 1 株配当 (TDnet 短信 XBRL の `dps_forecast`) ÷ `price` × 100** を日次で計算して保存。
Yahoo の配当利回りは保存しない。次のいずれかなら **NULL (未確定)** とし、無配 (0) と区別する
(`src/shared/indicators/forecast-dividend-yield.ts`)。

| 理由 | 判定 |
|---|---|
| `no-forecast-row` | TDnet 短信行が無い |
| `forecast-undisclosed` | 最新短信に年間配当予想が無い (未定 / 採取不能) |
| `forecast-conflict` | 同一短信の連結/単体行で予想が食い違う |
| `share-split-basis` | 短信の 200 日前〜基準日に株式分割/併合の開示 (予想の株数基準を確定できない) |
| `superseded` | 短信より後に短信・配当・分割/併合の開示 (`ir_disclosures` 表題) |
| `stale` | 最新短信が 130 日超前 |
| `price-missing` | 株価なし |

### 是正後の見込み (2026-10-16 断面へ同じ規則を SQL で適用)

| 判定 | 件数 | 備考 |
|---|---|---|
| 値あり (`forecast`) | 2,350 | うち 0% (無配) 315 |
| `no-forecast-row` | 912 | 6871 を含む |
| `superseded` | 247 | |
| `forecast-undisclosed` | 195 | |
| `share-split-basis` | 59 | |
| `forecast-conflict` | 6 | |
| 計 | 3,769 | 是正前の非 NULL は 3,750 |

値ありのうち 57 銘柄は是正前の Yahoo 値から 2 倍以上変わる。

### 影響

- 有報クオンツのスクリーニング (配当利回り下限)、お宝優待 (月次で core を複写、下限フィルタ・スコア) は NULL を「値なし」として扱う (従来どおり)。下限指定時の対象が減る。
- 004 DCF は NULL を「無配」と表示していたため、`未確定` と `無配 (0)` を分けて表示するよう修正。

### 未対応 (別件)

- TDnet 短信 XBRL の `jss_financials` 取込漏れ (TDnet 行を持つのは 2,975 銘柄、2 期以上は 140 銘柄)。
  取込が増えれば `no-forecast-row` / `superseded` が減る。
- 配当予想の修正開示 (短信以外) の XBRL を予想の更新に使うこと。
- 是正の本番反映は次回の `sync:daily:core` 実行時。D1 の既存値は手で書き換えていない。
