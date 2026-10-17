# 優待holding更新のsearch READ1停止を再資格する通常CLI

#486の本番通常再開は2026-10-17 06:47:49Zに、一次データDBのsearch READ1件（200、436,018B）の後、確認用observerが次のKey照会を送信前に拒否した。Notion保管・D1・source/modelは0で、元startedとzero-native再開intentは保持した。元通常producerの失敗とは扱わない。

原因はobserverが保存scopeのJSON順`version,kind,groups`から物理PREのgzipSHAを作り、通常CLIが共有parser後の`version,groups,kind`から作ったSHAと比較したこと。値・構造は同値でも物理bytesは異なる。保存searchは27結果、`has_more=false/next_cursor=null`であり、pagination原因ではなかった。保存応答を同じ`recordPrimaryData`へ純再生し、次の158B照会と原AssertionErrorの全文String SHAが一致した。元source、native、STOPは変更しない。

通常工具`backfill-public-facts.ts`に明示`resume-upgrade-holding-v1-read-only-stop`だけを追加した。既存zero-nativeの元source/同PRE/全pins/元root資格を再利用し、現在stateは旧2intentだけ、先行試行は7保存file・完全200の同service search READ1件だけ・D1/hosted/source/model0・次のnative未送信であることを確認する。旧2intentを消さず、新`upgrade-v1-read-only-resume-started.json`をwx/fsyncで一度作る。新intentの存在、別dir、追加native、未知応答、原本/clock/pin変更を拒否する。一般unknownや2度目のREAD停止からの自動再開は許可しない。

以降は既存normal archive→全47行CAS→全47行readback→物理POST→completionをそのまま使う。成功completionは旧2intentと新intentのSHAを結ぶ。旧choice・通常apply・zero-native入口の意味、原額/原因/条件/時計/SQL、JSS consumerは変更しない。

## 検証

- Nixの同lock/depsで専用手順22tests、関連旧upgradeを含む37 PASS/2既存private skip、tsc/lintを確認。手順fixtureはHTTP・本番データを模擬証拠に昇格せず、送信0の状態検査にだけ使う。
- 保存actualの97 pins/旧2intentを読み、共有qualifierを直接再生。旧47行expected/SQL・4対象/43他行が完全同値、HTTP/state/data write0。
- private根因proof: `tmp/feature-audit-20261017/yutai-holding4-readonly-stop-investigation-v2/result.json` SHA `63657808a2c6a10711c18e5680ad2c8c23cb9df155c4f8bb3401b5a79e48a88e`。
- private実資格: 専用WT`tmp/read-only-actual-pure-v1/`。元97 pinsと旧47 mapperが同値であることを記録し、本番claimは作成しない。

実再開は新accepted source・根因を直したobserver（同じ共有scope parserを使用）・全経路純検査・root releaseの別受入で行う。旧STOPを成功へ書換えず、物理PRE/POSTと全47行を実readbackするまでは4群採用未完とする。
