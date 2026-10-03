# マクロ定時処理・株式とマクロの期限チェック実績（2026-10-03）

2026-10-02 UTCの21時マクロ処理は起動したが、日経平均の確定終値資格が不足して停止した。
21:05株式・22:05マクロの期限チェックも実際に発火し、それぞれ失敗したproducerを検知した。
定時監視の発火と失敗検知は確認済み。株価全量・マクロ実保存の成功は未受入のまま。
[先の設定・17:13株式実績](stock-scheduler-production-20261002.md)で未観測だった項目を、後から実時計の証跡で確認した記録である。

## 21時マクロの実run

- [Actions run 37064206007](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/37064206007)
  は`workflow_dispatch`、main `239d12c62465c6cc7dfd83aefc194e2542b69fe8`、attempt 1。
  作成・開始21:00:43Z、終端completed/failure 21:01:29Z。
- `sync` jobは21:00:49Z〜21:01:28Z。
  `market context sync`は21:01:03Z〜21:01:22Zにfailure、`stock daily sync`はskipped。
  [Issue163の失敗コメント](https://github.com/satoki252595/kabulab_tool_cloudflare/issues/163#issuecomment-5961412970)
  も21:01:26Zに同runを参照した。
- 10/2の同workflowのdispatch一覧は2runで、PR280のmain merge（19:51:30Z）後は上記1runのみ。
  観測者による追加dispatch・rerun・Yahoo取得は0。
- failed logでは`^N225`の確定日の実終値を証明できず、N225確定日欠落gateでマクロ保存HOLD。
  正準経路は`fetchMarketContextTarget` → `selectConfirmedCloses` →
  `archiveAndPersistMarketContext` → 保存gateのfalse → CLIの「マクロ同期が不完全です」。
  不足を別日の値で埋めず、前回保存値を保持する経路で停止した。
  ここで観測したlogだけでは、上流のHTTP statusや原JSONのnull位置までは断定しない。
- 同run metadata/jobsと失敗logを取得した。失敗logは33628 bytes / SHA256
  `d3c669b16bce7fd944ff531fffa3fe650aafc3aaefe70beeebb9619fdac299c6`。
  読取receiptはSHA256 `ccbb3281bd8760b8809a1968817ea3e1778668b55d39cc547f7450022ff98e70`。
  続いて固定R2 receiptをremote GET操作1回で読み戻した（追加GH/source取得0）。
  CF claim 21:00:40.658Z → dispatch 21:00:43.843Z → returned run 37064206007が、
  上記GitHub runの実clockと一致した。原receipt394 bytes / SHA256
  `88178a1fece00bbc6147c3e12b1baf0efa9fd17f3d0cf579fc708ff4c7430242`、
  読取終端2026-10-03T00:08:42.262Z（JST09:08）。

## 真正期限Cronの実結果

Cloudflare production Observabilityの保存イベントを、下記の各3分窓だけで読んだ。
各窓は3可視イベント、計6で、追加ページ・live tail・設定変更は行っていない。
各開始・例外・worker outcomeは同じinvocationに属し、`eventType/origin=scheduled`、
`truncated=false`、version `e6b2a639-3873-47ae-b139-33be34b2aeb2`で一致した。

| 期限処理 | 読取窓UTC | 真正開始UTC | 例外終端UTC | 結果 |
| --- | --- | --- | --- | --- |
| 株式 `5 21 * * MON-FRI` | 21:04〜21:07 | 21:05:40.732 | 21:05:41.448 | sync jobがfailureのためexception |
| マクロ `5 22 * * MON-FRI` | 22:04〜22:07 | 22:05:36.130 | 22:05:36.922 | context sync jobが成功完了でないためexception |

UTC対象日は2026-10-02。JSTでは2026-10-03の06:05・07:05に対応する。
開始clockを予定時刻へ置き換えていない。
保存されたstackは株式`evaluateReadcheck` → `runDeadlineReadcheck`、
マクロ`evaluateContextReadcheck` → `runContextDeadlineReadcheck`を指す。
保存済みGH jobsを使った正準関数の純評価も両方FAILで、真正CF発火とは別の証跡として保持した。
画面のinfo/error件数はログ分類であり、producerの成功件数として扱わない。

## 証跡と残る境界

- 観測terminalは2026-10-03T00:02:16.829Z（JST09:02）。
  期限イベントreceiptは5535 bytes / SHA256
  `4ce41eb76323f7a0e7f044576b2368f8bf71ad2352b701ebacd0b60678221838`。
  株式はUI Copy JSONの全文bytesを保存。マクロはUI Copyが空だったため元の全DOM・可視全文を保存し、
  JSON解析では表示用の区切りだけを扱った。API HTTP rawを取得したとは主張しない。
- GH callerは一覧1・コメント1・run1・jobs1・failed-log操作1の計5。
  R2 remote GET callerは1。GH認証・Wrangler・Dashboard内部のHTTP回数は未測。
  観測フェーズのYahoo/EDINET取得、Notion/D1/R2データwrite、dispatch、rerun、取得再試行は0。
  secret値・私有Notion URL/ID・金融原値は公開していない。
- 独立したローカル再照合では、GH原stdout/stderr10件・全step・一意run・失敗コメント、
  CF保存bytesと全6eventの時計・invocation・cron・version・origin・stack・outcomeを確認した。
  再照合receipt1061 bytes / SHA256
  `0627af9a6c6cdf8e416aba269c1bfe3831ef156b690d7ad049559372dd736404`、追加APIは0。
- 2026-10-03T00:18:02.904Z（JST09:18）、取得済み証跡55ファイル・368641 bytesを
  共有`recordPrimaryData(force:false)`からNotionへ物理保管し、全metadata・manifestと
  添付の全文bytesを読み戻して閉鎖した。既存サービスDBを再用し、新DBは作っていない。
  gzip32792 bytes / SHA256 `1b0f21327dbce00c93b9bedc773cc91befddbbe8c4a09b12c3a8193559aa8bfe`。
  原本保管フェーズはNotion8・保存添付GET1で、upload status確認も1回だけ。
  pending等はSTOPする入口を使い、poll・再送・再entryは0。
  保管phaseの市場source取得・D1/R2/tag writeも0。
- 物理保管receipt745 bytes / SHA256
  `405d3fa62bef5cc0a21cce24291beedf389da458730d8c2990d08cfc0fd38404`。
  独立したローカル照合でも全9HTTPのrequest/response bytes・SHA・clock・status200、
  page metadata・manifest/fingerprint・添付全文一致と、gzip全55ファイルの再展開一致を確認した。
  独立receipt605 bytes / SHA256
  `ca2deb744dc81a8dd45112d0fc0d56232d08cb9448f22ee3c0c349d6318d3318`、追加APIは0。
- 株価残55件、VWAP全量・5分足、上流応答の資格回復はこの監査だけでは完了扱いにしない。
  追加full manualは0。次の本来の定時実行で保存成功を受け入れる必要がある。
