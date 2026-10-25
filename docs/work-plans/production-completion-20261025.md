# 定期取得の完了条件と残件 — 2026-10-26更新

対象は[Issue #348](https://github.com/satoki252595/kabulab_tool_cloudflare/issues/348)。[原20機能の監査](../test-logs/feature-gap-audit-20261014.md)と[全データ一覧](../batch-data-inventory.md)の範囲を縮めず、コード・配備・実データの受入を分ける。日次・月次は通常の機械処理、Clefによる事業タグ等は合意済みの月次手動とする。新規監視と全履歴RAWミラーは追加しない。以下は10/26までの有限確認であり、旧欠測件数の再集計や、改修後の全自然定期成功を示すものではない。

| 残件 | 完了とする条件 | 10/26までの確認 |
|---|---|---|
| 定時起動・実時間の締切 | 未来予定を拒否し、許容遅配・source停止・原本保存・native timeout・receiptの順序が全入口で一致 | #560と機械publisher追補#568、元job時計の有限再資格#570、SSH手動株式CLIの翌06時通信停止#584をCI・main配備・SSHへ反映済み。10/23 MWF/VWAPは17:15〜17:25 JSTの遅配が旧受付外となった。#560の予定時刻基準による根本修正後の自然定期実績は別受入 |
| 本文39項目・基本情報の補足同期 | Linuxの通常定期処理がモデル・語彙判定に依存せず差分同期し、旧タグ根拠と最新本文を区別 | 固定3,686社の旧10窓は478処理（同期261・同値216・保留1）で閉鎖。後続2683は05:45の別窓で同期1・保留0、原39と旧タグ根拠を保持。旧時点の未処理3,208社を保持し、次40社は未終端。全社完了や財務充足とはしない |
| 優待の機械要約 | 既存compiler・検証・原子的publisherをLinuxから呼び、未解析は保留。Macの成否を先行条件にしない | 8551通常3行反映後、05:25の全7,728行POSTで未完32群/54行/12銘柄・非対象7,725行同一を実測。続く8336年次3行は公式原本3実体・全4表PRE/POST・SQL0再計画と共有状態閉鎖を受入。以後の全市場残数は未計測、外数の初回2026-09-30限定3INSERTは未実行 |
| Notionの保存結果不明 | 非冪等書込の529等を再送せず、runnerと文書callerでも成功化・次文書続行しない | #563をmain `2fa25380`へ反映、CI・CF・SSH確認済み。読取529と明示拒否429は別契約のまま |
| 33業種更新の先行条件 | 株価・RSI失敗でも独立した原典取得を実行。取消・対象外の停止と通信枠を維持 | #562をmain `a90df635`へ反映、CI・CF・SSH確認済み。native境界は#560で同じ元job時計へ束縛。自然定期での更新成功はコード受入と分ける |
| Yahoo等の源欠測 | 保存原応答からNULL・0・項目欠測・通信障害を区別し、根拠なく無取引と断定しない | 結果区分の#561に加え、認証/crumb/価格API/共有停止の段階診断#564をmain `dee57443`へ配備・SSH反映済み。各欠測の原因確定・最新対象日の充足とは別 |
| 財務NULL・本文空欄・歴史relation | 保存原典との対応を機械分類し、原典に値がある取りこぼしだけ修復。非公表を数値で埋めない | 固定40社の通常照合は1,560セル＝一致1,528・同CSV要素なし32、資格不足0。財務の不足15原本から固定17行・323セルを通常診断し、ROA4行をNotion・D1へ反映。同statement全34列行CASと全17行PRE/POSTで、差は同4行のROAだけ、他13行・原本/時計/書類ID/licenseは不変。保存scope候補なし137を公式非開示と断定せず、全市場分類は未検収 |
| 受注・海外の保存補完 | 原本・主体・期を資格化し、通常parserと全6表の比較・原子的適用・独立inspectを通す | 旧20文書・既存75行の区分補完に続き、行なし13文書120明細をSSHで通常prepare→apply→別inspectまで閉鎖。恒久state146ファイル/145claim、旧133全bytes保持。区分NULL不一致31文書と、区分のみ一致6721の金額/key/全6表資格が残る |
| 株価・VWAP・IR原本 | 必要対象日の保存物と通常producerの実行を照合し、原典不足を別値で埋めない | 日足全3,686件は更新2,695・skip990・HOLD1で閉鎖し、新activeを独立受入。5分足5d窓も全3,686件＝更新3,679・skip2・error5、unknown/未着手0・原本123batch/pageとsummary保管済み。日足523Aの履歴欠測、株式マスタ38件、5分足の失敗・旧日付・窓外欠測、旧PUT不明は未検収。TDnet1279652は原本両入口404、会社公式の限定調査でも同一原本未確認/HOLD |
| 保有明細・権利処理 | 主体・株式種類・価格日・株数日・分割/併合/増資等の根拠と計算basisを資格化 | snapshot40169768650.1/session10/23/3,685 membersを独立受入。通常resumeの次窓はusedRows30/resumed2/held3・pending=false、23intent→23HTTP200・未解決writeなしで閉鎖。同窓のheld3と全保有価格・全権利種別の資格成立は未完 |
| マクロ・個別スクリーニング | 元仕様と同じ指標・対象・期間を使い、未取得を通過にしない | プライム売買代金比率、個別④需給・⑤カタリスト（2週間、過去/未来の範囲は確認中）は既存の未接続。#572の手動案内に残った未来限定を訂正。自動判定の完成扱いや、新条件の推定実装はしない。定義は下記 |
| 資金フロー29取得元 | 公表期間・全系列・単位と通常取得結果をsource別に確認 | 直近通常3runを確認。10/23の独立28sourceは26正常、投信/REITの2sourceはHTTP503で全体FAILURE。10/25に[公式10/23告知](https://www.imaj.or.jp/news/2026/20261023_001929.html)の統計停止継続と[正準index](https://www.imaj.or.jp/statistics/)の既存入口を確認。コード移転・非公表・取得成功に読み替えない。株価依存の業種売買代金は別経路で未検収、全sourceの最新keyだけで全期/全系列充足としない |
| 内部API・MCP | 既存の有効な認証情報で代表的な読取を本番通し確認 | 旧認証3ケース＋新REST7ケース/77行、MCP3ケースの段階受入済み。公開読取も5ケースPASS。全API・全データ充足の保証へ広げない。私有証跡は下記 |
| 本番受入・文書 | PR/CI/main/CF配備とSSH revisionを照合し、必要な有限補完を実行。設定と自然時刻の成功を区別 | #618 main 4b0fb282のCI3本・CF e3fe4397 100%・SSH同head、env/受注146state保持を受入。#619 main 656ffd90はマージ済みで本番反映確認中。全市場の財務/本文/優待・次の自然定期・月次実モデルは別受入 |

取得元の停止・非公表・原本消失は取得成功としない。理由付きHOLDを実装しても、その値自体の取得完了には数えない。旧件数と固定集合の完了を現在の全市場の残数へ読み替えない。

## コード・配備の受入証跡

10/26 05:39 JSTまでに、#618 main `4b0fb282`の[CI 40230875142](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/40230875142)3本成功、CF version `e3fe4397-e366-4583-a8ae-80c922f1f15e` 100%とSSH同headを受入。envと受注146state全bytesを保持した。私有受入は`main618-acceptance-v1/ACCEPTED-CI-CF.private.json`と`ACCEPTED-SSH.private.json`。#619 main `656ffd90`はマージ済みだが、CF/SSHの受入は別確認中である。

8551は05:25の通常処理で3行（62114〜62116）を更新し、全7,728行POSTで非対象7,725行同一、未完32群/54行/12銘柄を実測した。私有受入は`yutai8551-normal-window-draft-qol5_75_/ACCEPTED.private.json`、物理POST SHA `587844ba39627944a5ca4a9d7d121130f5cd134b39ac15b00ff2b43e79c39376`。続く05:30の8336年次3行（62011〜62013）は提供元HTML・公式HTML/PDFの3実体保管、全4表PRE/POST・非対象列保持・実POSTからのSQL0再計画・共有owner/両cursor閉鎖を受入。私有受入は`yutai8336-annual3-adoption-preflight-v1/ACCEPTED.private.json`、POST SHA `0084f71f0806118a064c47d22cb9d8c02d46c0e732d0d32d1d339764c61002fb`。以後の全市場残件は再計測しておらず、旧実測からの差引値を現在残数にしない。初回2026年9月30日の3INSERTは未実行である。

2683の商号差は05:45の通常別窓で同期1・保留0となり、Notion24要求で現在原39と旧タグ根拠の保持を確認した。runtime `4b0fb282`の次40社は作業中・未終端のため、旧10窓時点の未処理3,208社から推計で減らさない。

10/26 04:49 JST、#617 main `1c3c0590`の[CI 40227704142](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/40227704142)3本成功、CF version `f55463b0-a2ff-4aab-b996-ed86659b7044` 100%を受入。05:03にSSHも同headへ反映し、env・受注146state全bytesを保持した。私有受入は`main617-acceptance-v1/`。銀行優待のコード配備と実データ適用は別に受け入れる。

受注13文書は04:39に通常applyを閉鎖し120明細（連結true12/false108）を保存、04:54に別inspectを閉鎖した。全6表POST・原本本文・物理PRE/POSTの全bytes・非対象保持・再計画同値を確認。新13claimを加えた146ファイル/145claimはinspect前後不変、旧133ファイルも保持した。inspectは90HTTPで業務write0。私有完了は`orders-nofact13-inspect-offline-closure-v1/COMPLETION.private.json`（SHA `17b83404f5ed2be36964f651945470982d5667aa3c5cd1c5866e11e4cf624fa5`）。残31文書の後の最終窓は、区分一致だけの6721も含め値/key/全6表を確認し、固定177の完了をclaim数だけで推定しない。

10/26 03:44 JST、#616 main `ea6198cb`の[CI 40222296233](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/40222296233)3本成功、CF version `70fae727-6bcb-489a-affe-8da6f84198f7` 100%を受入。03:51にSSHも同headへ反映した。通常優待処理で3498の2行・6040の1行を更新し、全7,728行POSTの通常selectorは未完35群/57行/13銘柄。私有受入は`main616-acceptance-v1/`と`yutai3498-ski6040-normal-release-v1/ACCEPTED.private.json`（SHA `4c5f6e2c67ad22fbb673a0ff97415e9386aa52b3670e9465f18c803f5da9ce3a`）。

本文の固定母集団の10窓は03:49までに閉鎖し、500選択中478処理・未着手22、未選択3,186を合わせ未処理3,208社を保存した。同期261・同値216・保留2683の1社、結果不明0。2683は最新マスタのUOGroupと旧社名魚喜の差を確認し、主体資格を保持する通常経路の修正中。私有受入は`supplement-remaining73-explicit-normal-prep-v1/FINAL-ACCEPTED.private.json`（SHA `dfe865adcbcb16bdc8c1c253298f215b1c9ee885174e6d812892cbdb09ce33fa`）。

受注の次13文書は04:07までに通常prepareを閉鎖し、保存原本・全6表・通常parser/mapperと原子適用のoffline検証を完了した。120明細の連結区分はtrue12/false108で、形式A/Bから推定していない。API141要求・原本の追加上流取得/業務write/claim作成0、本番apply/独立inspectは未実行。私有受入は`orders-nofact13-offline-audit-draft-v1/COMPLETION.private.json`（SHA `91307e9443556eea1b799235b75245841749e773bb3dbf42c586239e3a2b9ed4`）。

10/26 01:57 JST、#615 main `f4ff12ed`の[CI 40213624437](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/40213624437)3本成功、Cloudflare version `54aaef7e-8620-413a-a51b-b23f7ece5d1d`の100%と同main buildの対応、SSH同SHAを受入。env・受注133stateの全bytes/mode・Mac runtimeは不変。私有受入は`tmp/feature-audit-20261026/main615-acceptance-v1/`。

同02:00 JST、8370の1群/1行を通常機械publisherで反映した。掲載5000円・87字の条件要約を採用し、全物理PRE/POSTと非対象保持、owner/pending閉鎖を確認。通常CLIは38群の既知保留によりexit1、外側の受入はexit0であり、全件成功とはしない。通常全7,728行POSTから未完38群/60行/15銘柄を実測した。追加COUNT・実行時モデル・新上流取得・業務再送0。私有受入SHA `7221dddb10825e3a42a6cd670618f15d188913a36d08c73739ba398f4d7b0b24`。

受注の旧45文書は、保存済み全原本の通常parser結果を文書ごとの連結区分として使い、1本の限定D1 SELECTで現受注126行＝NULL124/true2/false0を確認した。31文書が区分NULL不一致、13文書が受注行なし、6721の1文書は区分のみ一致。書類欠落0、read293/write0、Notion/R2/SSH/新原本/claim操作0。形式A/Bから連結/単独を推定せず、金額・自然key・原本保管・全6表の通常PREが未確認の44文書を再確認候補として保持する。私有FINISHED SHA `33217890f0813b2248587c4aa9dccf70e906fe8ca3c9927a0e6fdf9728d209a5`。

TDnet1279652は[会社公式IR・公式feedの限定調査](../research/tdnet-1279652-original-20261026.md)でも同一原本の移転先を確認できなかった。9/9差替と3/23同題名は別文書として除外し、原本未取得HOLDを維持する。今回のPDF取得・本番書込・通常CLI再投入0。

10/26 00:46 JST、受注の追加20文書は通常prepare→apply→別inspectをSSHで閉鎖した。既存75行の`is_consolidated` NULL→trueだけを補完し、数値行の追加0、他fact業務列・他5表・reported flagsを保持。物理PRE/POSTの独立読戻しと全133state bytes不変、全owned process終了を確認した。原本の追加上流取得・モデル・業務再送0。私有`orders-excluded65-next20-ssh-draft-v1/ACCEPTED.private.json` SHA `37d8d7c9b6bea72779257be4f1187d489221d0664663d136cb45f6838ea6d7b4`。累積claimの132/177は受入lineageで、現在の全市場充足率ではない。

同00:40 JSTのcode-only 1SELECTで現役内国普通株3,686コードを実測した。D1 read7,372/write0、文書/Notion/モデル0。これは本文の完了数ではない。既存の銘柄限定通常CLIで50社以下の74バッチへ計画した。私有`tmp/active-equity-codes-readonly-20261026-v1/FINISHED.private.json` SHA `d303c99d64ebe2862462383a5ce30f8cfdba8a8f8279e83453688211bdd6ad2a`。

01:28〜01:31 JST、先頭50社を`sync:mechanical --target=supplement --codes=… --limit=50 --budget-min=15`で通常処理した。全50社が同値、HOLD/未着手/モデル/新規上流0。50最新doc・原文/Notion本文の両SHA・銘柄別結果を保存し、共有3keyの本文/ETagと両cursor、全owned業務終了を確認。210,511ms、Notion165要求・429/再試行0であり、更新やHOLDが混在する後続の所要時間上限へは外挿しない。この固定母集団で残73バッチ/3,636社は別受入。私有`supplement-first50-explicit-normal-prep-v1/ACCEPTED.private.json` SHA `2904d5b7fccd2e37238749271cc46251c1cd1eb837137308a72b319d37a3e80b`。

配備受入は#614 main `4b34657f`、[CI 40210620863](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/40210620863)の3本成功・SSH同SHA。管理APIでdeployment `bdc9f3b3` / version `66ddea40`の100%と同main buildの対応を確認した。有報の封印保留を最終照合日順に巡回する修正、優待の百貨店・期限付きギフト、本文同期の銘柄別結果記録を含む。env・受注133state bytes・Mac runtimeは変更していない。私有受入は`tmp/feature-audit-20261026/main614-acceptance-v1/`。PRのCF previewはsuite受付後にrun未発行だったが、マージ後の同main自動buildと実配備は別に確認した。

10/26 01:22 JSTの優待通常1窓は47群を選択し、3086の6群12行と7599の2群4行を反映、39群を既知HOLDで閉鎖した。百貨店カードは現金額へ換算せずNULL、ギフトは掲載各回額13,500円/30,000円を各2行へ採用し、年額の割戻しは使わない。物理PRE/POST・非対象・本文cursor2152・baselineを保持、優待cursorは通常順序で進行しowner/pending閉鎖・全owned業務終了を確認。通常全7,728行POSTで未完39群/61行/16銘柄を実測した。実行時モデル/新規上流/業務再送/受入の追加APIは0。私有`yutai-contract9-normal-window-prep-v1/ACCEPTED.private.json` SHA `ceb27d886442d2ad25c5fb3b6f9a530512fc35077036612b3012825a19d539f6`。以下は個別の受入履歴。

23:02の通常優待1窓は56群を選択し、4053の6群/6行を採用・50群を既知HOLDとして閉鎖した。実行時モデル/新規上流/再送0、全6群の原文・recipient・両ポイント・金額NULL、物理PRE/POST、owner/pending閉鎖、本文cursor2152と旧baselineを保持。全7,728行POSTの通常selector再生が50群/80行/19銘柄であり、独立COUNTや旧数からの差引ではない。私有`yutai-contract7-normal-windows-prep-v1/ACCEPTED.private.json` SHA `b514618221d9ad7674960e7f8425ebf472951bfaa0d9ed4cae1a058f3ee383f9`。

23:31の保存レビュー3群/3行（3195・3498・6040）も通常publisherで反映し、全issuer7行と非対象4行の全mapped列、原文・recipient・金額NULL、物理PRE/POSTと共有状態を保持した。レビューの意味判断にはLLMを用いたが、実行時モデル/新規上流/再送は0。scope内の未完3群を全市場件数へ読み替えない。私有`yutai-pending50-third10-contract7-v1/ACCEPTED.private.json` SHA `672e62e9ce0afa3ede1fcc15069f66c0b4850dcb5fdfc875153912e036d13998`。

受注の重複実行防止stateは、旧Mac全actorの終端後に旧入口を0500へ停止し、112 claimと元初期metadataの全bytesをSSHの同一論理stateへ一度だけ転送した。独立読戻しで113 SHA・owner/mode・元cohort/PRE/outのbinding不変を受入。原本20 ZIPは追加転送せず、後続は通常prepareのNotion原本読取で資格化する。この移設自体は受注の追加適用ではない。私有`orders-excluded65-next20-ssh-draft-v1/orders112-mac-to-ssh-20261025-v1/independent-readback-accepted.private.json` SHA `f5d26c9da74499c74a1d371ca09a4a35cc24e34559b5c9b6280f6e5e12396bc1`。

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
| [#588](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/588) 電子ギフトの機械要約 | `f01de317` | [40154274111](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/40154274111) | version `0ba0a313-63fd-431f-8daa-0fab67e2fcdb`・100%、SSH同SHA。7360の3群/3行を本番適用 |
| [#589](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/589) 株式Actionsの明示direct経路 | `9b9f836a` | PR CI成功、[main 40154905961](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/40154905961)は11:38 JSTに自然SUCCESS | version `5c94f549-7a66-4d32-97e9-11e559fec92f`・100%、SSH同SHA。実上流通信の受入は別確認 |
| [#590](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/590) 優待受入・現在未完の記録 | `30586b83` | [40156087102](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/40156087102) | version `5885b8db-939e-4a1c-a18c-9c62064102d8`・100%、SSH同SHA |
| [#591](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/591) 保存primary形式のreader対応 | `0c968492` | [40156592721](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/40156592721) | build `f1730210-2ef4-4712-85c9-363f3c388c3c`、version `55348eac-467e-4169-b3cc-ec92b333667f`・100%、SSH同SHA。固定7社の通常再照合を受入 |

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

11:09 JSTに別50社の本文39項目をSSHの通常`audit:supplement:texts`で照合した。現在のcode-only 1SELECTで得た有効普通株3,686社から元固定5社を除く先頭50社を固定し、文書を先読みしていない。50社全て観測、未観測/未着手/実行停止0、1,950セルは一致487・同CSV要素なし20・原本/主体資格不足1,443。資格不足37社の内訳は型付き保存行なし31・主体識別不足/不一致6で、物理原本の消失を確定した分類ではない。空欄75セルのうち55は資格不足のため理由未確定、残20は同CSVに対象要素なし。原本資格が成立した範囲では抽出差による空欄0だった。313 HTTP、write/源API/model0。exit1は資格不足を含む結果で、全社成功や非開示の証明にしない。SSH私有`tmp/supplement-next50-readonly-20261025-v1/report.json` SHA `cec8ff9ba9432efcaff86337360636a460d429baf23ddc8b330d0dcf2353df68`、cohort SHA `9b239f96c00896ed22c33e095e522f408ed77565dd1b94dc96091e45fdf86580`。私有FS集計`tmp/feature-audit-20261025/supplement-next50-fs-summary-v1/AGGREGATE.private.json` SHA `c06413b07437af49721b1ea97d6db25f95f12eee106ae631c0579e3fdcf8acf5`。

130A/S100XSITは保存されたprimary内の識別情報が現D1と一致し、audit readerの保存形式非対応と判明した。#591でreaderを対応させ、下記7社を通常再照合した。診断時の元publisher時計未確認は旧証跡のまま保持する。11:36 JSTのmetadata限定3ROのreceiptは私有`tmp/feature-audit-20261025/edinet130a-type5-metadata-readonly-prep-v1/accepted-production/FINISHED.private.json` SHA `c59d0ac1d074bc4458facf4e09f90d7828cec1524caa7b8b3812b293c3f0e0d3`。

1301/S100YE8Kは通常のsource captureで当該文書1件のmetadataを資格化し、通常source-only修復で既存type1を再利用、不足CSVだけを記録した。記録1・既存type再利用1・非提供0、exit0で、facts/本文のwrite・model0。Mac私有`tmp/feature-audit-20261025/edinet1301-source-capture-prep-v1/accepted-production/FINISHED.private.json` SHA `d3598353bb85cb1c124457872c3d72ef58829d35fe5733327a1974bd33b03f09`、`accepted-repair/FINISHED.private.json` SHA `59326f77f58b9469392ec00cbaea9c766b8cdf68ed6e1f0d5601f4bf0f35f3ab`。

12:04 JSTの通常`audit:supplement:texts`は130A/138A/145A/146A/148A/149A/1301の7社を観測し、273セル＝一致260・同CSVに対象要素なし13、空欄13も同CSVの対象要素なしだった。exit0・未観測/未着手/HOLD0、82 HTTP（Notion52・429/再試行0）、source/model/業務write0。初回50社の37保留中7社を解消した。Mac私有`tmp/feature-audit-20261025/supplement-identity6-plus1301-accepted-v1/AGGREGATE.private.json` SHA `bd33ece479fa2948d2c38c62d2c4ed298483495563e7fb77963a34c0a63e610d`、SSH report SHA `ea36b231f99f70bd9ffe2736e2564f7d41551ca480c24a2e47b321570bdaef91`。

残る固定30文書は通常source-only修復20回で記録30・既存type再利用17・失敗0となった。財務・本文のwriteではなく、sourceのnative日時は保存表現のまま保持した。Mac私有`tmp/feature-audit-20261025/edinet-typedmissing30-repair-prep-v1/accepted-production/FINISHED.private.json` SHA `e74075cfe7f360fd3b8ee3bcb20b3515acb8793730ea7e3ead6495460708802b`。

12:40〜12:43 JSTの通常`audit:supplement:texts`で30社全ての物理原本資格・通常本文一致・現在latest文書と固定planの一致を確認した。1,170セル＝一致1,128・同CSVに対象要素なし42、空欄42も同理由。exit0・未観測/未着手/停止/失敗0、343 HTTP（Notion221・429/再試行0）、source/model/業務write0。初回50社で保留だった37社は上記7社と今回30社で解消したが、観測時刻は異なり、全50社の同時再照合・原本全体の非開示・全市場の充足は証明しない。Mac私有`tmp/feature-audit-20261025/supplement-typedmissing30-accepted-v1/AGGREGATE.private.json` SHA `416d6ca437fb852cd0edc6bd36306ca31f39477b651179425726ca88fc328528`、SSH report SHA `901367b3957432b77123148f0c9fc13f9c9cbf1eec73ecc8f69c7d441788d2dc`、control FINISHED SHA `85350e3a8edde4da693f6289d2d143d4fbc0d3697a1b0ca867215d6bd8efe64e`。

次の50社で型付きCSV不足だった40文書は、#594の通常`--type=5`を17群で実行し、記録40・既存再利用/非提供/失敗0で閉鎖した。未読type1の完成・非提供は判定しない。続くmain `65ed4992`の通常RO照合は40社全てのsource資格と固定docID/期/提出時計が一致し、1,560セル＝一致1,528・同CSV要素なし32、空欄32も同理由だった。未観測/未着手/停止/失敗0、HTTP 502回（Notion340・429 retry1・transient0）、業務write/源API/model0。元の次50社の40保留を解消した有限結果であり、時刻の異なる50社全体の合成を同時観測や全市場完了にしない。Mac私有`tmp/feature-audit-20261025/supplement-fixed40-after-source-prep-v1/accepted-production/AGGREGATE.private.json` SHA `5dd5af6061cfdcd8af09b5cdd7f8eb456c8b8b8701944c9b44145e9f3ae14f8f`。

3776は現旧type1 ZIPの43/43 member bytes、全facts、本文37節・索引が同値だった。#578の通常CLIで派生metadata4列だけを物理PRE/CAS/POST付き訂正し、別の通常strict再資格化で観測2件を解決、HOLD0・進捗revision18・予約閉鎖・財務/本文不変を確認した。旧receiptと現progressの不一致は最初のplanがSTOPし、現在の保存原本receiptを資格化してから実行した。比較条件を緩めていない。私有受入`tmp/feature-audit-20261025/edinet3776-production-acceptance/`の`completed.json` SHA `db84bc403eace11378b7ad91697dafef9ffab05ff1cd4c67c5adea307b57938d`、`FINISHED.json` SHA `01c8b31dda13eadf72aa7577236da85c194ae4b9a99dde901c374ce07f1991cd`。

1279652は#581の通常CLIへ9/8 JST・exact ID・実clock+10分を渡し、1回だけ実行した。元URLと同一filenameのJPXとも404、exit0でも`skippedNoFile=1`・created/updated0。PRE/POST各3ROで対象D1全列/本文/cache投影は同値、既知child live/親一致・exact key0を確認した。元PDF未取得HOLDを、取得成功へ読み替えない。40日窓外なので次の日次catchupでは対象外で、手動再投入もしない。失敗理由は実行log/receiptへ残し、新規の空Notion行・監視は作らない。私有`tmp/feature-audit-20261025/tdnet1279652-post-readonly-v1/POST.private.json` SHA `1416afe6d068630c7cf03a225ada52584a4894b18d1485f279f25148dffcf3a0`。

保有の9:23有限ROはactive `local-9fe26841-activation1`・session10/16・3685 members、既知DBの価格unknown/再開queueはcomplete0。要確認先頭2502は同世代HOLDだけを観測し、全残数にはしなかった。9:27の既存reopen条件と同じ別世代filterもcomplete0で、同世代resumeは実行しない。価格・原本は再取得していない。1798/FY2026-03-31の実原本では法的4/1・普通株1→5と期末分割前株数を資格化できるが、providerの3/30イベントとAPI価格単位への結合は未資格でHOLDを維持する。[Yahoo公式Help](https://help.yahoo.com/kb/finance-for-web/adjusted-close-sln28256.html)の調整後終値の説明や`close=adjclose`だけから、Chart API各フィールドの株数単位を推定しない（10/25有限調査）。併合・増資への率流用もしない。

財務は無条件100行queryがNotionの明示incompleteでSTOPしたため、現在候補に採用していない。code634Aへ先限定した完全1行は19数値中NULL8・未知型0、4キー/source/rawrelationが保存入力と一致。fresh⑤ metadataとhosted原ZIPは2ROで79,467 bytes/fullSHAを資格化し、保存原本と全bytes一致した。この物理資格はNULL理由判定や全active対象の分類完了とは別である。原本SHA `0278f0d855e184c0252019e82c2e0e4a4f4bda6e342094c6b80a18dc82ba1637`、私有`tmp/financial-null-634a-fresh-raw-20261025-v1/RESULT.private.json` SHA `4225d3e9158220c6d19b9a977692d11a4928a110dd92d3fbff37835a91b65a65`。

財務634Aは#585後、SSHの同main/Nixから通常captureを2HTTP・code先限定で実行し、complete1行を得た。exact保存原本のoffline診断は19値不変・HOLD0・抽出差候補0。空欄8は非数値/nil1、選択scope内の該当context/直接値なし7で、原本全体の非開示や全active分類を意味しない。源API/業務write/model/再送0。私有`tmp/financial-null-production-634a-20261025-v1/FINISHED.private.json` SHA `d761d2691d9f59df26704b7f6cb3ed3f7c0d0ae55419105e598de3539ed3d22c`、診断SHA `6f15be15096d8e50251945435e90a1af8cd6b8db3c15a247882b6de3bdb74447`。先行のdriver/argv停止はどちらもHTTP前と確認し、旧STARTED/EXIT/失敗logを保全した継続記録に分離している。

7911/8566もcode先限定の現行原本2行を通常captureとoffline診断で確認し、26既存値は不変、12NULLは選択原本scope内に候補がなく抽出差0だった。同2銘柄の履歴17行中、診断した2行以外の15行はexact local source-map不足HOLDであり、非公表や分類完了としない。

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

7360は保存済み電子ギフトの掲載額・ポイント換算・両交換先・贈呈期限を保持し、#588後の通常compiler・同銘柄全tier集計・原子取込で3群/3行を適用した。物理Notion PRE/POST・全列POST・cursor不変・owner/pending閉鎖を確認し、D1送信1回・source/model0だった。Mac私有`tmp/feature-audit-20261025/yutai-point-exchange-literal-v1/accepted-production/FINISHED.json` SHA `8b787074b2be16871567d6db400c2e130b94b31096c8321ad815c9aa5a302d6c`。

11:33 JSTに通常selectorを単一SELECTで新たに再集計し、有効普通株の優待7,729行に対して未完138群/206行/49銘柄を確認した。全138群が要約missing、contract違反/rework0。過去141群からの引き算ではなく、同statementのwindow総数と返却全行の一致を検証した測定である。D1読取28,523行・約208ms・1HTTP、write/Notion/R2/source/model0。Mac私有`tmp/feature-audit-20261025/yutai-pending-post-7360-count-plan-v1/FINISHED.production.private.json` SHA `21db455c3adb5e9604c6d4bd941e130d9d0c01166f20b4db8dcc520b6df6c933`。この件数確認を個別の原本・適用資格や全データ充足へ読み替えない。

明示レビューの7502は1群/1行、3377/7599は2群/3行を#593の通常CLIで適用した。両実行とも物理PRE/POST・同issuer全tierの完全POST・cursor2本の全bytes不変・owner/pending閉鎖を確認し、モデル/新上流取得0だった。14:03 JSTの新しい通常selector測定は未完135群/202行/48銘柄。旧138群からの差し引きではなく、現行集合の単一SELECTによる実測である。上の11:33値は履歴として保持する。

続いて契約`.3`で意味レビュー済み13群/20行を通常publisherへ適用し、物理PRE/POST・全issuer完全POST・cursor不変・owner/pending閉鎖を確認した。今回のruntimeモデル起動・新規上流取得は0であり、保存結果を作成した意味判断と区別する。14:48 JSTの通常selectorによる新しい単一SELECTは、優待7,729行の全行window一致を確認し、未完122群/182行/47銘柄（全て要約missing、contract違反/rework0）を実測した。D1読取28,523行・1HTTP・write0。14:03の135群は履歴で、差し引きによる推計ではない。SSHの`NOTION_MAX_RPS`は0.8へ調整し、並行するActions日足の1.6と設定値合計2.4 RPSとした。実行sourceはmain `0e031c6`で、[CI3本成功](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/40165706391)・CF `fd618f6b` 100%・SSH同headを受入済み。

通常機械処理の2窓では、共有cursorを正常に進めて4群/7行を追加採用した。15:16:40 JSTのwindow2正常POST7,729行を通常selectorでFS再計数した残件は118群/175行/46銘柄。追加HTTP0で、14:48の122群からの差し引きではない。物理PRE/POST・owner/pending閉鎖・旧baseline保持を確認し、runtimeモデル起動0。14:48と14:03の測定値はそれぞれ履歴として保持する。

Calendarは2026-11-11開始・毎月11日09:00 JST・開始0分前メールと短い5行のコマンド/privateログ手順への参照を読戻し済み。初メール受信・月次の本モデル実行は未観測。

10/22の通常優待月次は01:06〜01:59 JSTにexit0（明細1,711・取込1,650・優待7,728・失敗0）。古い1301のunknownだけを根拠に月次全体を再実行しない。全量D1再検証の完了を意味しない。

全20機能のうち、財務NULL・歴史relation、受注/海外の全対象分類、保有の全価格basisは固定5社の本文確認では検収できない。過去の件数を現在残数にせず、既存の対象限定監査で原本不足・非該当・実漏れを分ける。旧`audit:overseas`と非saved補完は廃止し、固定cohort・通信上限付きsaved prepare/inspectへ誘導する。旧入口は本番の定期処理では呼ばれていない。

10/23の株式未更新38件は保存済み証拠では35件の全NULLと技術障害3件に分かれる。NULLは出来高0ではなく、売買不成立は候補に留める。2385/2438のQuoteSummary409全文は設定proxyホストのCloudflare1001/DNS resolution errorで、Yahooデータ不在とは異なる。5884はChart原応答capture missing/ECONNRESET、QuoteSummary200の保存はある。取得した保存物はpart0だけでpart1〜35は未読、3件は未補完。私有`tmp/feature-audit-20261025/stock-tech3-saved-part0-readonly-v1/TARGET-ERROR-CLASSIFICATION.private.json` SHA `6d8fdc94e894ebbff83b3b2cec6d7a39efb3553bf214b1fbaa733fc500018c74`。12:33 JSTの固定35社の現在metadata読取は1SELECT・35行・D1 read105・write0で、全てactive/equity、Standard31・Growth4、event0だった。対象日10/23の資格・無取引は未確定のまま。私有`tmp/feature-audit-20261025/stock-null35-current-metadata-readonly-prep-v1/accepted-production/FINISHED.private.json` SHA `65090016dc1351c7285ffa75b577a7c10cf27a2e612c39b6b2d23219264aae42`。別の8303長期履歴HOLDを38件へ重複計上せず、過去の原本欠測やVWAP旧unknownの解消とも混同しない。#343の全権利種別の資格化、上記の未接続指標、原本/主体不足は理由付き未充足として残す。次の対象日の自然実行待ちは、それ自体を障害に数えない。

## 元仕様で確認した指標

[短期売買実践ガイド](https://app.notion.com/p/340d74ff84cd80ab893ae0e2d4751f90)を10/25に参照した（取得内容の最終編集日は2026-04-19）。この参照は現在のデータ充足率を示すものではない。

- マクロの売買代金は**東証プライム**の20日平均比。現コードの`topixTurnoverRatio`という名前から、TOPIX構成銘柄へ対象を変えない。
- 個別④需給は**買残高と出来高の比率**（2倍超で悪化）。買残/売残の信用倍率や日証金の融資/貸株倍率とは別である。出来高の対象日と平均期間を、勝手に補って実装しない。
- 個別⑤は**カタリスト（2週間、過去/未来の範囲は確認中）の存在**。決算だけでなく、レーティング変更・自社株買い・政策等も含む。2026-04-19編集版を10/25に再確認し、未来限定の解釈を撤回した。過去14日・今後14日・両方のいずれかはユーザーへ確認中で、未回答を期間の確定にしない。決算跨ぎの回避条件と置換せず、過去の発表日から将来予定を生成しない。

Primeの既存接続原典から、同一定義の当日実代金と20日平均の系列はまだ資格化できていない。[日報](https://www.jpx.co.jp/markets/statistics-equities/daily/01.html)は翌営業日掲載、[月報](https://www.jpx.co.jp/markets/statistics-equities/monthly/01.html)は原則翌月21日で、当日夕方の値へ代用しない。全市場・週次両側合算・終値×出来高にも置き換えない。[入力条件と公開出典](../research/prime-turnover-input-contract-20261025.md)を記録し、既存の許諾済み提供元の有無はユーザーへ確認中。返答待ちを許諾や契約不存在とは扱わない。個別④の出来高期間の確認もpendingのままで、指標の接続や定義選択は未実施。

[JPXの株式市況](https://www.jpx.co.jp/markets/equities/summary/index.html)は蓄積・加工等を禁止している。一般公開されていることだけを根拠に原本蓄積へ使用せず、既存の利用可能な公式統計原本を先に調べる。[JPXの決算予定一覧](https://www.jpx.co.jp/listing/event-schedules/financial-announcement/)は対象・更新時期と未掲載/予定変更の注意書きがあるため、掲載がない銘柄を「イベントなし」と判定しない。

意味レビュー済み7群/12行をsource `56b023dc`の通常publisherで適用後、15:36:13 JSTの新しい単一SELECT全7,729行で未完111群/163行/44銘柄を実測した。D1読取28,523行・1試行・162.4962ms・write0。15:16の118群は履歴であり、この測定は差し引きではない。4661の500株群は本文の限定月と9月recipientが不整合のためHOLDを維持する。枚数セルの限定月を反映するparser修正と、既存9月行の本番是正は別受入であり、今回のD1是正は0。

16:56:28 JSTの通常全POST 7,729行を通常selectorで再計数し、未完108群/160行/43銘柄を確認した。source `c358faf5`の通常CLIを60件＋18件の2窓で実行し、4820の3群/3行を採用した。選択78群は重複0で、全111群の一巡ではない。モデル/新規上流取得/再送0、物理PRE/POST・他行と金額nullの保持・owner/pending閉鎖・補足cursor不変を確認した。追加live SELECTではなく、15:36の111群は履歴として保持する。私有`tmp/feature-audit-20261025/yutai-v9-normal-windows-prep-v1/accepted-production/FINISHED.private.json` SHA `deeb1aea52f41ca27e694da0abfc8beac7d429ac4bd5525f5fa7d71f89fff9f2`。

#601/#602はmain `c358faf5`のCI3本・CF `204361de` 100%・SSH同headで受入済み。SSHの不足設定を補完し、設定不足で停止した既知ownerだけを旧terminal証跡・fresh state/cursorの全文とETag一致後にCASで閉鎖した。歴史的な通信0とは断定せず、旧失敗証跡は保持する。受入は`tmp/feature-audit-20261025/main602-acceptance-v1/`、明示reconcileのFINISHED SHA `a8937a1dee7dad4eb1b8ca0afb56d12f6dbc0ac04b3fc36d0433aab0cd5c3fe0`。

17:16 JSTの通常本文50件は27同期・未着手23で既知閉鎖した。直後の外側確認のTimeoutErrorは未解明のまま保全し、同CLIを再実行していない。17:32 JSTの別の明示読取3回でowner/pending null・旧baseline・優待cursor全bytes/ETag不変、本文cursor151A→157Aを確認した。個別27文書の独立読戻しは行っていない。私有FINISHED SHA `eb16b84af895d11f009a2df24bbd825f995f53dfed1002e5e133d05886d6b7e0`。

日足run40169768650は17:04 JSTに既知HOLDによるexit1で閉鎖した。更新2,695・skip990・HOLD1、unknown/未着手/429は0、原本90batch/90page・summaryは通常保管済み。523Aは旧8/19・8/21がfreshに無いため更新前に停止し、元日付を削除していない。17:35 JSTの独立3GETでactivation/active/registryの完全一致、snapshot40169768650.1・session10/23・coverage3,686・members3,685・523Aのみerror除外を確認した。公式銘柄表の世代/asOf・各価格原本の物理再読はこの3GETの受入外。私有RO FINISHED SHA `0bcbd5ed42c13b98c830d1291daf836739689c544cd8a13204a4b9d9d6199e09`。

#604はmain `8d8d1b39`の[CI 40177408880](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/40177408880)3本とCF version `2e9d2269` 100%を受入済み。その後#605でSSHも更新した。当時の4661通常是正CLIは原本資格確認段階でexit2、専用state作成・共有writer取得・DMLの前に停止した。別の単発原本GETはHTTP200・全byte数を観測したが、body読取が期限を越しSHA資格前に停止した。これらの旧失敗を保持し、後述の#608後の実行と区別する。5分足の通常[intra5d run40177951577](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/40177951577)は17:46 JST開始。

18:34 JSTまでに、保存レビュー済み13群/13行の通常取込・物理POST・全issuer33行照合・共有owner閉鎖を受入。私有`yutai-reviewed-next13-contract4-prep-v1`のFS受入SHA `e539d182b0d53202e3a01d20143ad7411349e95eeb35a2d8100c0cea232b1fb8`。続く単一SELECTは全7,729行、未完95群/147行/39銘柄、全てmissing。契約`.4`・業務書込0・再試行0で、件数の差引推算ではない。私有`yutai-pending-post-reviewed13-contract4-count-plan-v1`のFS受入SHA `7378895c6f8853e567af0997f6a0bf7dbf0837bbd087f63087210db68f20f90c`。

保有価格の通常再開1窓はusedRows24/resumed3/held3・pending=true、51intent→51HTTP200で閉鎖した。私有FS受入SHA `c3f67c75063151f8686fe3a628044d26a856fa9846cfdf0ddcd3ad078d7cf69b`。次窓はmain `f10cf6f2`でusedRows30/resumed2/held3・pending=false、23intent→23HTTP200・結果不明なし・completedありで閉鎖した。私有FS受入SHA `15678ddb4841a256ba1c044b0b2727ed89f26ca0c09e80b6e515f52566d74756`。同世代キューの再実行は不要。HTTP200とキュー消化を、全価格の充足や各権利basisの成立とは扱わない。

19:17 JSTに契約`.5`の保存レビュー4群/6行をmain `6268941e`の通常publisherで反映した。対象3銘柄の全9行POST・入力全SHA・cursor不変・baseline保持・owner/pending nullを受入、runtimeモデル/新規上流取得0。私有`yutai-reviewed-next4-contract5-prep-v1`のFS受入SHA `4e58cbaf6cd354e0093fc986875c6b14ecab40cbeddfb794d67442b98f135248`。18:34の95群から現在数を差し引き推算しない。

19:25 JSTに4661の通常保存原本修復がexit0で完了した。97,897,450 bytesの原本を通常共有経路で資格確認し、余剰1行（id59354）のみ削除、保持14行の全列・ID・時計と親行は不変。通常yield/score再計算後も実差分0。物理PRE/POSTと共有owner/pending閉鎖、両cursor/baseline不変を確認した。旧失敗・入力・Macを保全し、上流取得/モデル/再送0。私有`yutai4661-month-scope-after-download-fix-prep-v1/ACCEPTED.private.json` SHA `581c7ba3171010c170362e63f680ff62d89065b14f1d49c81d70dcda6cbdf8c3`。

19:37:36 JSTの新しい単一SELECT全7,728行を通常selector・契約`.5`で再計数し、未完91群/140行/37銘柄、全てmissingを実測した。HTTP1/試行1・D1 read28,520行・write0、Notion/R2/上流/モデル0。18:34の95群からの差引ではない。私有`yutai-pending-post-reviewed4-monthscope-contract5-count-plan-v1`のFINISHED SHA `8c751af946093b217fb3dfa922240798a95fb0b9d49574c8233e4d6e5194c307`、FS受入SHA `5991db7574cc001f115c2ee5897e9f797384546c491f97d471bc21263575abdd`。

財務7911/8566の不足15原本を追加取得した直後、旧2原本と併せた固定17行を通常offline診断した。323セルは既存一致171・保存scope候補なし137・明示対象外11・ROA抽出差候補4、HOLD0。この診断時点では4候補は未反映で、137を公式非開示とは認定しない。原本15件1,012,334 bytes、新29GET＋保全済み旧metadata1GET＝30GET、上流再取得/再試行/業務書込/モデル0。私有`tmp/financial-historical15-exact-originals-prep-20261025-v1/accepted-production-continuation-v1/FS-ACCEPTANCE.private.json` SHA `03489ff29573dfcab809e8a4c5db356fc6685e741e987a7bd0afb862403293c4`。

5分足run40177951577は19:25 JSTまでにexit1で既知閉鎖し、全3,686件＝更新3,679・skip2・error5、fatal/aborted/unknown/未着手0。1992/7677/9087は原応答全NULLのためsource_unavailableメタデータだけを保存し、既存有効日10/13・10/15・10/15を保持。6396/7509はtimestamp非配列として価格PUT前に停止した。更新3,679件のうち有効最新日10/23は3,639件、残40件は10/20〜22。skip2件は10/23であり、旧日付を無取引や当日充足と断定しない。原本123batch/pageとsummary保管済み、Yahoo429は0、Notion429は1。私有terminal REPORT SHA `e99c11b44a0745cfbca8f7e5c732e73a11211003a933f73b4ee6fb5e395f8242`。5d窓外の歴史欠測と元の結果不明PUTの解消はこの受入に含めない。

19:50 JSTの次の通常本文窓は50選択・44処理（同期21/同値23）・HOLD0・未着手6で閉鎖した。Notion444要求・429/再試行0、モデル/新規上流0。cursor157A→1801、共有writerと優待cursorの全body/ETag・baseline不変、owner/pending nullを確認。私有`supplement-next-fair-window-after4661-prep-v1/ACCEPTED.private.json` SHA `ff008411833a80784cabdc103f377bbcda88b9a6446e235d2d39502130ed43ad`。後続3窓は別実行として扱う。

20:23 JSTに別の保存レビュー4群/4行を通常publisherで反映した。3983だけ既存`companyValue`の認定3000円を採用し、3377/3560/3823は選択・源金額なし・抽選の各guardに従いNULL保持。対象4行と非対象1行の全mapped列POST、通常yield/score原子再計算、物理PRE/POST・共有owner閉鎖・両cursor不変を受入。独立した財務/score再GETは行っていない。19:37の全市場91群から残数を差引推算しない。私有`yutai-reviewed-current91-third4-contract5-prep-v1/ACCEPTED.private.json` SHA `4e1e1e58b8283bfc6aac3577317887561c62e468d72afeda06243dfac66896e4`。

財務の通常auditは既存cache17原本を再利用し、対象2銘柄のquery1＋一意原本GET17だけで17行を再解析した。通常Notion applyもquery2＋PATCH4の6要求だけで成功し、ROA4行以外の全propertiesと元取得時計は不変、同一キーの退避0。FINISHED SHA `fc4704baf71dce436c5e8c5ce11e5b10862867b9b8d08df3bea0c72bd5415544`、適用receipt17 SHA `d6b2d45aca091297e2c0590b78628abfe11ccba6ffa709efb79a11cae25a7dd0`。続くD1はcode先限定の1SELECTで17行/全34列、read21行・write0。差は同じ4行のROAだけで、他13行・全他列は同値。Python用設定名の不足による旧HTTP0 STOPを保持し、本番workflowと同じ明示aliasで読み取った。このPRE読取段階ではD1書込未実施で、後述の行CAS修正後の同期と区別する。私有比較summary SHA `d4c1d55db3fc983a884166b45902d752ad704b604ba669bd1f15d851a53f1460`。

6396/7509は同runの保存原本2batchだけをmetadata2＋physical2GETで資格化した。両HTTP200・`chart.error=null`・一意result/銘柄一致だが、timestampプロパティとOHLCV配列が全て未存在。通常parserの同じ拒否を再現し、銘柄単位の既知非fatal・価格PUT0は妥当と判断した。原応答から無取引や当日充足を補作しない。新Yahoo/D1/R2/業務書込/他58応答decodeは0。私有`vwap-intra6396-7509-saved-raw-ro-prep-v1/RAW-SHAPE-CLASSIFICATION.private.json` SHA `0f7dd7ba3573fb8ffe642344ba80f7faaf91b9a225d0c7d0f191100a87fef6e6`。

21:08 JSTにSSHの通常本文3窓が自然終了した。延べ150選択/107処理＝同期70・同値37、HOLD0、Notion1,327要求・429/再試行0。cursor1801→1813→190A→1934、各窓の共有owner/pending閉鎖と優待cursor/baselineの全body/ETag不変、全27ファイルを確認した。窓末未着手18/6/19は各時点の数で、合算残数や全市場完了にしない。私有`supplement-normal-three-windows-prep-v1/ACCEPTED.private.json` SHA `39a310cba9006265552aa77d5320fe172149b02701b288afa08a51e9b6734d9a`。

21:15 JSTに通常`sync_d1`の全34列行CASでROA4行を同期した。Notion fresh query1＋D1読取3＋UPSERT1の5要求、全17行PRE/POSTで7911のFY2024/2025は3.2/3.6、8566は0.91/1.19のみを採用し、他13行・原本/時計/書類ID/licenseは不変。親2銘柄一致、退避/保護/unknown/再送/新原本/モデル0。D1の業務changes4と物理rows_written12は区別する。私有`financial-roa4-d1-sync-prep-20261025-v1/accepted-production/POST-FULL34-QUALIFICATION.private.json` SHA `40597508e9e308efbcbda709137fcef6c99fde3ba45aacfeb08f7b598ccf2360`。

ポイント繰越の既知全文型は、当回ポイントと掲載年額の整合・残全文SHA・完全定型句・実recipientを共有helperで照合し、現在tierと繰越1000株を分離する。実5群10行の通常compiler/import/selector/carryを検査し、金額は約換算せずNULL。関連210 PASS・私有fixture不足12 SKIPを区別する。保存19:37の全7,728行を`.5`/`.6`で機械再生した影響検査は91→91群、追加/除外/reason差0であり、現在残数91の再測定ではない。私有`yutai-contract6-fullsnapshot-replay-v1/REPORT.private.json` SHA `8b8e794659a1b15d73b4f26236ac99abef8971145852dcb36d631d21f7edc70c`。

続いて契約`.5`の保存レビュー17群31行を通常publisherで反映した。10銘柄全68行の保存PRE/POSTを照合し、対象31行の要約・値と対象外37行の全mapped列保持を確認。企業公表額への変更7行、他のNULLは保持、owner/pending閉鎖・両cursor/baselineのbody/ETag不変。実行時モデル/新原本/再送0で、保存候補の意味レビューに使ったLLM判断とは区別する。10銘柄内pending26→9はscope内の値で、全市場を差引推算しない。私有`yutai-reviewed-saved91-fourth-sixth17-contract5-prep-v1/ACCEPTED.private.json` SHA `ed12a32d3cdf0496808210a8737c420e7356fe75bdb91591b6f5f159c452927c`。新`.6`では750ポイントの既存要約も共有定型句と異なるため再整形対象になり得るが、繰越条件と金額NULLを維持する。

その後の6群7行は3銘柄19行中の非対象12行を保持して受入。#611配備後の通常2窓は4397の5群10行を機械処理し、750ポイントの既存要約1群も正規の定型句へ再整形した。21:51:09 JSTの通常全7,728行POSTから未完60群90行23銘柄を追加HTTP0で再計数し、先の91群から推算していない。独立COUNTや別native応答保存はなく、通常の非限定active-equity query・strict parser・全集合POSTとID重複なしを根拠とする。私有`yutai-contract6-normal-windows-prep-v1/ACCEPTED.private.json` SHA `0d819f7bc31de2f0935c88bd28a4a3eda2b3d4a4e02781082072d78e416bed80`。

保存60群の手動選定をtaskId/原文SHAで調べ、銘柄単位の除外で落ちた8群と実読証拠が不十分な9群を全原文・受取条件へ戻して確認した。新たに適格な4群4行を通常publisherで反映し、3銘柄20行中の非対象16行、原文と受取条件、両cursorを保持した。公表額は7074の30,000/40,000円だけを採用し、4661/3169はNULL。先行Nix入口の引数不足はnode起動前・書込0のまま保全し、修正後のpublisher起動1回・業務再送0で閉鎖。私有`yutai-reviewed-current60-combined4-contract6-prep-v1/ACCEPTED.private.json` SHA `2c13f6ffee4bb88e437aa3ae9c83e74b2d7d34b1c4e1e1e8e4f13eaac8e1a11c`。この反映後の全市場残数は未再計測。

契約`.7`は要約上限120字と保有期間別ポイントの通常compilerを追加し、両数量・継続保有/記載・繰越・開始月を省略せず保持する。保存6群の通常planは受理6/拒否0、金額はNULL。保存21:51の全7,728行を`.6`/`.7`で再生した選定は60→60、追加/除外/理由差・他compiler差0だった。関連217 PASS・既存私有fixture不足10 SKIP、型/lintを区別して確認。新依存・追加APIはなく、本番の`.7`通常反映は別受入とする。
