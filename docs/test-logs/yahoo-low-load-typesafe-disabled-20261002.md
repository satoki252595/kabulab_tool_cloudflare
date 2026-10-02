# Yahoo低負荷化・TypeSafe停止 — 2026-10-02

Refs [#268](https://github.com/satoki252595/kabulab_tool_cloudflare/issues/268)。公開記録は
集計・実行リンク・SHAのみ。原文、認証値、個人の残高や請求情報は含めない。

## 直近のYahoo根拠

- [株式定時run 36930997317](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/36930997317)
  は `87765f9`、10/1 21:47:57.084Zの取引時間窓guardでYahoo取得前に停止した。
  この実行からYahoo制限解除は判定できない。私有ログ33,176B、SHA256
  `9d82e37745779722e3a6c3e29792e061daf0d05dbb4c0cad2de5e3cc0b8286f6`。
- [macro run 36946799827](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/36946799827)
  は `87765f9`、10/2 00:36:25.793ZにN225取得が成功したが、対象10/1の確定終値を
  証明できずHOLD、00:36:46.527Zに不完全終了した。私有ログ33,353B、SHA256
  `23b35c81d117a6900466389be28cb1b082308addf811f17a1d905147a7d3104a`。
- 両ログにYahoo 429/503・retryAt・transport失敗の記録はない。最新raw応答statusと
  Retry-Afterは未確認で、個別取得の成功を全面解除・全量復旧へ外挿しない。
  この調査で追加Yahoo取得・dispatch・本番変更は0。

## 変更する取得経路

- ActionsのYahoo producer jobを共通 `yahoo-source` groupで排他する。親stock jobの
  lock解放後にreusable moneyflowを起動し、親子が同じlockを待つ循環を避ける。
- stockとVWAPを並列1にし、共有clientの認証page・crumb・target・401再認証に加えて
  Nodeからのproxy送信も1秒間隔・cooldownへ通す。stock timeoutは210分、
  17:13UTC起動とsnapshot前後・
  D1各文の21UTC gateを維持する。shared内部の全HTTPが21UTC前に始まる保証ではない。
  3,689銘柄×2取得=7,378実HTTPは、1秒間隔だけで約123分が必要という
  下限の目安であり、認証・Notion・DB時間を含む完走予測ではない。
- 429/503は最初の応答で新規取得を止める。明示Retry-Afterの長い期限を短縮せず、
  期限なしの停止は最低15分。stock/macroの同run回収を停止し、VWAP intra取得は
  1 attempt。取得済み原文の物理保管・全文readbackを維持する。
- VWAPは最大30銘柄まで順次取得し、raw累積8MiB到達後は次の波を始めない。
  物理partsの8MiB上限分割は共有helperが行う。未証明のfresh skipを
  新設して10年日足の取得範囲を変えない。未使用 `/vwap-analysis/api/chart` は
  paramsにかかわらず410を返し、Yahoo取得0。画面は保存済み日足・5分足をR2から読む。
- 1秒間隔とcooldownはprocess/isolate内の制御で、グローバルに持続する上流quotaや
  複数isolate間のhard capとは呼ばない。新DO・cache・DB migrationは追加しない。
  [Worker isolateの実行モデル](https://developers.cloudflare.com/workers/reference/how-workers-works/)、
  [Retry-After仕様](https://www.rfc-editor.org/rfc/rfc9110.html#name-retry-after)
  （いずれも2026-10-02参照）。

## TypeSafeと検証

TypeSafeは事業タグ・単語帳評価・競合判定に用いた外部AI APIで、株価・VWAP取得とは
別経路。利用者方針で共有clientと有料CLI/pipelineをI/O前に停止し、credit補充は不要。
定時catchupの事業タグ起動も止める。保存済み判定・未判定・旧課金切れ25件は保持し、
自動SemIf代替はしない。明示 `--judge=semif` の既存経路だけを残す。

2026-10-02 13:12 JSTの統合offline回帰は30 suites / 462 PASS / 既存conditional
SKIP 8（total 470）。後続のVWAP lint修正と追加1 caseは2 suites / 31 PASS /
既存SKIP 3で再確認した。成功した異なるcaseは合計463で、463件を同じ統合runで
実行したという意味ではない。TypeSafe通信前停止、Yahoo間隔/cooldown/race、proxy、
410/R2配信、原文保管、producer停止と足の全fields保持をofflineで検証した。

`tsc`と全変更TS/JSの`eslint --max-warnings=0`がPASS。Nix経由のWorker
`wrangler deploy --dry-run`もPASS（1,701.77KiB / gzip 357.99KiB、15 assets）で、
本番deployではない。PR CIはこの記録時点で未実行、本番の低負荷取得の実受入は未実施。
過去の[株式](stock-normal-acceptance-20261002.md)・
[VWAP実受入](vwap-normal-acceptance-20261002.md)の失敗件数・原文保管実績は変更しない。
