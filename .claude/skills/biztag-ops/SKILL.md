---
name: biztag-ops
description: kabulab-cf 005 yuho-quant の事業タグ(biztag)パイプラインをローカル/GitHub Actions から運用する(run/backfill/golden/rollback の実行、実行サマリの読み方、安全上の注意)。「biztag を回して」「事業タグを再実行して」「単語帳を巻き戻して」「biztag のバックフィルを回して」「biztag の結果を見て」などの依頼で使う。設計そのものの変更(単語帳スキーマ・判定ロジックの実装)はこのスキルの範囲外(通常の実装作業として docs/005-yuho-quant-business-tags.md を読んで直接編集する)。
---

# biztag-ops — 事業タグパイプラインの運用

## 前提

- 設計の正本: [`docs/005-yuho-quant-business-tags.md`](../../../docs/005-yuho-quant-business-tags.md)
  (§11「運用手順(runbook)」が本スキルの元ネタ)。kabulabAgents 向け契約は
  [`docs/005-yuho-quant-business-tags-contract.md`](../../../docs/005-yuho-quant-business-tags-contract.md)。
- CLI は全て `pnpm biztag <subcommand>`(**リポジトリルート**から)。実体は
  `services/yuho-quant/data-scripts/biztag.ts`。
- ローカル実行には `.env` に `TYPESAFE_API_KEY` / `NOTION_TOKEN` /
  `NOTION_STOCK_INFO_PAGE_ID` / `NOTION_DB_STOCK_MASTER`(既存)に加え、
  `NOTION_STOCK_SUPPLEMENT_DB_ID` / `NOTION_BIZTAG_LEDGER_DB_ID` が(初回セットアップ
  後は)設定されていること。CLOUDFLARE_* / D1_DATABASE_ID(D1 HTTP 読取用)も要る。
  **未設定の変数があれば型付きアクセサが起動時に throw する**(ルール2/3。エラーの
  変数名を見て `.env` を直す。フォールバックしない設計を信頼してよい)。
- `services/yuho-quant/src/biztag/calibration.json` が無いと `pnpm biztag run` は
  明示的なエラーで止まる(未較正のまま実行させない設計。§11.4 参照)。

## ローカル実行

```bash
# 差分処理(通常運用と同じロジックをローカルで動かす)。まず --dry-run で確認する
pnpm biztag run --dry-run --limit=5              # Notion に書かず件数・判定結果だけ見る
pnpm biztag run --limit=20                        # 実際に書く(少数銘柄で試す)
pnpm biztag run --codes=7203,6758                 # 銘柄コード指定(カンマ区切り)
pnpm biztag run --budget-min=20                   # 時間予算(分)。超過分は次回の差分処理が拾う

pnpm biztag gate                                  # 未審査の単語帳変更提案を審査する
pnpm biztag golden                                # ゴールデンセットで精度測定(較正用)
pnpm biztag golden --yes-min=0.8 --no-max=0.2 --out=/tmp/golden-result.json
pnpm biztag rollback --to=v1 --reason="..."       # 単語帳を過去の版へ巻き戻す(reason 必須)
pnpm biztag packet                                # 見直し材料(review packet)を再生成
pnpm biztag stats                                 # 現状のサマリだけ見る(書込なし)
```

**`--dry-run` を付けずに `run`/`rollback` を実行すると本番 Notion(「株式情報」ページ
配下の実データ)に書き込む。** ローカルで試すときは必ず `--limit=` か `--codes=` で
対象を絞り、まず `--dry-run` で結果を確認してから本書込みする。

## GitHub Actions から実行

```bash
# 日次相当を手動で1回だけ動かしたいとき (target を biztag にすると他の取込を走らせない)
gh workflow run catchup.yml -f target=biztag

# 大量バックフィル(6h タイムアウトいっぱいまで使える。通常はここから)
gh workflow run backfill.yml -f job=biztag

# 一部だけ (limit 指定可)
gh workflow run backfill.yml -f job=biztag -f limit=200

# 精度測定
gh workflow run backfill.yml -f job=biztag-golden

# 巻き戻し (to と reason は必須。無いとジョブ側が即座にエラーで落ちる)
gh workflow run backfill.yml -f job=biztag-rollback -f to=v1 -f reason="v3 の精度低下のため"

# 実行状況の確認
gh run list --workflow=backfill.yml --limit=5
gh run watch <run-id>
```

## 実行サマリの読み方

各実行は標準出力に JSON サマリ(CI では `$GITHUB_STEP_SUMMARY` に markdown も)を出す。
見るべき項目:

| 項目 | 見るポイント |
|---|---|
| 状態ごとの件数(`判定済`/`本文なし`/`読込失敗`/`判定不能`/`未判定`) | `読込失敗`/`判定不能` が想定以上に多い→ EDINET 側 or jev 側の恒常的な問題を疑う |
| 判定済の割合(カバレッジ) | 母集団のうち何%が判定済か。低下していないか前回と比較 |
| 1社あたりのタグ数・候補語数 | 極端に少ない(0近辺)→ 単語帳のキーワード網羅漏れ、または本文抽出が壊れている可能性 |
| jev 呼び出し回数・入力トークン・費用見積もり | 想定コストから大きく外れていないか(大幅なコスト増はグローバル運用ルールにより承認が必要) |
| Notion リクエスト数・429回数 | 429 が多い→ 同時実行(他の biztag* job や backfill 系)と時間帯が被っていないか確認 |
| `notify` / `notify_title` / `notify_summary`(GitHub Actions 出力) | `notify=true` のとき Issue が立つ。中身は「運営が判断すべきこと」(関門停止・期限切れ・再試行上限到達)であり、ジョブ自体の失敗ではない。docs §11.6 参照 |
| `failures` 一覧 | 個別に失敗した銘柄コードと理由。再試行対象かどうかは Notion の該当行「次回再試行日」「再試行回数」を見る |

## 安全上の注意

- **単語帳(語彙)を手で書き換えない**。変更経路は (1) Cursor Automation の提案 →
  `pnpm biztag gate` の自動審査、(2) `pnpm biztag rollback` の2つだけ
  (`services/yuho-quant/CLAUDE.md` 参照)。台帳 DB のハッシュ照合で手動編集は
  検知される。
- **`biztag-rollback` は履歴を消さない**(指定した版と同じ内容の新しい版を作るだけ)が、
  本番の判定結果は次回 `run` の影響判定で書き換わる。理由(`reason`)は必ず書く
  (台帳の「理由」列に残る。後から「なぜ戻したか」を追えるようにするため)。
- **`--limit`/`--codes` 無しの `pnpm biztag run` をローカルでいきなり流さない**。
  全銘柄対象の処理は `backfill.yml` の `biztag` job(6h タイムアウト)に任せる方が
  安全(ローカル端末の回線切断・スリープで中断しても、差分方式なので次回が続きから
  拾うが、無駄なやり直しを避けるため)。
- **トークン・シークレットをコマンド出力やコミットに残さない**。`gh workflow run` は
  secrets の値を引数に取らない設計(secrets は GitHub 側に登録済みの値をジョブが読む)
  なので、`-f` に実際のトークン値を渡す場面は無いはず。もし何かのコマンド例でトークンを
  引数に取る必要が生じたら、その場で立ち止まって「フォールバックさせず失敗させる」
  設計に直せないか考える(ルール2/3)。
- **費用**: jev(TypeSafe System One)は入力トークン課金。大量バックフィル
  (`biztag` job、6h)は一度に数千銘柄×最大20問/バッチを判定しうるため、実行前に
  想定件数から概算コストを見積もる(サマリの「費用見積もり」は実行後の値。事前見積は
  対象銘柄数 × 平均候補語数 ÷ 20(バッチサイズ) が呼び出し回数の目安)。月次のコスト
  増が大きい([`~/.claude/CLAUDE.md`](~/.claude/CLAUDE.md) のグローバル運用ルールが
  定める「月1000円以上のコスト増」の目安)場合は、運営の承認を先に取る。
- **Notion への同時書込 (biztag 系は GitHub Actions の concurrency で強制直列化済み)**:
  `catchup.yml` の `biztag` job と `backfill.yml` の `biztag`/`biztag-golden`/
  `biztag-rollback` job は、いずれも `biztag-notion` という同じ concurrency
  グループに入っており、同時に走らせようとしても GitHub Actions 側が自動的に
  キューイングする(2026-09-25 レビュー指摘対応。台帳の「有効な版はちょうど1件」
  等の check-then-act 前提が同時実行で壊れ、二重作成・台帳不整合を起こしうる
  ため、"壊れずにスループットが落ちるだけ" では済まない実害があった)。手動で
  `gh workflow run` する場合も、この2ワークフローの biztag 系は安心して連続実行
  してよい(先に走っている方が終わるまで自動的に待たされる)。biztag 系以外の
  `backfill.yml` job (`yuho-missing`/`yuho-text`/`ir`) はこの制約の対象外なので、
  従来どおり同時起動は3系統以内という運用目安に従う。
