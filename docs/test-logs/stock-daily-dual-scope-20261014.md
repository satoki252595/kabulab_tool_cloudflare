# 株式日次の当日データと5年RSIの独立資格

実装・ローカル検証日: 2026-10-14。追加上流取得・本番書込・再dispatchは0。

## 原典で確定した障害

[株式18時run 38539360030](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/38539360030)
は3638/3686銘柄を更新し、48銘柄を保留した。47銘柄は10/14の原典日足が全NULL、
8303は当日実値があり、過去の調整後終値だけが異常という別原因だった。
source clockを提供遅延の推測や別の終値で埋めていない。

8303の保存Chart(5y/1d、events=split,div)原本:

- capture clock: `2026-10-14T10:15:47.400Z`
- full body SHA: `bf9735d9ae7af4888625a5a6e5a53c9f3d69588273a1cb79a4cacbcc5d5244db`、66935B
- 全1221本のうち調整後終値が非正の245本: 2022-03-30〜2023-03-29
- 直近130本: 2026-04-02〜2026-10-14、既存adj/OHLCV guardで全本適格
- 10/14実値: open1481/high1489.5/low1461.5/close1478.5/volume3868600/adj1478.5
- Notion物理原本: page `3f9d74ff-84cd-8102-826a-dbade7263c7f`、
  `yahoo-raw-38539360030.1-stocks-first-part-20.json.gz`、
  gzip SHA `f8b51aa828410fdabb3709072bbff72659e2f2227b6a132289f817497fef389f`

保存38gzipの全物理SHA・内包7373応答SHA、当該失敗48集合とD1当日coverageの
照合はprivate receipt `stock18-failure-38539360030-readonly-v1/reconciled-summary.json`
SHA `00605c4ef50a49b6cfe65b1097059dc63c1a9671df943660efc5056b66f60a34`。

## 通常本番経路

通常`buildSnapshot`だけが`stockDailyScopes: true`を取得前に指定する。
同じChart(5y)1回とQuoteSummary1回を使い、原文capture/全文保管後にD1を書く順序は維持。
日本株・5y・原文captureの欠測は送信前STOP。

全5年が従来guardを通れば返り値・計算・保存は従来と同じ。非正adjがある場合は、
全raw OHLCVの実在値検査と直近130本の既存adj/OHLCV/coherence guardを独立に行う。
直近の非正adj/raw OHLCVなど即時拒否条件は全体STOP。既存の帯域guardが棄却する
バーは従来通りwarnして不採用とし、対象日の実close/dateが欠ければ後続fresh gateでSTOPする。
この既存sanitize/fresh gateを通った直近窓から当日金融、短期指標、
OHLCV、momentumを作り、5年RSIは`RsiHistoryHold`として保留する。
異常adjの置換、5年母集団からの除去、別rangeへの取得変更はしない。
既存`fetchChart`/`fetchStockRawData`の既定full5y guardと他callerは変更しない。

RSI HOLDでは`rsi_percentile`にINSERT/UPDATEを出さず、旧全列・computed_atを保持する。
`currentUpdatedStocks`は当日更新数、`successStocks`はRSIまで成立した件数。
HOLDは`failedStocks`および既存物理失敗バッチの`history_hold`分類へ含め、
原文SHA・異常245本・期間・理由を保持する。既存1%監視閾値とsector coverageは変更しない。
1件のみの単社検証ではsuccess0/failed1/currentUpdated1になり、全成功へ丸めない。
当日書込も失敗した場合は同一銘柄を二重計数せず、書込失敗と履歴HOLDの両理由を保持する。
通常producerはliteral`retry:false`で回収helperを呼び、helperはcallback/beforeAttemptの前に
attempted0/recovered0で即returnする。runのoptionsから変更できないため、初回flush失敗後の
recovery成功によりHOLD観測が同銘柄で増える経路は通常runでは到達しない。
実SQLiteのD1 transient503 faultでもfetchStock1/current0/failure1/historyHeld1を確認した。

## 公開readerと時計

共通`percentileMatchesFinancialSnapshot`で、RSI computed_at >= 対応する金融fetched_atを要求する。
金融行や時計が欠けていれば資格化しない。既存7日条件と合わせて一覧の行・全件COUNT・
除外COUNT・全period/blue-chip filter・ホームBlue Chips件数へ適用する。
詳細も同じ時計関係を使い、現在株価に対応しない旧RSIを表示せず未取得を明示する。
7日超だけでない除外理由へ一覧の説明/バルーンヘルプも合わせた。
7日超でも金融と同じsnapshotの詳細値には、従来の古さ警告を維持する。

rgで直接readerはscreening/detail/pagesの3箇所、ビューはその結果だけを読むことを確認。
現行RSIアプリはSSR経路のみで、独立したRSI JSON APIはない。
repair-preflightの旧値保全照合、Python inactive cleanup/governanceは値の採用readerではなく変更不要。
下流監視へは既存DailySyncResult/全失敗バッチから履歴HOLDを伝え、current coverageと混同しない。

fetched_at/computed_atは従来のD1`unixepoch()`保存時計(整数秒)を維持し、
raw capture clockや取引日を代入しない。金融のflushの後にRSIをflushするため正常更新では
computed_at >= fetched_atになる。SQLite回帰で1478.5/1489.5/1461.5をREAL列とmomentumへ
丸めず運び、旧RSI時計の保持を確認する。表示側の既存小数桁整形と保存値は区別する。
初回OHLCV保存は従来通り130本、週次pruneは90本。保持規則の変更はない。

## 検証と増分

全文原bodyはprivate物理保管のまま保持し、公開GitのCI fixtureは実原典の最小projectionだけにした。
8303は過去実異常1行＋直近130行、7203は正常2行、quoteは日次に必要な実raw fieldsだけ。
provenanceへ元取得時計・原bodySHA/bytes・物理gzipSHAと、新projectionSHA/bytes・選択index・
削除fields/用途を分離して固定。認証/署名URL/headersは含めない。
全原本1221本/異常245本/直近130本・元SHA・正常7203全5年新旧同値はprivate offline再生で検査し、
receipt SHA `b161bdb62b8f9d91c03e269df7b10ad6478b9f41785b113d8ef7850257bc8730`を固定した。
この検査の通信/業務writeは0。CI fault injectionも元原典に実在する負adj値だけを使う。

Yahoo由来の`personal-only`運用分類の一次根拠は
[Yahoo Financeデータ提供方針](https://sg.help.yahoo.com/kb/SLN2310.html)の再配布禁止と
[Yahoo利用規約](https://legal.yahoo.com/us/en/yahoo/terms/otos/index.html)の商用reuse制限。
2026-10-14に一次HTML2件を保存・全SHA照合した。金融API取得0、license文書GET2。
この変更で利用許諾を取得したり、法的な適用範囲を断定したりはしていない。

Nix Node22.22.2/pnpm9.15.9で関連16suite/232tests PASS、global tsc・owned ESLint・diff check PASS。
実原本8303 bad-full/good-recent、正常7203新旧完全一致、他caller strict拒否、
直近adj/過去raw OHLCの異常拒否、入力契約の送信前STOP、旧RSI全列不変、
当日保存/履歴HOLDの別集計、一覧/詳細/ホームと表示文言を検証した。

追加source GET/Notion/R2通信、DDL、依存追加は0。通常成功では5y adjを1回追加走査するだけ。
HOLD時だけ既capture bytesのSHAと直近130本の資格を計算し、RSI1rowの更新を省く。
除外COUNT/homeは既存金融PKへのjoinを追加し、一覧のCROSS JOIN順序を維持する。
本番8303の回復、長期245本の原典訂正、残47の当日原典提供は未受入。
