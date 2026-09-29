# 株式 sync CF スケジューラ — 検証記録 (2026-09-30)

## 対象

`src/scheduler/stock.ts` (dispatch + 期限 readcheck)、`worker/entry.ts`
scheduled 配線、`wrangler.toml` `[triggers]`、`stock-sync.yml`
(旧株式 cron 廃止・`scheduled-stocks` + `scheduled_date` 追加)、
`assertScheduledDate` (producer 入口検証)、`.env.example` キー追加。

## 検証 (Nix・mock のみ。live POST なし)

- `pnpm vitest run src/scheduler/`: 32 件 PASS
  (曜日・日跨ぎ・期限・重複・曖昧 POST・200 正常・CAS 競合・target routing・
  false-green・秘密非出力)。
- `pnpm vitest run src/cron/daily-mode.test.ts`: 8 件 PASS
  (既存 6 + `SCHEDULED_DATE` 検証 2。fetch 前停止を確認)。
- `pnpm typecheck` / `pnpm lint`: 成功。
- `wrangler deploy --dry-run`: 成功 (`[triggers]` 2 cron 含む)。
- 全体 `pnpm test` は CI で確認。

## 公式仕様の確認 (read-only 参照)

- CF Cron Triggers: UTC、`controller.cron`/`scheduledTime`、曜日は
  1=日曜のため `MON-FRI` 名前指定。Free は CPU 10ms/cron・subrequest 50。
- R2 `put` + `onlyIf: If-None-Match: *`: 既存時 null (claim)。
  `If-Match` で CAS 保存。
- GitHub workflow_dispatch: `X-GitHub-Api-Version: 2026-03-10`、
  HTTP 200 + `workflow_run_id`/`run_url`/`html_url` を検証。
  `return_run_details: true` を body に付与 (plan 指定)。
- Jobs API: `GET .../runs/{id}/jobs?per_page=100` + Link 分頁。
  step conclusion `skipped` で許容内失敗なしを判定。

## 未実施 (Root 引き継ぎ)

- `GITHUB_ACTIONS_TOKEN` の発行・Worker 登録なし (資格なし)。
- live dispatch POST・本番 cron 発火なし。
- PR は未 merge (資格設定待ち)。既存 cron は稼働中のまま。
