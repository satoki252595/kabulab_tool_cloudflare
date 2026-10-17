# RAWのhosted送信前の予算停止を通常partialへ限定する — 2026-10-18

RAW74は、原3,600秒予算のうち3,535.618秒でhostedの次GET開始を拒否し、exit1/通常summaryなしで終了した。保存safeログのmessage SHA `3cf569e6b53772d1d12410a060e8b23123a4e9ddba6d099b4879871efcaf9126`は、実execution `4d76e9b1`の「hostedの65秒headroom不足。送信せず停止」と完全一致する。残64.382秒で発火する実送信前guardが原因で、署名URL失効やprovider HTTP失敗とは判定しない。

原full job logは114,308B、SHA `6315903ad8541bea8da59737b7fb84d8741dd87fbefbd8c1f1cfbb1ea077adb7`。本PRのfixtureはそこからの安全な停止情報だけで、署名URL・認証情報・原本文を含まない。全native/JSONLはこのlogへexportされていないため、481というcallback attempt数から実GET数や完了prefix件数を推定しない。旧STOP・remote state・元poolは変更していない。

## 最小修正と停止境界

通常callerは同じ `runRawBackfill` を使うCLIだけ。新item入場時に、inflightがNULLで残65秒未満なら既存の `partial / stoppedByBudget=true / budgetStopReason=seconds` で止める。accounting/fsync・独立hostedの残差待機後の実送信直前検査も維持する。そこで拒否された場合だけprivateな `NotionConfigError` 派生型を返し、download周囲でinflight NULLを確認してpartialへ閉じる。既存inflight・一般NotionConfigError・HTTP/transport・R2 PUT・D1 INSERT・ACK不明は従来どおり失敗させる。

現在itemのraw/index送信前でだけpartialへ移り、cursorは最後の全照合済みprefixから進めない。成功download数は全body・実wire・SHA/サイズ検証後に数える。拒否された開始通知や途中受信bytesは別counterへ保持し、actual HTTP送信数とは呼ばない。既存のhosted間隔、retry上限、価格/金融値、15列index、manifest、cutoff、maxSeconds/bytes、pool上限とoriginは変更しない。

`raw-index-continue.py`の本体は変更しない。全照合済みprefixが1件以上の正常partialだけが同じrevision/plan/予算の次runへ進める。進捗0のbudget partialは通常continuationが拒否し、無限の空runを作らない。単発reconcileやSTOP/不完全receiptからの自動続行も拒否する。

## 保存再生と回帰

- 実停止fixtureの3535.618秒/64.382秒とmessage SHAを一致させ、新item読取前の停止を確認。
- 通常 `createRawDownloader` → `downloadArchivedFile` のmock transportに実原停止時計を与え、fsyncが65秒境界を跨ぐと次GETを送らず、先行全検証prefixを保持することを確認。
- 第1GETのtransport/partial body後に第2GETの入場を拒否し、受信0/2bytes・attempt通知を保持、raw/index mutation0を確認。同じ文言の一般エラーでも型が違えば失敗する。
- 旧raw inflightをbudget partialに隠さず、PUT/INSERT unknown・HTTP429・bytecap・deadline・残差pacingの既存回帰を維持。
- 保存の実3原本275,269Bを同一manifestの明示subsetとして旧/new通常publisher/downloaderへ与え、成功結果・全15列index・状態/receipt/eventsの全値同一、同入力再実行のrawPUT0/INSERT0を確認。これは隔離in-memory/transport再生であり、remote原本再GETやRAW74完了件数の証明ではない。
- 同じ正常continuation関数で進捗prefixのseconds-partialを受け入れ、進捗0を拒否。元pool/実行revisionを変えない。

Nix Node22.22.2/pnpm9.15.9の関連Node 2 suites/135 tests、Python継続4 tests、root TypeScript・対象ESLint・diff checkはPASS。初回のPython discoverはドットを含む既存試験名を検出せず0件だったため、通常の直接file実行で全4件を確認した。新test spyの引数型1箇所もtupleを明示して型検査を通過した。比較の旧baselineは既存の凍結Mac4ce runtimeのRAWコード（実execution4d/current2dcbと全bytes同一）を読取だけで使い、canonicalを後日pullしても旧版比較が変わらない。旧runtime/環境は変更していない。私有全比較proofは本WTの `tmp/raw-read-budget-pure-v1/` に保存する。実3原本の比較結果SHAは `dbaa52301ba952582dd73be792c003cda66c8a9f8c48ec31ad37f435680875e9`。実74の原ログ/terminal受入と、保存原本・normal controlsの純再生を別の証明として残す。

## 旧RAW74の再開は別受入

このコード修正は旧STOPを成功へ変更しない。rootが全旧actor終端後、既存通常 `--mode=inspect --limit=1|2` で元plan/cutoff/manifest、現在/直前cursor、active/state全bytes SHA、raw全文と15列indexをREADだけ確認する。

inflight NULLかつ現itemの原本/索引が未作成と確認できれば、結果不明writeのreconcileを不要に実行せず、新受入revisionの通常applyを同じ元200回poolで別releaseする。inflight非NULLなら、原SHAとstate全bytes SHAに固定した既存 `--reconcile-sha256` / `--reconcile-state-sha256` の条件を満たす場合だけrootが別判断する。reconcileのintent/complete、旧latch、原unknownを保存し、自動解除しない。

inspect/reconcile/ordinaryapplyも元poolの消費へ計上し、起点や残回数をリセットしない。最新remote状態と完了prefixはまだこのPRで観測しておらず、新dispatch/retry/GET/PUT/INSERTは0。main/CF受入・freshREAD・root別release前の実再開は0。
