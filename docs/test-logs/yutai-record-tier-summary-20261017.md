# 優待の2期間と名簿回数を全文対応する定型要約（2026-10-17）

通常Mac定期の`compileSimpleSummary`に、QUOカードの2期間・各掲載額と名簿記録回数を保持する1文法だけを追加した。保存5,748群・7,716行で新たに一致したのは1899の1群1行だけ。本人の資格判定や期間別の検索、全優待条件の構造化を完了した変更ではない。本番適用・次21時定期の受入は未実施。

現在稼働するMac固定リビジョン4a66929cには、この新文法は含まれない。Workerの配信だけでMac定期へ反映済みとはしない。通常20時/21時の受入を優先し、Mac runtimeの切替・新文法の定時受入は別のreleaseで行う。

原文の会社名・コード・SHAによる固定出力ではなく、対応するQUOカード見出しと本文全体から、未満/以上の年閾値・両額面・円表記・名簿回数・贈呈月をcaptureする。2期間と定義の年閾値が等しく、正の安全整数、妥当な月、60字以内の要約、既存の`ambiguous_condition_tiers`判定である場合だけ、両期間・両額面・明記された継続と名簿回数を出す。余分な注記・株数条件・併用・名義・別期間・回数定義は全文不一致で定型化しない。未記載の「同一名義」や「連続3回」を加えず、贈呈月を権利月・基準日へ変換しない。

評価額はNULLのままで、最大額・平均・合算・年換算をしない。掲載額と名簿条件の関係を要約へ残すが、`publicFacts`の期間tier構造は未解析のまま。通常の要約契約、金額guard、原子取込、物理PRE/POSTを使い、有効な既存要約を再生成する選定変更はない。定型処理の識別子だけ`simple-face-value-one-of-holding-and-record-tier-v4`に更新する。

既存の選択19行＋単一保有期間4行の構造を使い回して2期間を保存することはできない。`public-facts.ts`のv3 ASTは単一期間1特典だけで、`holdingPeriods`は期間表記の集合。SSRの`tiers`はD1の`minShares`による群分けで、期間・名簿回数・額面の対応を持たない。既存の選択ASTへ詰めると「1点選択」へ意味が変わる。今回は新DTO・DDLを追加せず、この構造化・tierfilter・本人適用・公式照合の残件を保持する。

## 保存原本による比較

元原文はprivateのみ。Gitの`record-tier-saved1.json`には原文SHA・実コード・recipient・期待要約・NULL理由だけを保存し、掲載原文を複製しない。

| 入力・証跡 | SHA-256 |
|---|---|
| 保存5,748群`all-groups.private.json` | `cf75176596e3515ff264c8541189934388ea374f92dfdd33d3d01f04d2e91f38` |
| 保存7,716行`yutai-public-facts-backfill/readback.json` | `82317d87aedf4877a1a6b16fb899832fc395223e85523d45123a5207a70f8dfb` |
| 実1899の掲載全文 | `1d0b318a45b5c967ac66e2db3c793b6da54c1b9cd9264a71daf924478993bbdc` |
| 専用WT `tmp/yutai-record-tier-proof-v1/paired-result-v3.json` | `0ed2b43c8c5e31a3feeb87f54f0ee0c0f34504d68b915da6df8ffb1c9569788d` |
| 同`paired.mts` | `329ecd4b7b725f41c9d8852c6e27eee6e2556af0c809addb76b08eba819f9903` |

base54097の通常compilerと変更後を同じ保存入力で比較し、定型46群→47群、旧46の全結果同値、新規1群の通常取込planner拒否0を確認した。全群の厳密金額・理由、全7,716行の通常producer DTO・掲載時計・全入力列は同値。正常DTO出力の共通SHAは`76524321bc469310f2b7132ed5edb77676734c7af23cbe03ec1bca0ffc7c469b`。実1899の評価額は元のNULL、権利月12・基準日NULL・掲載の贈呈時期は保持する。比較用の全群retaskは純検証だけで、本番の全件再生成や修復件数ではない。

同じNix/lockでcompiler全5,748群を交互順に7回計測し、中央値29.482ms→30.457ms、差+0.975ms。全比較processのpeak RSSは302,612,480B。既存モデル・原子取込・HTTP・描画を含まないローカル測定であり、本番のCPU・完走やモデル削減実績を保証しない。追加source/API・Notion・モデル・業務書込・依存は0。

Nixで関連7suite170 PASS、既存private原文不在5件は明示skip。新しい実1899全文の回帰は、原文を保存したローカルprivate入力でskipせずPASSした。CIにはこのprivatePathが無いため、実全文の1件は`skipIf`で明示skipし、原文をGitへ追加しない。残る新5件の文法境界試験はCIで常時実行する。期間の不一致、未知名義/併用、別tier、曖昧・不正桁・非円、回数/年/月の不正、同額・安全整数超過・60字超を拒否する。root TypeScript・変更TSのESLintもPASS。最初の既存試験は旧定型識別子の期待値で1件失敗し、新版へ直した後に全関連suiteを再実行した。

```sh
nix develop --offline -c env -u NODE_PATH node --import tsx \
  tmp/yutai-record-tier-proof-v1/paired.mts tmp/yutai-record-tier-proof-v1/root-paired.json
```

同一名義・同株主番号の継続、権利の取得回数、複数特典の受取/券利用の併用、他の期間・株数tierの適用は未資格のまま。今回の名簿記載回数を、本人が権利を取得した回数へ読み替えない。機能13全体の完了として数えない。
