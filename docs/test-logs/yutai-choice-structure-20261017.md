# 優待の全文1点選択構造・決定的要約（2026-10-17）

## 変更範囲と通常経路

新しい純関数 `parseBenefitChoiceStructure` を通常月次取込の `buildPublicBenefitFacts` と、Mac定期 `runLocalSummary` の既存定型compilerへ共用する。新しい依存、表、列、API、source取得やNotion要求を追加しない。既存原本・更新前全行の物理保管、原子取込、全POST、入力変化・値・条件の共有guardは維持する。

対応する表見出しと、本文全体が `◆以下より1点を選択`＋2～8件の連続番号一覧である場合だけ資格化する。各行は対応済み商品ラベル、正の安全整数の円額、`相当`/`分` で全文一致する必要がある。見出しの両商品は本文一覧に存在し、明示的な「等」がない場合は2選択肢・2商品と一致する必要がある。範囲・不正桁区切り・番号欠け/重複・非円単位・未知ラベル・追加注記・不明見出しは未解析。保有期間・抽選・申込・併用があれば、この構造では資格化しない。NFKCと前後空白だけを表記正規化し、原文は変更せず全文SHAへ束縛する。

`public_facts` の新producerはversion2。`conditionStructure` は `literal_parsed`＋`ast: {take:1,options:[{ordinal,listedYen,notation}]}`、または `unparsed`＋`ast:null`＋理由。両方に文法ruleと原文全文SHAを残す。商品ラベルや掲載原文はDTOへ入れない。旧version1は同じstrict readerで変更せず読める。掲載選択肢の円額は評価額・最大額・合計額ではなく、選択群の `qualifiedAmount`/`estimatedValue` はNULLを保持する。

SSRは解析済み選択肢数と選ぶ点数だけを用語ヘルプ付きで表示する。内部JSS RESTも同じstrict unionを読み、`can_aggregate:false`、personal-only、公開Worker404を維持する。保有期間別・併用の構造解析は今回未対応であり、既存mention検出を適用条件確定へ昇格させない。

定型compilerは対応全文を「優待を1点選択」へ変換し、金額NULLで既存 `planSummaryImport` を通す。生成識別子は `simple-face-value-and-one-of-v2`。公開要約契約の版・受入規則は変更しない。有効な既存要約のskipを維持する。

## 保存原本による全5,748群の検証

保存D1 preimageは7,716行、5,748群。2026-10-13保存断面であり、現在本番の残数ではない。

- preimage全文SHA: `7ff595f9fdac5c32c8c14d0fed0f5b41d8d7d61e7059209baf367aeca9c01d18`
- 既存全群解析SHA: `cf75176596e3515ff264c8541189934388ea374f92dfdd33d3d01f04d2e91f38`
- 対応実源: 3148の3群3行、7585の4群8行、8278の8群8行、計15群19行。
- 旧定型27群の全結果同値、新定型は42群。追加15群は全て金額NULL、その他のcompiler結果は不変。
- 5,748群の既存額判定・保有/選択/抽選/応募mention・併用表記・金額理由は全て同値。
- 選択一覧prefix115群のうち、未対応の注記・品目等がある100群は未解析のまま。保有期間構造と併用構造の解析は0件。
- 新旧42件の正常取込拒否0、採用後の正常planner skip42件を純再生。原文にない選択肢数を要約へ加えず、明記された1点だけを使う。

実原文はprivate保存のみ。Gitの `choice-list-saved15.json` は元SHA・実コード・受取条件・期待ASTだけの投影で、商品ラベルやdescriptionを複製しない。実保存入力があるローカル試験は正常producer/parser/importを全15群へ通す。CIの文法変異入力は合成境界試験と明記し、実制度や本番出力と混ぜない。

全群純監査は専用worktreeの `tmp/choice-grammar-proof-v1/replay.mts` で再現できる（出力は新しい私有パスのみ）。`fetch` を拒否し、モデル・sourceAPI・業務書込0。既存入力proof/STOPは変更しない。

```sh
nix develop --offline --command pnpm exec tsx tmp/choice-grammar-proof-v1/replay.mts tmp/choice-grammar-proof-v1/root-replay.json
```

## 費用・未受入範囲

同保存5,748群のparserのみ3回計測は24.94/19.51/18.18ms（中央値19.51ms）。追加JSON propertyは群単位1,102,832B、7,716行へ付す場合1,479,964B。HTTP transport・既存原本保管・額判定・SQL・描画を含まないローカル測定であり、本番処理時間や完走を保証しない。未要約で文法が適合する群はモデル0で処理できる。有効な既存要約を再生成してモデル回数を減らした実績とは呼ばない。

既存v1行の全件書換や本番データ補完は行っていない。通常月次full-importは新v2を生成するが、既存metadata backfillはNULL行限定のまま。保有期間tier・併用・抽選・公式資格等の全条件が構造化済みとはしない。実本番の新v2・次Mac定時の受入は別途必要。

検証: Nix/Node22、7 suites175 PASS＋既存private入力欠測2 skip、standalone JSS3 suites25 PASS、両プロジェクトtypecheck・対象lint・diff check PASS。実15群のprivate回帰は実行済み。全群最終純proof `replay-v4.json` SHA `8ba5129b81ba608dfbbae5299510b5121f8dd7b19f6a91593d7293fdbd8eb8ef`、replay script SHA `fcbde0fb72b89658122e7f572c0ab425cdf8008759e9f25947d86b390af50ba7`。計測 `measure-v2.json` とscriptも同私有namespaceに保持する。これらは正常toolの保存入力照合で、本番データ適用・次定時受入ではない。
