# 優待の単一掲載期間を全文で対応させる（2026-10-17）

保存5,748群・7,716行を調べ、掲載期間と特典の対応を全文で限定できた4群を通常の共有parserへ追加した。2282のクーポン3群と9048の入場券1群だけ。本人の保有実績、株数段階、同株主番号・名簿記録回数、複数期間、併用は資格化していない。曖昧な残件を成功やゼロへ変えない。

## 通常経路と保存契約

- `holding-structure.ts` は見出しと本文の2文法を全文照合する純関数。余分な注記・行・期間・株数段階があれば未対応とする。保存前の原文SHAを保持し、追加HTTP・モデル・依存・DDLはない。
- 通常取込の `buildPublicBenefitFacts` と通常Mac定期要約の `compileSimpleSummary` が同じ関数を使う。既存の金額判定と原子取込を通し、有効要約のskipや要約契約版を変えない。
- 対応4群だけDTO v3の `single-holding-period-v1` を使い、掲載期間と円相当額または入場券枚数を持つ。`applicability: unverified` とし、原文・施設名を公開DTOへ入れない。v1/v2の再読は維持する。
- 旧資格済み掲載額1,000/2,000/3,000円と理由を保持する。入場券枚数から円評価せずNULLを保持する。掲載時計、公式未確認、旧条件・株数・権利月は変更しない。
- SSRとprivate JSSは同じstrict DTO readerを使う。**private JSS consumerのv3配備を確認してからv3実データを採用する。** 本PRで旧行を更新せず、限定v1→v2選択構造更新modeも変更しない。

## 保存原本と純検証

原文は外部掲載文のためGitへ含めない。コミットするfixtureは実4群のcode・全文SHA・旧public facts・期間/円額/枚数AST・株数/月の投影のみ。CIの文法境界用入力は実制度のデータと扱わない。実全文のproducer/parser/compiler/import回帰は下記private fixtureで実行した。

| 入力・証跡 | SHA-256 |
|---|---|
| `tmp/feature-audit-20261013/yutai-condition-tools-20261017-v1/all-groups.private.json`（5,748群） | `cf75176596e3515ff264c8541189934388ea374f92dfdd33d3d01f04d2e91f38` |
| `tmp/feature-audit-20261013/yutai-public-facts-backfill/readback.json`（7,716行の旧v1全列） | `82317d87aedf4877a1a6b16fb899832fc395223e85523d45123a5207a70f8dfb` |
| owned WT `tmp/yutai-holding-audit-v1/saved4.private.json` | `c266539cfc5e45d168c93edbb8f5352b2b422503f83ac6c1c193d804475b785a` |
| 同 `baseline-v2.json` | `3cd30b1122f7fc884f563abbaf0f4d395e29dbc3a87a25b30522a64a28275141` |
| 同 `after-v3.json` | `ecd653ef6eed784ee65753b5d8591b454ee9211d535b7dce19d3013b7a742996` |
| 同 `paired-comparison-v1.json` | `069a93c1ac56a5e43316a2f29e2487ca98e3cd46fda80d03a8092c3eeed99aad` |

全5,748群の旧金額・理由・source時計・条件は同値。既存定型42群の出力も全同値で、追加4群だけ46群になる。同じ保存入力とNix/lockの単回測定は0.379807秒→0.379835秒、peak RSS 259,728→259,680KiB。計測揺らぎを含み性能保証ではない。追加source/API/モデル/業務書込みは0。

検証はNixで関連6 suites 101 PASS（既存private fixture不在4件skip）、root TypeScript/lint PASS。実4全文のlocal回帰2件はskipせずPASSした。JSS standalone private 15 tests PASS（v3実4投影を含む）。

```sh
nix develop --offline -c env -u NODE_PATH node node_modules/vitest/vitest.mjs run \
  services/otakara-yutai/src/tests/benefit-holding-structure.test.ts \
  services/otakara-yutai/src/tests/benefit-choice-structure.test.ts \
  services/otakara-yutai/src/tests/public-facts.test.ts \
  services/otakara-yutai/src/tests/summary-local.test.ts \
  services/otakara-yutai/src/tests/public-facts-v1-upgrade.test.ts \
  services/otakara-yutai/src/tests/yutai-full-import.test.ts
# standalone JSSの既存lock/依存を使用、services/jss-api cwd:
nix develop --offline -c env -u NODE_PATH node node_modules/vitest/vitest.mjs run test/private.test.ts
```

## 残件

掲載中の保有表記2,852群に対し、上記4群以外は新文法で資格化しない。株数tier・名簿記録回数・同株主番号・加算特典の対応や併用対象を、部分語抽出から組み立てる処理は追加していない。本人の適用確認と公式照合、既存データへの実採用、正常定期runの受入も別の未完項目として保持する。
