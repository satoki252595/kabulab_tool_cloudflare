# 定期取得の完了条件と残件 — 2026-10-25

対象は[Issue #348](https://github.com/satoki252595/kabulab_tool_cloudflare/issues/348)。[原20機能の監査](../test-logs/feature-gap-audit-20261014.md)と[全データ一覧](../batch-data-inventory.md)の範囲を縮めず、コード・配備・実データの受入を分ける。日次・月次は通常の機械処理、Clefによる事業タグ等は合意済みの月次手動とする。新規監視と全履歴RAWミラーは追加しない。以下は10/25の確認済み証跡であり、旧欠測件数の再集計や、改修後の全自然定期成功を示すものではない。

| 残件 | 完了とする条件 | 10/25時点の確認 |
|---|---|---|
| 定時起動・実時間の締切 | 未来予定を拒否し、許容遅配・source停止・原本保存・native timeout・receiptの順序が全入口で一致 | #560と機械publisher追補#568、元job時計の有限再資格#570をCI・main配備・SSHへ反映済み。改修後の全自然定期実績は別受入 |
| 本文39項目・基本情報の補足同期 | Linuxの通常定期処理がモデル・語彙判定に依存せず差分同期し、旧タグ根拠と最新本文を区別 | #565/#568/#569を反映、共有状態移行・有効化済み。634Aは39列SHA・本文入力SHA・receipt一致と意味15列保持を確認。初回Actionsは選択50社中31社を同期、HOLD0・未着手19・モデル0。10分の新規開始予算による有限結果であり、全社完了ではない |
| 優待の機械要約 | 既存compiler・検証・原子的publisherをLinuxから呼び、未解析は保留。Macの成否を先行条件にしない | 移行・有効化済み。2307の有限1件はカレンダー/基準日変更のみで額面がなく正当HOLD、更新0・完全POST不変・閉鎖を確認。初回Actionsは選択60件すべて保留・適用0・モデル0、pending147→147。他の保留を2307と同じ理由と断定しない |
| Notionの保存結果不明 | 非冪等書込の529等を再送せず、runnerと文書callerでも成功化・次文書続行しない | #563をmain `2fa25380`へ反映、CI・CF・SSH確認済み。読取529と明示拒否429は別契約のまま |
| 33業種更新の先行条件 | 株価・RSI失敗でも独立した原典取得を実行。取消・対象外の停止と通信枠を維持 | #562をmain `a90df635`へ反映、CI・CF・SSH確認済み。native境界は#560で同じ元job時計へ束縛。自然定期での更新成功はコード受入と分ける |
| Yahoo等の源欠測 | 保存原応答からNULL・0・項目欠測・通信障害を区別し、根拠なく無取引と断定しない | 結果区分の#561に加え、認証/crumb/価格API/共有停止の段階診断#564をmain `dee57443`へ配備・SSH反映済み。各欠測の原因確定・最新対象日の充足とは別 |
| 財務NULL・本文空欄・歴史relation | 保存原典との対応を機械分類し、原典に値がある取りこぼしだけ修復。非公表を数値で埋めない | #566/#567の有限読取をSSHで実施。設定不足3IDを補正し、新lineage3列も確認済み。固定5社scope4は全195セル着手済み：一致112・同CSV要素なし5・原本/主体の資格不足78。空欄8は対象要素なし5・資格未確定3。実漏れ0はこの固定集合だけの測定。repairの`secCode/periodStart`契約差と保存結果不明時の後続停止を#575で修正・main/CF/SSHへ反映。6963はsource-only復旧成功、2683は保管未閉鎖停止後のROでCSVのstrict資格成立を確認。3840未開始・3776保留は残る。旧6,251セル・35,158セル・relation1,649行を現在残数にしない |
| 保有明細・権利処理 | 主体・株式種類・価格日・株数日・分割/併合/増資等の根拠と計算basisを資格化 | 明示不該当の分類は#561で配備済み。全保留価格・全権利種別の資格成立は未完 |
| マクロ・個別スクリーニング | 元仕様と同じ指標・対象・期間を使い、未取得を通過にしない | プライム売買代金比率、個別④需給・⑤将来カタリストは既存の未接続。#572で手動案内を元仕様へ修正済み。自動判定の完成扱いや、新条件の推定実装はしない。定義は下記 |
| 内部API・MCP | 既存の有効な認証情報で代表的な読取を本番通し確認 | 旧認証3ケース＋新REST7ケース/77行、MCP3ケースの段階受入済み。公開読取も5ケースPASS。全API・全データ充足の保証へ広げない。私有証跡は下記 |
| 本番受入・文書 | PR/CI/main/CF配備とSSH revisionを照合し、必要な有限補完を実行。設定と自然時刻の成功を区別 | #568/#570/#569までCI・配備・SSH反映済み。#571は自動CF build失敗後、同SHAの明示配備成功と100%を確認。移行・有限確認・有効化済みで、初回Actions結果、次の自然定期、月次メール/実モデルは別受入 |

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

CF管理APIのnames-only確認で`GITHUB_ACTIONS_TOKEN`・`CRON_SECRET`・`EDINET_API_KEY`・`NOTION_TOKEN`の登録と、必要なNotion plain varsのbindingを確認した。GitHubのworkflow参照Secretは登録済み。初回切替後の`MECHANICAL_PUBLISHING_ENABLED=true`も読戻し済みで、GitHubのR2 global secretは変更していない。Macは同account/bucketの既存SSH資格へ2 credentialだけを補正した。設定名の監査と配備実体は私有証跡へ分離している。

認証付き読取の私有証跡は`tmp/jss-auth-current7-20261025-v1/ACCEPTED.json`、公開読取は`tmp/jss-public-read-20261025.json`。認証付きの新REST7ケース/77行・MCP3ケースと旧3ケースの段階受入であり、全経路の網羅試験や旧欠測の解消ではない。

## 有限本番受入と残る境界

[共有状態の初回切替](../mechanical-publishing.md#初回切替rootoperatorが一度だけ実施)は明示fenceで完了した。旧10,456 files・3,485完成journal・1,779,649,567 bytesは不変。baseline `c968eddf…`を保管し、owner/pending閉鎖を全文GETで確認した。受入済みMac runtimeは`.runtime/mac-publishing-20261025`の`45629c8`。旧runtimeは版不一致で停止し、月次preflightを確認した。初回の通常初期化を成功へ読み替えたものではない。

canonicalのClef journal検査は978ディレクトリ、accepted977/rejected1・unknown/partial0だった。結果不明が存在する場合の保全ルールと、今回の実観測を混同しない。

634Aの完全POSTは39列SHA・新receipt・本文入力SHA一致、lineage3列を確認し、判定入力SHAはNULL/未確認を保持した。私有証跡: `tmp/634a-post-acceptance-20261025-v1/FINAL.json`（SHA `bb7ccbf3e30146ced9749a609c3751c1fec05daaf5de3d833e783862d89fc4f8`）。固定5社は634A/6963/2683/3840/3776だけの観測。他4社は、3社の保存ZIPの所属/状態資格不成立と3776のlatest source HOLDを直接観測した。旧reportはページ不存在・archived/trash・親不一致のどれかを区別していない。別途見つかったrepair契約差は#575で修正した。現canonical DBのactive type5 keyを未検出だった固定3通のうち、6963はsource-only CLI成功。2683は一覧保存後のZIP保管で`archive_unclosed_no_retry`となり、同runを再送せず3840の開始も止めた。scope4の通常RO診断では6963/2683ともCSVのstrict資格・全文同値が成立したが、2683のtype1を含む保管停止全体の閉鎖は未証明。3840は未開始のまま原本資格不足。これを4社全ての原因と断定しない。全社・全空欄の解消ではない。

scope4は195セル中、一致112・同CSVに要素なし5・原本/主体不足78。6963は37/2、634Aは38/1、2683は37/2、3840/3776は各39セルの資格不足。8空欄は対象要素なし5と未資格3、実漏れ0・時点差0・未読0。上流/業務/モデル0、44 HTTP、Notion 429なし。全市場の充足へ一般化しない。SSH私有reportのSHAは`11774995d7d2c438e43e8f526bdf906a90a01b87226fd39b54c83c8b5dced1da`。

3776の追加限定readでは、本番の受注・海外facts各0件、索引37件、保存本文37節が現行parser/serializerと一致した。現旧type1 ZIPを物理取得し43/43 member bytesも一致。差は派生status3項目と省略根拠の保管page/manifest/ZIP SHAで、既存strictのHOLDを維持する。金融値・本文の欠落は見つからず、情報修正の保留解除は未完。私有証跡は`tmp/feature-audit-20261025/edinet3776-current-equality-readonly-v2/result.json`（SHA `79460c4da509e19259da3a9a5b28375cdc93914bbe46ed79a7d6148e1edb2525`）。

初回の既存Actions `all` [40133382741](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/40133382741)はsource `45629c8`で自然終了し、**overall FAILURE**だった。

| 段階 | 有限実結果 |
|---|---|
| 本文 | selected50・processed31・synced31・HOLD0・unstarted19・model0。10分の新規開始予算終了で19社を残した。Notion449 requests・429 0・retry0 |
| 優待 | selected60・accepted0・rejected60・held60・pending147→147・model0。60件の個別理由を全て同じと断定しない |
| 実行境界 | 両jobの元job時計検証成功、Node v22.23.3、safe-stopped classなし、再実行0。通常閉鎖後のsummaryに加え、R2別GETでowner/pending=NULL・baseline `c968eddf…`一致・旧全bytes不変を確認 |

私有証跡は`publishing-initialization-fence` WT内の`tmp/feature-audit-20261025/mechanical-first-gha-v1/FINISHED.json`（SHA `416aca17ba76d94cf1d85b693abc5606ef9da64740e85c855c4d21fa1847e018`）、R2別GETは`tmp/mac-publishing-transition-20261025/first-gha-closed-readback.json`。未着手19は今回選択した50社の範囲であり、全市場の残数ではない。全残数を再計測していないため、全充足までの日数は算出しない。

Calendarは2026-11-11開始・毎月11日09:00 JST・開始0分前メールと短い5行のコマンド/privateログ手順への参照を読戻し済み。初メール受信・月次の本モデル実行は未観測。

10/23の株式未更新38件は保存済み証拠では35件の全NULLと技術障害3件に分かれる。NULLは出来高0ではなく、売買不成立は候補に留める。別の8303長期履歴HOLDを38件へ重複計上せず、過去の原本欠測やVWAP旧unknownの解消とも混同しない。#343の全権利種別の資格化、上記の未接続指標、原本/主体不足は理由付き未充足として残す。次の対象日の自然実行待ちは、それ自体を障害に数えない。

## 元仕様で確認した指標

[短期売買実践ガイド](https://app.notion.com/p/340d74ff84cd80ab893ae0e2d4751f90)を10/25に参照した（取得内容の最終編集日は2026-04-19）。この参照は現在のデータ充足率を示すものではない。

- マクロの売買代金は**東証プライム**の20日平均比。現コードの`topixTurnoverRatio`という名前から、TOPIX構成銘柄へ対象を変えない。
- 個別④需給は**買残高と出来高の比率**（2倍超で悪化）。買残/売残の信用倍率や日証金の融資/貸株倍率とは別である。出来高の対象日と平均期間を、勝手に補って実装しない。
- 個別⑤は**2週間以内のカタリストの存在**。決算だけでなく、レーティング・自社株買い・政策等も含む。決算跨ぎの回避条件と置換しない。過去の決算短信の発表日から将来予定を生成しない。

[JPXの株式市況](https://www.jpx.co.jp/markets/equities/summary/index.html)は蓄積・加工等を禁止している。一般公開されていることだけを根拠に原本蓄積へ使用せず、既存の利用可能な公式統計原本を先に調べる。[JPXの決算予定一覧](https://www.jpx.co.jp/listing/event-schedules/financial-announcement/)は対象・更新時期と未掲載/予定変更の注意書きがあるため、掲載がない銘柄を「イベントなし」と判定しない。
