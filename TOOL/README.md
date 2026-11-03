# TOOL — お金の流れレポート生成スクリプト

資金フローと事業タグの可視化レポート（HTML）を生成する検証用スクリプト群。
本番プロダクトの機能ではなく、ローカルで手動実行する分析ツール。

## スクリプト

| ファイル | 役割 |
|---|---|
| `mf-dump-divisions.mts` | 現行単語帳（台帳）から「タグ名 → 区分（川上/川下/流通）」を `mf-vocab-divisions.json` へ出す（読み取りのみ） |
| `mf-biztag-precompute.py` | Notion「銘柄マスタ（補足）」の事業タグ × D1日足から週次集計 `mf-biztag-heatmap.json` を作る（読み取りのみ） |
| `mf-report.mts` | お金の流れレポート全体 `moneyflow-report.html` を生成 |
| `mf-biztag-report.mts` | 事業タグ専用レポート `biztag-moneyflow.html` を生成 |

生成物（`*.html` / `mf-biztag-heatmap.json` / `mf-vocab-divisions.json`）は
個人利用限定・要確認ライセンスのデータ由来のため **git管理外**（`.gitignore`）。
スクリプトだけをGitHubで管理する。

## 再生成手順

リポジトリルートで実行する。`.env` が必要（事業タグ区分の取得は受入済み
Mac runtime の手順に従う。docs/mac-monthly-manual.md 参照）。

```sh
# 1) 単語帳の区分表（受入済みruntimeから。revisionは .env の
#    BIZTAG_LOCAL_ACCEPTED_REVISION と一致する runtime を使う）
cd .runtime/mac-unified-20261103
nix develop --offline --no-write-lock-file --command env -u NODE_PATH \
  pnpm exec tsx --env-file=.env ../../TOOL/mf-dump-divisions.mts
cd -

# 2) 事業タグ×日足の週次集計
set -a; . ./.env; set +a
(cd pipeline && uv run python ../TOOL/mf-biztag-precompute.py)

# 3) レポート生成
pnpm exec tsx TOOL/mf-report.mts
pnpm exec tsx TOOL/mf-biztag-report.mts
```

## 見る

既存のローカルサーバー（`tmp/` 配信、port 8791）互換のため、生成HTMLは
`tmp/*.html` から symlink でも辿れる:

- http://127.0.0.1:8791/moneyflow-report.html
- http://127.0.0.1:8791/biztag-moneyflow.html

サーバーが止まっている場合は `TOOL/` を直接配信してもよい:

```sh
python3 -m http.server 8792 --bind 127.0.0.1 --directory TOOL
# → http://127.0.0.1:8792/biztag-moneyflow.html
```

## 注意

- レポート内の文章はスクリプト内の固定文であり、実行時にLLMが生成するものではない。
  数値はすべて取得済み実データからの機械集計。
- 事業タグ自体は有報テキストへのAI判定結果（公式分類ではない）。
  レポート各節の注意書きと指標定義が正。
- 非公開前提。公開ページへの転載はしないこと。
