# 定期取得の完了条件と残件 — 2026-10-25

対象は[Issue #348](https://github.com/satoki252595/kabulab_tool_cloudflare/issues/348)。[全データ一覧](../batch-data-inventory.md)の範囲を縮めず、コード・配備・実データの受入を分ける。日次・月次は通常の機械処理、Clefによる事業タグ等は合意済みの月次手動とする。新規監視と全履歴RAWミラーは追加しない。以下は10/25の確認済み証跡であり、旧欠測件数の再集計や、改修後の全自然定期成功を示すものではない。

| 残件 | 完了とする条件 | 10/25時点の確認 |
|---|---|---|
| 定時起動・実時間の締切 | 未来予定を拒否し、許容遅配・source停止・原本保存・native timeout・receiptの順序が全入口で一致 | #560をmain `d0e892c4`へ反映、CI・CF配備・SSH同SHAを確認済み。機械publisherのnative追補は#568、改修後の自然定期実績は別受入 |
| 本文39項目・基本情報の補足同期 | Linuxの通常定期処理がモデル・語彙判定に依存せず差分同期し、旧タグ根拠と最新本文を区別 | 分離・共有writerは#565（main `ed9923da`）で実装済み。#568の元job時計・保存source資格は受入待ち。別途タグ用モデルpreflight分離・共有状態初期化・有限本番受入・有効化が残る。Mac自動起動は停止を維持 |
| 優待の機械要約 | 既存compiler・検証・原子的publisherをLinuxから呼び、未解析は保留。Macの成否を先行条件にしない | #565でLinux入口と原文取込・Mac共通の非期限writerを実装済み。#568のnative追補後、同じ初回移行・本番受入・有効化が必要。未閉鎖intentは自動解除しない |
| Notionの保存結果不明 | 非冪等書込の529等を再送せず、runnerと文書callerでも成功化・次文書続行しない | #563をmain `2fa25380`へ反映、CI・CF・SSH確認済み。読取529と明示拒否429は別契約のまま |
| 33業種更新の先行条件 | 株価・RSI失敗でも独立した原典取得を実行。取消・対象外の停止と通信枠を維持 | #562をmain `a90df635`へ反映、CI・CF・SSH確認済み。native境界は#560で同じ元job時計へ束縛。自然定期での更新成功はコード受入と分ける |
| Yahoo等の源欠測 | 保存原応答からNULL・0・項目欠測・通信障害を区別し、根拠なく無取引と断定しない | 結果区分の#561に加え、認証/crumb/価格API/共有停止の段階診断#564をmain `dee57443`へ配備・SSH反映済み。各欠測の原因確定・最新対象日の充足とは別 |
| 財務NULL・本文空欄・歴史relation | 保存原典との対応を機械分類し、原典に値がある取りこぼしだけ修復。非公表を数値で埋めない | 有限読取CLIは#566（main `af2830a6`）、停止stage診断は#567（main `4ee0c136`）で実装済み。SSHの必須Notion ID3不足は補正済みだが、新nullable3列が未作成で資格停止。旧観測の本文6,251セル・歴史relation1,649行を現在残数へ読み替えず、全件解消も未受入 |
| 保有明細・権利処理 | 主体・株式種類・価格日・株数日・分割/併合/増資等の根拠と計算basisを資格化 | 明示不該当の分類は#561で配備済み。全保留価格・全権利種別の資格成立は未完 |
| マクロ・個別スクリーニング | 元仕様と同じ指標・対象・期間を使い、未取得を通過にしない | 売買代金入力、需給、将来カタリストの未接続は今回の不具合修正範囲に残る既存制約。新条件を推定実装せず、完成扱いにしない。定義は下記 |
| 内部API・MCP | 既存の有効な認証情報で代表的な読取を本番通し確認 | 旧認証3ケース＋新REST7ケース/77行、MCP3ケースの段階受入済み。公開読取も5ケースPASS。全API・全データ充足の保証へ広げない。私有証跡は下記 |
| 本番受入・文書 | PR/CI/main/CF配備とSSH revisionを照合し、必要な有限補完を実行。設定と自然時刻の成功を区別 | #563/#562/#564/#560のCI・配備・SSH一致を確認済み。#568・機械publisher切替・schema/有限本番受入・次の自然定期実績は未完として分離 |

取得元の停止・非公表・原本消失は取得成功としない。理由付きHOLDを実装しても、その値自体の取得完了には数えない。旧件数と固定集合の完了を現在の全市場の残数へ読み替えない。

## コード・配備の受入証跡

| 修正 | main | CI成功run | CF配備・SSH |
|---|---|---|---|
| [#563](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/563) Notion529・Python caller | `2fa25380` | [40120945024](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/40120945024) | build `b99428fe`、SSH同SHA確認済み |
| [#562](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/562) 33業種の先行条件 | `a90df635` | [40121405897](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/40121405897) | build `e218277a`、SSH同SHA確認済み |
| [#564](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/564) Yahoo取得段階 | `dee57443` | [40121989719](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/40121989719) | build `fa4c0832`、SSH同SHA確認済み |
| [#560](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/560) native・source/閉鎖期限 | `d0e892c4` | [40125828509](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/40125828509) | version `c50e2709-4c99-49bd-821a-7ea36ec43e52`、100%配備・SSH同SHA確認済み |

CF管理APIのnames-only確認で`GITHUB_ACTIONS_TOKEN`・`CRON_SECRET`・`EDINET_API_KEY`・`NOTION_TOKEN`の登録と、必要なNotion plain varsのbindingを確認した。GitHubのworkflow参照Secretは登録済みで、`MECHANICAL_PUBLISHING_ENABLED`未設定は初回切替待ちによる意図的停止。値の読取・変更はこの確認に含めない。私有証跡: `tmp/cf-main-state-read-20261025-v2/result.json`。

認証付き読取の私有証跡は`tmp/jss-auth-current7-20261025-v1/ACCEPTED.json`、公開読取は`tmp/jss-public-read-20261025.json`。認証付きの新REST7ケース/77行・MCP3ケースと旧3ケースの段階受入であり、全経路の網羅試験や旧欠測の解消ではない。

機械publisherは[#565](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/565)のマージを初期化・有効化の実績に数えない。[#568](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/568)の受入後、[共有状態の初回切替](../mechanical-publishing.md#初回切替rootoperatorが一度だけ実施)と有限本番確認を閉じてから有効化する。

## 元仕様で確認した指標

[短期売買実践ガイド](https://app.notion.com/p/340d74ff84cd80ab893ae0e2d4751f90)を10/25に参照した（取得内容の最終編集日は2026-04-19）。この参照は現在のデータ充足率を示すものではない。

- マクロの売買代金は**東証プライム**の20日平均比。現コードの`topixTurnoverRatio`という名前から、TOPIX構成銘柄へ対象を変えない。
- 個別④需給は**買残高と出来高の比率**（2倍超で悪化）。買残/売残の信用倍率や日証金の融資/貸株倍率とは別である。出来高の対象日と平均期間を、勝手に補って実装しない。
- 個別⑤は**2週間以内のカタリストの存在**。決算だけでなく、レーティング・自社株買い・政策等も含む。決算跨ぎの回避条件と置換しない。過去の決算短信の発表日から将来予定を生成しない。

[JPXの株式市況](https://www.jpx.co.jp/markets/equities/summary/index.html)は蓄積・加工等を禁止している。一般公開されていることだけを根拠に原本蓄積へ使用せず、既存の利用可能な公式統計原本を先に調べる。[JPXの決算予定一覧](https://www.jpx.co.jp/listing/event-schedules/financial-announcement/)は対象・更新時期と未掲載/予定変更の注意書きがあるため、掲載がない銘柄を「イベントなし」と判定しない。
