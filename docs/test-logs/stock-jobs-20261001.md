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

## 公式仕様

- [GitHub workflow dispatch](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)：
  Actions write権限、API `2026-03-10` のHTTP200応答にrun IDとURLが含まれる。
- [CF Cron](https://developers.cloudflare.com/workers/configuration/cron-triggers/)：
  UTC起動とscheduled handlerを使用。cron変更の伝播に最大15分。
- [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)：
  conditional putでreceiptのclaim/CASを行い、競合時は再dispatchしない。
