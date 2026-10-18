# 10/16の欠測41銘柄をSSHで価格だけ補完

2026-10-18 14:12 JST、main `b2c2474ef1f2c88974c243173245defa0ee6bce8`（#527）の通常限定CLIをSSHのNix環境で1回実行した。41銘柄のOHLCVを4原子バッチで挿入し、全値の読戻しとNotionの物理receipt検証まで完了。実処理9.192秒、同値による書込省略0、HOLD0、結果不明0。観測した所有親子プロセスも閉鎖した。

## 入力と保存先

10/16の株式同期にあった42件は、当日価格欠測41社と8303のRSI用過去履歴HOLDに分かれる。今回の対象は前者の価格表だけである。

- 市場日: 2026-10-16。原本の実取得日: 2026-10-18。取得時計を市場日へ書き換えていない。
- 原本: 通常VWAPの日足10年窓で物理保管済みの33gzip。受入refsと各原本・memberの全SHA、symbol、取得時計、rangeを検証した。
- 転送: refsを含む34ファイル・54,369,465Bだけ。tar転送4.284秒、12.11MiB/s。全市場・全履歴のミラーは行っていない。
- 保存先: D1の`swing_daily_ohlcv`の銘柄ID・日付・OHLCV・調整終値だけ。既存の銘柄同一性・不存在CAS・plain INSERTを再利用し、各バッチ直後に全値を読戻した。

VWAPの丸め済み値を流用せず、原本の精度を保持した。原本の出来高0も値のまま保存しており、無取引・停止・上場廃止の確定とは扱わない。対象41社の10/16終値と調整終値は同値だった。

## 停止条件と適用境界

固定scopeのpendingと送信前intentをfsyncし、出力名・原本directory・CWDを変えても同じcheckoutの停止記録を回避できないようにした。既存同値は書込0、既存NULLを含む不同はHOLD。通信結果不明ならpendingを保持して後続・再送を止める。今回の正常completed・全journal・receipt SHAと、元の20分枠内の終了を確認した。

財務断面、RSI、スイング等の指標、全市場集計、旧取得時計は変更していない。通常の5年窓と同runのquote summaryを再取得・再資格化した結果ではなく、10/16の日次同期runの42失敗履歴や全市場成功を置換しない。8303の過去245本の非正adjusted値も保留のままである。

保存原本で10/16から実取得までに報告された分割・配当等は0件だった。未提供イベントの不存在や、既存D1全履歴との取得時点・basis一致は証明していない。係数による価格補正や財務・RSI再計算は行わない。

新しい取得元API・モデル呼出し・DDL・依存追加は0。通常journalでは4原子バッチと全41件のPOST値を確認した。Notion総要求数、D1の実読取/書込行数・native総数、実請求額は独立計測していない。

独立FS照合でも、保存済み41行の原値・member SHA・取得時計、PRE不存在、12/12/12/5行のCAS付きINSERT、全POST、receipt/completed/元期限・所有親子閉鎖が一致した。捕捉SQLをin-memory SQLiteで再生した結果も全41値と一致。追加の本番GETや原本33gzipの再走査は0である。

## 保存証跡

私有保存先: `tmp/feature-audit-20261018/stock41-price-repair-ssh-preparation-v1/`。

- 通常実行受入: `normal-action-acceptance.json` — SHA256 `104adc6e196e29b2dfccc6b89cce6358f9be03b39f24d661cc5ede0cfc762660`
- 閉鎖保存物8件のmanifest: `actual-action-v1/closed-set-manifest.json` — SHA256 `11e3a65112115ad461a9b57359618b1aabb51520058098aa59d91b9e3759e889`
- 全journal: `actual-action-v1/result.json.events.jsonl` — SHA256 `a29f347db3eb3aa5a4cf878761977102fadd026da655007aaecbf62c2eac391e`
- 正常物理receipt: `actual-action-v1/result.json.receipt.json` — SHA256 `999880a3bcf1199dd112ab95e6aa139625f1ff4ba60da98f2a8e98949d2050a6`
- 独立FS受入: `delegate-normal-action-acceptance-v1.json` — SHA256 `f7c6a720bf65021594872606355aca9f100f7e69877b6d9ad994e8645c5bd0f6`

原本・価格値の全文・署名URL・秘密情報はGitへ保存しない。通常の全値読戻しを保存物から確認し、別の全銘柄再GETを完了条件へ追加しない。
