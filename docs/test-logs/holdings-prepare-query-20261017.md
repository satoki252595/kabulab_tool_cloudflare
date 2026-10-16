# 保有明細prepareの履歴選択範囲（2026-10-17）

通常の `selectLatestHoldingsDocuments` は、今回の候補株を同じ1 SQL内で先に絞り、その株の年報履歴だけを順位付けする。追加通信・DDL・依存・原本取得・モデル利用はない。通常prepareとapply直前の`onlyCode`再資格が同じ関数を使う。

候補は共通`activeEquityCondition()`、`afterCode`、任意`onlyCode`、年報120/130の存在を満たす株をコード昇順で`limit + 1`件選ぶ。年報のない株が枠を消費しないよう相関`EXISTS`を含める。最新会計期末→提出時刻→文書PKの順位、外側の資格・コード順、`rows`と`more`は維持する。値は従来どおり束縛する。

## 保存実データの純照合

- 基準はmain `8faf8c57e4d567b50ae12a7f613d5cacbdc34c0b`の旧関数（SHA256 `5aa54ba88357afc51da271e4c2f718233a0d5be04374b609eaa478f898a831b5`）。
- 保存済み本文復旧の全6表snapshot 60個から、2,945株・30,569文書の実履歴を使用。各株について最初の保存snapshotの履歴を丸ごと使い、異なる時点の文書行は合成していない。同時点の全市場snapshotや現在の本番全量ではない。
- 入力gzip SHA256 `25b5a2c166a9f286dbdb078cfc31eabae249e634adeb84aa8f825da6c0f777de`。元snapshotのpath/SHA/取得時計と各株の採用元は同gzipへ保持。
- 3,170条件で旧新の全出力・提出時刻・`more`が一致。20件/50件の全ページはどちらも2,945株、コード列SHA256 `d06b128cc1e0922fe8090e62a3661c6d6fcbfbaa08f388e21472bb2cc83a5729`。全2,945株の`onlyCode`、cursor境界、`afterCode`と`onlyCode`の交差も照合した。
- NixのNode v22.22.2・SQLite 3.50.4と既存の全migrationを使うローカル照合。旧snapshotに未存在のnullable列を実DDLで作ることはローカルschema rehearsalであり、fresh本番PREとは区別する。selectorに使う列はすべて保存原値。

純照合の保存先は`.runtime/holdings-prepare-sql/source-v1/tmp/holdings-prepare-sql-audit-v1/`。`result.json`、`queries.json`、`performance.json`、元snapshot一覧付き入力gzipを保持する。HTTP/D1本番read/Notion/source API/model/本番writeはすべて0。

## 実行計画・ローカル負荷

既存`core_stocks_code_unique`・`idx_core_stocks_active_market`・`yuho_documents_stock_idx`を使う。同じ入力・`afterCode=145A, limit=20`の`EXPLAIN QUERY PLAN`では、window用文書読取が旧`SCAN yuho_documents USING INDEX yuho_documents_stock_idx`から新`SEARCH yuho_documents USING INDEX yuho_documents_stock_idx (stock_id=?)`になった。候補株の存在確認も既存stock索引を使う。

読み取り専用SQLiteでウォームアップ後5回の中央値は36.07ms→2.19ms。1,000命令刻みのprogress handlerによる概算VM命令数は2,289,000→140,000（約94%減）。これは保存した部分集合でのローカル測定であり、本番D1の時間・`rows_read`削減量や全量の所要を保証しない。測定JSON SHA256は`721e1846c1cdb22e413eb9d3ec37f9b0e6d78c1d6d69b1b83b6f4141514fa67d`。

## 回帰と本番受入

既存テストへ、年報なし/非年報だけのactive株、非普通株・inactive・未確定区分、最新期末と訂正の同時刻PK順、ページ境界`more`、`onlyCode`とcursorの交差、1問い合わせ、既存stock索引での文書検索を追加した。本番`period_end`はNOT NULLであり、NULLを補完する処理は追加しない。

mainの発行株数診断変更を通常mergeした後の関連3 suite・74 test、型検査、lintはPASS。GitHub CIと本番の負荷測定はそれぞれ別に確認する。

```sh
nix develop --offline -c pnpm exec vitest run services/yuho-quant/data-scripts/lib/shareholdings-backfill.test.ts services/yuho-quant/data-scripts/backfill-shareholdings.test.ts src/shared/db/core-stocks-license-boundary.test.ts
nix develop --offline -c pnpm typecheck
nix develop --offline -c pnpm lint
```

本番D1の有限old/new SELECT比較と`rows_read`測定、次の通常prepareは別途受入する。保存latest応答の既観測171,301読取行を、新SQLの実測値へ置き換えてはいない。大量保有明細の実公開、原本・価格のHOLD解消、権利処理の完了もこの変更の受入範囲には含めない。

## 既存索引を使う走査の固定

続く本番の単発2 SELECT（同じ`afterCode=145A, limit=20`）は、旧全履歴171,241行/400.8285msから、#448の候補限定83,678行/95.7946msへ減った。21行の全列・順序、20行の選択と`more`が一致し、書込は0。元nativeと旧作業treeは`.runtime/holdings-prepare-sql/source-v1/tmp/holdings-prepare-paired-read-v2/`へ不変保存する。これだけでは127 prepareの読取が約1,063万行になる条件を解消できない。

そこで、既存DDL `0000_clean_tag.sql`の`core_stocks_code_unique`を候補の`INDEXED BY`で指定し、外側stock結合を`NOT INDEXED`にする。後者もINTEGER PRIMARY KEYのrowid検索は許される。選択条件・順位・束縛値・通信数は変えない。DrizzleでSQL table fragmentを使うため、その2列の射影を同じ型のSQL式にする。索引欠落時にはprepareが失敗し、別計画・別問い合わせで補完しない。

これは、[SQLite公式仕様](https://www.sqlite.org/lang_indexedby.html)が通常の最適化用hintとは区別する、実測済みの計画の固定である。索引名をschema契約にするため、本番の索引存在と実行計画を別の有限readで確認するまでmergeしない。DDL追加は不要。

基準main `117b213394593b67199af738227101e25b15cb7b`の#448関数と、変更した通常関数を、同じ保存2,945株/30,569文書へ直接実行した。SQLの文字列置換をしない通常関数の3,170条件、全20/50件ページ、全`onlyCode`で全出力・時刻・`more`が一致。生成SQLは先行private案と完全一致した。`.runtime/holdings-prepare-code-index/source-v1/tmp/code-index-normal-v3/`の`result.json` SHA256は`2c07574a653b7d197eab319d35e2115c9cc8460f836048a8c3f1b5241fb86865`、`queries.json`は`83e353fb39e0bb2fff9a42535acb4900c16d4bed441878074eb0f6b874fda9a5`。原SQLiteの全SHAは前後不変で、HTTP/本番writeは0。

同じ生成SQLのローカル5回中央値は2.171ms→0.231ms、概算VM命令140,000→19,000。候補は`core_stocks_code_unique (code>?)`で検索し、外側は`INTEGER PRIMARY KEY (rowid=?)`検索になる。両方のactive索引全株走査が消える。測定JSON SHA256は`1f47d3ab6a4d2ed76d8d3108794c04eed311bb0239bd0e8dc3b847bc7507a8e6`。この部分集合での測定を、本番`rows_read`や全量の時間へ換算しない。

回帰では本番と同名のcode UNIQUE索引を使い、rowid検索、active全株索引走査の不在、索引欠落時の1問い合わせだけの失敗を確認。既存選択回帰・型検査・lintはPASS。本番は`PRAGMA index_list(core_stocks)`と基準/変更SQLの`EXPLAIN QUERY PLAN`各1回の計3 readを別releaseで行い、実行計画・索引が資格を満たさなければ停止する。実際の新SQLの`rows_read`測定と次の通常prepareは引き続き別受入とする。
