# 成長率投影の実行時計 — 2026-10-17

`rebuildYuhoGrowthProjection` の `computed_at` と対象限定sweepは明示した `runStartedSec` を使っていたが、`as_of` だけ再計算時の実時計だった。同じ保存原本・同じ開始時刻を翌UTC日に再生すると、財務値が同じでも全SQL/POST一致検査が集計日の違いで停止する。

共通関数の `as_of` も `new Date(runStartedSec * 1000)` のUTC日に揃える。引数なしの通常取込は既存どおり関数開始時に一度取得した時計を使う。株価・財務値・原本clock・表採用・NULL・SQL本数・対象範囲・sweep・取得元には変更がない。追加HTTP/モデル/依存/DDLは0。

通常callerは `src/cron/yuho-edinet.ts` の非シャード取込末尾（既存の既定時計）と、`saved-overseas-atomic.ts` の海外/受注共通builder（明示した保存run時計）。Node/ActionsとWorkerは同じ関数を使う。

実3106/S100YIYEの保存ZIP・全6表fixtureを再利用し、開始時刻23:59:50Zの同じatomic batchを23:59:55Z/翌00:00:05Zに再計算する時計制御テストを追加した。修正前は `as_of` とそのSQLパラメータだけが10/16→10/17へ変わり失敗、修正後は全SQL/params/全6表expectedが一致した。引数省略時も実保存断面を使い、SELECT途中でUTC日をまたいでも開始日の `as_of` / `computed_at` を保持し、他5表を変更しない。時計制御はこのテストだけであり、実producerの時計や過去の観測値へ適用していない。

Nixの関連4 suites36 tests、TypeScript/lint PASS。変更はDate構築1箇所で、通信やSQLの追加はない。保存補修の実費・次定時の本番受入は別に確認する。

既に開始済みの凍結runtime（海外2bac/受注acc17）・旧PRE/POST/停止証跡・as_of値は書き換えない。旧producerが跨日で純監査を停止した場合も、旧STOPを保持し、実送信SQL/全POSTの観測as_ofと元builder時間区間を別証跡で資格化する。新コードを旧producerと主張したり、Dateの偽装・原本時刻の遡及変更・結果不明のAPPLY再送で閉鎖しない。
