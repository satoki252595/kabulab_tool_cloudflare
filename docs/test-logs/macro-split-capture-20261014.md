# 朝マクロの日本引け原本持越し（2026-10-14）

06:00 JSTに日本株のYahoo日足を再取得すると当日終値NULLがあり、10:30 JSTへ移すと日経VIが当日のlive値になる。予定日Dの日本市場分を18:00 JSTに保管し、翌06:00 JSTに同じDの米国確定値と結合する。過去日の原本や最新値による補完は行わない。本番値の書込とCI後の初回定時確認はroot担当。

## 契約と処理

1. 株式同期の既存`stocks-session` guardが取得した同じN225応答を再利用する。既存Notion一次原本の全bytes照合が完了してからJP処理へ渡す。新規N225 GETやNotionへのN225再uploadはない。
2. 予定日DのN225実日足、前日実終値、source session/観測時刻を検証する。同D session終了、または明示未来nextsession・既存helperが選んだ同D実bar・同D15:30以降のquote時刻のどちらかが必要。NULLや別日のcloseは採らない。日経VIは1GET・30秒timeout。ZXD=D、TZ付きDPP:Tの日付=D、15:45 JST以降かつ実capture以前が必要。日中tick、原本なし、HTTP失敗は理由付きHOLD。
3. 日経VI HTMLとJP manifestを共有`recordPrimaryData()`で物理保管し、`verifyArchivedAttachments()`で全bytes照合する。manifestにはN225の既存保管ページ・SHA・実観測時刻を参照として残す。正常時だけ既存R2 bucketへ`macro/jp-close/D.json`をIfNoneMatchによる単発CASで作成し、同じbodyを再読照合する。
4. 同日のR2原本が既にあるときはNotion全bytesを再照合し、VI再取得・上書きはしない。保存結果不明、SHA不一致、CAS競合、読戻し不一致は再送せず停止する。
5. 朝は予定日DのR2原本を厳密再parseし、同じJP manifest/VIのNotion物理bytesを再照合する。その後に`^VIX`、`^GSPC`、`NIY=F`だけを各1GETする。JP cacheが無ければ米国GET0・D1 write0でHOLD manifestを保管する。別日のcacheを探さない。
6. composite manifest v2は夕朝の別captureを明示し、日本原本への参照と米国各attemptの実時刻/SHAを残す。GSPC/N225/VIX/VIの同一確定日Dと既存必須値gate、22:00 UTC保存期限を維持する。NIYは従来同様snapshotと明示する。

Node入口`pnpm sync:daily:core`は引数なしも株式+JP保管のみ。朝の結合は`--context-only`で明示する。Actionsは既存R2 secret4個を受け渡し、rootがGitHub上の存在を確認済み。AWS SDKは既存Node R2 helperだけがimportし、`src/cron`へ新規importしない。

## 公式時刻根拠と一次保管

- [日経平均VI算出要領](https://indexes.nikkei.co.jp/nkave/archives/file/nikkei_stock_average_volatility_index_guidebook_jp.pdf)：2025-01-27版。日中立会の15秒間隔計算に加え、クロージング・オークション終了時にも計算する。
- [JPX 現物株の立会時間](https://www.jpx.co.jp/equities/trading/domestic/01.html)：2026-10-14取得の現行ページ。後場終了15:30 JST。次sessionへroll済みのN225では、同Dのquote時刻もこの終了時刻以降であることを要求する。
- [JPX 日経225オプション制度概要](https://www.jpx.co.jp/derivatives/products/domestic/225options/01.html)：2026-10-14取得の現行ページ。日中closingは15:45 JST。

仕様根拠は2026-10-14に各1回のみ取得し、以降再取得0。共有Notion一次保管`stock-sync / macro-official-hours-20261014`へ2原本計440,342bytesを物理uploadし、全bytes読戻し照合済み。SHA256はPDF `4988f700aa38ce3a95b1ffd1a77d8b0b64c3277672fa010e9b9d6edbec289704`、JPX HTML `35dbea8204ab4020478c329e1011554d18ea2f4d913d4504e5dc6d904adb8e4a`。実ID・原本・source/receiptはprivate `tmp/feature-audit-20261013/official/`に保存し、Gitへ原本を追加しない。

現物15:30根拠HTMLも追加1GET・29,157bytesを別key`stock-sync / macro-official-cash-hours-20261014`へ物理保管して全bytes照合済み。SHA256 `5b9ad3c96c4755b1c031e19bdde6c2c9edfe12bcb439e75215335db37949d201`。既存2原本の再取得・上書きはしていない。仕様調査の計3GETは今回限りで日次には追加しない。

## 費用・性能と検証の限界

- producerの取得helper呼出し数は既存株式N225 guard1 + 夕VI1 + 朝米国3 = **5**。変更前のguard1 + 朝マクロ5 =6から1減る。同日再実行で既存JPが適格なら夕VIは0、欠測時の朝はsource0。これは統合テストの計数で、proxy内部処理を含む実upstream数・新定時の所要時間は初回runで計測する。固定sleep・新有料AI・新しい全銘柄取得は追加しない。
- 追加R2は日付別1objectのPUT1と、夕の存在確認/readback2GET・朝1GET。書込retry0、既存helperの既知5xx read retryだけを継承する。objectは8MiBを超えるとPUT前停止し、部分保存しない。上限からの最悪累積は365日で約2.85GiB。実サイズは初回本番JP receiptで確認する。
- 保存済み実VI HTMLは92,863bytes、既存macroのN225原本は数KiB程度。base64のためR2 bodyはraw合計の約4/3+小manifestとなる。これは既存原本による規模目安であり、新定時runの実測値ではない。
- NotionのN225 rawは既存物理保管を参照し二重uploadしない。JP manifest/VIを2files、朝US3raw+manifestを4files保管する。旧朝macroの6filesに対して合計6filesで、raw数は増やさず1record/小manifestと朝JP原本の読戻しが増える。
- 機構テストの閉場N225 metadata/VIは明示したSYMBOLIC fixtureを使用する。本番取得成功を捏造しない。米国rawは既存capture fixtureを再利用。夕朝統合テストで5GETと照合順序を計数し、D1同日write1を検証する。本番復旧完了は次の正常夕JP保存→朝同日結合のreceiptとD1読戻し後に判定する。

## 夜間NULLの保存原本分類

`stocks-session` run37346868885.1の保存原本（SHA一致）は予定日2026-10-05、実取得10/5 17:14:19Z、currentPeriod10/6、rmt10/5 06:45:03Z。末尾10/5 barは1本・close=NULLで、同日実closeは0本。直前実closeは10/2。翌日placeholderを除けば予定日の実closeが残る型ではなく、10/2を10/5へ付替えてはいけない。

保存VWAP session3件（10/4 15:32Z/16:58Z/23:49Z取得）は末尾10/2実close、10/5bar自体が無い。これだけで翌10/5の予定日充足とは主張しない。全4件の実clock/session/bar有無はprivate `n225-saved-session-classification.json`に記録。既存stock/VWAPの日付・実close guardはこの変更で緩めていない。

## ローカル検証

`pnpm exec vitest run src/cron/macro-jp-leg.test.ts src/cron/daily-mode.test.ts src/cron/daily-batch-custody.test.ts src/shared/yahoo/nikkei-vi.test.ts src/cron/macro-session.test.ts src/scheduler/stock-sync-yml.test.ts src/cron/daily.test.ts`：7suite、169PASS。

`pnpm exec tsc --noEmit`、変更6TypeScriptファイルのeslint（warning0）、`git diff --check`成功。閉場/形成中/明示nextsession/旧session/日中quote/NULLclose/前日VI/未来tick/原本改変/Notion不明/R2不明/同日再実行/キャッシュ欠測時source0を検証した。定時macroの予定日・開始窓・期限と既存stock guardの回帰を維持している。
