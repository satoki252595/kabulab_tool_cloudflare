# Yahoo再試行期限の伝達と取込停止（2026-10-02 JST）

[通常VWAP run36903916350](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/36903916350)
はYahoo認証429でfailure、795最終応答を物理保管し769銘柄を保存、5分足は未起動。
既存原文の全27parts/fullsummary再読で、HTTP200が773・HTTP429が22、
有効本文取得済みだがABORTでPUT未送信4件とsource未試行2,894件を区別した。
22 bodyはproxyが返すcredential rate wrapperで、Cloudflare Paid枠不足の証拠ではない。
当時のraw header whitelistにはRetry-Afterが無く、その元ヘッダ値はUNKNOWNのまま。
今回の修正がその過去ヘッダを回復したとは扱わない。

## 経路と不足

| 境界 | 既存挙動・根拠 | 今回の変更 |
| --- | --- | --- |
| Worker credential | getcrumb429のretryAtを保持、期限前は同typederrorを再throwしbootstrap0 | 無変更・既存auth回帰を保持 |
| Worker proxy | credential errorの残り秒をRetry-Afterへ伝播、Chart応答はstatus/body/header中継 | 無変更・新error-origin header無し |
| shared daily/5m | ensureOkでretryAfterMsのみを渡しretryAtMsを落とす | 既存絶対期限helperを再利用、数値/HTTP-date期限を保持 |
| raw metadata | client/custodyともcontentType/upstreamStatusだけを保存 | safe Retry-Afterを両段のallowlistへ追加、認証headers除外維持 |
| VWAP producers | 連続5のみでABORT、成功でcounter resetし未来期限を見ない | future retryAtを受けたら即ABORT、全inflight settled原文をcustody後にexit2 |
| stock first pass | 初回429だけを30秒へclamp | 毎429のmax実期限を保持、開始予定が21UTC以後ならrun STOP |
| stock recovery | 実120秒指示も30秒へ短縮し再取得 | 30秒待機予算/実行期限外は未試行skip、期限内だけ既存1回回収 |

503は合法Retry-Afterがある場合に絶対期限を持つ。ヘッダ無しの503は従来のnull期限と
連続数判定を維持する。raw CaptureはHTTP/parse失敗より前、custodyは全inflight完了後、
D1/R2 writeより前という順序を保持する。

stock first-pass gateのSTOPは取得済全原文を保管した後にthrowし、D1 flush前に終了する。
既存のraw保管/readback後deadline checkと各D1 statementのbeforeWrite callbackは無変更。
回収時の長い共通Yahoo期限では、一過性失敗の再処理も新Yahoo取得を含むため全件を
skippedDueToLimitで残す。期限を超えて強行し、完全成功として扱う経路は追加しない。

## 外部待機と実装の限界

Yahooの実429を解除するコード変更ではない。取得再開は期限以後の別の通常runで実データを
観測する必要があり、このPRでは新source GET・dispatch・Notion/D1/R2 mutationを行わない。
Credential cacheは既存isolate内の数値/値だけを共有し、I/O Promiseを共有しない。
Cloudflareはisolateの寿命と同一instanceへのroutingを保証しないため、認証cacheを
全Worker共通の永続レート制御として扱わない。
[Cloudflare公式runtime説明](https://developers.cloudflare.com/workers/reference/how-workers-works/)。
恒常429を解消済み、全量日足/5分足が正常化したという主張はしない。

## 検証

- 既存認証/proxy/chart/rawのoffline回帰75件pass。期限前bootstrap0、120秒期限を
  短縮しないこと、期限後の再bootstrapとWorker request-owned I/Oを保持。
- 関連7 suites149 pass/3既存skip。数値とHTTP-date期限、safe header→gzip、
  first-pass期限延長/21UTC開始停止、回収30秒予算外GET0、予算内の既存回収を確認。
- 追加intra回帰ではfuture rateをMAX_RL前に検知し、相方inflightのsettledを待って
  原文保管、次wave GET0・R2 PUT0・exit2を確認。対象suite12 pass。
- 検証は既存Nix project runtimeで実行。source/本番mutation/dispatch0。
  型/lint/最新main通常merge後のCI結果はPRの最終headで確認する。
