# 株式同期を日次レポート基準前に終える（2026-09-28）

## 原因と設定

`core_stock_financials` は最新1行を日次 upsert し、`fetched_at` を保存時刻へ更新する。
旧 stock-sync は21:00 UTC（翌06:00 JST）開始予定なので、同時刻を固定基準とする
kabulabAgentsの過去値読取では当日のYahoo指標を使えない。保存後の値から過去を推測しない。

- JP株式/core/rsi/swing: `13 17 * * 1-5`（翌02:13 JST）。全銘柄を一日一度だけ同期。
- マクロ: 旧 `0 21 * * 1-5`（翌06:00 JST）を維持。^N225/^VIX/^GSPC/NIY=F/日経VIのみ。
- 月次 `30 1 10 * *`、UTC月曜の年次/prune、同一concurrency groupは維持。
- dispatch=daily/allは株式とマクロを各一度。stocks/contextを独立再実行可能にした。
  CLIの引数なしは従来の一括実行、専用モードは `--stocks-only` / `--context-only`。

[東証の取引時間](https://www.jpx.co.jp/english/equities/trading/domestic/01.html)は15:30 JSTまで。
[NYSE通常市場](https://www.nyse.com/trade/hours-calendars)は9:30–16:00 ET。
02:13 JSTの米国市場は取引中なので、全工程の前倒しはS&P/VIXの途中値へ市場判定を変える。
株式だけを前倒しし、米国通常市場中のマクロ専用実行も止める。値を終値に変換・推測しない。

## 実10run（旧21:00 UTC schedule、GitHub API読み取り）

| 実行日UTC | 予定から開始まで（分） | 実行（分） | 予定から終了まで（分） | Run |
|---|---:|---:|---:|---|
| 2026-09-25 | 173.45 | 15.80 | 189.25 | [36202742393](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/36202742393) |
| 2026-09-24 | 168.17 | 19.13 | 187.30 | [36074529685](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/36074529685) |
| 2026-09-23 | 148.88 | 15.90 | 164.78 | [35933806216](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/35933806216) |
| 2026-09-22 | 151.92 | 20.40 | 172.32 | [35797864362](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/35797864362) |
| 2026-09-21 | 176.23 | 14.72 | 190.95 | [35669787483](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/35669787483) |
| 2026-09-18 | 127.87 | 13.08 | 140.95 | [35404460926](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/35404460926) |
| 2026-09-17 | 146.52 | 17.73 | 164.25 | [35286855335](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/35286855335) |
| 2026-09-16 | 154.77 | 15.13 | 169.90 | [35162911897](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/35162911897) |
| 2026-09-15 | 147.42 | 18.22 | 165.63 | [35035737071](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/35035737071) |
| 2026-09-14 | 164.82 | 21.18 | 186.00 | [34910229782](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/34910229782) |

実測最大190.95分。02:13→06:00の227分との差は36.05分。
最大開始遅延と最大実行時間を別runから合わせた197.41分でも余裕29.59分。
04:00へ二時間前倒しだけでは足りない。GitHubの未来の遅延を保証する数字ではない。

## 休場・欠損・遅延

upstreamには日本祝日カレンダーがなく、SLOは平日のみの計算と明記されている。
銘柄日付をカレンダーから作らず、^N225の実timestampの日足がUTC対象日と一致することを
全D1書込前に確認。`Chart.dataDate`のtimestamp欠損時の「今日」置換は判定に使わない。
個別銘柄も実日足が当日でないと更新しない。休場と障害は推測区別せず理由付き失敗にする。
既存の同一GitHub失敗IssueとNotion株価同期失敗記録を使い、新しい監視DBは作らない。

株式専用は東証終了前/固定基準後の開始を止め、完了が06:00を越えれば明示失敗。
取得時間・保存時間は実時計を維持し、基準後の値を過去レポートへ戻さない。
マクロ専用は価格同期記録・全銘柄取得・日本株指標を触らない。
追加費用は株式側の市場日確認1 Chart/日と短いmacro専用workflow起動のみ。
