# 定期取得の完了条件と残件 — 2026-10-25

対象は[Issue #348](https://github.com/satoki252595/kabulab_tool_cloudflare/issues/348)。[原20機能の監査](../test-logs/feature-gap-audit-20261014.md)と[全データ一覧](../batch-data-inventory.md)の範囲を縮めず、コード・配備・実データの受入を分ける。日次・月次は通常の機械処理、Clefによる事業タグ等は合意済みの月次手動とする。新規監視と全履歴RAWミラーは追加しない。以下は10/25の確認済み証跡であり、旧欠測件数の再集計や、改修後の全自然定期成功を示すものではない。

| 残件 | 完了とする条件 | 10/25時点の確認 |
|---|---|---|
| 定時起動・実時間の締切 | 未来予定を拒否し、許容遅配・source停止・原本保存・native timeout・receiptの順序が全入口で一致 | #560と機械publisher追補#568、元job時計の有限再資格#570、SSH手動株式CLIの翌06時通信停止#584をCI・main配備・SSHへ反映済み。改修後の全自然定期実績は別受入 |
| 本文39項目・基本情報の補足同期 | Linuxの通常定期処理がモデル・語彙判定に依存せず差分同期し、旧タグ根拠と最新本文を区別 | #565/#568/#569を反映、共有状態移行・有効化済み。634Aは39列SHA・本文入力SHA・receipt一致と意味15列保持を確認。初回Actionsは選択50社中31社を同期、HOLD0・未着手19・モデル0。10分の新規開始予算による有限結果であり、全社完了ではない |
| 優待の機械要約 | 既存compiler・検証・原子的publisherをLinuxから呼び、未解析は保留。Macの成否を先行条件にしない | 移行・有効化済み。2307は額面のない基準日変更で正当HOLD。初回Actionsの60件全保留後、#579の2872・#586の3521を各3群/3行、SSHの通常原子取込で適用し、完全POST・cursor不変・owner/pending閉鎖を確認。10:43 JSTの本番再集計は未完141群/209行/50銘柄。他の保留を同じ理由と断定しない |
| Notionの保存結果不明 | 非冪等書込の529等を再送せず、runnerと文書callerでも成功化・次文書続行しない | #563をmain `2fa25380`へ反映、CI・CF・SSH確認済み。読取529と明示拒否429は別契約のまま |
| 33業種更新の先行条件 | 株価・RSI失敗でも独立した原典取得を実行。取消・対象外の停止と通信枠を維持 | #562をmain `a90df635`へ反映、CI・CF・SSH確認済み。native境界は#560で同じ元job時計へ束縛。自然定期での更新成功はコード受入と分ける |
| Yahoo等の源欠測 | 保存原応答からNULL・0・項目欠測・通信障害を区別し、根拠なく無取引と断定しない | 結果区分の#561に加え、認証/crumb/価格API/共有停止の段階診断#564をmain `dee57443`へ配備・SSH反映済み。各欠測の原因確定・最新対象日の充足とは別 |
| 財務NULL・本文空欄・歴史relation | 保存原典との対応を機械分類し、原典に値がある取りこぼしだけ修復。非公表を数値で埋めない | #566/#567の有限読取と#575/#577の原本修復を反映。固定5社に続き、現在code集合から別50社の本文1,950セルを通常CLIで照合した。結果は下記。全市場の分類は未検収で、旧6,251セル・35,158セル・relation1,649行を現在残数にしない |
| 株価・VWAP・IR原本 | 必要対象日の保存物と通常producerの実行を照合し、原典不足を別値で埋めない | 株式10/23未更新38件の原応答は35件全NULL・技術障害3件。VWAP固定3513/2198は日足[40144871284](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/40144871284)・5分足[40145161209](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/40145161209)で10/23まで補完し、summary物理全bytes・4POST全文SHAと通常資格を受入。旧PUT不明・全市場snapshot保留は維持し、全5分間隔の完全性へ広げない。TDnet1279652は単一再開を1回実施し、元URL/同一文書JPXとも404。対象D1全列/本文は不変、原本未取得HOLD。無取引や世界中の原本消失とは断定しない |
| 保有明細・権利処理 | 主体・株式種類・価格日・株数日・分割/併合/増資等の根拠と計算basisを資格化 | 明示不該当の分類は#561で配備済み。現在の開始可否と同世代HOLDの観測は下記。全保有価格・全権利種別の資格成立は未完 |
| マクロ・個別スクリーニング | 元仕様と同じ指標・対象・期間を使い、未取得を通過にしない | プライム売買代金比率、個別④需給・⑤将来カタリストは既存の未接続。#572で手動案内を元仕様へ修正済み。自動判定の完成扱いや、新条件の推定実装はしない。定義は下記 |
| 内部API・MCP | 既存の有効な認証情報で代表的な読取を本番通し確認 | 旧認証3ケース＋新REST7ケース/77行、MCP3ケースの段階受入済み。公開読取も5ケースPASS。全API・全データ充足の保証へ広げない。私有証跡は下記 |
| 本番受入・文書 | PR/CI/main/CF配備とSSH revisionを照合し、必要な有限補完を実行。設定と自然時刻の成功を区別 | #587のPR/main CI成功・同mainのCF100%・SSHを確認。main CIのテスト内タイマー競合は#587で解消。財務634Aの通常CLI受入と優待の有限本番適用は下記。初回Actionsの部分結果、次の自然定期、月次メール/実モデルを全件成功へ読み替えない |

取得元の停止・非公表・原本消失は取得成功としない。理由付きHOLDを実装しても、その値自体の取得完了には数えない。旧件数と固定集合の完了を現在の全市場の残数へ読み替えない。

## コード・配備の受入証跡

| 修正 | main | CI成功run | CF配備・SSH |
|---|---|---|---|
| [#563](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/563) Notion529・Python caller | `2fa25380` | [40120945024](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/40120945024) | build `b99428fe`、SSH同SHA確認済み |
| [#562](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/562) 33業種の先行条件 | `a90df635` | [40121405897](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/40121405897) | build `e218277a`、SSH同SHA確認済み |
| [#564](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/564) Yahoo取得段階 | `dee57443` | [40121989719](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/40121989719) | build `fa4c0832`、SSH同SHA確認済み |
| [#560](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/560) native・source/閉鎖期限 | `d0e892c4` | [40125828509](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/40125828509) | version `c50e2709-4c99-49bd-821a-7ea36ec43e52`、100%配備・SSH同SHA確認済み |
| [#568](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/568) 機械publisherのnative・source資格 | `7bad1bd1` | PR/main CI成功 | CF配備・SSH反映済み |
| [#570](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/570) 元job時計の有限再資格 | `0e68f801` | [40128240200](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/40128240200) | CF build `c7624cf9`、後続mainの配備・SSHに包含 |
| [#569](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/569) タグpreflight分離・本文来歴 | `a21fa1b6` | PR/main CI成功 | version `9072e964-e127-48ed-bf2b-0fffd4079b5b`、100%配備・SSH同SHA確認済み |
| [#571](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/571) 初回移行fence | `45629c8` | Node/Python成功 | 自動build `ded7ac0d`はasset API 10013で失敗。同SHAのWrangler明示配備1回が成功し、管理APIでversion `ed9038a7-ec2e-462b-a3fe-a6ec83874cb3`・100%を確認 |
| [#572](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/572) 元仕様に沿う手動案内 | `645db237` | [40133412573](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/40133412573) | build `3f2844d1`成功、管理APIでversion `bf5563f9-20b8-4481-a0ba-e26e2a4d831c`・100%を確認 |
| [#575](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/575) 通常/復旧の一次metadata・未閉鎖停止 | `a17c57d6` | [40136279550](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/40136279550) Node/Python成功 | build `a8af5744`成功、管理APIでversion `263d6810-8786-4d7f-a5db-ffddc3367b39`・100%、SSH同SHA |
| [#576](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/576) 現行運用文書・重複通知廃止 | `6049fd95` | [40137729773](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/40137729773) | version `aa91b16b-f992-486b-a997-88b5930c9de1`・100%、SSH反映済み |
| [#577](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/577) 適格完成ZIP再利用 | `63d89e48` | [40139171263](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/40139171263) | version `65dec3d3-89d1-45d4-ad47-3960d3610abb`・100%、SSH同SHA |
| [#578](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/578) 同値の派生metadata4列を明示訂正 | `d1f703c9` | [40142355257](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/40142355257) | version `c2aacf0a-3e15-4546-843e-56992275ab3f`・100%、SSH同SHA。3776の通常strict解決まで成功 |
| [#579](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/579) 送付月付き優待の機械要約 | `9e7356ab` | [40144212644](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/40144212644) | build `b4e10992`、version `569d9bde-f2c6-4cd1-a511-1985d2d91405`・100%、SSH同SHA。2872の3群/3行を本番適用 |
| [#581](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/581) 単一IR再開・元PDF識別 | `6f52395f` | [40145400482](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/40145400482) | version `b4ff24cb-3ede-4efc-9b91-300c0283be18`・100%、SSH同SHA。1279652だけ実行し両入口404/HOLDを確認 |
| [#582](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/582) 旧海外入口の退役 | `844790eb` | [40146402645](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/40146402645) | version `c721cb23-7acc-41e6-bf5d-7caa98994964`・100%、SSH同SHA。通常ingest/saved engineは維持 |
| [#583](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/583) 原本と既存parserによる有限財務診断 | `1bfc2c4b` | [40148979259](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/40148979259) | version `32e2a264-84d7-4af4-9580-46d86f5c7e1e`・100%、SSH同SHA。通常CLI入口のargv不備は#585で修正 |
| [#585](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/585) 財務CLIの必須SHA引数を修正 | `07b82532` | [PR 40149308878](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/40149308878) | version `6656d185-ce5a-4763-94fe-d479d9a5311a`・100%、SSH同SHA。通常captureとoffline診断を受入 |
| [#584](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/584) SSH手動株式CLIの通信期限 | `d4a2a5c1` | [40150303623](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/40150303623) | version `a15c48b9-8526-441f-a9f7-6019ac38bed1`・100%、SSH同SHA |
| [#586](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/586) 2施設券の機械要約 | `6c9b6218` | [PR 40150454142](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/40150454142) | version `b726c63e-25d8-4048-a4ff-922fccb11ae5`・100%、SSH同SHA。3521の3群/3行を本番適用 |
| [#587](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/587) 未対応銘柄指定の拒否・テスト競合修正 | `034bbd1c` | [40152192772](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/40152192772) | version `6612c0b3-5c20-4211-ada7-46d0ca592304`・100%、SSH同SHA |

mainの[40150836132](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/40150836132)はPython成功・Nodeの1テスト失敗だった。`daily-mode.test.ts`がHTTP側signalの停止後、別タイマーのR2 signalも停止済みと即断する競合を通信0で再現した。同じR2 assertionを有限の`vi.waitFor`で待つ修正とし、製品の期限・停止guardは変更していない。失敗runを成功へ読み替えず、#587のPR/main CI成功を別に受け入れた。

Python共通CLIは`master_sync`だけが銘柄限定に対応する。未対応9ジョブの`--codes`/省略形/空指定を引数解析で拒否し、設定・DB・原本取得へ進ませない。無指定の通常定期処理とmasterの厳格なコード検証は維持する。

CF管理APIのnames-only確認で`GITHUB_ACTIONS_TOKEN`・`CRON_SECRET`・`EDINET_API_KEY`・`NOTION_TOKEN`の登録と、必要なNotion plain varsのbindingを確認した。GitHubのworkflow参照Secretは登録済み。初回切替後の`MECHANICAL_PUBLISHING_ENABLED=true`も読戻し済みで、GitHubのR2 global secretは変更していない。Macは同account/bucketの既存SSH資格へ2 credentialだけを補正した。設定名の監査と配備実体は私有証跡へ分離している。

認証付き読取の私有証跡は`tmp/jss-auth-current7-20261025-v1/ACCEPTED.json`、公開読取は`tmp/jss-public-read-20261025.json`。認証付きの新REST7ケース/77行・MCP3ケースと旧3ケースの段階受入であり、全経路の網羅試験や旧欠測の解消ではない。

## 有限本番受入と残る境界

[共有状態の初回切替](../mechanical-publishing.md#初回切替rootoperatorが一度だけ実施)は明示fenceで完了した。旧10,456 files・3,485完成journal・1,779,649,567 bytesは不変。baseline `c968eddf…`を保管し、owner/pending閉鎖を全文GETで確認した。受入済みMac runtimeは`.runtime/mac-publishing-20261025`の`45629c8`。旧runtimeは版不一致で停止し、月次preflightを確認した。初回の通常初期化を成功へ読み替えたものではない。

canonicalのClef journal検査は978ディレクトリ、accepted977/rejected1・unknown/partial0だった。結果不明が存在する場合の保全ルールと、今回の実観測を混同しない。

634Aは39列SHA・新receipt・本文入力SHA一致、lineage3列と意味15列保持を確認した（私有`tmp/634a-post-acceptance-20261025-v1/FINAL.json`）。その後の原本復旧は6963/S100YF41、2683/S100Y5OG、3840/S100YKGUだけ。6963/3840のsource-only CLIは成功した。2683の旧runは`archive_unclosed_no_retry`のまま保全し、別ROで現在のtype1/type5の物理資格を確認した。旧unknownの閉鎖・原因確定とは別である。

| 本文39列の保存原本照合 | 結果・範囲 |
|---|---|
| scope4 固定5社、195セル | 6963/634A/2683/3840/3776。一致112・同CSVに対象要素なし5・原本/主体資格不足78。旧時点の測定を現在残数にしない |
| scope5 3840だけ、原本復旧後 | 39セル＝一致38・同CSVに対象要素なし1。原本資格不足/未読/未着手0 |
| scope6 3776だけ、通常解決後 | 39セル＝一致37・同CSVに対象要素なし2。資格不足/未読/未着手0、業務/上流/モデル0、16 HTTP・Notion10・429/再試行0 |
| 上記の時点が異なる5社の合成 | 一致187・同CSVに対象要素なし8。5社同時再測定や全市場の充足率ではない。原本CSVの要素なしをPDF全体で非開示とは扱わない |

私有report SHA: scope4 `11774995d7d2c438e43e8f526bdf906a90a01b87226fd39b54c83c8b5dced1da`、scope5 `e4fc47d20c5a70ddaceff3e78c7536fbd305443e2a112cd3678b43ca0735fd45`、scope6 `da657860602933c38675940f86eab9674bd0f47156b855e5ed66a38ceb36ed31`。

11:09 JSTに別50社の本文39項目をSSHの通常`audit:supplement:texts`で照合した。現在のcode-only 1SELECTで得た有効普通株3,686社から元固定5社を除く先頭50社を固定し、文書を先読みしていない。50社全て観測、未観測/未着手/実行停止0、1,950セルは一致487・同CSV要素なし20・原本/主体資格不足1,443。空欄75セルのうち55は資格不足のため理由未確定、残20は同CSVに対象要素なし。原本資格が成立した範囲では抽出差による空欄0だった。313 HTTP、write/源API/model0。exit1は資格不足を含む結果で、全社成功や非開示の証明にしない。SSH私有`tmp/supplement-next50-readonly-20261025-v1/report.json` SHA `cec8ff9ba9432efcaff86337360636a460d429baf23ddc8b330d0dcf2353df68`、cohort SHA `9b239f96c00896ed22c33e095e522f408ed77565dd1b94dc96091e45fdf86580`。

3776は現旧type1 ZIPの43/43 member bytes、全facts、本文37節・索引が同値だった。#578の通常CLIで派生metadata4列だけを物理PRE/CAS/POST付き訂正し、別の通常strict再資格化で観測2件を解決、HOLD0・進捗revision18・予約閉鎖・財務/本文不変を確認した。旧receiptと現progressの不一致は最初のplanがSTOPし、現在の保存原本receiptを資格化してから実行した。比較条件を緩めていない。私有受入`tmp/feature-audit-20261025/edinet3776-production-acceptance/`の`completed.json` SHA `db84bc403eace11378b7ad91697dafef9ffab05ff1cd4c67c5adea307b57938d`、`FINISHED.json` SHA `01c8b31dda13eadf72aa7577236da85c194ae4b9a99dde901c374ce07f1991cd`。

1279652は#581の通常CLIへ9/8 JST・exact ID・実clock+10分を渡し、1回だけ実行した。元URLと同一filenameのJPXとも404、exit0でも`skippedNoFile=1`・created/updated0。PRE/POST各3ROで対象D1全列/本文/cache投影は同値、既知child live/親一致・exact key0を確認した。元PDF未取得HOLDを、取得成功へ読み替えない。40日窓外なので次の日次catchupでは対象外で、手動再投入もしない。失敗理由は実行log/receiptへ残し、新規の空Notion行・監視は作らない。私有`tmp/feature-audit-20261025/tdnet1279652-post-readonly-v1/POST.private.json` SHA `1416afe6d068630c7cf03a225ada52584a4894b18d1485f279f25148dffcf3a0`。

保有の9:23有限ROはactive `local-9fe26841-activation1`・session10/16・3685 members、既知DBの価格unknown/再開queueはcomplete0。要確認先頭2502は同世代HOLDだけを観測し、全残数にはしなかった。9:27の既存reopen条件と同じ別世代filterもcomplete0で、同世代resumeは実行しない。価格・原本は再取得していない。1798/FY2026-03-31の実原本では法的4/1・普通株1→5と期末分割前株数を資格化できるが、providerの3/30イベントとAPI価格単位への結合は未資格でHOLDを維持する。[Yahoo公式Help](https://help.yahoo.com/kb/finance-for-web/adjusted-close-sln28256.html)の調整後終値の説明や`close=adjclose`だけから、Chart API各フィールドの株数単位を推定しない（10/25有限調査）。併合・増資への率流用もしない。

財務は無条件100行queryがNotionの明示incompleteでSTOPしたため、現在候補に採用していない。code634Aへ先限定した完全1行は19数値中NULL8・未知型0、4キー/source/rawrelationが保存入力と一致。fresh⑤ metadataとhosted原ZIPは2ROで79,467 bytes/fullSHAを資格化し、保存原本と全bytes一致した。この物理資格はNULL理由判定や全active対象の分類完了とは別である。原本SHA `0278f0d855e184c0252019e82c2e0e4a4f4bda6e342094c6b80a18dc82ba1637`、私有`tmp/financial-null-634a-fresh-raw-20261025-v1/RESULT.private.json` SHA `4225d3e9158220c6d19b9a977692d11a4928a110dd92d3fbff37835a91b65a65`。

財務634Aは#585後、SSHの同main/Nixから通常captureを2HTTP・code先限定で実行し、complete1行を得た。exact保存原本のoffline診断は19値不変・HOLD0・抽出差候補0。空欄8は非数値/nil1、選択scope内の該当context/直接値なし7で、原本全体の非開示や全active分類を意味しない。源API/業務write/model/再送0。私有`tmp/financial-null-production-634a-20261025-v1/FINISHED.private.json` SHA `d761d2691d9f59df26704b7f6cb3ed3f7c0d0ae55419105e598de3539ed3d22c`、診断SHA `6f15be15096d8e50251945435e90a1af8cd6b8db3c15a247882b6de3bdb74447`。先行のdriver/argv停止はどちらもHTTP前と確認し、旧STARTED/EXIT/失敗logを保全した継続記録に分離している。

初回の既存Actions `all` [40133382741](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/40133382741)はsource `45629c8`で自然終了し、**overall FAILURE**だった。

| 段階 | 有限実結果 |
|---|---|
| 本文 | selected50・processed31・synced31・HOLD0・unstarted19・model0。10分の新規開始予算終了で19社を残した。Notion449 requests・429 0・retry0 |
| 優待 | selected60・accepted0・rejected60・held60・pending147→147・model0。60件の個別理由を全て同じと断定しない |
| 実行境界 | 両jobの元job時計検証成功、Node v22.23.3、safe-stopped classなし、再実行0。通常閉鎖後のsummaryに加え、R2別GETでowner/pending=NULL・baseline `c968eddf…`一致・旧全bytes不変を確認 |

私有証跡は`publishing-initialization-fence` WT内の`tmp/feature-audit-20261025/mechanical-first-gha-v1/FINISHED.json`（SHA `416aca17ba76d94cf1d85b693abc5606ef9da64740e85c855c4d21fa1847e018`）、R2別GETは`tmp/mac-publishing-transition-20261025/first-gha-closed-readback.json`。未着手19は今回選択した50社の範囲であり、全市場の残数ではない。全残数を再計測していないため、全充足までの日数は算出しない。

2872は保存済みの掲載金額2,000/3,000/4,000円と送付5〜6月を共通compilerで抽出し、通常の全同銘柄tier集計・原子取込で3群/3行だけ適用した。物理Notion PRE/POST、全列POST、利回り/score、cursor2本の全bytes不変、R2 owner/pending閉鎖を検証。source/model/cursor書込0、D1送信1回、Notion12 requests・429/再試行0。SSH固定receipt `tmp/yutai-shipping-2872-normal-once-v1/FINISHED.json`（SHA `b2033aaf6c7972cd2bf8f8d553beac4d89d610253e08104ea372f86ca370dfee`）。

3521は保存済みの2施設券の全文から枚数・人数・利用不可日を保持し、通常compiler・同銘柄全tier集計・原子取込で3群/3行を適用した。掲載円額がないため推定額nullを3行とも保持。物理Notion PRE/POST・全列POST・cursor2本不変・owner/pending閉鎖・旧baseline不変を確認した。D1送信1回、Notion12 requests・429/再試行0、source/model/cursor書込0。SSH固定receipt `tmp/yutai-admission-3521-normal-once-v1/FINISHED.json`（SHA `d1079f7e43264442ca7c9b6bd7412e237cd4a70bb15e2f8aa33458ff3c61fbfe`）。

10:43 JSTの単一SELECTで、有効普通株の優待7,729行と同statementのwindow総数一致を確認し、通常selectorの未完は141群/209行/50銘柄だった。全件が要約missingで、contract違反/reworkは0。旧147からの引き算ではなく、現在集合の再計測である。D1読取28,523行・約246ms・1HTTP、write/Notion/R2/source/model0。この読取を適用用の原本資格へ流用しない。SSH私有`tmp/yutai-pending-current-count-fixed-v1/FINISHED.json` SHA `05068597732e5eb592137e17316749360677c5fe73ac515573d22dcb1a333c9e`。

Calendarは2026-11-11開始・毎月11日09:00 JST・開始0分前メールと短い5行のコマンド/privateログ手順への参照を読戻し済み。初メール受信・月次の本モデル実行は未観測。

10/22の通常優待月次は01:06〜01:59 JSTにexit0（明細1,711・取込1,650・優待7,728・失敗0）。古い1301のunknownだけを根拠に月次全体を再実行しない。全量D1再検証の完了を意味しない。

全20機能のうち、財務NULL・歴史relation、受注/海外の全対象分類、保有の全価格basisは固定5社の本文確認では検収できない。過去の件数を現在残数にせず、既存の対象限定監査で原本不足・非該当・実漏れを分ける。旧`audit:overseas`と非saved補完は廃止し、固定cohort・通信上限付きsaved prepare/inspectへ誘導する。旧入口は本番の定期処理では呼ばれていない。

10/23の株式未更新38件は保存済み証拠では35件の全NULLと技術障害3件に分かれる。NULLは出来高0ではなく、売買不成立は候補に留める。2385/2438のQuoteSummary409全文は設定proxyホストのCloudflare1001/DNS resolution errorで、Yahooデータ不在とは異なる。5884はChart原応答capture missing/ECONNRESET、QuoteSummary200の保存はある。取得した保存物はpart0だけでpart1〜35は未読、3件は未補完。私有`tmp/feature-audit-20261025/stock-tech3-saved-part0-readonly-v1/TARGET-ERROR-CLASSIFICATION.private.json` SHA `6d8fdc94e894ebbff83b3b2cec6d7a39efb3553bf214b1fbaa733fc500018c74`。別の8303長期履歴HOLDを38件へ重複計上せず、過去の原本欠測やVWAP旧unknownの解消とも混同しない。#343の全権利種別の資格化、上記の未接続指標、原本/主体不足は理由付き未充足として残す。次の対象日の自然実行待ちは、それ自体を障害に数えない。

## 元仕様で確認した指標

[短期売買実践ガイド](https://app.notion.com/p/340d74ff84cd80ab893ae0e2d4751f90)を10/25に参照した（取得内容の最終編集日は2026-04-19）。この参照は現在のデータ充足率を示すものではない。

- マクロの売買代金は**東証プライム**の20日平均比。現コードの`topixTurnoverRatio`という名前から、TOPIX構成銘柄へ対象を変えない。
- 個別④需給は**買残高と出来高の比率**（2倍超で悪化）。買残/売残の信用倍率や日証金の融資/貸株倍率とは別である。出来高の対象日と平均期間を、勝手に補って実装しない。
- 個別⑤は**2週間以内のカタリストの存在**。決算だけでなく、レーティング・自社株買い・政策等も含む。決算跨ぎの回避条件と置換しない。過去の決算短信の発表日から将来予定を生成しない。

Primeの既存接続原典から、同一定義の当日実代金と20日平均の系列はまだ資格化できていない。[日報](https://www.jpx.co.jp/markets/statistics-equities/daily/01.html)は翌営業日掲載、[月報](https://www.jpx.co.jp/markets/statistics-equities/monthly/01.html)は原則翌月21日で、当日夕方の値へ代用しない。全市場・週次両側合算・終値×出来高にも置き換えない。

[JPXの株式市況](https://www.jpx.co.jp/markets/equities/summary/index.html)は蓄積・加工等を禁止している。一般公開されていることだけを根拠に原本蓄積へ使用せず、既存の利用可能な公式統計原本を先に調べる。[JPXの決算予定一覧](https://www.jpx.co.jp/listing/event-schedules/financial-announcement/)は対象・更新時期と未掲載/予定変更の注意書きがあるため、掲載がない銘柄を「イベントなし」と判定しない。
