# kabulab 費用確認 — 2026-10-01

## 判断と対象

Workers Paid の既存契約を使えば、株式・マクロの定時起動移行のために新しい
Cloudflare プランやサーバを購入する必要はない。正常起動時の追加処理は月88回の
Worker 実行と R2 操作で、既知の通常取込もリクエスト数・R2 操作数は少ない。
2026-10-01〜02の認証済みダッシュボード読取で、現在の請求期間の requests・CPU・
D1 read/write/保存・R2 A/B/Standard保存・Builds、および最後30日の Logs が各包含枠内に
あることを確認した。Billingの使用量はaccount集計で、サービス別の帰属はできない。
この確認範囲では追加請求対象はなく、既知の通常負荷を理由に上位プランへ変更する
根拠はない。外部AI・Notionなど未確認の費用を含めた
「全費用が必ず $5/月」「将来の追加費用も必ず $0」とは結論しない。

- 通常負荷表の起点: main `7f1442972793051882d4c2d15771348eb6e4c647`。
  Yahoo原文保管修正は[PR #256](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/256)、
  main `380e931e2305d9871e430cfccea3aa033c468e89`。追加負荷を末尾へ分けた。
- 定時起動変更: [PR #195](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/195)。
  専用repo限定PATをWorker Secretへ設定し、3CI成功後にmain `4440e78`へmerge済み。
  自動deploy・traffic100%・4 Cron登録を確認した。株式・マクロ計4 Cronの負荷表は
  変更なし。株式の真正定時dispatch/receiptとproducer開始を確認したが、
  対象日の日経平均終値欠落で個別株取得前に停止した。後続の真正マクロdispatchと
  株式・マクロ期限確認も発火・失敗検知を確認したが、producer保存成功は未受入。
  [後続実績](./test-logs/stock-macro-deadline-20261003.md)
  [本番設定受入](./test-logs/stock-scheduler-production-20261002.md)
- 料金・制限の取得日: **2026-10-01**。金額は USD、税・為替換算を含めない。
- ユーザーの Paid 契約申告に加え、認証済みダッシュボード読取で Workers Paid を確認。
  請求画面・個人情報・他サービスの利用額は私有証跡とし公開 Git に保存しない。
- GitHub API で当該 repo の `visibility=public` を確認。認証値を公開せず、
  費用確認のためのプラン購入・設定変更・ジョブ起動は行っていない。
  通常ジョブ検証・本番修復は[別記録](./test-logs/remaining-ops-20261002.md)に分ける。

## Cloudflare の料金

Workers Paid は **アカウントにつき最低 $5/月**。Web サイトの Free/Pro/Business
とは別契約である。複数 Worker があっても各 Worker に $5 を足さず、含まれる枠を
アカウント内で共有して判断する。今回その契約は既存なので、新規購買額ではない。
[公式 Workers 料金](https://developers.cloudflare.com/workers/platform/pricing/)

| 項目 | 含まれる量/月 | 超過単価 |
|---|---:|---:|
| Worker 動的リクエスト | 10,000,000 | $0.30 / 1,000,000 |
| Worker CPU 時間 | 30,000,000 ms | $0.02 / 1,000,000 ms |
| Workers Logs 保存イベント | 20,000,000 | $0.60 / 1,000,000 |
| Workers Builds | 6,000 分 | $0.005 / 分 |
| D1 rows read | 25,000,000,000 | $0.001 / 1,000,000 行 |
| D1 rows written | 50,000,000 | $1.00 / 1,000,000 行 |
| D1 保存容量（全 DB 合計） | 5 GB | $0.75 / GB-month |
| R2 Standard 保存容量 | 10 GB-month | $0.015 / GB-month |
| R2 Standard Class A | 1,000,000 | $4.50 / 1,000,000 操作 |
| R2 Standard Class B | 10,000,000 | $0.36 / 1,000,000 操作 |

表の根拠は上記 Workers 料金、[Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/#pricing)、
[Builds](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/)、
[D1](https://developers.cloudflare.com/d1/platform/pricing/)、
[R2](https://developers.cloudflare.com/r2/pricing/)。Logs の Paid 保持期間は 7 日、
Builds は 1 build 最大 20 分・同時 6 件。GitHub Actions の分数は Builds の分数へ足さない。

Worker の外向き subrequest と待機時間には Worker リクエスト/CPU と同じ課金を
足さない。D1・R2 に行った操作は各製品の料金として別に数える。静的 assets 配信は
無料だが、SSR/API の動的実行と混同しない。
[Workers 料金の定義](https://developers.cloudflare.com/workers/platform/pricing/)

D1 は返却行数ではなく **走査行数** が read、INSERT/UPDATE/DELETE と索引更新が
write を増やす。表だけでなく索引も容量に含まれる。Paid の 1 DB 上限は 10 GB、
アカウント上限は 1 TB、SQL の実行上限は 30 秒。5 GB は無料の合計保存枠であり、
1 DB のハード上限ではない。[D1 料金](https://developers.cloudflare.com/d1/platform/pricing/)、
[D1 制限](https://developers.cloudflare.com/d1/platform/limits/)

R2 Infrequent Access は無料枠の対象外。保存 $0.01/GB-month、Class A $9/M、
Class B $0.90/M、取得 $0.01/GB、最低保存期間 30 日。頻繁に全ファイルを
read-merge-write する `vwap-data` を安易に IA に移すと読み出し料金が増える。
Standard/IA ともインターネット egress は無料。R2 は GB-month・操作の百万単位を
切り上げるため、枠をわずかに超えても比例計算だけでは請求と一致しない。
[R2 料金・丸め・保存クラス](https://developers.cloudflare.com/r2/pricing/)

## 既知の頻度からの月次見込み

これは **正常取得・同じ母集団・再実行なし** の負荷計算であり、月間実測ではない。
2026-10 の暦では平日 22 日、月水金 13 日。祝日でジョブが発火しないとは仮定しない。
母集団 `N=3,695` は直近の保存済み実運用記録
([VWAP 記録](./test-logs/vwap-repair3-actual-20261001.md)、
[完了検査](./test-logs/vwap-cli-completion-20261001.md)) を使った負荷の断面。
全銘柄更新の成功や今後も N が同じことを意味しない。

| 経路 | 計算式 | 10月の正常処理見込み |
|---|---|---:|
| stock-sync Yahoo Chart + QuoteSummary | `N × 22 × 2` | 162,580 proxy GET |
| VWAP 日足 + 5分足 Yahoo Chart | `N × 13 × 2` | 96,070 proxy GET |
| 上記の合計 | `N × (44 + 26)` | 258,650 Worker inbound requests |
| VWAP 日足 + 5分足 R2 | `N × 13 × 2` | GET 96,070、PUT 最大 96,070 |
| 信用残日次 R2 | `22 × (GET 最大4 + PUT 最大2)` | GET 最大 88、PUT 最大 44 |
| 株式・マクロ スケジューラ | `22 × 4` | Cron 88 起動、PUT 88、GET 44 |

stock-sync の取得実装は [daily.ts](../src/cron/daily.ts) と
[Yahoo client](../src/shared/yahoo/client.ts)。VWAP は
[日足](../scripts/vwap/ingest-daily.ts)、[5分足](../scripts/vwap/ingest-intra.ts)、
[信用残](../scripts/vwap/ingest-margin.ts)、定期頻度は
[stock-sync workflow](../.github/workflows/stock-sync.yml) と
[VWAP workflow](../.github/workflows/vwap-ingest.yml)。日足は毎回 10y を取得する。
R2 の同値 skip があるので PUT は上限側の値である。

株式は17:13 UTCにdispatch・21:05に完了確認、マクロは21:00にdispatch・22:05に
完了確認する。正常な1日は各経路のR2 claim PUT + 結果 PUT + 完了確認 GETで、
計4 PUT + 2 GET。株式とマクロのreceiptは別キーで、22平日では44件/月、保存容量の
増分は数十KB程度の想定となる。receiptの累積容量は別に確認する。
実同期は従来のActionsのままで、旧株式・マクロGitHub cronは除く。
receiptによる重複拒否と再 POST禁止を保てば
同期件数を二倍にしない。GitHub Jobs 読取は最大 10 ページに限定されている。
[PR #195](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/195)

上記だけなら R2 は Class A 最大 96,202、Class B 最大 96,202/月。
含まれる操作枠の約 9.62% / 0.96%であり、proxy は Worker リクエスト枠の約 2.59%。
この断面にマクロ本体の取得・保管、初回/修復、再取得、公開ページ/API のアクセス、他 Worker、
`jp-stock-raw` / `jp-stock-supply` の処理、R2 list/head/multipart は含めていない。
これらを 0 と扱わず実測へ加算する。

CPU は `requests × 実平均 CPU ms` で求める。仮に上記 258,650 requests の
平均 CPU を 10 / 50 / 100 ms と置けば 2.587 / 12.933 / 25.865 Mms。
**この平均 CPU は感度を見る仮定値で、実測値ではない。** HTTP の所要秒数を CPU
時間に変換しない。Cron には専用固定月額を足さず、起動・CPU・利用した製品を数える。
[CPU の定義と Cron 制限](https://developers.cloudflare.com/workers/platform/limits/#cpu-time)

## 費用を増やす経路と既存の歯止め

| 経路 | 現コードの事実 | 判断・最小対応 |
|---|---|---|
| 公開 SSR/API の増加 | `kabulab-cf`、`jss-api-public`、`jss-api-private` が同じ D1 を使う | 取込回数だけから総額を確定せず、Worker 別 request/CPU と D1 row metrics を見る |
| 全量再実行 | VWAP 日足は 10y/銘柄。stock-sync は Chart + QuoteSummary、OHLCV は増分保存・90本保持 | 失敗修復は対象限定の既存入口を使う。全銘柄反復実行や保持延長を新規に追加しない |
| 取得再試行 | 5分足は最大3試行。429/503と404は即再送しない。連続 rate limit で中断 | 正常月次表へ試行回数を混ぜない。再実行数と異常時の追加 GET を別集計 |
| R2 書込/一覧/保管増加 | GET→全体PUT、保管 summary、日次margin、原本バケットがある | Class A・storage と保存クラスを確認。大量 list/multipart/IA 遷移は別見積り |
| Workers Logs | `wrangler.toml` は invocation logs有効、`head_sampling_rate=1`、traces無効。jss-apiもobservability有効 | 障害調査に必要な全ログを維持。実 event数で判断し、sampling変更は提案のみ |
| CPU の高い公開呼出し | repo の3 Worker configに明示 `limits.cpu_ms` がない | ダッシュボードの現在値・CPU p95/p99・最大値を確認し、必要時だけ値を提案。独断で上限を下げない |
| CI/Build の反復 | CIは同refの前runをcancel。外部GitHub CIとCloudflare Buildsは別 | Build分数を確認。必要時は既存build watch pathsで無関係変更を除く案を検討 |
| AI判定の反復 | biztag差分処理、同入力のmemo、競合 `--only-unjudged` がある | `--force`等の全再判定前に対象件数とtoken予算を確認。時間予算を金額上限とは呼ばない |

R2 PUT は SDK 内部も 1 試行で、曖昧な送信結果を自動再送しない
([R2 helper](../scripts/vwap/lib/r2.ts))。Notion アーカイブも key の冪等性を持つ。
これらは不要な書込と重複原本を防ぐが、公開アクセス全体の月額上限ではない。

過去の全財務修復では source D1 の返却 meta が read 169,121 / write 138,452
だった ([修復記録](./test-logs/financial-context-unit-2026-09-28.md))。
仮に無料枠を既に消費し尽くしても、この write の単価計算は約 $0.1385。
この履歴の数字を毎日の恒常負荷や現在の月間利用量には流用しない。

## 上限と監視

Cloudflare Budget Alerts は超過を**通知するだけ**で、処理や請求を停止しない。
通知はアカウント単位の従量料金が対象で、固定契約料は含まない。公式には $10 の
既定通知の展開も告知されている。2026-10-02の認証済画面でこのアカウントの
Budget Alerts設定済みを確認した。日次処理なので翌日の通知になる。
設定・受信先の個別値は私有証跡とし、今回変更は行っていない。
[Budget Alerts](https://developers.cloudflare.com/billing/manage/budget-alerts/)、
[既定通知の告知](https://developers.cloudflare.com/changelog/post/2026-06-15-budget-alerts-default-on/)

CPU 制限は**1 invocation の上限**で、月間総額の hard cap ではない。Paid HTTP は
既定30秒、最大5分。Cronは1時間未満間隔なら30秒、それ以上なら15分。
I/O待機はCPUに含まれない。高額化の防止は CPU 上限だけでなく、認証・許容ルート・
回数・対象件数・冪等性で行う。[Workers 制限](https://developers.cloudflare.com/workers/platform/limits/)

請求期間を合わせた集計は Billing > Billable Usage で確認する。ここに表示されるのは
**従量超過**で、固定契約料を含まない。暦月の単純日割りと混同しない。
[Billable Usage](https://developers.cloudflare.com/billing/manage/billable-usage/)

## GitHub・外部 API・Notion

- **GitHub Actions**: 当該 repo は public、既存の定期 job は `ubuntu-latest` の
  標準 runnerなので実行分数は無料。larger runner・artifact/cache保存・privateへの
  変更は別料金条件。private変更時は現在のLinux 2-core超過単価 $0.006/分を使い、
  jobごとの分切上げ・含まれる枠・保存量を再計算する。現repoの定期実行だけを理由に
  有料runnerへ変更する必要はない。
  [Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)、
  [runner料金](https://docs.github.com/en/billing/reference/actions-runner-pricing)
- **TypeSafe Jev**: 2026-10-03の利用者方針で、今後追加される適格な新規銘柄の
  初回事業タグもローカルSemIfへ変更する。TypeSafeの外部判定は停止を維持し、
  有料APIへの自動切替やcredit補充は不要。既存の判定済みタグ・AI根拠は銘柄コードで
  再利用し、有報/語彙変更でも付け直さない。未設定/判定失敗だけkeywords/excludesで
  不足を補完する。語彙審査・定期精度測定・競合判定は再開せず、本文資格不足はHOLDで
  既存結果を保持する。旧課金切れ25件は機械照合で補完・独立保存確認まで完了した。
  [実績](./test-logs/biztag-existing25-actual-20261002.md)
  以下の一括費用は**旧仕様の記録**であり、現在の新規銘柄だけの月額見積りではない。
  公式 Jev 1.13 は入力 $0.042/Mtokens、出力無料。
  [client定数](../src/shared/jev/client.ts) と
  [見積式](../src/shared/jev/stats.ts) が一致。`費用 = 実入力tokens / 1,000,000 × 0.042`。
  既存の過去20社670,382入力tokensから全3,607社へ比例した $5.08 は一括実行の
  過去推定であり、月額実測ではない
  ([既存記録 §12.8](./005-yuho-quant-business-tags.md))。`budget-min=20` は時間制限で、
  停止前はdry-runでも判定APIを呼び、既定最大3 retryは最大4送信になった。曖昧な失敗で提供側に
  課金された量が成功応答のtoken集計に出ない可能性があり、過去分の請求は未測定。
  新規初回をJevへ限定していた時点ではclientの同run再送を0にし、専用markerのある
  失敗だけ次回の上限付きretry対象にしていた。
  認証済consoleの2026-10-02読取ではtop-upの最低購入単位は$5。
  今回の調査で購入・有料probeは行っていない。現行の`run --dry-run`は新規初回を
  明示HOLDにして有料判定を呼ばず、機械判定へも置き換えない。
  [TypeSafe公式モデル料金](https://docs.typesafe.ai/models)
- **SemIf**: 利用者指定により、既存のMac/MLX環境とモデルcacheを新規初回事業タグへ
  再利用する。ローカル推論に外部API従量料はなく、新規プラン・runner購入は不要。
  端末・電力・稼働時間まで無料とはしない。移行時の実データ較正を定期ジョブへ追加せず、
  適格な新規初回が0件ならモデルも起動しない。
  移行較正は実87社・858ラベル、研究2resident・94calls・183,180msで完了し、
  外部判定API・本番タグwriteは0。これは研究phaseの経過時間の和で、月間実測・
  電力代・本番1runの所要時間ではない。ローカル費用は未計測として保持する。
  [SemIf公式リポジトリ](https://github.com/TheoLeeCJ/SemIf-OpenJev)、
  [Mac定時運用](./005-biztag-local-runtime.md)
- **Cursor/外部生成AI**: 単語帳の年次レビューや優待要約はrepo外のautomationを
  利用する。Cloudflare Paidに含まれず、契約・実使用量が未取得なので金額未確定。
  [年次レビューの既存手順](./005-yuho-quant-business-tags.md)、
  [優待要約の契約](../services/otakara-yutai/docs/llm-summary-task.md)
- **Notion**: 2026-10-02の認証済み請求画面で、既存Plus契約とBusiness trialの併存を
  確認した。試用終了後は既存プランの継続を選べる。個別の契約額・更新日・seat数は
  私有証跡へ保存した。今回の残件対応のための新規アップグレードは不要。
  Paidはmemberごとの契約で、API呼出し量だけから月額を算出しない。
  [Notion料金](https://www.notion.com/pricing)
  APIはBusiness/Enterprise 600 req/min、他180 req/min、workspace共有の制限もある。
  Free複数memberは lifetime 1,000 blocks、Paid/single-member Freeは無制限。
  現契約を確認せずこの制限が直ちに該当するとは決めない。
  [API制限](https://developers.notion.com/reference/request-limits)、
  [workspace制限](https://developers.notion.com/reference/workspace-block-limits)
- **CoinGecko等**: `COINGECKO_DEMO_API_KEY` は任意のDemoキーで、今回追加の有料
  契約はない。匿名/無料のrate limitから有料プランへの自動移行は行っていない。

## 実測と最終判定に必要な値

未取得は 0 ではない。秘密・請求書・他サービス財務を公開 Git に置かず、
サービス固有の計数と検査日時だけを残す。アカウント全体の使用枠は私有で確認する。

| 確認対象 | 本書作成時の状態 |
|---|---|
| Workers Paid契約 | 認証済ダッシュボード読取で確認済み |
| Worker requests・CPU | 認証済画面で包含枠内確認。account集計でservice別帰属不可、実数は私有 |
| Workers Logs | 認証済画面の最後30日が包含枠内。account集計と対象Workerを確認、実数は私有 |
| D1容量・rows read/write | 認証済画面で包含枠内確認。account集計で当該DB別帰属不可、実数は私有 |
| R2 Standard容量・A/B | 認証済画面で包含枠内確認。account集計でbucket別帰属不可、実数は私有 |
| R2 IA容量・retrieval | 使用状態未確認、Standard表で代用しない |
| Workers Builds | 認証済画面で包含枠内確認。account集計でproject別帰属不可 |
| GitHub runnerとvisibility | public/標準ubuntuを確認済み。保存課金は未確認 |
| Jev入力tokens・credit・請求、Notion現在契約 | 新規初回もSemIfへ変更する方針でJev通信停止・credit補充不要。既存保存タグは再利用し、不足補完/旧25件の有料呼出し0。過去月間請求は未取得。Notion既存Plus契約＋Business trialを認証済みで確認 |
| 既存Budget Alerts | 認証済画面で設定済み確認。hard capではなく通知のみ、変更なし |
| 現在のCPU limits | ダッシュボード値は未取得。設定変更なし |

月次概算は各製品の `max(使用量 − 含まれる量, 0) × 単価` の合計に
既存 Workers $5 とその他の契約料を足す。R2は上記の切上げとIA条件を適用する。
この合計は **アカウントの既存枠をどう消費するか** に依存するため、serviceだけの
追加処理を丸ごと無料枠と比較した値を請求額としては出さない。

Logsの新料金acceptance画面は未受諾のまま。画面には20M超過時に受諾しない場合の
samplingが記載されているが、現在は枠内なのでこの調査で受諾・sampling変更は行わない。
最後30日のObservability集計と請求期間は一致するとは限らず、将来の超過判定では
対象期間と適用状態を再確認する。

本調査で料金変更・ログ削減・CPU上限変更・新規購買は行っていない。
service別実測を取得したら、検査日時・serviceの計数・確定範囲を追記して判断を更新する。

## Yahoo原文保管の追加負荷

2026-10-02に通常株価・VWAPの最終Yahoo応答本文の保管欠落を確認し、同じHTTP応答を
gzipへまとめて共有Notionへ保管する修正を進めた。追加のYahoo GET、D1/R2への原文書込は
増やさず、圧縮はNodeで実行する。上の通常負荷表とは別にNotion保存とrunner時間が増える。
[実装・測定と限界](./test-logs/yahoo-raw-custody-20261002.md)を正本にする。

既存Chart54件を全bytes/SHA照合したオフラインgzip測定から、株式Chartだけの外挿は
約85.6 MB/日、約1.88 GB/22回、約660保管ページ/月。標本は全銘柄の代表性を保証せず、
QuoteSummary・回収・実本番wrapperの全metadataを含めない。VWAPの10年/5分足原文は
全量実測前で、同じ圧縮率を適用しない。

原文保管修正時のVWAPはfetch並列5で最大30銘柄/8 MiB到達までまとめる設計だった。
現mainでは[PR #269](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/269)で
上流への取得負荷を抑えるため並列1・実HTTP間隔1秒へ変更し、最大30銘柄/8 MiBの保管上限は維持した。
以下の過去試算は同じ保管batch上限によるもので、取得所要時間の実測ではない。各batchが1添付で足りる
正常シナリオなら `ceil(3695/30)×13×2 = 3,224` ページ/月、約19,344 Notion API呼出。
既存380 ms limiterの間隔相当は約2.04時間/月（保守2.5 req/sでは約2.15時間）。
5銘柄ずつ保管する案の約19,214ページ/月より約83%減る。8 MiB分割、初回探索、転送、
429待機は別であり、これは実測所要時間でも保存件数の確定上限でもない。

既存Notion Plusには[unlimited file uploads](https://www.notion.com/pricing)があり、今回の
修正のための追加契約は不要。ただし[1 DB 250,000行等の制限](https://www.notion.com/help/optimize-database-load-times-and-performance)
があるため、upload無制限を行数無制限とは解釈しない。原文を公開Actions artifactへ出さず、
標準public runnerの実行分数は無料。初回の実保存量・ページ数・所要時間を記録して
300分のjob期限を確認する。将来の利用増加・他サービス分の費用は現在の枠内観測から保証しない。

初回の[通常VWAP受入](./test-logs/vwap-normal-acceptance-20261002.md)では、
795応答の全原文105,967,254 bytesをgzip 38,145,883 bytes/27ページへ保管・全文照合した。
日足stepは9分1秒、769件保存後にYahoo認証の429で停止し、5分足は未起動。
この停止runの部分実測を全銘柄/月額へ比例外挿しない。429の保存本文はproxyの
Yahoo credential error経路であり、Cloudflare Paid包含枠の不足を示すものではない。

[PR #263](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/263)で、共通Yahoo
clientが429/期限付き503の絶対再試行期限を失わないよう修正し、株式回収・VWAPは
その期限を短縮して新規取得を始めない。期限のあるVWAP制限では次の取得波を停止し、
同じ応答の原文・Retry-Afterを保管する。異常時の不要な取得を減らす修正であり、
提供元の制限解除・全件取込の成功・月額の固定を保証するものではない。

信用残の通常業種集計は[実行記録](./test-logs/moneyflow-margin-normal-20261002.md)で
476件の記録と全件照合まで完了した。保存済み9/30の入力を使い、JPX原本の追加GETは0。
入力2ファイルの実体保管と独立全文照合も完了した。単発の受入検証を月間負荷へ足さず、
既存プラン内という現在の判断は、上記の確認範囲と観測時点に限定する。

海外売上の[固定15文書の原本検証](./test-logs/overseas-next15-custody-20261002.md)では、
未保管13文書を各1回取得し、原ZIP合計16,940,276 bytesを共有Notionへ実体保管・全文照合した。
既存2文書は読取だけで再取得・再アップロード0。実通信はsource13／Notion83／hosted15で、
この段階のCloudflare D1/R2通信・更新は0。全文の数値資格9／保留6を本番修復完了とは扱わない。
この単発原本確認を月額へ外挿したり、原本不足を理由に新たな有料プランを購入したりしていない。

その後の[固定13資格の実反映](./test-logs/overseas-qualified13-actual-20261002.md)は
9文書更新・4文書同値、apply D1 142回/169 SQL、応答metaのread2,554/write328。
仮に包含枠を使い切っていても、このread/write単価計算は合計約$0.000331で、
DB保存量・税・他経路は別である。PRE/POSTの新規Notion添付は計450,825 bytes、
Notion呼出はPRE8/apply8、原本再取得・原ZIP/PRE再アップロード・R2通信は0。
既存Plusで追加契約は不要。D1所要時間をWorker CPU料金へ換算せず、単発実績を月額へ外挿しない。

## 10/3 JSTの有報補修実量

本文欠落4社のCSV/XBRLは全8ZIPを物理保管し、正準取込・Notion全文146節・参照4件・
派生確認・PRE/POSTの読戻しまで完了した。受信保存済みD1 metaの合計は
HTTP20回、SQL60文、rows_read3,185 / rows_written478、max_attempts1。
これらはAPI計数で文書・本文の件数とは別で、月額料金への外挿はしない。
実XBRL publisher GET4、TypeSafe0、R2 write0、再送0。
[原本と受入範囲](./test-logs/biztag-no-text94-20261002.md)。

Mac/Nixの真正通常処理は3,689件中3,685件をskipし、復旧4件だけ機械補完した。
実Notion109、rateLimited/transientRetries0、モデル/外部AI呼出し0。
独立POSTの実Notion48・D1 SELECT4と物理保管を含むMac受入の累計は
Notion212/hosted2。GH/CF CLI内部HTTPと金融原本GET実回数は未計測のため別扱いとする。
NixへGitを追加したが、新規プラン購入・有料AI credit補充は0。
ローカル機器の電力・減価償却を無料とは扱わない。
[定時処理の実績](./test-logs/biztag-semif-new-stock-20261003.md)。

[本文2通の限定修復](./test-logs/yuho-text2-roundtrip-hold-20261003.md)では、公式一覧2 GET、
資格/PRE/POSTの物理保管・旧本文確認を含めてNotion44/hosted3、D1 SELECT6を観測した。
実保存試行のphaseはNotion20/D1 SELECT3/hosted1で、全文不一致を検出し既知の旧状態へ復旧。
新規原ZIP取得・R2 write・paid AI・同POST再送0、成功0を保留として記録する。
これは単発実績で、将来の保存量や月額へ外挿せず、追加契約・credit補充は行っていない。

後続の[可逆形式による再保存](./test-logs/yuho-text2-lossless-actual-20261003.md)では、
新PRE112memberを6,028,433 bytesのgzipへ物理保管・全文照合し、実Notion8/hosted1を観測した。
実置換・pointer更新・POST物理保管はNotion23/D1 HTTP7/hosted1で完了し、
今回stage累計はNotion37/D1 HTTP10/hosted2、SQL12。POST gzipは1,418,091 bytes。
D1の保存応答metaは今回stage全体でrows_read1,435 / rows_written2、max_attempts1。
実置換phaseだけではSQL9 / rows_read1,315 / rows_written2。rootの独立全文・manifest・
実meta照合と第二者の独立照合はPASS。追加費用を0と断定しない。
旧修復phaseの件数・失敗実績を変更せず、単発PRE容量を月額へ外挿しない。

## 10/3 JSTの追加68文書

[本文68件の本番補完](./test-logs/remaining-followup-20261003.md)の更新phaseは、実D1 HTTP281・
SQL989文、保存応答metaのrows_read33,128 / rows_written8,075、全total_attempts1だった。
2026-10-03に再確認した[公式D1料金](https://developers.cloudflare.com/d1/platform/pricing/)の
超過単価で、包含枠をすべて使い切っていると仮定しても、このread/writeだけは約$0.008108。
DB保存量・税・他phase・他サービスは別であり、実請求額とは扱わない。初回調査のCPU制限429は
使用量UNKNOWNを保持し、成功読取1,423+1,160行とこの更新phaseを混同しない。

原本136 ZIPは70,421,539 B、PRE gzipは5,319,932 B、POST gzipは26,428,504 Bを物理保管した。
POSTだけ20 MiBを超えたため、既存multipartの3 partで保管・全読戻しし、原本/本文/D1の再送0。
新規プラン購入・TypeSafe credit補充・有料AI・R2更新は0。旧CSVを再利用し、必要XBRL67と
明示対応1文書のCSV/XBRL2 GETだけを追加した。単発補完を月額へ外挿しない。

後発の訂正有報1件は、既知キャッシュ2 queryの未観測後に必要CSV/XBRL各1 GETだけ取得した。
更新phaseはD1 HTTP12/SQL41、rows_read12,343 / rows_written123・全total_attempts1で、
同じ超過単価換算は約$0.000135。68件とこの訂正の更新phase合計は約$0.008243で、
実請求額・保存量・税・他phaseとは区別する。訂正の原本2 ZIPは1,031,973 B、PRE/POST gzipは
1,006,500/1,771,952 Bを物理保管・全読戻しし、旧136 ZIP・旧26 MB POSTの再送は0。
この段階の新規プラン購入・有料AI・TypeSafe・R2更新は0。タグPREの読取4SQLは
rows_read51,600/write0、訂正の新PRE読取7SQLはrows_read3,832/write0として別に保持する。

646Aマスタ修復の更新phaseはD1 HTTP3/SQL12、rows_read5,147 / rows_written4・全attempts1。
同じ超過単価で読み書きだけ約$0.000009、本文68件・訂正1件・この修復の更新phase合計は
約$0.008253。3マップ変更に伴うindex等を含む実metaを使い、4を銘柄更新数とは扱わない。
646Aの新PRE読取はrows_read624/write0、訂正後の新タグPREはrows_read51,601/write0。
どちらも読み書きの更新phase合計には含めず、保存量・税・他経路とともに別に保持する。
新規契約・原本再取得・モデル・有料AI・R2更新は0。
646A修復のPRE/POST gzipは160,796/396,185 Bを物理保管・全文照合し、各Notion8/hosted1。
更新phaseのNotion5と合わせてNotion21/hosted2で、既存原本ZIP・本文証跡束の再アップロード0。

補完68銘柄のMac通常タグ処理は実Notion370/D1 SELECT4、rows_read51,601/write0。
新PREは64 member/gzip 1,928,630 BでNotion8/hosted1、原本や旧証跡束の再アップロード0。
有料AI・ローカルモデル起動・新原本取得・D1/R2更新・再試行0、ローカル機器の費用は別扱い。
このSELECT分の超過単価換算は約$0.000052で、単発実績を月額料金へ外挿しない。
現行68行の本文・判定根拠・次回skipの独立POST読取はNotion136、D1/原本/モデル/有料AI/
データ書込/再試行0。既存3,622判定の保持は通常処理で既に得た全行と既存受入証跡を比較し、
追加のglobal GET・旧原本束の再アップロードは0。
通常処理とPOST読取の全原応答・独立照合は2,065 member・原量174,243,624 Bとして保管した。
POST gzip 55,137,525 Bは共有multipartの6 partで物理保管・全読戻し（Notion14/hosted1）。
訂正後の新タグPREからここまでの実累計はNotion530/hosted2/D1 SELECT8、
rows_read103,202/write0。古い未使用計画や訂正前のPRE読取はこの累計に混ぜない。
旧原本ZIP・本文束・PREの再アップロード0、新契約・有料AI・モデル起動も0。
