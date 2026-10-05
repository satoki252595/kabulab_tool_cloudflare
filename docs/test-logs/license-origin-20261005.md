# ライセンス未分類の出自確認（2026-10-05）

`core_stocks` の `id`・`created_at`・`updated_at` は自作DBメタデータとして `commercial-ok`、`is_active` はJPX母集団・公式イベント、`is_yutai` は優待行の存在からの派生として `personal-only` とする。実 writer は [銘柄母集団同期](../../src/cron/universe.ts)、[公式overlay](../../src/cron/universe-overlay.ts)、[優待取込](../../services/otakara-yutai/data-scripts/yutai-full-import.ts)、[月次再計算](../../src/cron/monthly.ts) を確認した。公開面での既存WHERE述語は維持し、フラグの値を投影しない。

`universe_official_events` はJPX原市場情報を含み、`universe_overlay_state` も原本日付・保留コードを含むため、両表全体を `personal-only` とする。自作の観測時計が混在することを理由に表の制約を緩めない。

`yutai_genres` の名称・slug・説明は [YUTAI_GENRES](../../services/otakara-yutai/data-scripts/yutai-full-import.ts) の自作固定値。2026-10-04T21:26:57.584Z（10月5日JST）に本番へreadonly SELECTを1回行い、全16行・3項目が固定値と完全一致した。応答原bytes・全tupleは私有保存し、行JSONのSHA256は `209e7dc53d359a8df02e5c38b6e7319d3cb944b2ff1800e5aad735bebcf12272`。追加取得元・Notion・D1書込み・モデル呼出し0。分類は `commercial-ok` とする。

これはジャンル定義の分類であり、掲載文から銘柄へジャンルを割り当てた優待行の制約は変更しない。直前の通常ops_checkは実33表・402列に対して宣言31表・列地図6行を観測し、上記3カテゴリを警告していた。今回の宣言は33表・銘柄11列を対象とする。

Pythonの列・表地図、言語横断契約、JSS列マスクと公開投影ガードを一致させる。公開鮮度APIは既存の許可判定を使い、`commercial-ok`・`factual-cite` のみ返す。NULL・空文字・未知タグ・`personal-only` は返さず、内部鮮度は元の行を保持する。

これは出自の分類と公開境界の修正である。TDnetの未走査、原文品質保留、保存結果不明などの業務結果を解消した証明ではなく、本番の列地図投入・通常ops照合は変更の反映後に別途確認する。

Nix経由でPythonの地図・投入・SLO・フィクスチャ方針の関連181テスト、JSS全173テスト（既存skip3件）、公開列境界・述語・優待公開面の109テストが成功。JSS独立型検査、ルート型検査・lint、Python Ruff、差分空白検査も成功した。

## 本番の公開境界

PR314は全CI成功後にmain `dae6686` へマージし、main CI37237257869も全成功。
同headのWorkers Build `ac694376-f3cb-4358-bf9a-c06d3ea0a720` は21:44:26 UTCに成功した。
実deploymentのversion `68bba525-d68f-4298-9858-1887b81ad6a5` は100%配信で、作成は21:44:17.837 UTC。
native metadataにGit SHAは無いため、expectedHeadをnativeの証明とはせず、同head Buildと時計を結合した。

独立JSSも`--keep-vars`で各1回デプロイし、public `8f91813c-3989-492a-8d8e-1431eb6e2cfc`、
private `1add0656-64b9-4da9-b797-d805220e1b56` の100%配信を読戻した。
両側のRAW bindingと、privateだけのSUPPLY binding・既存`JSS_API_KEYS` secret名の保持を確認。
実URLへの4 GETは、公開health200/鮮度200（許可分類のみ3行）、非公開health200/未認証鮮度401だった。
NULL・未知分類の除外は実返却のallowlistと回帰テストを根拠とし、拒否元行を本番で全列挙したとは主張しない。
readonly CLI8回・HTTP4回。CLI内部HTTP時計・attempt数はUNKNOWN、再デプロイ・設定変更は0。
全46原ファイルを私有保存し、集約receipt SHA `11222177ab881f3c1944c89daaca8c6a32ddddd59d8b21401e16e1010d87d54c`。
これは公開境界の実受入で、源泉の再配布許諾や本番列地図投入の完了とは別である。

## 通常列地図投入と照合

main52cの[通常ops_check 37254314741](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/37254314741)
で、列地図投入・strict検査は成功した。本番33表402列、宣言した銘柄11列とwriter claim17件を照合した。
マスタも11列・2索引・孤児0で成功。投入の更新対同値skip内訳・実HTTP packet計数は
CLIログだけでは未観測で、全4層の検査を全書込0とは扱わない。
同runのFAILUREは別の鮮度SLO4件であり、出自分類や商用再配布許諾を同一視しない。

週末加齢の修正後main caで[通常ops_check 37256039258](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/37256039258)
も02:37:40 UTCに終端した。列地図・writer claim・本番33表402列・マスタ11列/2索引/孤児0の
照合は再度成功し、ライセンス警告0。SLOだけ残3件がyellowで、取得原本の権利や商用許諾を
変更した結果ではない。実seed書込対同値skip・HTTP packet数は引き続き未観測。
