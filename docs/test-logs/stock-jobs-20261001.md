# 株式・マクロ定時失敗の調査（2026-10-01）

対象は Issue #163 / #160、main `7f1442972793051882d4c2d15771348eb6e4c647`。
本調査は GitHub 実ジョブログと既存 Notion 原本の読取のみ。新しい Yahoo 取得、
D1/R2 書込、workflow dispatch は実施していない。

## 株式：予定イベントの遅配

- [run 36779265451](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/36779265451)
  は予定 `2026-09-30 17:13 UTC` に対してイベント作成・開始が `21:24:52 UTC`。
  `stock daily sync` は `21:25:15 UTC` に開始し、共有時間窓 guard が停止した。
- 株式取得前の停止で、正常保存の証明ではない。失敗バッチは既存経路で
  `price-sync-batch-36779265451.1` に記録されている。
- CF Cronで株式・マクロの起動だけを移すPR #195を最新mainへ統合する。既存の
  全経路時間窓・N225実終値・母集団overlay・完了期限を保持する。
  原本日付を予定日へ上書きしない。

## マクロ：遅配と一次欠測を分離

- [run 36796102550](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/36796102550)
  は予定 `2026-09-30 21:00 UTC` に対してイベント作成・開始が
  `2026-10-01 00:25:24 UTC`（09:25 JST）。株式 step は skipped。
- 原本は [Notion の既存バッチ](https://www.notion.so/3ecd74ff84cd81c9b79dd8e28794daf4)
  `macro-source-batch-36796102550.1-1790814338681`。
  manifest は5対象各1回・HTTP200を記録しており、429失敗ではない。
- `macro-N225-attempt0.json` を読戻し、2889 bytes・SHA256
  `374c7f3dcadc017067041c581cff81aeeced94ecb70455184ddefcea7707e2f7`
  が既存添付manifestと一致した。
- N225原本の `2026-09-30` 行は OHLC・調整終値・出来高がすべて null。
  `2026-10-01` には実数があるが、regular session終了前の形成中バー。
  `selectConfirmedCloses` が9/30の実終値を証明できず HOLD するのは正当。
  meta価格・前日バー・0で補完しない。
- `macro-manifest.json` も読戻し、2031 bytes・SHA256
  `9ca66965c0846598211ea5900c504d42bd50861e400a01a408db58c5bef64d30`
  が既存添付manifestと一致した。draftの GSPC/VIX確定日は9/30、VI日は10/1。
  原本側のN225欠測が回復しても、このバッチのVI日付不一致は別のHOLD条件。
  本調査では残る4添付の物理再照合はしていない。

## 後続の業種・資金フロー

この2実行は sync job failure により sector33 / moneyflow が skipped。
既存の正常producer・実取引日・許容内失敗なしを要求する連鎖を維持する。
producerの正常実保存と後続sector-turnoverの同日実保存が揃うまで #160 / #163
を完了扱いにしない。

## Scheduler統合の検証

- `scripts/sync/moneyflow-only-check.sh`：14ケース PASS。
  `scheduled-stocks` は全sources、手動 `stocks` は sector-turnoverのみ。
  廃止した株式GH cronは明示拒否。
- Nix管理のNode22.22.2/pnpm9.15.9で最終対象77テスト・TypeScript・lint成功。
  `wrangler 4.101.0 deploy --dry-run`も成功。
- 全TypeScript suiteも4155 PASS・427既存skip、255ファイルPASS・1 skip
  （2026-10-02 JST実行、48.94秒）。その後、Jobs APIの株式/comment stepが
  重複する2ケースを追加し、一意性guardを含む対象77テストとTypeScript/lintを
  再確認した。CIはpush後に別確認する。
- credential設定・CFの定時発火・実dispatch・期限readcheckはこの調査の実施範囲外。

## 通常時間帯の実受入（2026-10-01 15:32 UTCまで）

- PR #195 head `51dd661` の CI `check` / `python-pipeline` と Workers Builds は全PASS。
- Rootが排他で起動した[通常run36879969126](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/36879969126)
  は14:54:08〜15:11:07 UTCの株式stepで3634/3689成功・55失敗となり非0。
  sector33/context/moneyflowは全skip。同日連鎖保存の受入は未達。
- [既存Notion failurebatch](https://www.notion.so/3ecd74ff84cd81d0b34dc354d3671e5b)
  `price-sync-batch-36879969126.1`を全読戻し。7785 bytes/SHA256
  `f7d8d0bd43ae10e9e1a91b2cf995a200b9c06f457b8a8ef51e59a7dba066fbe5`
  が保管manifestと一致。54件は10/1実日足未取得、1件8303はnegative raw adjで
  全応答拒否（metadata分類はsourcegap54/unknown1）。guardは保持する。
- 15:19:34 UTCにD1 SELECT2本でactive+equity3689、10/1実close+volume3634、
  indicator latest_date10/1も3634。欠落55はfailure全55と集合完全一致、全55の
  latest_saved_ohlcvは9/29。sector-turnover全数coverage条件を満たさない。
- 旧9/29診断manifestと原文54（55添付）を既存Notionから読戻し、全bytes/SHA一致。
  旧54と今回の欠測54は重複15・旧のみ39・新のみ39。重複15の旧原本には
  9/29 exact1行の実close/adj正値・volumeがあるが、10/1原本は未保管のため
  今回のstale/null/forming細分類を推定しない。
- 15:24:09 UTCのD1 SELECT2本で失敗55は全active+equity、発効済delist0。
  5484（10/19）・9691（10/9）は未来予定で、欠測を理由に除外しない。
  旧のみ39のうち14は公式発効済delistでinactive、残25はactive。
- 通常株式の全Chart/QuoteSummary原文保管は未実装と判明した。failurebatchや
  マクロraw保管を全株式custodyと読み替えない。この不足の修正は別PRで扱う。
  本追跡のYahoo/source追加GET、Notion/D1/R2 mutation、追加dispatchは0。

## 公式仕様

- [GitHub workflow dispatch](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)：
  Actions write権限、API `2026-03-10` のHTTP200応答にrun IDとURLが含まれる。
- [CF Cron](https://developers.cloudflare.com/workers/configuration/cron-triggers/)：
  UTC起動とscheduled handlerを使用。cron変更の伝播に最大15分。
- [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)：
  conditional putでreceiptのclaim/CASを行い、競合時は再dispatchしない。
