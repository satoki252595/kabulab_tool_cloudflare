# 単語帳(語彙)見直し提案 — 保管場所

このディレクトリは `pnpm biztag gate` に**まだ通していない**単語帳変更提案の草稿を置く場所。
`vocabulary/v1.json` には反映しない(単語帳の正本は台帳 DB — `services/yuho-quant/CLAUDE.md` 参照)。

## ここにある提案

- `2026-09-25-quality.json` — 2026-09-25 の精度診断(タグ0件 1,229/3,606件)を受けた品質改善提案。
  `baseVersion: "v1"`。内容は `docs/005-yuho-quant-business-tags.md` 更新時のコミットメッセージ、
  または本エージェントの最終報告を参照。

## 提出手順(運営が行う)

このファイル自体を Notion 台帳へ直接書き込む経路は無い(単語帳の変更経路は
Cursor Automation の提案 → `pnpm biztag gate` の2つだけ。`services/yuho-quant/CLAUDE.md` 参照)。
このファイルは**提案の内容(草稿)**であり、実際に台帳へ「提案(未審査)」として載せるには
Worker の受付エンドポイントを叩く必要がある:

```bash
curl -X POST "$KABULAB_CF_ORIGIN/yuho-quant/vocabulary/proposals" \
  -H "Authorization: Bearer $VOCAB_REVIEW_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @services/yuho-quant/src/biztag/proposals/2026-09-25-quality.json
```

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
