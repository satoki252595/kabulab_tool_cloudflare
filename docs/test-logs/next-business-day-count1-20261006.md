# 次営業日自動実行の一回限りの実結果確認（2026-10-06）

Refs #196 #284。検証開始は2026-10-06 07:10 JST以降、実対象日は2026-10-05。
対象の株式・マクロは真正Cloudflare CronからGitHubへdispatchされ、両producerがFAILUREで終端した。
Notion物理原本には対象日のN225終値・調整後終値がともにNULLで、既存の品質ゲートが保存前に停止している。
発火成功・原本保管成功を、株価・マクロのデータ更新成功へ置換しない。
実行main SHAは両runとも `0cd52ade66fa4903f4c3e1e80d45753b08bf4edc`。

AGENTS.md、正本CLAUDE.md、サービス規約とIssue #284/#196の最新記録を最初に確認した。
最新記録の優待Muse・TDnet writerは終端済みで、今回の同job再起動は0。
Macの実行環境はproject Nixと既存依存を使用し、.env秘密値を表示しない。

## GitHub実dispatchと終端

| 対象 | 実run | 作成UTC | sync job UTC | run更新UTC（終端状態確認済） | 結果 |
| --- | --- | --- | --- | --- | --- |
| 株式 | [37346868885](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/37346868885) | 17:13:57 | 17:14:02〜17:14:33 | 17:14:34 | FAILURE |
| マクロ | [37373340324](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/37373340324) | 21:01:37 | 21:12:03〜21:12:33 | 21:12:34 | FAILURE |

両runは `workflow_dispatch`・main・attempt 1、入力はそれぞれ
`scheduled-stocks` / `scheduled-context` と `SCHEDULED_DATE=2026-10-05`。
全job/stepと元run metadata、ログを照合した。株式は母集団overlay・個別株取得・sector33へ進む前に停止し、
moneyflowはskipped。マクロも必須N225資格が欠け、後続4取得元を開始せず保存HOLD。
GitHubの作成clockとjob開始clockを区別し、待ち時間を処理時間へ加算しない。
Artifactsは両runとも0であり、原本はNotion側にある。

通常失敗通知は[#163株式コメント](https://github.com/satoki252595/kabulab_tool_cloudflare/issues/163#issuecomment-5999395147)と
[#163マクロコメント](https://github.com/satoki252595/kabulab_tool_cloudflare/issues/163#issuecomment-6003019114)で同runを参照している。
log SHA256は株式 `0261ae1a71ffa78f5a364b83ea80b3ebc9e20a6020483dfc939299b323e6e746`（33,334 bytes）、
マクロ `8d8c3eca3f3a4fc2d93200de4061b56531f5826f59764e41efb6ba6c91423533`（38,448 bytes）。

## Cloudflare真正4 Cron

Dashboardの既存Observability保存イベントを対象4窓だけで読み、scheduled invocationと実時計を照合した。
dispatchのoutcome=okはGitHubへの起動完了であり、producerのデータ保存成功を表さない。
株式期限21:05 / マクロ期限22:05 UTCのCronは実発火し、それぞれのFAILUREをexceptionとして検知した。

| Cron（UTC） | 実開始UTC | 実終端UTC | 結果 |
| --- | --- | --- | --- |
| `13 17 * * MON-FRI` | 17:13:53.535 | 17:13:59.015 | dispatch ok、run 37346868885 |
| `0 21 * * MON-FRI` | 21:01:34.987 | 21:01:39.672 | dispatch ok、run 37373340324 |
| `5 21 * * MON-FRI` | 21:06:02.402 | 21:06:03.681 | exception：sync job failure |
| `5 22 * * MON-FRI` | 22:06:06.582 | 22:06:07.542 | exception：context sync jobが一意の成功完了ではない |

各invocationのorigin/eventTypeはscheduled、truncated=false、versionは
`88733f9d-0b8c-4f58-b684-37c4bd20fdcb`で一致した。
JSONのscheduledTime原値は株式 `1791220425`、マクロ `1791234045`、株式期限 `1791234345`、
マクロ期限 `1791237945`（各UTC 17:13:45 / 21:00:45 / 21:05:45 / 22:05:45）。
秒を0に丸めず、scheduledTime・実開始・実終端を別に保持した。
期限の予定時刻を実開始時刻に代入しない。両期限結果はGitHub jobsの共有関数による純評価とも一致する。
公式MCPのevents読取はscheduledイベントのrequestId/outcome欠損をconnectorが拒否し、
4窓ともINVALID_ARGUMENTとなったため、既存Dashboard読取へ進んだ。サービスのcron不発と扱わない。
DashboardのJSONダウンロード原bytesを4ファイル（計19,147 bytes）保存し、
全scheduled 12イベント・12一意ID・同invocation/trace・元timestampNs・clock・cron・run IDを純検証した。
株式窓の別fetch 1イベントはproducer自身の既存Yahoo proxy GETで、観測者の追加源GETには数えない。
これはUIが書き出したJSONであり、API HTTP rawを取得したとは主張しない。
CF安全集約3,712 bytesのSHA256は `f0295b7e209a7140fec56cd6d04b4e68aa6a16147ce972afc9a40bc5015d6447`。
観測側live tail・設定変更・dispatchは0、Dashboard内部HTTP回数は未測。

## R2 dispatch receiptとD1実保存

固定key `stock-scheduler/receipt-2026-10-05.json` と
`stock-scheduler/context-receipt-2026-10-05.json` を既存OAuth read-only経路で読戻した。

| 対象 | R2 claim UTC | R2 dispatch UTC | bytes | SHA256 |
| --- | --- | --- | --- | --- |
| 株式 | 17:13:53.535 | 17:13:58.154 | 395 | `7ebc4f790494d7f9f8a05f71e4f951d5f71af5a78d65153fd9a1bbb6ff27d79a` |
| マクロ | 21:01:34.987 | 21:01:38.067 | 394 | `095144a91ddca9b60ccc993e8e62e4e65cc8c6d9695a0bd8c536703d98a16f12` |

両receiptはversion 1・status dispatched・scheduledDate・cron・returned run ID/URLがGitHub実runと一致した。
読取完了は22:15:04.153 / 22:15:05.205 UTC。最初のWrangler読取は既存.envの限定tokenで403となり、
データを取得していない。その失敗を保持し、既存のsecretをchild envから除くOAuth経路へ切り替えた。
認証設定・token権限は変更していない。R2 caller操作は初回失敗1＋成功2、CLI内部HTTP回数は未測。

22:15:02.077 UTCに単一SELECTを実行し、HTTP200・rows_read=380,528・rows_written=0・
changed_db=false・total_attempts=1を確認した。D1元応答780 bytesのSHA256は
`b9696cb22b294474c225acdaff3936e5e2f871217cb42d3d4aec7c2d49fae7a3`。

| 保存層 | 全行数 | 実最新源日 | 2026-10-05行数 | 実最新computed_at |
| --- | --- | --- | --- | --- |
| swing_daily_ohlcv | 376,039 | 2026-10-01 | 0 | 列なし |
| swing_stock_indicators | 3,766 | 2026-10-01 | 0 | 1790867406 |
| swing_market_context | 120 | 2026-10-02 | 0 | 1791116109 |
| swing_sector_daily | 603 | 2026-10-01 | 0 | 列なし |

指標表の初回SELECTは源日・対象日件数を取得せずNULLを射影した。独立レビューで調査漏れを検出し、
22:21:52.540 UTCに実latest_date列を別の単一SELECTで取得した。HTTP200・rows_read=3,766・
rows_written=0・attempt=1、源日NULL行0、上表の最新10/1・対象10/5行0を確認した。
元のNULL射影を実源日NULLと扱わず、初回応答も保持した。追加原応答471 bytesのSHA256は
`4bce4d7a812ac317281982a0c297af46946be76051681b74fcf7f61e195359e4`。
computed_atを源日へ変換して補完しない。今回のCF株式runはD1株式producerであり、
別workflowのVWAP R2 daily/intra producerを起動しない。R2 receiptの保存は実証したが、
それをR2株価全量保存と数えず、今回のCF chainによる株価・マクロ実保存成功は未達とする。

## Notion物理原本の全読戻し

既存stock-sync DBだけをqueryUniqueRowで一意照会し、listPageFilesとhosted GETを使った。
3件の一意照会（株式2件はKey完全一致、マクロはrunID接頭辞に一致する1件）・
3page GET・4添付GET、計10応答すべてHTTP200。
全4物理添付のmanifest・fingerprint・bytes・SHA256が一致し、22:16:13.615 UTCに終了した。
DB作成・列PATCHへ入り得るensure/isArchived経路は使用しない。
新たなpublisher GET・Notion書込・再試行は0。原文・金融原値・Notion原本ID/URLは公開Gitへ保存しない。

- 株式 `yahoo-raw-37346868885.1-stocks-session-part-0`：gzip 2,352 bytes、SHA256
  `b4348d8a2d483128bbb6c36e33d8c2466763e75ff1f16e050b90eb216b7e36b7`。
  wrapperのrun/stage/expectedDate/partsと全member 1件を照合。元JSON2,733 bytes、SHA256
  `e6e89f2339f6c039623905e96c1ce3ce235e78f0705c807877fb3151e4ac1405`、
  実HTTP200・実受信17:14:19.578 UTC。対象10/5のclose/adjは原JSON・共通parserともNULL。
  棄却0、checkFreshCloseは `missing_fresh_close`。過去値の代用をしない。
- 株式失敗batch `price-sync-batch-37346868885.1`：882 bytes、SHA256
  `4720de9b423cc4f9766cbd0811a7467cf93d81b552e83070f25350983807f28e`。
  実開始17:14:17.069 / 終了17:14:26.523 UTC。tradingDate・stats件数はNULL、
  failureCollectionはaborted。failures=[]を取得失敗0・成功0へ変換しない。
- マクロ `macro-source-batch-37373340324.1-1791234738535`：実開始21:12:18.535 UTC。
  N225の実要求21:12:18.910 / 実受信21:12:21.376 UTC、HTTP200、2,733 bytes、SHA256
  `45b13bcaf1bb35a522bd5e3f400c4ee31d559157ce8101edd0fdce1091f294ee`。
  対象10/5のclose/adjはNULL。原epoch `1791158400` とregularMarketTime `1791182703`を保持。
  同generationのmacro-manifest 858 bytes、SHA256
  `50cafce5345b3300962cedebf05ab986fd0076e1e9edb973fc3d748e9c432de2`。
  attemptはN225 1件だけ、残4取得元はnotAttempted、draft値・源日keyはNULL、gate=false。

株式とマクロのraw SHAは異なる。別時刻の応答を同じ原本や同じ成功結果へまとめない。
共通parser・鮮度判定・必須マクロgateと全保存物の一致から、今回の停止は源データの資格不足であり、
修正すべき実装不具合は確認されていない。quality/license/unknown-result停止を維持する。

## 検証範囲と未解決

今回の追加dispatch・rerun・publisher取得・D1/R2データ更新・モデル起動は0。
TypeSafe設定・.env・既存4業務Cronは保持する。
保存済みGitHub jobsを共有evaluateReadcheck / evaluateContextReadcheckで純評価して両FAILを確認した。
これは真正CF期限発火の証拠とは別で、元NULLと未知件数を保持している。
Notion物理照合の集約SHA256は `9c3d5491ebdf1726eddcab0d3e7dab0e98444eeb0ee52bd08d29f8f8b3f871b4`、
保存後の独立全ファイル照合SHA256は `4c864eb24f9203fea646389b347cbf06522a31a5d079420a72e7eb378e32f1e3`。
今回読戻したNotionのFetched Atは分精度であり、実source clockを分へ切り詰めた値と一致することを確認した。
それぞれの完全な実clockは添付内の元値を使用している。
独立した追加通信0の照合はNotion/GitHub/D1/R2の107項目とCFの57項目でPASS、
追加指標SELECTも原応答から確認した。照合記録SHA256はそれぞれ
`df2d4fcb4cecef45421f92c2e7f209756b80baeb9741e3c87496f46c440652ce`、
`599d166001f7a4104d5dd7c4f041f95ad1d5a070105bd01ad8cdf5b4126b79bc`、
`dc1477102fdf8569576e7b51184b8ce15d68725df8bb2820ade764f37ef85c63`。
私有証跡は専用フォルダのignored tmpへ保全し、公開記録には件数・clock・runURL・SHAだけを残す。

未解決は対象10/5のN225確定終値資格と、株価→sector33→moneyflow・マクロの同日保存。
#196/#284はOPENを維持する。以前からの品質・有報同定HOLD、#291/#292/#293の鮮度・条件・許諾契約、
未公表JPX資料も、このCOUNT=1検証だけで完了にしない。

## 結果記録とCOUNT=1予約の無効化

結果を[#196](https://github.com/satoki252595/kabulab_tool_cloudflare/issues/196#issuecomment-6004292540)と
[#284](https://github.com/satoki252595/kabulab_tool_cloudflare/issues/284#issuecomment-6004294481)へ記録した後、
2026-10-05 22:19:16.940 UTC（10/6 07:19 JST）に利用者指定のコマンドを1回実行した。

```sh
orca automations edit a3e9f5b3-e776-4a3d-a625-9d3395f8fa03 --disabled --json
```

edit応答と独立したshow読戻しの両方で `enabled=false` を確認した。
Orcaは保存済みnextRunAt `1822774200000`（2027-10-06 07:10 JST）を残すため、NULLとは記さない。
予約の有効フラグはfalseで、次年への再有効化・反復予約作成は0。
show原応答3,517 bytes、SHA256 `2c9fc9ff99538c273289b122ae019fa81d64fe398f0c788d626297fc689ca9e9`。
既存Cloudflare業務Cronは独立したままで、変更0。
