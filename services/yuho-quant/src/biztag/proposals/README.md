# 単語帳(語彙)見直し提案 — 保管場所

このディレクトリは `pnpm biztag gate` に**まだ通していない**単語帳変更提案の草稿を置く場所。
`vocabulary/v1.json` には反映しない(単語帳の正本は台帳 DB — `services/yuho-quant/CLAUDE.md` 参照)。

## ここにある提案

- `2026-09-25-quality.json` — 2026-09-25 の精度診断(タグ0件 1,229/3,606件)を受けた品質改善提案。
  `baseVersion: "v1"`。内容は `docs/005-yuho-quant-business-tags.md` 更新時のコミットメッセージ、
  または本エージェントの最終報告を参照。

- 2026-09-26 に上記を提出し、関門で採用 → **v2**。続けて `2026-09-26-tester-themes.json`
  (半導体テスタを半導体製造装置・半導体バリューチェーンのテーマ構成語へ追加) を採用 → **v3**。
  台帳が正本なので、このディレクトリのファイルは提出記録として残す。

- `2026-09-26-round2.json` — v3 適用後もタグ0件が1,128/3,606件残っていた診断への
  是正案(ラウンド2)。`baseVersion: "v3"`。銘柄マスタ（補足）の空タグ・判定済 1,130 社の
  「事業の内容」を精査し、卸売業(127社)・小売業(78社)・サービス業の一部(経営コンサル・
  広告代理業)に単語帳の語が1つも無いことが最大の原因と特定。distribution 列(当時
  10/100・上限まで90語の余地あり)へ5語を新設し(`B.SVC.SPECIALTY_WHOLESALE` 専門商社・
  卸売業／`B.SVC.APPAREL_FOOTWEAR_RETAIL` 衣料品・靴の小売専門店／
  `B.SVC.LIFESTYLE_SPECIALTY_RETAIL` 生活雑貨・趣味用品の小売専門店／
  `B.SVC.MANAGEMENT_CONSULTING` 経営コンサルティング／`B.SVC.ADVERTISING_AGENCY`
  広告代理店)、あわせて実データで「自動車部品」という平易な表記が132件出現するのに
  既存語 `B.MOBI.AUTO_PARTS`(upstream・満杯)の keywords が JSIC の複合語のみだったため
  `add_keywords` で補強した(2026-09-25 タイヤ是正と同種)。出典はすべて日本標準産業分類
  (総務省 R5)。詳細な検証結果は下記「このエージェントが実施した検証」を参照。

## 提出手順(運営が行う)

このファイル自体を Notion 台帳へ直接書き込む経路は無い(単語帳の変更経路は
Cursor Automation の提案 → `pnpm biztag gate` の2つだけ。`services/yuho-quant/CLAUDE.md` 参照)。
このファイルは**提案の内容(草稿)**であり、実際に台帳へ「提案(未審査)」として載せるには
Worker の受付エンドポイントを叩く必要がある:

```bash
curl -X POST "$KABULAB_CF_ORIGIN/yuho-quant/vocabulary/proposals" \
  -H "Authorization: Bearer $VOCAB_REVIEW_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @services/yuho-quant/src/biztag/proposals/2026-09-26-round2.json
```

(`2026-09-25-quality.json`/`2026-09-26-tester-themes.json` は既に採用済み・v3。次に提出すべきは
`baseVersion: "v3"` の `2026-09-26-round2.json`。)

(`$VOCAB_REVIEW_TOKEN` は `VOCAB_REVIEW_TOKEN_SHA256` のハッシュ元。Cursor Automation の
`KABULAB_CF_VOCAB_TOKEN` と同じ値。ローカルの `.env` には平文トークンを置かない運用のため、
実際のトークン値は運営の手元でのみ扱う。)

台帳に「提案(未審査)」として載ったら、次の `pnpm biztag run`(catchup.yml の日次実行、または
`gh workflow run catchup.yml -f target=biztag` で即時実行)の冒頭で `pnpm biztag gate` が自動審査する。
先に手元で審査を通るか確認したい場合は:

```bash
pnpm biztag gate
```

を(提案が台帳に載った状態で)実行する。関門の中身(§6.3 4項目)は
`docs/005-yuho-quant-business-tags.md` 参照。

## このエージェントが実施した検証(ローカル・jev/Notion/D1 の資格情報なしで可能な範囲)

1. `ProposalSchema.safeParse` — 形式検査 OK。
2. `verifySources`(関門と同じ関数)を実際に一度ネットワーク越しに実行し、
   全 17 件の変更・出典 URL・引用が「日本標準産業分類」PDF の実テキスト
   (unpdf 抽出・NFKC/空白正規化)に実在することを確認済み(issues: 0)。
3. `applyProposal` + `validateVocabulary` — 適用後の単語帳が意味検査を全て通過
   (issues: 0)。適用後は upstream 100/100(上限ちょうど)・downstream 97/100・
   distribution(新設) 10/100。
4. `prefilter` を実データ(golden セットの実引用文・ローカル fixture)に対して
   before/after で実行し、Advantest(6857)に半導体テスタ語が新規候補として付くこと、
   既存 fixture の候補集合が壊れていないことを確認済み。

**未検証(このワークツリーに `TYPESAFE_API_KEY` / `NOTION_TOKEN` / D1 資格情報が無いため実行不能)**:
`pnpm biztag golden`(jev 呼び出しを伴う精度測定)、および 7203/6857/5108 等の実銘柄に対する
dry-run 判定(`pnpm biztag run --dry-run`)。運営側で `.env` を用意した環境で
`pnpm biztag gate` を実行すれば、関門が自動でゴールデンセット再評価まで行う。

## `2026-09-26-round2.json` の検証(このエージェントは Notion/D1/jev の読み取り専用資格情報あり)

1. `ProposalSchema.safeParse` — 形式検査 OK。
2. `applyProposal(v3, round2, "v4")` + `validateVocabulary` — issues 0 件。
   適用後の列内訳は upstream 100/100(変更なし・満杯)・downstream 97/100(変更なし)・
   distribution 15/100(10→15。新設5語はすべて distribution)。変わった語は6件
   (add_business×5 + add_keywords×1)／v3の有効語数256 = **2.3%**(上限20%に対して余裕大)。
3. `verifySources`(関門と同じ関数)を実際に一度ネットワーク越しに実行し、
   全6件の変更・9件の出典URL・引用が「日本標準産業分類」PDF の実テキスト
   (unpdf抽出・NFKC/空白正規化)に実在することを確認済み(issues: 0)。
4. **カバレッジ(prefilterのみ・jev呼び出しなし)**: 銘柄マスタ（補足）から
   `事業タグの状態=判定済` かつ3列とも空の1,130社の「事業の内容」等を実際に取得し、
   v3→v4で `prefilter` を再実行。**312社(27.6%)が新語による候補を新たに獲得**
   (内訳: `B.SVC.SPECIALTY_WHOLESALE` 163社・`B.MOBI.AUTO_PARTS` 101社・
   `B.SVC.LIFESTYLE_SPECIALTY_RETAIL` 24社・`B.SVC.APPAREL_FOOTWEAR_RETAIL` 19社・
   `B.SVC.ADVERTISING_AGENCY` 19社・`B.SVC.MANAGEMENT_CONSULTING` 14社。重複あり)。
   うち17社は候補語が0件→1件以上に転じた(残りは既存の誤フィット候補に加えて
   正しい候補が付いた形)。
5. **jevサンプル判定(dry-run・20社)**: 上記で新候補を獲得した20社を実際にjevへ
   問い合わせた結果、**16社(80%)が新語で「はい」判定**(確率0.64〜0.99)に転じた
   (例: 阪和興業→専門商社・卸売業0.93、しまむら→衣料品・靴の小売専門店0.98、
   博報堂DYホールディングス→広告代理店0.98、トヨタ紡織→自動車部品0.70)。
   1社は要確認止まり、3社は既存語含め全て「いいえ」(誤検知ではなく、候補にはなった
   ものの実際の主業ではないとjevが正しく除外した例を含む)。
6. **ゴールデンセット再評価(`pnpm biztag golden --vocab-file=v4.json`。calibration.json の
   yesMin=0.50・noMax=0.25・jev-1.13.0)**: precisionYes **0.968**(v1較正時 0.962 から
   低下なし・関門の目標0.9以上を満たす)・recallYes 0.757(較正時0.760と同水準)・
   mustHitRecall 0.905(較正時と同一)・mustNotViolations 0・filterMissRate 0。
   新設5語はゴールデンセットに expect ラベルが無いため(§6.3既知の制約どおり)この評価に
   一切寄与しない — 精度への影響は `B.MOBI.AUTO_PARTS` への `add_keywords` のみだが、
   結果は悪化していない。

以上より、関門(§6.3 4項目)は全てローカルで再現・通過を確認済み。
