# 優待v1→v3掲載期間の明示採用（2026-10-17）

[#482の共有全文parser](yutai-single-holding-period-20261017.md)で読める実4群を、通常の `backfill-public-facts.ts` から採用する明示modeを追加した。既存v1→v2の選択肢15群と混在させず、既存の全列CAS・物理PRE/POST・一度だけのcanonical latchを再利用する。新writer・registry・parser・DDL・依存・source API・モデルは追加しない。

## 範囲と通常CLI

新modeは `prepare-upgrade-holding-v1` / `apply-upgrade-holding-v1`。scopeは `version: 1` と `kind: single-holding-period-v1` を必須にし、code・group ID・正規化前原文全文SHA・全recipientを固定する。最大2銘柄・4群・4更新行。manifest・物理保管metadata・開始/完了markerにもkindとtargetVersion3を束縛する。旧choice scopeには新kindを渡せず、holding modeへchoice文法を渡しても送信前に止まる。

同じ共通producerへ保存原文・全recipient・旧source時計/公式情報を渡し、全文期間構造が正資格で、旧v1の全fieldsが同値の場合だけversionとconditionStructureを変更する。NULL/v2/v3/未知DTO・意味差・別全文・部分recipient・重複は停止する。旧額1,000/2,000/3,000円、理由、個別時計NULL、公式未確認を保持し、券枚数を価格へ変換しない。本人・株数tier・同株主番号・記録回数・併用は未確認のまま。

2銘柄の全PREを正常active/equity readerで読む。100行を越えれば切り捨てず停止する。実47行のcompact PREは69,347Bなので、**holding modeだけPRE128,000Bまで**扱う。target JSONは64,000Bのまま。旧choice modeのPRE/target64,000B・上限15群19行3銘柄・SQL・shape・stateは維持する。各JSON上限は総HTTP bodyの上限ではない。

```sh
# fresh source/全47行PREとroot releaseを取得してからのみ。source/scope/outputはprivate。
nix develop --offline -c env -u NODE_PATH node --env-file=.env --import tsx \
  services/otakara-yutai/data-scripts/backfill-public-facts.ts \
  prepare-upgrade-holding-v1 <fresh-source.json> <private-output> <holding-scope.json>
nix develop --offline -c env -u NODE_PATH node --env-file=.env --import tsx \
  services/otakara-yutai/data-scripts/backfill-public-facts.ts \
  apply-upgrade-holding-v1 <fresh-source.json> <private-output> <holding-scope.json>
```

## 変更前保全と結果不明

canonical `.env` のrealpath親配下 `tmp/yutai-public-facts-v1-holding-upgrade` が新modeの一意なstate。旧choiceの `tmp/yutai-public-facts-v1-upgrade` は変更・解除しない。最初の物理PRE保管より前に開始markerをwx/0600/file fsync＋parent fsyncで保存する。別out・別PREでもこのmodeの既存markerを迂回できず、完了後も自動再送しない。modeからstateを固定し、state引数や自動リセットは追加しない。別実体.envで別stateを作る運用は禁止し、root releaseがcanonical実体・pins・所有writerを確認する。

全scoped行の全列・株式主体・件数を一つのatomic batchでCASする。変更は4行のpublic_factsだけで、対象外43行の差も全batchをrollbackする。fullPOSTと物理POSTの原本SHA読戻しが成功してから完了markerを作る。途中unknownは元marker/原本/応答を保持し、D1・upload・POSTを再送しない。

## 保存実データによる純検証

入力は過去のaccepted D1全7,716行readback（SHA `82317d87aedf4877a1a6b16fb899832fc395223e85523d45123a5207a70f8dfb`）。現在の本番PREではない。2282の7行と9048の40行を全文で再利用した。原文はprivateのままで、Gitへ追加していない。

専用WT `.runtime/yutai-v1-holding-upgrade/source-v1/tmp/holding-upgrade-pure-v1/` の証跡:

| ファイル | SHA-256 |
|---|---|
| `actual-scoped.private.json`（全47行） | `f0979385aed0a710d54ce39dc7f274635f218d6233a4b7c26c1b6801711deffa` |
| `scope.json`（4群） | `10875c8a12e6ab84721881ba0a17b18e0109ccb18b41a5d3ed0b811f1348cbc5` |
| `audit.mts` | `9a93d5575068a395d26a5f7ad4d6769c4099b3ab170cfcca95b7e5300ad43f73` |
| `result.json` | `ba2ab3ed44d6ffa9b77d31a204a15db5a884b0f32c94fbbb744486cf31c3ebb6` |

Nix関連3 suites 29 PASS（原文private fixture不在2件skip）、TypeScript/対象lint PASS。実47行と旧choice実23行のlocal回帰はskipせずPASSした。正常planner→SQLiteで4群4行だけv3へ更新、他43行・旧額/理由/全clock・全他列を保持。47行×12列、2主体×4列、47行の欠落、追加1行の計620CAS負例は全rollback。同じSQLの再送も拒否。旧choice実23行では、accepted3821の旧toolと新toolのexpected・3SQL/params・全plan fieldsが完全同値。旧NULL-only planner本文もbyte一致。

保存標本は3SQL/HTTP batch JSON87,951B、単回正常SQLite実行0.676ms・全audit0.644秒。物理payloadのgzipはPRE6,813B/POST7,152Bで、過去の保存時計を使ったsize rehearsalのみ。本番wire bytes・fresh PRE・本番性能保証とは呼ばない。追加HTTP/source API/model/production writeは0。

```sh
nix develop --offline -c env -u NODE_PATH node --import tsx \
  tmp/holding-upgrade-pure-v1/audit.mts tmp/holding-upgrade-pure-v1/root-replay.json
nix develop --offline -c env -u NODE_PATH node node_modules/vitest/vitest.mjs run \
  services/otakara-yutai/src/tests/public-facts-v1-upgrade.test.ts \
  services/otakara-yutai/src/tests/backfill-public-facts.test.ts \
  services/otakara-yutai/src/tests/benefit-holding-structure.test.ts
```

## 配備と残件

private JSS v3 consumerのroot配備受入は `tmp/feature-audit-20261017/jss-holding-v3-consumer-deploy-v1/root-final-acceptance.json`（SHA `a7efcdb3a4585e8d1ebb13799304b199f4ac6218a41e092f32647808965a43b2`）。既存6bindings/runtimeを保持し、health200・未認証401とstrict v1/v2/v3コードを確認したもの。認証付きの実v3 payloadは未確認で、新4行の適用もまだ0。本CLIのfresh PRE・root release・単発送信・fullPOST/物理2ファイルの実受入が別途必要。

保有表記2,852群の曖昧な残件、株数tier/同株主番号/名簿記録回数/併用は本modeで埋めない。全条件や全20機能の完了とは扱わない。
