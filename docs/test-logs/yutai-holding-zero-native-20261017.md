# 優待holding添付名と送信前停止の再資格（2026-10-17）

実4群のv1→v3採用は、通常CLIがcanonical開始記録を保存した後、Notion添付名の共通検査で停止した。`yutai-v1-holding-upgrade-pre-<完全SHA>.json.gz` は101文字、POST名は102文字で、既存`toNotionUpload`の100文字上限を超えた。通常`recordPrimaryData`の最初のawaitより前の失敗である。

元の実行は`attempt-once.json`と`STOP.json`だけを残し、seq/Notion/hosted/D1 read/D1 batchは全0。原started・原STOP・47行PRE・実行source・元releaseを保持した。現在の業務適用4行や物理PRE/POSTの完了を主張しない。

## 通常工具の変更

holdingの添付名だけを`yutai-holding-v1-{pre|post}-<完全SHA>.json.gz`へ短くした。冪等Keyは旧`yutai-v1-holding-upgrade-…`のまま。本文、gzipの原内容、旧額、理由、原時計、全47行CAS/SQLは変更しない。旧choiceの添付名・Key・計画も同一である。

PRE/POST両phase名を共通`toNotionUpload`でclaim前に検査する。今後の名前検査失敗で新たな開始記録を残さない。upgrade失敗は、既存private出力先へ原因・stack・causeを保存し、公開ログには原文を出さない。

明示`resume-upgrade-holding-v1-zero-native`だけが、次の全条件を通常入口で検査する。通常prepare/applyやchoiceでは既存latchを引き続き拒否する。

- 同じcanonical `.env`配下の実体stateに、元`upgrade-v1-started.json`だけがある。元SHA、同じ計画dir、source/scope/PRE/expected/SQL/manifest、元root PRE資格・release・observerと元producer/input全pinsが一致する。
- 元attempt実体directoryが所有者限定で、保存物が`attempt-once.json`と`STOP.json`の2個だけ。seqと全IOが0、原時計の順序が正しく、全owned processの終端が明示されている。
- native/partial、archive/apply/readback進捗、非0送信、不明進捗、異なるdir、入力差を認めない。新PREや別出力で未閉鎖unknownを迂回しない。

再資格後は元startedを削除・上書きせず、同stateへ`upgrade-v1-zero-native-resume-started.json`をwx/fsyncで一度だけ追加する。以後は同じ通常archive→単発atomic sender→全47行readback→物理POSTを使う。成功記録は元startedと新sidecar両方のSHAへ結ぶ。再停止時も再自動送信しない。これは一般のunknown解除や既送信の再送許可ではない。

```sh
nix develop --offline -c env -u NODE_PATH node --env-file=.env --import tsx \
  services/otakara-yutai/data-scripts/backfill-public-facts.ts \
  resume-upgrade-holding-v1-zero-native \
  /private/source.json /private/same-plan /private/scope.json /private/zero-native-qualification.json
```

原stateと全証跡を保持するローカル運用が条件。source/inputの現在資格と別のroot releaseなしに、このコマンドを実行しない。新LLM、source API、依存、DDLは追加しない。

## 検証と証拠

元の保存PREと同一gzipを旧通常archiveへ純再生し、HTTP0で101文字拒否を再現した。元のroot state/STOPは不変。

新通常qualifierを実root旧stateへread-onlyで通した。45個の元input pins、実47行/4群の旧新計画・expected・SQL全値一致、旧choice実23行の全plan fields同値を確認した。新sidecarは作成していない。保存証拠はprivateであり、原文はGitへ加えていない。

- 元失敗再現: `tmp/feature-audit-20261017/yutai-holding4-zero-native-investigation-v1/result.json` SHA `3bf48250f236cb81c649c9a83735e33d9aa2f4e1e7afc40393fa3af525992b67`。
- 当PR worktreeの`tmp/zero-native-actual-pure-v2/`に、実旧入力の再資格・旧新全計画比較と全SHAを保存した。原canonical stateへの書込、HTTP、model、業務書込は0。result SHA `9138b4ad104208bd96fd33e9dce03ccc8ccd04d0c995bfb4bec7a3cd6b142eb0`。
- 通常CLIの専用modeも隔離された手順fixtureで再生し、同計画の一度sidecar後のエラーがprivateへ残ること、元startedの不変と再entry拒否を確認した。このfixtureを実HTTPや実業務適用の受入とは呼ばない。
- native>0、追加native保存物、新dir、pin差、manifest差、pin欠落、未終端はsidecar/HTTP前に拒否する。

旧620CAS負例の実47行PREと今回fresh PREは全文SHAが一致している。今回の添付名修正で財務値・本人適用・条件資格を変更していない。曖昧条件は未解析、認証付き実v3応答と実4群適用の受入は別途とする。

関連5 suitesは43 PASS・既存private skip6、新回帰10件は全PASS。`tsc --noEmit`・対象eslint・diff checkもPASS。新たな通信は追加せず、通常の正常処理では添付名検査2回だけ。再資格の全pins読取は明示ローカル再開時だけであり、通常の一度latchを緩めない。
