# 株式UTC対象日と保存済み日本市場sessionの明示確認

2026-10-15。コード検証済み、本番復旧の書込は未実施。

株式日次は開始時のUTC日を対象日とし、06:30 UTCから21:00 UTC未満まで実行する。2026-10-15の00:00〜05:59 JSTは、既存の株式仕様では2026-10-14の対象範囲に入る。一方、VWAPの保存原本確認は実JST当日を要求する。両者の時計契約を混ぜると、正常な株式の翌未開場時間を拒否してしまう。

`src/shared/stock-sync-window.ts`へ既存のUTC日付式・開始窓・21:00書込期限を抽出し、通常`runDailySync`からも呼ぶ。実`Date.now()`、月曜判定、例外文、取得・計算・保存処理は維持する。

新しい明示読取`loadArchivedStockDailySessionReference(date, readOptions)`は、実UTC対象日・開始窓・期限を読取前後に確認して、既存の保存JP leg readerを使う。確認時刻は`qualification.qualifiedAt`、原本の観測時刻は`reference.observedAt`として区別する。元の全文SHA・N225の確定session・R2本文・Notion物理gzip・manifestの全照合を変えない。任意の時刻を渡す引数や失敗時の別source切替は設けない。

既存`loadArchivedDailySessionReference`は読取前後の実JST同日確認を維持する。通常の`yahoo-direct`選択、VWAPの開始条件、原本の取得時刻・日付は変えない。

検証:

- Nix Node22.22.2/pnpm9.15.9。関連6 suite、161 tests、型検査が成功。
- 保存済みN225最小fixtureの元SHA`82343be04851794a5dfe682e22a8cb7a731159aaf256a8a9e993f02ba1d38772`と元2026-10-14 18:02 JSTの観測時刻を維持して、JST翌日でもUTC期限前だけ新stock readerが受理する。
- 実UTC日との相違、開始前、21:00期限到達、読取中の期限超過、原本欠測・gzip不一致は停止する。同じ翌JST日のVWAP readerは従来どおり取得前に停止する。
- 保存原本の確認本体5,861 bytesは抽出前と同一。通常株式のUTC式・開始条件・期限比較と例外文も元実装から保持する。一次データの追加取得・業務書込・モデル推論は0。

通常経路の通信数・依存・保存量は増えない。明示readerを呼ぶ場合の既存R2・Notion・hosted読取と予算はそのままで、原本の再アップロードは行わない。8303の復旧は別の新しい計画で全9表のfresh PRE/CASと実時計を確認する必要がある。旧停止計画への再入や、245件のRSI履歴HOLDの解除を本変更の成功条件に含めない。
