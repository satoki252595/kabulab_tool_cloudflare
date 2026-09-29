# 株式 sync の CF スケジューラ

株式日次 sync の起動時刻を GitHub Actions schedule から Cloudflare Cron
Trigger へ移す。実実行は従来どおり GitHub Actions (`stock-sync.yml`
`workflow_dispatch`)。設計は GPT-sol read-only 計画、実装は本 PR。

## 原因

- 旧 GH 株式 schedule (平日 17:13 UTC) が 250/318 分のイベント生成遅配を
  2 回連続で起こした。runner 待ちは 3 秒で、遅れは runner 不足ではなく
  schedule イベント生成側だった。
- 06:00 JST 基準 guard が正しく STOP し、遅配 run の D1 保存は起きていない
  (欠測として正しく残った)。
- cron 前倒しは Yahoo 確定証拠なしで不採用。起動時刻の信頼性を CF 側へ
  移すことで根本対策する (旧方式廃止はユーザー許可済み)。

## 設計

CF cron 2 本 (`wrangler.toml` `[triggers]`、曜日は `MON-FRI` 名前指定。
CF の数字曜日は 1=日曜で GitHub と違うため):

| cron (UTC) | 処理 (`src/scheduler/stock.ts`) |
|---|---|
| `13 17 * * MON-FRI` | R2 receipt を claim → workflow_dispatch POST → run 詳細を CAS 保存 |
| `5 21 * * MON-FRI` | 期限 readcheck (receipt + Jobs API で完了検証。成功以外は error) |

- POST 前ガード: 未知 cron・未来・土日・UTC 日跨ぎ・開始期限 (60 分) 超過
  は POST 前に error。既存の price guard・close guard・完了期限・失敗率
  1% 判定は不変。
- receipt: `stock-scheduler/receipt-<予定UTC日>.json` を `If-None-Match: *`
  で原子的 claim。取得者のみ POST。同時・逐次の二重 dispatch は追加
  POST 0 (accepted duplicate)。POST 検証 (HTTP 200 + `workflow_run_id` /
  `run_url` / `html_url`) 後に `If-Match` で CAS 保存。
- pending・結果不明は成功にしない。自動再 POST なし (CAS 競合時は
  手動トリアージ。POST 済みのため再送しない)。
- secret・URL 値はログに出さない (run_id の数値のみ)。
- `scheduled_date` は共有 producer 入口 (`runDailySyncAndRecord`) で形式と
  対象日一致だけを検証する。時刻のバックデート・原本日付の上書きなし。
- 新 dispatch target `scheduled-stocks` は株式 only。moneyflow selector は
  旧 scheduled と同じ空文字 (全 sources)。手動 `stocks` の
  sector-turnover 限定は維持。
- readcheck 成功条件: job `sync` が completed・success かつ `stock daily
  sync` が success・completed_at が 21:00 UTC 以前、かつ
  `許容内失敗があれば Issue にコメント` が SKIPPED (success = 許容内失敗
  ありの false-green。step 欠落も error)。Dispatch 受付は同期完了でない。
- 既存の Notion 完了/失敗バッチ・Actions 通知を再利用。新 table・DO・
  Issue 書き込み権限は不要。

## 受入

- `src/scheduler/*.test.ts`: 曜日・日跨ぎ・期限・重複・曖昧 POST・200 正常・
  target routing・date mismatch・false-green を固定 (mock のみ。live POST なし)。
- `pnpm typecheck` / `pnpm lint` / `wrangler deploy --dry-run` 成功。
- PR の CI 3 緑。**PR は資格設定待ちで未 merge** (下記手順の後、Root が merge)。
- merge 後: 翌平日の dispatch receipt・Actions run・readcheck OK を確認する。

## 制限

- Free プラン: cron 1 回あたり CPU 10ms・subrequest 50・cron 5 個/アカウント
  (公式 Limits)。本処理は R2 1〜2 回 + GitHub API 数回で十分収まる。
  cron 変更の伝播には最大 15 分かかる。
- 祝日: 共有営業日カレンダーは無い。現 producer 仕様どおり、原本の当日
  実終値なしは明示 failure のまま (N225 前日/null を休場推定して skip 成功
  には変えない)。`scheduled_date` は検証のみ。祝日 failure → readcheck
  error の経路を維持し、公式 JPX 休業日正本が入るまで別対応とする。
- `GITHUB_ACTIONS_TOKEN` 未設定の Worker では scheduled が即 error
  (fail-closed)。既存 gh OAuth を Worker へ移さない。

## 手順 (Root・ユーザー向け)

1. ユーザー: この repo 限定の Actions 読み書きトークンを新規発行する
   (既存トークンの権限拡大はしない)。
2. Root: `wrangler secret put GITHUB_ACTIONS_TOKEN` で Worker に登録する
   (値はログ・PR・Issue に出さない)。
3. Root: 本 PR をレビュー後 merge する (既存 cron を先に止めない。
   削除は本 PR に含まれる)。
4. 翌平日 17:13 UTC 以降: receipt・dispatch run・21:05 readcheck OK を確認する。
5. 異常時: Cron Events / Workers Logs の error を見て手動トリアージする。
   自動再 POST はしない。
