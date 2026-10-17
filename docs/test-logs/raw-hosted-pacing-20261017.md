# RAW原本のAPI枠とhosted取得枠

2026-10-17。通常RAW CLIの明示入力だけで、既存Notion API枠とは別に保存添付GETを待機させる。追加依存・先読み・並列取得・原典再取得はない。既存の200run pool、固定manifest、unknown停止、CAS、全body/索引15列の読戻しは変更しない。本番への採用・旧poolからの引継ぎは別途受け入れる。

## 通常入口と既定の互換性

`--hosted-max-rps=1.0` を通常 `--mode=apply` に明示した場合だけ、hosted GETを独立枠へ分ける。許容値は有限の0.25〜1、Notion APIは0.25rps以下に制限する。dry/inspect/reconcileとの併用、不正値は通信前に拒否する。省略時は従来どおりAPIとhostedを同じ待機枠で数え、callbackの順序も維持する。

Actionsの `hosted_max_rps` は既定が空欄。指定した正常CLIが成功した場合だけ、既存の継続helperが同じ値を次runへ渡す。実行revision・cutoff・件数・byte/時間・残run上限の引継ぎは従来どおり。入力を持たない既存actorの呼出しは変わらない。旧revisionへ新しいflagを渡したり、稼働中のactorを変更したりしない。

既存通常callerは原本を順次1件ずつ処理し、hosted GETは同時1件。独立枠の待機は送信計数・私有記録のfsyncを待ってから行う。直近送信開始のmonotonic時計から残差だけ待ち、待機後にabortと65秒headroomを再検査する。共有 `downloadArchivedFile` はこのcallbackから同期abort検査を経てfetchへ進み、その間の非同期I/Oはない。共通download helper自体は変更しない。

既存の最大2GET、部分本文を含むbyte計数、元サイズ、ZIP wrapperの一意member、fullSHA、HTTP429停止は維持する。待機中に拒否されたstartも既存callbackの予約計数へ残るため、予約済み試行数を実送信数へ読み替えない。3600秒は新規開始の予算で、開始済み原本を必ずその秒数で切るwall timeoutではない。

## 保存データによる確認

Nixで関連7 suite **253 tests PASS**、継続helperのstdlib Python **3 tests PASS**、`tsc --noEmit`、対象ESLint、`git diff --check`を実施した。追加16件は既定combinedの同値、独立枠のAPI制限、fsync20秒後の次callback259ms→残差741ms、待機中abort/headroom、429単発停止、既存transport再GET、不正入力を検査する。timer/transport入力は明示的なprotocol投影で、本番HTTPの実測ではない。

保存manifest 78,832件（SHA `fccedf9bb6c1548ff3a0b206634fbdbf531acaac63192275cc31720f1db11362`）から、手元に全文がある実3原本275,269Bを固定した。元metadata/docId/取得時計を保持するsubsetを旧f631通常publisherと新通常publisherへ直接渡し、全結果・索引15列・状態/receipt全bytes・event順と、繰返し時PUT/INSERT0を全文一致させた。原本SHAは次のとおり。

- `a0cbcba0a5e0a8cdd5423723a8fcea8422c6106b8d009291cff05e5746f69d7b`
- `56461b48a30a0abc94c39a034fbd2bf9a44397528bd6c745377f600fce39b173`
- `d2de6b3233f56fb0db13541f8e6df18f26953c0c4d222fdc18fe18f12c032888`

さらに保存source metadataが揃うS100Y5S8だけは、同じ共有download helperへ保存全文をtransport投影し、旧/新の全文・byte数・試行1回を一致させた。残2件の取得URLは再構成していない。いずれもremote HTTP/model/業務write0、native200の新観測や現在の⑤metadata資格とは呼ばない。

私有再生は `.runtime/raw-hosted-rate-20261017/source-v1/tmp/raw-hosted-actual-parity-v1/replay.mts`、結果 `result-v3.json` SHA `ae9373b87918464f073b9cd9342da07990ef772deaa381e7f9718ca7817bb080`。入力・旧新source・lockを前後SHA検査する。独立再実行は同WTのNixから `node --import tsx tmp/raw-hosted-actual-parity-v1/replay.mts --out=<未作成の小文字名.json>`。原証跡・元poolは変更しない。

## 性能・運用の限界

保存RAW64のsafe summaryは500件、Notion API10、hosted485、3,255.857秒。hostedが開始数の大半を占めるが、実待機時間の内訳は記録されていない。合算4秒枠の待機上限は条件付きで494間隔×4秒＝1,976秒であり、実待機がこの値だったとは証明しない。1rps化の本番短縮率・完了ETA・4倍速は未実測。

保存⑤添付38URLのhostnameは `prod-files-secure.s3.us-west-2.amazonaws.com`。この38件はRAW64全485URLの再現ではなく、同runのURLは非exportで未観測。Notion APIの公開rate制限をS3/CDNへそのまま適用する根拠も、S3/CDNが無制限という根拠もない。専用hosted1rps/concurrency1を将来の有限運用条件として採用する範囲で、provider429は停止を保つ。

Notion APIについてはMac定時2.63＋RAW API0.25＝2.88rps。hosted独立枠は別の条件であり、実APIを1rpsへ上げてMacと合算3.63rpsにする変更は行わない。既存signedURL・calls・bytes・retriesを増やさず、quota、課金の実残額、処理待機時間は未測定のまま残す。

旧poolの引継ぎでは、rootが次continuationのstep8開始前を観測し、必要な停止後の全terminal/logから原本処理・mutation未開始を確定できた場合だけ、新revisionの単発入口を別releaseする。未開始を確定できなければunknownとして停止し、通常inspectへ戻す。cancel/dispatchを自動化せず、停止したrunも元200上限へ計上する。元origin/cutoff/manifest/state/cursor/ACK unknownは保持する。
