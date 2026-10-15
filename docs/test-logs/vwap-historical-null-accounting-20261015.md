# 日足原本の過去NULL行分類（2026-10-15）

通常定期処理 `ingest-daily` → `qualifyDailySourceRange` → `completedDailyFetch` の共通境界を修正した。Yahoo原本のtimestamp数と採用価格行数の差だけで停止していた入力について、実在する各行を有効価格または過去のOHLCV全欄NULLへ分類する。

NULL行は `completedFetch.rawRows` に版・原行数・元timestampを保存し、価格・出来高・非取引日の推定には使わない。部分NULL、端点、対象日、重複・逆順、未知の版や改変した証跡は保留。従来の全行採用証跡は形式を維持する。原本SHA・観測時刻・対象日・10年窓と独立市場原本の条件を保持し、旧有効日付が新原本から欠ける場合は既存のwhole-post rebuildで停止する。

Nix Node 22.22.2 / pnpm 9.15.9・既存lockで関連3 suiteは129 PASS / 既存3 SKIP。型検査・対象lint・diff checkも通過。7件の保存済み原本gzip・各member全文SHAと別途保存済みの10月14日市場原本を照合したoffline replayでは、5271・6092・7075・8303の旧観測とのrebuildが通過し、523A・634A・641Aは旧有効日付の欠落で停止した。旧手動runのbenchmark・更新前データを復元したという主張ではなく、新しい本番書込も行っていない。

追加の外部取得・LLM・依存ライブラリは0。4件の追加証跡は93 / 2,799 / 3,954 / 5,934 bytes、完成候補に占める最大比率は約4.3%。NULLを含む入力の分類と保存証跡検査は行数に比例する。7原本の解凍・全SHA・解析・照合を含むローカルreplayは約236msだったが、変更前後の性能差や本番全量の所要時間を保証する測定ではない。

私有原本・URL・旧値・replayはGit対象外。監査記録 `vwap-daily-null-root-replay-v1/SUCCESS.json`、原本診断 `vwap-daily7-readonly-v1/ROOT-native-source-diagnosis.json` を保持する。原本来歴と全期間完全性を区別し、修正受入後のデータ回復は最新の旧値・ETagを読み直して別途実施する。
