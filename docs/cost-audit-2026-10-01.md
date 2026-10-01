# kabulab 費用確認 — 2026-10-01

## 判断と対象

Workers Paid の既存契約を使えば、PR #195 の定時起動移行のために新しい
Cloudflare プランやサーバを購入する必要はない。正常起動時の追加処理は月数十回の
Worker 実行と R2 操作で、既知の通常取込もリクエスト数・R2 操作数は少ない。
同日のダッシュボード読取で、現在の請求期間の requests・CPU・D1 read/write/保存・
R2 A/B/Standard保存・Builds は、同一アカウントで他サービスを含めても各包含枠内に
あることを確認した。この確認範囲では追加請求対象はなく、既知の通常負荷を理由に
上位プランへ変更する根拠はない。Logs・外部AI・Notionなど未確認の費用を含めた
「全費用が必ず $5/月」「将来の追加費用も必ず $0」とは結論しない。

- コード基準: main `7f1442972793051882d4c2d15771348eb6e4c647`。
- 未反映の変更: [PR #195](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/195)
  head `353c19419d7d680ecd3ebfd23ee0ff529f7b272c`。実装・マージ後に再確認する。
- 料金・制限の取得日: **2026-10-01**。金額は USD、税・為替換算を含めない。
- ユーザーの Paid 契約申告に加え、同日のダッシュボード読取で Workers Paid を確認。
  請求画面・個人情報・他サービスの利用額は私有証跡とし公開 Git に保存しない。
- GitHub API で当該 repo の `visibility=public` を確認。認証値は読まず、
  この調査ではプラン購入・設定変更・ジョブ起動を行っていない。

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
| PR #195 スケジューラ | `22 × 2` | Cron 44 起動、PUT 44、GET 22 |

stock-sync の取得実装は [daily.ts](../src/cron/daily.ts) と
[Yahoo client](../src/shared/yahoo/client.ts)。VWAP は
[日足](../scripts/vwap/ingest-daily.ts)、[5分足](../scripts/vwap/ingest-intra.ts)、
[信用残](../scripts/vwap/ingest-margin.ts)、定期頻度は
[stock-sync workflow](../.github/workflows/stock-sync.yml) と
[VWAP workflow](../.github/workflows/vwap-ingest.yml)。日足は毎回 10y を取得する。
R2 の同値 skip があるので PUT は上限側の値である。

PR #195 は 17:13 UTC に dispatch、21:05 UTC に完了確認する。正常な 1 日は
R2 claim PUT + 結果 PUT + 完了確認 GET。実同期は従来の Actions のままで、
旧株式 GitHub cron は同 PR で除く。receipt による重複拒否と再 POST 禁止を保てば
同期件数を二倍にしない。GitHub Jobs 読取は最大 10 ページに限定されている。
[PR #195](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/195)

上記だけなら R2 は Class A 最大 96,158、Class B 最大 96,180/月。
含まれる操作枠の約 9.62% / 0.96%であり、proxy は Worker リクエスト枠の約 2.59%。
この断面に macro、初回/修復、再取得、公開ページ/API のアクセス、他 Worker、
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
既定通知の展開も告知されているが、このアカウントで設定済みとは仮定しない。
日次処理なので翌日の通知になる。現在の設定・受信先を読取確認し、設定変更は別判断。
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
- **TypeSafe Jev**: 公式 Jev 1.13 は入力 $0.042/Mtokens、出力無料。
  [client定数](../src/shared/jev/client.ts) と
  [見積式](../src/shared/jev/stats.ts) が一致。`費用 = 実入力tokens / 1,000,000 × 0.042`。
  既存の過去20社670,382入力tokensから全3,607社へ比例した $5.08 は一括実行の
  過去推定であり、月額実測ではない
  ([既存記録 §12.8](./005-yuho-quant-business-tags.md))。`budget-min=20` は時間制限で、
  dry-runでも判定APIを呼ぶ。既定最大3 retryは最大4送信になり、曖昧な失敗で提供側に
  課金された量が成功応答のtoken集計に出ない可能性がある。請求/残credit確認が必要。
  [TypeSafe公式モデル料金](https://docs.typesafe.ai/models)
- **SemIf**: ローカル MLX 推論で外部API従量料はないが、端末・電力・稼働時間まで
  無料とはしない。通常のタグ判定を無断で他モデルに変更しない。
- **Cursor/外部生成AI**: 単語帳の年次レビューや優待要約はrepo外のautomationを
  利用する。Cloudflare Paidに含まれず、契約・実使用量が未取得なので金額未確定。
  [年次レビューの既存手順](./005-yuho-quant-business-tags.md)、
  [優待要約の契約](../services/otakara-yutai/docs/llm-summary-task.md)
- **Notion**: #132 の過去コメントで Business trial の確認根拠があるが、現在の課金
  プラン・試用終了日・seat数はこの調査で未取得。Paidはmemberごとの契約で、
  API呼出し量だけから月額を算出しない。公式のfile uploads条件・試用後の契約を確認する。
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
| Workers Paid契約 | ダッシュボード読取で確認済み |
| Worker requests・CPU | rootが包含枠内を確認済み。account実数は私有、service別は未計測 |
| Workers Logs | 未取得。請求表に表示されないことを0の証拠にしない |
| D1容量・rows read/write | rootが包含枠内を確認済み。account実数は私有、当該DB別は未計測 |
| R2 Standard容量・A/B | rootが包含枠内を確認済み。account実数は私有、bucket別は未計測 |
| R2 IA容量・retrieval | 使用状態未確認、Standard表で代用しない |
| Workers Builds | rootが包含枠内を確認済み。project別分数は未計測 |
| GitHub runnerとvisibility | public/標準ubuntuを確認済み。保存課金は未確認 |
| Jev入力tokens・credit・請求、Notion現在契約 | 未取得。過去の成功数・trial確認で代用しない |
| 既存Budget Alerts/CPU limits | ダッシュボード値は未取得。設定変更なし |

月次概算は各製品の `max(使用量 − 含まれる量, 0) × 単価` の合計に
既存 Workers $5 とその他の契約料を足す。R2は上記の切上げとIA条件を適用する。
この合計は **アカウントの既存枠をどう消費するか** に依存するため、serviceだけの
追加処理を丸ごと無料枠と比較した値を請求額としては出さない。

本調査で料金変更・ログ削減・CPU上限変更・新規購買は行っていない。
service別実測を取得したら、検査日時・serviceの計数・確定範囲を追記して判断を更新する。
