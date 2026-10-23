# 定期処理の時刻契約と検証（2026-10-23）

対象は[Issue #348](https://github.com/satoki252595/kabulab_tool_cloudflare/issues/348)の定期実行経路。
10/22には日証金12:17予定が17:43、信用残17:00予定が22:16となり、Python有報21時のrun生成も未確認だった。
時刻・対象日・先行条件は[時刻契約](../stock-scheduler.md#取得処理の時刻契約)、全機能は[運用一覧](../production-job-inventory.md)を参照。

- Python3系統と信用残の起動元をCFへ移し、対象の予定日時をCLIまで保持する。
- CLIは環境準備・排他待ち後に実時計で受付を判定する。原本の基準日・公表日を予定日へ置換しない。
- VWAPの日足と5分足を同run/attemptの受付artifactでつなぎ、間でYahoo排他を解放する。日足exit0/1後だけ後続へ進み、最終成功は両方exit0が必要。
- 信用残はYahoo排他と分離。moneyflowは閉鎖済みの既知失敗なら独立Yahooへ進むが、joinでは失敗を維持する。
- Node有報は19:43まで新規source、19:53まで開始済み単位を閉鎖。手動/Workerの既定5分は維持する。
- HTTPとS3 SDKの開始条件へ期限を伝播。原本の未確定保存は保持し、再送・日付代用・LLMを追加しない。

## 検証

Nix devShell（既存flake/lock、追加依存なし）で実行。

| 検査 | 結果 |
|---|---|
| Node全体 `pnpm exec vitest run` | 6,725成功、444既存skip、失敗0 |
| Python全体 `uv run pytest -q` | exit0。未取得の実原本fixtureはskipを維持 |
| `pnpm typecheck` / `pnpm lint` / Python ruff | 全成功 |
| `pnpm audit:report:check` | 成功 |
| `wrangler deploy --dry-run` | 成功、既存bindingsでbundle生成 |
| workflow全14本のYAML parse | 成功、21 job（意図的無効1本を含む） |
| 独立レビュー | soft後の保有source開始・JPlegのSDK期限漏れを修正し再確認済み |

境界テストは遅配・日跨ぎ・週末・未来日時、CLI開始/追加IO期限、同run/attempt引継ぎ、日足0/1/2/137の実YAML bash、未知結果の再送禁止、SDKの第2GET停止を含む。
検証では実上流取得・業務データ書込・モデル実行を行っていない。既存skipを成功件数に含めない。

PRのCIとmainの実配備はGitHubの変更履歴で追跡し、配備SHA・version・Cron設定の受入をIssue #348へ記録する。
自然時刻の取得成功・原本不足/HOLD・取得元503の解消は、コードのテスト成功とは別に扱う。
