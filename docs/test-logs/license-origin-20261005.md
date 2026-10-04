# ライセンス未分類の出自確認（2026-10-05）

`core_stocks` の `id`・`created_at`・`updated_at` は自作DBメタデータとして `commercial-ok`、`is_active` はJPX母集団・公式イベント、`is_yutai` は優待行の存在からの派生として `personal-only` とする。実 writer は [銘柄母集団同期](../../src/cron/universe.ts)、[公式overlay](../../src/cron/universe-overlay.ts)、[優待取込](../../services/otakara-yutai/data-scripts/yutai-full-import.ts)、[月次再計算](../../src/cron/monthly.ts) を確認した。公開面での既存WHERE述語は維持し、フラグの値を投影しない。

`universe_official_events` はJPX原市場情報を含み、`universe_overlay_state` も原本日付・保留コードを含むため、両表全体を `personal-only` とする。自作の観測時計が混在することを理由に表の制約を緩めない。

`yutai_genres` の名称・slug・説明は [YUTAI_GENRES](../../services/otakara-yutai/data-scripts/yutai-full-import.ts) の自作固定値。2026-10-04T21:26:57.584Z（10月5日JST）に本番へreadonly SELECTを1回行い、全16行・3項目が固定値と完全一致した。応答原bytes・全tupleは私有保存し、行JSONのSHA256は `209e7dc53d359a8df02e5c38b6e7319d3cb944b2ff1800e5aad735bebcf12272`。追加取得元・Notion・D1書込み・モデル呼出し0。分類は `commercial-ok` とする。

これはジャンル定義の分類であり、掲載文から銘柄へジャンルを割り当てた優待行の制約は変更しない。直前の通常ops_checkは実33表・402列に対して宣言31表・列地図6行を観測し、上記3カテゴリを警告していた。今回の宣言は33表・銘柄11列を対象とする。

Pythonの列・表地図、言語横断契約、JSS列マスクと公開投影ガードを一致させる。公開鮮度APIは既存の許可判定を使い、`commercial-ok`・`factual-cite` のみ返す。NULL・空文字・未知タグ・`personal-only` は返さず、内部鮮度は元の行を保持する。

これは出自の分類と公開境界の修正である。TDnetの未走査、原文品質保留、保存結果不明などの業務結果を解消した証明ではなく、本番の列地図投入・通常ops照合は変更の反映後に別途確認する。

Nix経由でPythonの地図・投入・SLO・フィクスチャ方針の関連181テスト、JSS全173テスト（既存skip3件）、公開列境界・述語・優待公開面の109テストが成功。JSS独立型検査、ルート型検査・lint、Python Ruff、差分空白検査も成功した。
