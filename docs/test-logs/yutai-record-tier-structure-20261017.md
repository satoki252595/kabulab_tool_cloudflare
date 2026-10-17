# 優待の全文2期間・名簿定義の構造化（2026-10-17）

既存`compileSimpleSummary`が全文で確認しているQUOカードの2期間文法だけを、`parseBenefitRecordTierStructure`へ移した。通常producerとcompilerが同じparserを使い、掲載期間と両円額、継続保有の名簿定義、毎年の発送予定を`public_facts.version=4`へ束縛する。保存5,748群・7,716行で構造が増えるのは1899の1群1行だけ。一般の株数/保有期間tierや併用、本人適用の完成ではない。

`conditionStructure`は原文全文SHA、順序付きの2期間と各掲載額・`相当`/`分`、`registryDefinition.continuousHoldingPeriod`と最低記載/記録回数、発送月・旬・毎年・予定を持つ。名簿への記載または記録を、同じ名義・同一株主番号・連続回数や本人の権利取得回数へ変換しない。原文の贈呈月は発送予定だけで、recipientの権利月12・基準日NULLを変更しない。

掲載額は評価額でも合計額でもない。`qualifiedAmount=NULL`・`ambiguous_condition_tiers`、`applicability=unverified`、既存の公式未照合・受信時計を維持する。株数・追加条件・不明注記を部分抽出しない。未対応入力は従来のv2未解析へ残り、既存v1〜v3は同値で再読する。v3の単一期間やv2の1点選択へ2期間を詰め替えない。

## 通常の呼出経路

| 呼出 | 今回の処理と保持する境界 |
|---|---|
| `fetch-yutai-full.ts` → `yutai-full-import.ts` → `buildPublicBenefitFacts` | 既存の原本保存・全量原子取込で共通parserを使う。source/recipient・金額guardは不変。 |
| `backfill-public-facts.ts` → `buildPublicBenefitFacts` | 既定NULL-only、明示v1→v2/v3の有限scope・物理PRE/POST・CASは不変。同じhelperへv1→v4の明示1群/1行/1銘柄modeだけを接続する。 |
| `summary-local.ts` → `compileSimpleSummary` | 既存全文matcherを共通parserへ移動。全5,748群の要約・評価額・選定・import契約は同値。 |
| SSR `renderBenefitFacts` → shared strict DTO | 両期間・掲載額・名簿定義・発送予定と未確認範囲を表示し、初心者向け説明を併設する。`minShares`の既存群分けや金額合算を変更しない。 |
| private JSS `/v1/yutai/:code` → shared strict DTO | v4を再読する。原文はSELECT/返却せず、`can_aggregate=false`・`personal-only`を維持。public経路は変更しない。 |

新DDL・列・依存・source/Notion要求・モデル実行は0。現稼働Mac4a/E4、future runtime、既存journal・private input pinsは変更しない。v4 consumer配備後の既存1行の有限採用と通常定時の受入は別途必要で、コード配備だけでデータ採用済みとしない。

## 保存原本の比較

| 固定入力 | SHA-256 |
|---|---|
| 保存5,748群`all-groups.private.json` | `cf75176596e3515ff264c8541189934388ea374f92dfdd33d3d01f04d2e91f38` |
| 保存7,716行`yutai-public-facts-backfill/readback.json` | `82317d87aedf4877a1a6b16fb899832fc395223e85523d45123a5207a70f8dfb` |
| 実1899の掲載全文（group `b461d16329ef774b` / row `49050`） | `1d0b318a45b5c967ac66e2db3c793b6da54c1b9cd9264a71daf924478993bbdc` |
| 元実1群private fixture | `7e016b4df744f49840b7cc0bc9554792ded4e6c2ff0483c94b36466b62304c05` |

正本原文はprivateのみ。Git fixtureは旧DTO・期待AST・元SHAの投影で、原文を含めない。CIはこの投影でstrict DTO/SSR/JSSを検証し、全文のprivate入力が無い3試験は明示skipする。ローカルでは元原文への参照だけを置き、3つの全文回帰をskipせず実行した。

独立saved replayは全5,748群の正常compiler出力47件と金額・理由を同値比較し、全7,716行で旧値・時計・公式状態を保持する。実1899の1行だけv2未解析→v4掲載構造となり、他7,715行の正常DTOは全値同値。元v1全7,716行および変更前producerのv2/v3全行は新strict parserで同値に再読する。原文・全入力列は前後SHA同一、socket/fetchは禁止して追加通信・モデル・業務書込0を確認した。

再生script/resultはproject rootのprivate `tmp/feature-audit-20261017/yutai-record-tier-v4-proof-v1/`へ保存する。出力先を別名にすればrootが同入力で独立再生できる。

```sh
nix develop --offline --command env -u NODE_PATH node --import tsx \
  tmp/feature-audit-20261017/yutai-record-tier-v4-proof-v1/replay.mts \
  "$PWD/tmp/feature-audit-20261017/yutai-record-tier-v4-proof-v1/root-result.json"
```

通常優待28suite648 PASS、既存private原文不在7件は明示skip。JSS standalone12suite187 PASS・既存10skip、root/standalone TypeScriptと変更TSのESLintもPASS。不完全・逆順・異なる閾値・定義先の不一致・未知条件・非円/異なる表記をHOLDし、DTOの単一評価額への昇格・未知キー・不正回数・不正発送月も拒否する。初回の既存SSR試験は説明文の旧全文期待で失敗し、対応済み以外の複数期間が未解析と明示した後に全suiteを再実行してPASSした。standalone型検査のfixture配列undefinedは明示guardを追加して再検証PASS。新CLIのunknown試験は隔離envの`tmp`親が未作成だったためnative前に失敗し、project環境と同じ親を試験側へ用意して全28suiteを再実行PASSした。

全群producerの交互5回中央値は205.667ms→209.109ms、全比較process peak RSS 323,829,760B。結果`agent-result-v3.json` SHAは`3c28a1bd122d31678b12bb7e1847af951c581e17461a3118b56e1d9967c27556`、再生script SHAは`591f7d1862c5489cefdf9273571caee3e9f8ec1278b518f77e012ecbf782ba7c`。同じhostの並行処理影響は分離していない。CPU・RSSはNodeのローカル純処理だけで、本番Worker/定時の所要や完走・モデル削減の実績を保証しない。

## 明示した既存1行の通常移行

`prepare-upgrade-record-tier-v1` / `apply-upgrade-record-tier-v1`を既存`upgradeV1Main`へ接続する。`kind=holding-record-tiers-v1`・target4・1群/1行/1銘柄に限り、既存`planV1StructureUpgrade`の全列・全code行数・元JSONのCASと同じ3SQLを使う。旧v1の全値・原文SHA・全recipientの現在一致が必要。変えるのはversion/conditionStructureだけで、他列・元source時計・公式状態を保持する。

stateはcanonical `.env`実体の親配下`tmp/yutai-public-facts-v1-record-tier-upgrade`に固定する。旧choice/holdingのstateやunknownを削除・更新・流用しない。開始をwx/fsync保全し、通常`recordPrimaryData` / `verifyArchivedAttachments`の物理PRE、1batch送信、fullPOST、物理POST後だけcompletionを保存する。別outputや別PREからの再送も開始済みstateで拒否する。新modeにunknown再開入口は追加しない。

全量`importYutaiFull`は95%coverageと対象行の再建・利回り追随を伴うため、1行のmetadata保守に使わない。通常CLIにも`revalue-saved`という既存modeはない。今回の明示保守は既定NULL-onlyを装わず、元の有限choice/holdingと同じ正常helperを使う。新DB列・並行publisher・全7,716行の転送は追加しない。

保存の実1899を同helper/SQLiteへ通し、v4以外全値同一・12列の競合rollback・同SQLの再送拒否を確認した。旧実choice23行/19更新とholding47行/4更新のexpected/SQLは旧版・元保存計画と完全同値。結果`upgrade-result-v2.json` SHAは`d652b2c2875004bcbf0672b037b1cecb0495ed2adb307b299620ffe1aaf33555`。最初のscratch再生はSQLiteのnull prototypeとplain objectの比較だけでSTOPし、元script/STOPを保全して全列射影を明示した後にPASSした（production I/O 0）。通常CLIのprepare→apply→物理2回→completionとD1結果不明→再送拒否は、明示したstructural adapterで実行経路を確認した。実HTTP/物理アップロード成功の主張ではない。

v4 consumerの実配備、fresh1899全行PREと現在の原文/旧v1資格、独立root releaseと通信枠を確認するまでLIVE0。保存時点の1行を現在値と呼ばず、fresh入力が変われば通常CAS/HOLDで止める。
