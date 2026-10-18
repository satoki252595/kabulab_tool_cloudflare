# 本番定期処理とSSHでの補完

確認日: 2026-10-18。対象: main `eb0484b67e9157c5fad131ae43971a5438ac79fc` と既存Mac設定。
時刻はJST、Cloudflareは起動・結果監視、重い取込本体はActionsまたはMacで実行する。
設定上の予定と、実行成功・全銘柄のデータ充足は別に確認する。

| 処理 | 予定時刻・頻度 | 本体と保存先 | SSH/Linuxでの実行・過去分 |
|---|---|---|---|
| 日証金の貸借・需給 | 平日12:17 | `supply_daily.yml` / Python → Notion・D1・R2 | 実行可能。通常CLIは公表中のCSVを取得し、日付指定で任意の過去CSVを取り直す機能ではない |
| VWAP日足・5分足 | 月水金17:00、CF起動 | `vwap-ingest.yml` → `ingest:vwap-daily`、`ingest:vwap-intra` → R2、原本Notion | 実行可能。日足は10年窓で不足分を回収。一般の5分足は銘柄＋1〜60日窓を指定可能。任意from/toは既存422回復の固定5銘柄だけ。既存writerと同時起動しない |
| 市場の信用残高 | 平日17:00 | 同workflowの`ingest:vwap-margin` → R2、原本Notion | 実行可能。`--date=YYYYMMDD`対応、公開元に原本が残る日だけ |
| 株価・財務断面・RSI・スイング・モメンタム・業種騰落 | 平日18:00、CF起動 | `stock-sync.yml` / `sync:daily:core --stocks-only` → D1、原本Notion/R2 | 実行可能。ただし通常CLIに任意の過去日指定はない。保存原本の限定補完と最新日の通常更新を分ける |
| 東証33業種の対応 | 株式同期の成功後 | 同workflow / Python `sector33_sync` → D1、原本Notion | 実行可能。最新の公式提出者表と現在の銘柄を照合する処理 |
| 価格依存の業種別資金フロー | 株式同期の成功後、許容失敗もない場合だけ | `moneyflow.yml` / `only=sector-turnover` → Notion | 実行可能。`--as-of`対応、当日の全必要価格が保存済みであることが前提 |
| 価格非依存の資金フロー28取得元 | 平日18:15、CF起動 | `moneyflow.yml` / `only=independent` → Notion | 実行可能。月次・週次等の公表資料もこの日次入口で更新を検知。`--as-of`だけで全取得元の過去資料を指定できるわけではない |
| TDnet・有報の補完 | 平日19:00、CF起動 | `catchup.yml` / `ingest:ir-tdnet`、`ingest:yuho-edinet` → D1・Notion | 実行可能。有報の受注・海外・発行株数診断、保有明細/価格の保存待ちも同じ通常入口で再開。TDnet保存物の再開期間指定、有報の専用backfillあり |
| 事業タグ・39本文・競合の機械準備 | 毎日20:00、Mac LaunchAgent | `biztag-local/main.ts run biztag` → Notion・D1、receipt R2 | 本文等は機械処理。新規/入力変更の事業タグ判断だけローカルClef-Flash/MPS。現Linux SSHへモデル処理を移さない。競合は準備のみ、意味判定の自動再開はしない |
| EDINET財務サマリ・原本 | 平日21:00 | `edinet_daily.yml` / Python → Notion・D1・R2 | 実行可能。`--date YYYY-MM-DD --require-cloud`で過去の提出日を指定できる。19時のNode有報処理とは別系統 |
| 優待要約 | 毎日21:00、Mac LaunchAgent | `biztag-local/main.ts run yutai-summary` → D1・Notion、receipt R2 | 定型は機械処理、残りだけ既存ローカルMLXモデル。モデルを含む通常入口はMac専用 |
| 鮮度・ジョブ・schema・ライセンス監視 | 毎日23:30 | `ops_check.yml` / Python → D1観測・GitHub Issue | 実行可能。ただし過去分のデータ補完ではなく、現在の保存状態を検査する処理 |
| 日米マクロ結合 | 火〜土06:00、CFの月〜金21:00 UTC起動 | `stock-sync.yml` / `sync:daily:core --context-only` → D1・R2・Notion | 実行可能。対応する予定日の保存済み日本市場原本が前提。任意過去日のマクロを最新値で再構成しない |
| EDINET銘柄マスタ | 毎月1日06:00 | `master_sync.yml` / Python → Notion・D1・R2 | 実行可能。現在の公式コード表を同期、任意過去時点のマスタ再現ではない |
| 母集団・優待原文・優待スコア | 毎月10日10:30 | `stock-sync.yml` / `sync:universe` → `yutai:fetch` → `sync:monthly:core` | 3段階とも実行可能。最新の母集団・原文・保存株価から再構築。要約は別のMac21時処理 |
| TDnet速報・上場状態 | 平日09:00〜19:00毎時 | `tdnet_hourly.yml` / Python → Notion・D1・R2 | 実行可能。`--date YYYY-MM-DD`対応、公表元の保存期間が前提。19時のNode補完とは別系統 |

CFの結果確認は株価/VWAP23:35、独立資金フロー23:45、開示20:05、マクロ07:05。
これらは再取込ではなく、予定日・受領run・実step・終了窓を確認する監視である。
月次の資金フロー資料は上表の28取得元に含まれ、別の月次Cronは置いていない。

## SSHに移す場合

2026-10-18 11:51時点のSSH cloneはmain `449a157a2275266926f4041ba029f648333a6fa3`。
最終修正をマージしてからfast-forwardし、既存flake/lockのNix環境で同じ通常CLIを使う。
現SSHのR2資格情報はraw/vwapの2bucket限定。追加取得に必要なEDINET・Yahoo proxy・Notion保管先の設定はまだ揃っておらず、全処理をそのまま起動できる状態ではない。
秘密値は表示/Git保存せず、必要な処理の設定だけをprivate `.env`へ渡す。

日足の10/15・10/16不足は、進行中の通常全量日足更新が履歴ごと回収する対象。
それと同じwriterをSSHで重複起動しない。終端summaryで未取得の銘柄/日だけを確定してから、必要な補完をSSHへ移す。
全履歴RAWのミラー、全市場の再取得、月次処理の一括再実行は、この不足2日を直すための必須作業ではない。

通常Node入口の例（必要設定・排他を確認してから実行する）:

```sh
nix develop --command pnpm ingest:vwap-daily
nix develop --command pnpm ingest:vwap-intra --codes=7531,9311 --range=60d
nix develop --command pnpm sync:daily:core --stocks-only
```

月次のLinux実行は`sync:universe`、`yutai:fetch`、`sync:monthly:core`の順。
`sync:monthly`はMacのモデル要約も束ねるためLinuxへの一括移管コマンドにしない。
Pythonの過去提出日補完はリポジトリのNix環境内で`pipeline`へ移り、
`uv run python -m jp_stock_pipeline.jobs.edinet_daily --date YYYY-MM-DD --require-cloud`を使う。

保有価格だけの補完は、既存CLIの`resume-prices`から定期EDINETと同じ価格queue/loaderを1回呼ぶ。
上限は100明細・5文書・116価格chunk・256MiB・新規開始300秒。有報一覧/Yahoo取得・L2再構築は行わない。
出力先の親directoryを用意し、`nix develop --command pnpm exec tsx scripts/notion/shareholdings.ts resume-prices tmp/holdings-prices/price-001.json`で実行する。
保留/続きありは非0終了でも、正常結果と`completed-write.json`がある場合だけ既知の未完として扱う。
`pending-write.json`や通信結果不明がある場合は、出力名を変えて自動再送せず原記録を保持する。

## 日足停止報告との照合

「#411未配備/CF起動ゼロ」は確定原因ではない。
[既存の実観測](test-logs/vwap-scheduler-session-20261015.md#2026-10-16-本番17時cronの秒ゼロ前提を修正)では
10/16 17:00:52のCF Cron発火と、旧時刻検査による例外を確認した。
17:00分の秒を許す通常共有guardへ修正済み。10/15木曜は月水金Cronの起動対象日ではない。
現在の配備・次の自然Cron成功・現在進行中の手動補完は、それぞれ分けて受け入れる。

EDINETの「未処理16件」は10/16 10:20 UTCの保存実logでは全件`identity_unresolved`。
実取込3件・全144.161秒で、件数60/開始予算300秒へ到達した記録ではない。
保有明細の未完も含む終了判定の`reachedCap`を「16件の取込上限」と読み替えない。
別の事業タグHOLD集合や、後日のEDINET未処理件数とは分ける。

11:53までの管理API確認では、main `eb0484b6` のCF build
`b12c9adf-d706-4e05-ac91-3bf47138bf4f`は成功し、02:42:27 UTCの配置ログで
月水金08:00/14:35 UTCの両trigger登録とWorker version
`8a021efa-10f7-407a-8d06-560d92262cdd`を確認した。#411と秒の検査を直した#432は現mainの祖先。
直近100件のVWAP Actionsと10/16の実jobでは、当日のschedule成功は信用残だけで、
日足/5分足のCF dispatch成功ではなかった。修正後の自然Cronは次の10/19月曜17時が未受入。
