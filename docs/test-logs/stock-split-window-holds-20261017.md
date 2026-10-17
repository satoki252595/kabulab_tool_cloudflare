# 報告splitを跨ぐ日次計算だけの保留

2026-10-17、追跡[#343](https://github.com/satoki252595/kabulab_tool_cloudflare/issues/343)。base `02de89504957e44f4b2d12f10ad74e3322dba38f`。これはChart原本の報告イベントと計算窓の照合であり、価格の誤りの確定、法的権利の資格化、全20機能や次回本番定時の受入ではない。

通常の `stock-sync → sync:daily:core → buildStockSnapshot` と保存原本replayが同じbuilderを使う。既存の `extractStockCorporateEvents` が検査した同じ応答のsplit（分子・分母・辞書key・epoch）だけを参照する。イベント日は既存株式バーと同じUTC暦日で、法的効力日や市場権利落日へ読み替えない。`実使用する有効列の先頭日 < 報告split日 <= 末尾日` のときだけ、providerのOHLCV株数基準が未証明である理由を既存 `corporateDiagnostics.unknownReasons` と必須batchへ記録し、該当計算をNULLにする。比率を価格や出来高へ再適用しない。

| 計算 | 実使用する列 | 保留する既存nullable列 |
|---|---|---|
| ATR | 直近130行中の有限high/low/close。15本未満は既存計算自体がNULL | atr14 / atrPct |
| 平均出来高・出来高比 | 末尾20本、または当日＋直前20本の完全なvolume列 | volume20d / volumeRatio |
| 平均売買代金 | 末尾20本の完全なclose / volume | avgTurnover20d |
| 値幅 | 末尾20行の有限highまたはlow。両列が存在する実日付 | range / fib各列 |
| 前日比 | 直近130行中の末尾2本の有限close | pctChange1d |

報告splitと窓初日が同じだけでは跨ぎにしない。欠測により既に計算不能の平均等に新たなsplit保留理由を付けない。raw OHLCV・受領価格・出来高・previousClose・adj・原本時計・財務、RSI/SMA/MACD/momentumは保持する。受領closeを保持することは「split未調整」の主張ではない。

## 原典契約と保守HOLDの限界

Yahooの[Historyページ](https://finance.yahoo.com/quote/9984.T/history/)にはCloseはsplit調整、AdjCloseはsplitと配当を反映する旨の一次脚注がある（root調査2026-10-17）。History表示のCloseとChart APIのquote.closeが同じ基準という資格、および全OHLC・volumeの基準はまだ結ばれていない。この脚注から未調整価格と決め付けて倍率を再適用せず、反対にChart全OHLCVを資格済みへ昇格もしない。

今回の保留は未資格に対する保守政策で、111社の価格が誤りだと証明した修正ではない。rootレビューで、History脚注だけではChartの契約を断定せず、正式なbasis資格が得られるまで実使用窓を跨ぐ計算だけ限定HOLDとする方針を採用した。今回の保存範囲でclose2の変更は0だった。原典のsourceContractと株数単位を資格化できれば、その証拠により将来この保留を外し得る。

VWAPの `zeroSplitCovered` は10y証拠・JST・5分足対日足の全span資格を含むため、5y株式builderへ丸ごと適用しない。VWAPの既存gateを変更せず、同じ原本と実使用期間を結ぶ既存株式診断を再用する。省略eventsは「なし」の証明にしない。正式効力日・株式class・増資/新株予約権/自己株消却/会社分割等の完全な台帳、配当の株数基準、旧保存日足の異なるcapture間の再受入、JSS調整OHLCの全基準資格は未完のまま。

## 保存3,687社の変更前後比較

保存run `38877553046.1` の38 gzip・7,375 memberを全SHA/bytes照合。株式3,687社を新旧の正常 `parseSavedStockRawData` とbuilderへ順序交互に通した。別session `^N225` は株式対象に含めない。

- raw parseは両方3,687成功。実当日足の欠測41社は新旧同じ理由でHOLD、fresh通過は3,646社。8303の過去RSI245本HOLDも保持。
- ATR14/ATR%は111社、volume20/volumeRatio/turnover/range/fibは各53社だけが従来非NULLからNULLへ変わった。pctChange1dの変更0、他の全snapshot値・原OHLCV・財務・adj系指標は全値同じ。
- 2814はvolume21の初日2026-09-14とsplit日が一致し、出来高比を保持。8303・7203・9252の現在窓は全値不変。4374は実2026-09-29の2:1がATR/出来高/値幅を跨ぐ正例。実9252の1:1.2併合は明示historical subsetで回帰した。
- ATR可用性はこの保存標本で111/3,646社分減る。安全側の保留による機能上の影響であり、性能改善や誤価格訂正とは称しない。正式なprovider基準を結ぶ残件は#343に保持する。

parse累計は旧6,338.421ms / 新6,135.414ms、builder累計は旧318.571ms / 新318.631ms。同じ原本の単回交互実行であり、短縮・無劣化や本番所要の保証ではない。追加理由のJSONは合計20,826B増加。追加source/Notion/DB要求・モデル・依存・DDL・本番業務書込みは0。通常の同じindicator upsertへ相乗りし、列数・SQL本数を増やさない。

既存nullable consumerも追跡した。`screenStock`は保留したATR/流動性を合格扱いせず、関連 `detectAllPatterns` は必要なrange/volume/pct等がNULLなら発火しない。sector集計はNULL前日比を除外、JSS/スイング画面は既存nullable列を返し、金融数学のlowvol抽出は非NULL条件を使う。古い指標を新日付の値として保持せず、その日の該当列をNULLで保存する。原本日足と財務値を止める全銘柄STOPは追加しない。

私有paired結果: root `tmp/feature-audit-20261017/daily-ohlcv-rights-window-study-v1/paired-result-v1.json` SHA `12d0ad61deec5061635b7c438f5027f2e48c540dcf3c90f31f17f67eaa42ab31`。公開fixtureは5社の元Chart/QuoteSummary body10個を変更せずgzip126,056Bで保存し、元取得時計・全SHA/bytesと物理memberをprovenanceへ記録する。auth header・署名URLは含めない。テスト用URL組立やnullable/期間投影は明示protocol試験であり、新しい実観測ではない。

検証: Nix、関連4 suite/53 PASS、cron・各consumer等28 suite/486 PASS（重複suiteを含む別集計）、全TypeScript・対象ESLint PASS。nullable行除外・窓初日一致・last2 historical境界・逆分割・events省略・ratio異常STOPを回帰した。本番保存値の更新・定時完了・physical batchの読戻しはこのPRのローカル検証では受け入れていない。
