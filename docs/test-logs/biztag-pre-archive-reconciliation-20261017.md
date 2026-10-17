# 補足publisherのPRE保管結果不明を限定照合する

2026-10-17。通常Mac/Node publisherのphysical PREページPOSTで応答が欠測し、元intentが全runを停止した。業務PATCHを再送せず、PRE保管だけの結果不明を明示した1社に限り、通常CLIと共通publisherで照合・再開する入口を追加する。実データ適用はこのPRの検証に含めない。

## 正常入口と資格

`pnpm biztag run --mechanical-only --codes=<固定1コード> --limit=1 --budget-min=<15以下> --reconcile-pre-archive=<私有proof.json> --reconcile-proof-sha256=<全SHA>`。dry-run、receipt refresh、複数コード、暗黙budgetは不可。通常のaccepted revision、canonical `.env`実体、kernel writer lockを維持する。照合に使った時間もrunの新規着手budgetから控除する。全通信のhard stop・native request/response bytes上限は、既存の有限stageで別に制御する。

proofはversion1、stockCode、journalKey、intentSha256、preSha256、archivePageId、sourcePageのpath/SHA、全native counterのintent/request/response/responseMetadata各path/SHAを持つ。元capture全counter・全ファイルSHA・200応答・時計を確認し、元intent以降が通常single-part PREの「Key不存在query→upload作成→全multipart送信/ACK→PREページPOST応答欠測」の4 nativeだけであることを要求する。元intent以降の業務PATCH/根拠操作、途中欠測、別multipart、既知ページPOST、semantic根拠変更は資格を与えない。proofはoperatorが全SHAで固定する捕捉baselineであり、失われた歴史的送信を生成・証明するものではない。

原intent/PREは変更しない。別canonical `supplement-pre-archive-reconciliations/<元key>/` にwx・0600・file/directory fsyncのonce intentを、最初の照合HTTPより前に保存する。Key一意1件、元POSTの主体/全metadata/manifest/時計、同じ338,657 byteのような全physical PRE、実source metadata/clockの同値を読取り、`pre_archive_reconciled` phaseを別記録する。0件・重複・差異・unknownでは元pendingを保持し、同じkeyを別outputから再試行しない。

通常plannerのcode/doc/source pointerをproofへ束縛し、元full snapshot・key・次文書が完全同値のreserveだけを1回消費する。PREは再upload・page POSTしない。共通publisherが再度Key/metadata/physical PREを読取り、target full PRE/根拠、通常D1最新doc/pointer、source metadata/clockを業務PATCH直前に照合する。通常single-attempt PATCHと全読戻し、全保持列/根拠同値の後だけ、元schemaの`completed.json`を追加する。業務結果不明への一般的な例外許可やcompletion自動生成はない。

## 互換と検証範囲

元`supplement-publications/<key>/`は`pre.json`・`intent.json`・`completed.json`の3ファイル/schemaを維持する。sidecarを4つ目として混ぜないため、凍結した旧E4 factoryでも正常完了後にassertReadyできる。無指定の定期処理は従来どおり未閉鎖intentをmetadata/model/HTTP前に拒否する。通常無指定callerの追加HTTPは0。新provider・モデル・依存・DDLは0。

CIは既存の実4502 source fixtureで、正常2 PATCHのPRE再利用、partial PATCH unknown、別PRE、source/pointer変更、semantic操作、不完全capture、別upload、Key0/重複、physical差異を構造的Notion/FS応答で確認する。fixtureの値は保存原本、Notion応答は明示したprotocol投影であり、本番の更新成功とは区別する。

私有実保存再生はG18の462 intent/461応答と、別の96 native読取から5695のtarget/source/archive/fullPREを使用する。共通proof validator・physical verifier・同入力publisherをscratch stateへ渡し、1 simulated PATCH、元3files閉鎖、凍結E4 factory互換を別processで確認する。元全証跡・canonical journal・環境bytesの変更、HTTP、モデル、取得元、業務書込は0。この正常経路試験はknown18/19 D1を含む全96 native受入監査の代用ではない。

今回復旧の実行は、凍結E4の既存preflight/lockと新accepted helper/runBiztagを使う有限wrapperへ、両ソース・入力・releaseの全SHAを束縛して行う。Mac E4/環境/保存済み104 modelは切替えない。定時runtimeの更新はG/104終端後の別受入となる。任意unknown businessのread-only判定・汎用再開CLI、手動dedupの旧update経路は今回の対象外。
