# 保存原本による受注・海外・本文の再解析（2026-10-14）

Issue #348 の未完分類。調査時点の D1 は受注 `table_unrecognized` 1,318 件、海外 `geo_present_unstructured` 7,391 件、海外 `parse_error` 3 件、本文 `parse_error` 7 件。対象文書のメタデータ 8,471 件を read-only で照合した。全件の修復完了を意味しない。

受注の根因の一つは、実表の「次期繰越工事高」「期末繰越工事高」を既存 Pattern B が認識しなかったこと。既存の「繰越高」と同じ残高列として認識する最小変更を加えた。期間は原表の実際の至年月日または明示された前期・当期からだけ確定し、根拠のない行に報告期を補わない。既存保存 HTML で以前失敗した 66 件中 7 件が改善し、そのうち保存一次 XBRL ZIP を全文 SHA 照合した 3 件（S100W2JG、S100W69L、S100WAYO）は連結区分・単位・期間・期待 facts まで確定した。他の未認識表は引き続き未解決。

本文エラー 7 件は既存 Notion の legacy docID 行に保存された CSV ZIP が実在した。現行 parser は順に 23/22/20/22/21/22/22 節を抽出したため、少なくともこの 7 件は原本喪失ではなく過去のエラー状態が残っている。海外エラー 3 件は保存 XBRL ZIP から S100LK5R のみ `ok_geo_cols` と保存契約を確認した。S100LIS1/S100LN7K は原表非対応のため `geo_present_unstructured`、facts 0 を維持する。

検証した一次 ZIP は 13 ファイル・3,898,900 bytes。既存 Notion hosted file の読取のみで、上流 GET 0、remote mutation 0。元 ZIP/SHA・旧→新 status・期待本文/facts・明示 HOLD 理由を private plan `tmp/feature-audit-20261013/saved-parser-pilot-plan-NOT-EXECUTED.json`（0600、Git 対象外）へ固定した。実行済みではない。適用前には対象 D1 の最新 preimage、既存 unknown latch、原本 SHA を再照合する。本文は新 row 全文検証→D1 atomic 確定→旧 row retire の順序を守る。

既存 HTML cache は ZIP の member manifest を持たない派生物なので、cache の改善件数を本番修復件数と数えない。過去の中止済み repair grant は再利用しない。

検証: 受注 parser 27 tests、関連 3 suites 49 tests、変更ファイル ESLint、TypeScript、`git diff --check` が成功。
