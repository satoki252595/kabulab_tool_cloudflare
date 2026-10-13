# 株式・マクロ sync の CF スケジューラ

株式日次・マクロ sync の起動時刻を GitHub Actions schedule から Cloudflare Cron
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
- 10/1のマクロも予定21:00 UTCが翌00:25 UTCへ205分遅配した。
  日本市場の形成中バーとVI翌日の日付が入り、原本日付gateが正しくHOLDした。
  マクロ起動もCFへ移し、株式とは独立したreceiptと期限確認を持つ。

## 設計

CF cron 4 本 (`wrangler.toml` `[triggers]`、曜日は `MON-FRI` 名前指定。
CF の数字曜日は 1=日曜で GitHub と違うため):

| cron (UTC) | 処理 (`src/scheduler/stock.ts`) |
|---|---|
| `0 9 * * MON-FRI` | R2 receipt を claim → workflow_dispatch POST → run 詳細を CAS 保存（18:00 JST。取引日 D の当日） |
| `35 14 * * MON-FRI` | 期限 readcheck (receipt + Jobs API で完了検証。成功以外は error。23:35 JST) |
| `0 21 * * MON-FRI` | `scheduled-context` をdispatch。株式・sector33・moneyflowは起動しない |
| `5 22 * * MON-FRI` | 専用context receiptのrunを読み、同日のcontext成功と22:00完了期限を検証 |

2026-10-09 に株式 dispatch を `13 17`（02:13 JST）から `0 9`（18:00 JST）へ移した。
02:13 JST は、取引日 D の ^N225 日足 close が null になる時間帯（D 23:30 JST 以降。
D=2026-10-08 の原文で 00:15 以降が null）の中だった。全銘柄 run の最悪所要は
[stock-sync-asof-2026-09-28.md](./test-logs/stock-sync-asof-2026-09-28.md) の実測最大
190.95 分（約 191 分。run 35669787483）。18:00 開始なら最悪 21:11 JST 終了で、
23:30 まで 139 分ある。別 run の最大遅延と最大実行を足した 197.41 分でも 21:17 JST、
余裕は約 133 分。終値の有無を実測したのは D 21:15 と 23:30 だけで、18:00 を含む
15:30〜21:15 は未計測。開始時刻は実測の結果で変わりうる。21:15 以降に始めると
191 分では 23:30 前に終わらない（21:15 開始の最悪終了は翌日 00:26 JST）。

- POST 前ガード: 未知 cron・未来・土日・UTC 日跨ぎ・開始期限
  (株式60分、マクロ30分) 超過
  は POST 前に error。既存の price guard・close guard・完了期限・失敗率
  1% 判定は不変。
- receipt: `stock-scheduler/receipt-<予定UTC日>.json` を `If-None-Match: *`
  で原子的 claim。取得者のみ POST。重複時は既存 receipt を読戻し、
  同予定日・dispatch cron・時刻妥当性 (同日・順序)・正の run ID・
  同一 repo/run URL の全部入りで dispatched のときだけ正常 duplicate
  (追加 POST 0)。claimed/破損は error 継続・再 POST なし。
  readcheck も同一 parse で統一。互換 fallback なし。
  POST 検証 (HTTP 200 + `workflow_run_id` / 同一 repo・run の `run_url` /
  `html_url`) 後に native `etagMatches` で CAS 保存。
- マクロreceiptは `stock-scheduler/context-receipt-<予定UTC日>.json`。
  株式と同日でも別claimとし、原本・成果・成功判定を混同しない。
  予定から30分を超えたマクロdispatchはPOST前に停止する。
- GitHub API は `User-Agent` 必須。Jobs 分頁は同一 origin/path・run 限定、
  循環検出・10 頁上限超過は error。run ID は正の整数のみ。
- pending・結果不明は成功にしない。自動再 POST なし (CAS 競合時は
  手動トリアージ。POST 済みのため再送しない)。
- secret・URL 値はログに出さない (run_id の数値のみ)。
- `scheduled_date` は共有 producer 入口 (`runDailySyncAndRecord`) で検証
  のみ。`STOCK_SYNC_TARGET=scheduled-stocks` のとき必須
  (欠落・空・空白は fetch 前に落とす)。手動 stocks 未指定は現契約維持。
  時刻のバックデート・原本日付の上書きなし。
- 新 dispatch target `scheduled-stocks` は株式 only。moneyflow selector は
  旧 scheduled と同じ空文字 (全 sources)。手動 `stocks` の
  sector-turnover 限定は維持。
- `scheduled-context` は日付が必須。Node入口は予定日21:00〜21:30 UTCだけ
  開始を許可し、GSPC確定日が予定日と一致することを既存原本gateに追加する。
  N225/VIX/VIの同日・必須値・物理保管は既存条件を保持する。保管後に
  22:00を超えた場合はD1保存を止める。古い確定日を予定日へ置換しない。
- マクロreadcheckはsync jobとcontext stepの一意な成功、同日21:00〜22:00
  の完了、株式stepとmoneyflow jobのskipを全て要求する。HOLDは成功にしない。
- readcheck 成功条件: job `sync` が completed・success かつ `stock daily
  sync` が success・completed_at が同日 09:00〜14:30 UTC (古い別日の
  成功を通さない。14:30 UTC は D 23:30 JST で、それより後は null 帯に
  入った完了なので成功にしない。旧上限 21:00 UTC からは縮めた)、かつ `許容内失敗があれば Issue にコメント` が
  SKIPPED (success = 許容内失敗ありの false-green。step 欠落も error)。
  検証対象は receipt の run ID と照合する。Dispatch 受付は同期完了でない。
- 既存の Notion 完了/失敗バッチ・Actions 通知を再利用。新 table・DO・
  Issue 書き込み権限は不要。

## 受入

- `src/scheduler/*.test.ts`: 曜日・日跨ぎ・期限・重複・曖昧 POST・200 正常・
  target routing・date mismatch・false-green を固定 (mock のみ。live POST なし)。
- `pnpm typecheck` / `pnpm lint` / `wrangler deploy --dry-run` 成功。
- [PR #283](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/283) は資格設定後にmainへマージ済み。2026-10-03の本番version `d5027aee-ef18-4b34-b6c8-da87ea37b22f` はmerged SHA `f53e572928b8d73b800a7b1693571a7c2d1f84d3` に対応し、100%配信を確認した。
- 自動定時実行の受入は、次の平日のdispatch receipt・Actions run・readcheckの実成功で判定する。設定済み・デプロイ済みをデータ更新完了とは扱わない。

## 制限

- Workers Paid で運用する。scheduled は全銘柄の処理を行わず、日次
  各dispatchの R2 2 PUT + GitHub 1 POST と、各readcheckの R2 1 GET + Jobs API
  読取のみ。正常時は平日約22日で88回/月の cron 起動、R2 88 write +44 read
  程度となる (Jobs API のページ数・既存 workload の費用は別計数)。
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
4. 翌平日: 株式09:00/14:35、マクロ21:00/22:05のreceipt・run・readcheckを確認する。
   株式 step の完了が 14:30 UTC（23:30 JST）より後なら readcheck は失敗する。
5. 異常時: Cron Events / Workers Logs の error を見て手動トリアージする。
   自動再 POST はしない。
