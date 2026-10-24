# ゼロ・不該当・欠測の分類修正（2026-10-25）

対象は[Issue #348](https://github.com/satoki252595/kabulab_tool_cloudflare/issues/348)。運用上の区分は[バッチ結果と空欄](../batch-result-states.md)を参照。

- 日証金の融資残高0・貸株残高正は倍率0。値なし・分母0だけを算出不能とする。
- 保有明細の根拠付き明示不該当を専用状態・別件数へ分離。通常catchupと有限backfillは同じ判定を使う。旧markerは最大1通/回、保存原本と全文根拠を再資格し、後続HOLDを再照会する。明細公開・価格成功への変換や旧unknown解除は行わない。
- EDINET/TDnetの検証済み空一覧・対象外は理由付き成功状態で記録。主体不明・limit未着手・保存不明をその状態へ入れない。TDnet空一覧は原本保管後に終了し、不要な全件マップ読取を省く。
- CFTC未公表は原本保管・全bytes照合後に期間付き理由を記録。予定期の観測0件・最終join非成功は維持し、通信・解析障害と分ける。
- Yahoo日足未提供は`source_unavailable`。出来高0・NULL・項目欠測を区別する。売買不成立か配信欠測かを推測して成功化しない。5分足の既存区分は維持。
- マクロの必要入力が欠け、結論が未確定ならHOLD。取得済み条件だけで結論が確定する場合はその判定を維持。

## 検証

既存flake/依存lockのNix devShellで実施。新規依存なし。

| 検査 | 結果 |
|---|---|
| Node全体 `pnpm exec vitest run` | 6,769成功、444既存skip、失敗0 |
| Python全体 `uv run pytest` | 1,952成功、70既存skip、失敗0 |
| `pnpm typecheck` / `pnpm lint` / Python ruff | 成功 |
| `pnpm audit:report:check` | 成功 |
| D1 schema生成 | 差分なし、migration不要 |
| `wrangler deploy --dry-run` | 成功、既存bindingsでbundle生成 |
| 独立レビュー | Python、株式/マクロ、保有明細、CFTCの境界を確認、重大指摘なし |

初回の全体Node検証で新Notion状態を持たない旧schemaスタブが27件失敗した。実原本・snapshot・製品guardを変えず3つのテストのschema投影を補正し、全体を再実行して上記の結果を確認した。実原本未保有のskipは成功に含めない。

テストは業務上流の追加取得・本番書込・モデル実行を伴わない。CFのCron・Actionsの頻度・Yahoo排他・Mac月次手動の設定は変更しない。CFTC未公表応答の原本保管・照合と旧不該当markerの限定再資格には必要なNotion IOが発生する。

PR/main/本番配備のSHA・ビルド・versionはIssue #348へ記録する。自然時刻の取得成功、原本不足や取得元停止の解消、過去データ全件補完は、このコード検証の成功とは別に扱う。
