# 定時受付と原本閉鎖の検証（2026-10-25）

対象は[PR #560](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/560)。本番取得・書込み・再実行は行わず、通常CLIとWorkerの実装を検証した。時刻の全表は[運用契約](../stock-scheduler.md#取得処理の時刻契約)を参照。

- CFの予定slotと実時計を分離し、未来・別日・対象外slotを取得前に拒否する。Python EDINETの翌日配送でも元slotのreceiptを照合する。
- CF claimの待機後もPOST直前に再検査する。既存のclaimed・POST結果不明を再送しない。
- Actionsの同run/attempt/job/runnerから取得した開始時計を、依存準備を含むnative終了予算へ束縛する。取得不能・一意でない・予算不足ではsourceを開始しない。
- softでは新sourceだけを止め、取得済み株式・VWAP batch・PDF・JPX部分原本を閉鎖する。hard後の新送信・保存は止め、結果不明を成功や未送信へ変換しない。
- PythonのNotion待機後・HTTP再試行・R2 SDK native送信・需給のworker threadにも同一期限を伝播する。R2の先行PUT後の停止はunknownを保持する。最終ops receiptは業務guard解除後、native終了前の別枠で閉鎖する。
- 株式の権利一覧/XLS、VIのR2照会後、母集団Basicの3段通信、TDnet詳細PDFの2取得元も実送信前に再検査する。Yahoo並列数・Notion枠・既存claim・保存資格は変えない。
- 手動株式もnative予算へ束縛し、原本閉鎖30分と後続sector33の原本保存枠600秒を予約する。600秒はsector33全体の上限ではないため、sector33も元jobのsource/hardを検査し、子原本CLIへ同じ時計を渡す。
- `all`末尾のマクロ・母集団・優待・再計算も元jobの時計を維持する。優待のsource停止時は取得済みdurable原本だけを保管し、部分取込に進まない。PRE/ACK後のhard停止はpendingを保持する。共有writerのR2 SDKにも同じhardを渡す。

検証は専用worktreeの既存Nix/lockで実施し、mainの#561〜#565を統合した。

| 検証 | 結果 |
|---|---|
| Node全件 | 6,843成功、既存465 skip、失敗0 |
| Python全件 | 1,958成功、既存114 skip、失敗0 |
| TypeScript / 通常lint | 成功 |
| Python ruff（src/tests/clock helper） | 成功 |
| audit report整合 / git diff check | 成功 |
| Worker dry-run（Wrangler 4.101.0） | 成功、実deployなし |

skipは既存の原本fixture未取得等であり、成功件数へ含めない。実業務の自然起動・原本全量充足はこの検証だけでは確認済みにしない。GitHub上の開始時計の実接続はCIの`Verify current native job clock`で検証する。
