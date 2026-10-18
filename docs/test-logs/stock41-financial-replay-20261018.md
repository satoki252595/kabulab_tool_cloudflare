# 株価欠測41銘柄の通常5年原本確認と財務・指標の補完

確認日: 2026-10-18。最新の市場日は10/16。OHLCVだけの[14:12の補完](stock41-price-repair-20261018.md)に続き、17:18に固定41銘柄の財務・RSI等をSSHの通常限定CLIで反映し、全値・物理保管・所有プロセスの閉鎖を受け入れた。

## 保存原本から分かったこと

10/16の通常5年窓の原本では、対象41銘柄すべてに10/16のtimestampがあるが、同日のOHLCVと調整終値はNULLだった。直前の正値バーは10/15。parserが有効な10/16価格を落とした証拠はなく、鮮度検査による停止だった。D1に残っていた10/14という日付とも区別する。

先の補完に使った10/18取得の10年原本には10/16の有効値があったが、取得日と取得窓の両方が異なるため、5年窓の恒常不具合と断定しない。RSIの計算窓・percentile母集団を変えるので、10年窓を5年窓の代わりに使わない。

## 10/18の通常取得による確認

16:38:23〜16:39:59 JST、既存の`fetchStockRawData(code, "5y", {stockDailyScopes: true})`と通常のNotion物理保管を使い、固定41銘柄の5年価格と同runのQuoteSummaryを順次取得した。先行3銘柄の資格確認・物理保管後だけ、残り38銘柄へ進んだ。

- 41/41銘柄で10/16の正の終値・調整終値と通常履歴guardを確認した。
- 原応答82件、3,345,648Bを2gzip、計1,181,666Bとして通常保管した。全memberのSHA・実取得時計・5年窓・原文一致を独立に保存物照合した。
- 通常取得で数えた82回はNodeからproxyへの論理要求であり、Worker内部の上流通信総数ではない。
- 実行95.181秒、Notion API 12要求・hosted読取2回、429・再試行・LLM・D1・財務書込は0。
- SSH価格補完は正常窓の終了後に待機し、この取得を単独writerで実行。所有プロセスの終了確認後、元の期限・設定のまま価格補完を再開した。

さらに通常の価格parserを再利用し、新しい5年原本の10/16全7値が、先にD1へ挿入した10年原本の41行と完全一致することを確認した。この比較は保存物のみ、HTTP・D1・LLMは0。実際の財務補完時の現在値・競合検査を代用するものではない。

初回の実行設定では必須キー不足により通常CLIの起動前に停止した。業務通信・書込0の停止記録を保全し、開始契約の参照キーと設定を照合する検査を追加した別の実行で上記を取得した。

## 保存原本からの限定反映ツール

`scripts/sync/stock41-financial-repair.ts`は上記の固定41銘柄・10/16・同run原本だけを入力にする。通常の`parseSavedStockRawData`・`buildStockSnapshot`・同じDrizzle行/SQL builderを再利用し、財務断面・RSI・指標・モメンタム・当該銘柄のsignalを一つの原子batchで更新する。通常日次の取得窓・書込順・失敗処理は維持し、定期取得の追加呼出しを増やさない。

書込前に現在の主体・全5表・JSS年次入力・既存10/16 OHLCV全7値と最新日を照合する。OHLCV不同や新しい市場日の保存は保留し、旧値を上書きしない。signalは対象銘柄の古い集合だけを置換し、新signalが0件の場合も同じstock限定削除を通す。年次・OHLCV・他銘柄・全体の掃除や業種集計は更新しない。

送信前intentと固定scopeのpendingをfsyncし、通信結果不明・競合・POST不一致で後続を止める。出力先や原本directoryを変えても同じcheckoutのpending/completedを回避できない。全列POSTと実書込時計を確認し、receiptの保存バイト列そのものをNotionへ物理保管する。

全列比較の検証で、SQLiteの`json_object`がREALの末尾桁を丸める問題を検出した。REALだけをSQLiteの26桁表現で読み、有限の元数値へ戻す。許容誤差や値の丸めで比較を通さない。既存の金融計算・保存精度は変えない。

Nix Node22.22.2で関連5suite/59件、実保存82原本→通常計算→in-memory SQLiteの全41銘柄の原子更新・全POSTを検証した。旧PRE/CASの実数精度回帰8件、root型検査・対象5file lintもPASS。通常writerと生成SQL/paramsの同値、他銘柄/年次/OHLCV不変、競合rollback・signal0・結果不明後の再入場拒否を確認した。新依存・DDLは0。本番への限定反映はこの検証とは別受入。

開発時のSonnetコード限定レビューは1回・138.397秒・約0.40米ドルで、重大指摘0。出力先の事前確認、不正形状STOP、反映先stock_idの送信前確認、非空JSS入力の回帰検証を追加し、最終候補の対象10件・型検査・lintを再確認した。データ補完にLLMは使わない。通常writerの7表SQL定義・行計算・await/順序/失敗処理が変更前と同じこともRootが独立比較した。

SSHから本番D1へ読取だけの事前確認を行い、9項のUNIONが本番上限で拒否されることを検出した。5項と4項のCTEを外側2項で結合し、同じ1request・対象範囲・parserを維持する。JSON関数も[公式の引数上限32](https://developers.cloudflare.com/d1/platform/limits/)に合わせ、15組ずつ`json_object`/`json_set`で構築してNULLを保持する。compound制約の根拠は[workerdの実装変更](https://github.com/cloudflare/workerd/pull/796)も参照した。

Python標準SQLiteへcompound5・関数引数32の実上限を設定し、旧SQL2種類の拒否と新しい実生成SQLの全列/REAL/NULL/volume0の回帰を追加した。最終対象11件・型検査・lintはPASS。続いて17:07 JSTにSSH Nixから本番D1へ5つの読取を行い、REALの全精度roundtrip、JSSのcode先頭主キー、年次scope/銘柄限定queryの索引利用、実9行・51REALタグ・NULLの読取を0.698秒で確認した。D1/Notion書込・取得元API・モデル0。診断用`sqlite_version()`の禁止と旧UNIONの400は旧記録に残し、金融値の更新や結果不明の書込再送は行っていない。

本番読取proof: `tmp/feature-audit-20261018/stock41-financial-d1-preflight-v1/ssh-v3-result.json`、SHA256 `f9eba60900a061763a94b4128d7154e31421f3290dda6de3591016d5663a542b`。これは一銘柄の事前読取であり、41銘柄の実反映は別受入。

実行は、現在の固定原本pack・必要なprivate `.env`・排他・既存停止記録を確認してから、プロジェクトNix内で次の通常Node入口を使う。通常の日次を過去日へ偽装する引数は加えない。

```sh
nix develop --command env -u NODE_PATH node --env-file=<private.env> --import tsx \
  scripts/sync/stock41-financial-repair.ts --execute \
  --source-dir=<fixed-source-pack> --out=<new-private-result.json>
```

## 受入範囲

17:18 JST、main532のSSH Nix環境から通常限定CLIを1回実行し、41銘柄を反映、HOLD0・終了コード0で閉鎖した。財務断面・RSI・指標・モメンタムと銘柄限定signalを更新し、新signalは2件。全41銘柄のPRE・入力CAS・全列POST、原本からの通常再計算と実送信SQL、receiptの正常物理保管を保存物から独立照合した。これは通常helperの全値読戻しの受入であり、独立HTTP再GETではない。

元の実行窓は08:18:04.961〜08:38:04.961 UTC、所有親の実経過は21.427秒。通常reportは08:18:06.466〜08:18:20.238 UTCの13.772秒、物理receiptは08:18:25.528 UTCに完了した。市場日10/16、原本の実取得日10/18、今回の実書込時計を分けて保持する。D1 124要求・Notion API 9要求・hosted読取1回は全134応答200、結果不明0。新取得元通信・モデル・年次・OHLCV・他銘柄の更新は0、pendingなし・観測した所有プロセスは全閉鎖。

17:19 JSTには通常opsのcoverage SQLを1回だけ読み、対象3,687、価格・指標・モメンタム各3,687、マクロ日10/16を確認した。`rows_read=14,749`、書込0、attempts1、DB duration 65.0812ms。このcoverageは財務表やRSIの全項目充足を直接数える検査ではなく、全市場の再計算でもない。

8303の過去245件の非正調整値、日足523A/641AのHOLD、5分足7531/9311の取得元欠測を、この41銘柄の成功へ含めない。将来の5年原本供給、本日20/21時と10/19の17/18時の自然定期成功も未確認。全20機能の完了とはしない。新しい依存・DDL・モデル利用はない。D1の実請求額と上流総通信数は未測定。

## 保存証跡

私有保存先: `tmp/feature-audit-20261018/stock41-fresh5y-capture-v2/`。

- 通常結果 `result.json`: SHA256 `7748d4be06527db4b2a9fd3a44f3f2f3dc95c3f2446a913e1e725ffb3e88bcae`
- 所有プロセス閉鎖 `owner-terminal.json`: SHA256 `deaef0b295e82c60287aab29596cbb0f30740b7781bf015b3a9e230570570f56`
- 独立保存物照合 `delegate-saved-acceptance-v1.json`: SHA256 `7b5b105b6356b2e4aaf2562ee9b5d5cf3da5a98c868c5e6647d7b92122238108`
- 既受入OHLCVとの全値比較 `root-5y-ohlcv-saved-equality.json`: SHA256 `f3ff83bec237fa9ced6f8b41402ceec660ef28a316d357584e52d405c4c496cc`

本番反映の22保存物・通常結果・coverageは、私有保存先 `tmp/feature-audit-20261018/stock41-financial-ssh-preparation-v1/actual-ssh-v1/`。以下の受入証跡はその親directoryに保存。

- 独立保存物照合 `delegate-actual-financial-acceptance-v1.json`: SHA256 `4836399dab8a75f259c9715a8beccad96e0e27cddcce9ebe6a59046c6e796c98`
- Root最終受入 `root-final-acceptance-v1.json`: SHA256 `5a9a463f4be4407e195163f856efac2808ae656f3aba99c95695127d9aa80b6a`

原本全文・秘密値・署名URLをGitへ保存しない。追加の全市場再取得・全履歴ミラー・独立HTTP再GETは完了条件に加えない。
