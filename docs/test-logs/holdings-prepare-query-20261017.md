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

関連3 suite・68 test、型検査、lintはPASS。GitHub CIと本番の負荷測定はそれぞれ別に確認する。

```sh
nix develop --offline -c pnpm exec vitest run services/yuho-quant/data-scripts/lib/shareholdings-backfill.test.ts services/yuho-quant/data-scripts/backfill-shareholdings.test.ts src/shared/db/core-stocks-license-boundary.test.ts
nix develop --offline -c pnpm typecheck
nix develop --offline -c pnpm lint
```

本番D1の有限old/new SELECT比較と`rows_read`測定、次の通常prepareは別途受入する。保存latest応答の既観測171,301読取行を、新SQLの実測値へ置き換えてはいない。大量保有明細の実公開、原本・価格のHOLD解消、権利処理の完了もこの変更の受入範囲には含めない。
