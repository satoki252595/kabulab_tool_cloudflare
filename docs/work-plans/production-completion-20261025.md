# 定期取得の完了条件と残件 — 2026-10-26更新

対象は[Issue #348](https://github.com/satoki252595/kabulab_tool_cloudflare/issues/348)。[原20機能](../test-logs/feature-gap-audit-20261014.md)と[全データ一覧](../batch-data-inventory.md)を維持する。コード/配備の受入、対象限定の実データ受入、全件充足を分ける。旧欠測数は現在残数へ繰り越さず、経過と旧実測はGit履歴・各検証記録を参照する。

2026-10-26 11:54:46 JSTまでの受入を基準とする。main #630 `3d990b21`の[CI 40257605922](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/40257605922)（check/python）とCloudflare version `f80802ed-45e0-48ea-8cbb-0f110fadc3b1` 100%、Mac/SSH同HEADを受入。受注11文書と6721の残4件は通常apply・別inspect・最終FS照合まで閉鎖し、固定current177/177＋歴史4件を受入。補足一巡は1,438/3,686社、優待は通常7731行POSTで26群/45行/10銘柄が直近実測。全体完了ではない。

## 定期接続と実行環境

日次04:17 JSTのActionsはmainの`github.sha`とNode22/pnpm9のfrozen lockで本文50社→優待60群を実行し、新compilerへ接続する。月次10日10:30 JSTは母集団→公式source対応の優待通常取得/物理保管→再計算。#621–630の通常caller接続に欠落は見つからず、未来予定日の実行を待つだけの改修残件は置かない。優待の日次Actionsは固定allowlistの対象metadata・終了集計をartifactへ7日保存し、本文・要約・raw・秘密を含めない。設定・正常呼出経路・既存実行/回帰での確認と、将来runの実結果を混同しない。

MacはNix/既存lockの月次手動＋Calendar/メールが合意済み運用。旧自動起動を復活せず、月次driverはbiztag/競合準備のみで優待要約を起動しない。SSHは同Nix/lockの有限補完。稼働中のbulk固定runtime `4b0fb282`はsupplement限定・固定codes・cursor不更新で、main更新を理由に途中変更しない。全normal publisherの共有owner/pending・元state/原本を保持する。

## 原20機能の現在受入と残

| 機能 | 現在受入 | 残・未完 | 先行条件 | LLM |
|---|---|---|---|---|
| 銘柄マスタと上場状態 | 通常日次overlayと月次母集団の独立経路を配備 | 全対象の最新基準日・廃止/再現役化は未検収 | 公式発効日・主体・株式種類を資格化 | なし |
| 株価と財務断面 | 通常日足3,686件＝更新2,695・skip990・HOLD1を閉鎖 | 株式日次同期の未更新38銘柄（保存区分35NULL＋技術3）、日足523Aの歴史欠測、価格/財務の全期間充足。physicalChart確証は10/35のみで、全35原本読了やNULL＝無取引としない | 保存snapshot・対象session・全母集団で検収 | なし |
| RSI、スイング、モメンタム | 株式通常CLIの同じ派生経路を配備 | 全対象の基準日/期間不足/欠測理由を区別した充足 | 適格価格系列と必要期間 | なし |
| マクロ判定 | 日米session/時刻guardと通常起動を配備 | 東証プライム売買代金20日平均比、個別需給/カタリストは下記の未接続 | 対象市場・系列・公表時計/許諾の確定 | なし（未実装あり） |
| 財務サマリ | 7911/8566のROA4行をNotion/D1へ反映、17行全34列照合 | 全市場のNULL/抽出漏れ分類・歴史relation。候補なし137を非開示と断定しない | 通常parser・原典の期間/単位/連結scope | なし |
| EDINET継続取得と本文範囲 | 日次catchup→通常ingest、報告HOLDを保持する経路を配備 | 識別保留/本文なし/原本不足を各対象の根拠で解決 | 公式主体・doc/FY・保存ZIP/本文 | なし |
| 有報39項目 | 固定3,686社の一巡処理は累計1,438社（現在の連続23窓920社＋先行518社）まで受入（11:54:46 JST時点）、固定runtime4b0で第24窓を実行中 | 残2,248社は実行中/未観測を含む。全社一巡・各列充足は未完。原39と旧タグ根拠を保持 | 共有owner/pending閉鎖・同定済み本文/7メタ/全文 | なし |
| 受注と海外売上 | 11文書41区分と6721残4件を通常apply＋別inspect・最終FS照合まで受入。固定current177/177＋歴史FY2021–24の4件、state182ファイル/181claims、旧178ファイル不変 | 固定集合と歴史4件の受入で、全市場の充足は未認定。会社発表比率の基準不明は保存年額からの通常計算と区別する | 全6表fresh CAS・source本文・物理PRE/POST・通常mapper/projection | なし |
| TDnetとIR PDF | 期限/単一ID再開と元PDF同定guardを配備 | 1279652は両入口404、限定公式調査でも同一原本未確認/HOLD | 同一元PDF資格。別日差替で代用しない | なし |
| VWAP日足 | 全3,686対象の通常runとactive snapshotを受入 | 523A等の対象別欠測、旧PUT不明の個別閉鎖 | 原本・価格basis・完全readback | なし |
| VWAP 5分足 | 通常5d run全3,686件＝更新3,679・skip2・error5を閉鎖 | 5エラー、更新分の旧日付40件、窓外欠測。旧PUT不明 | 必要期間/銘柄を限定、sourceと有効日を照合 | なし |
| 信用残と日証金需給 | 独立の通常取得/予定slot・保存経路を配備 | 各系列の公表期間・残存旧日付・対象外/欠測分類 | 基準日と公表日、単位・母集団 | なし |
| 株主優待取得と要約 | main630の.13/v26通常collector/compiler/importへ接続。7731行POSTで残26群45行10銘柄を実測 | 5243全2/3045全4/9842全6のsource是正と既存compiler適用は未実施。差引推計を現残にしない | bulk終了＋共有owner/pending閉鎖、全原本物理保管→fresh4表PRE/通常派生→原子適用/全POST再測定 | 実行時モデルなし |
| 事業タグとMac定時処理 | 旧自動2label停止、月次Calendar/メール・受入runtime45629c8・通常preflight確認 | 適格新規/実入力変更の意味判定は合意済み月次手動 | Nix・受入HEAD/同lock/private env/state・kernel/shared writer | Clef判定のみあり |
| 競合判定 | 月次driverで設定済みscopeの機械入力準備へ接続 | 意味判定・TypeSafe・全社自動判定は意図的停止 | biztag成功、既存cursor/pending・固定scope | 準備なし／意味判定停止 |
| 資金フロー | 独立28source通常runは26正常・投信/REIT2source503、公式統計停止告知を確認 | 停止2source、価格依存sector-turnover、全期間/全系列の充足 | 取得元ごとの公表期間/単位、sectorは価格資格と株式成功 | なし |
| 原本とAPI索引 | 通常取得は共有Notionへ実体/SHA保存。必要RAW限定補完を使用 | 歴史原本のcustody/未索引分類は未完。全量ミラーは意図的停止 | 本番が読む原本だけ、通常writerと同定/SHA/読戻し | なし |
| 有価証券保有明細 | snapshot40169768650.1/session10月23日/3,685members、通常resume23HTTP200・pending=false | held3、全保有価格・分割/併合/増資等の法的日付/株数/価格basis | 主体・株式種類・通貨/単位・対象日・原典 | なし |
| APIとMCP | 認証旧3＋REST7ケース77行、MCP3ケース、公開5ケースを段階受入 | 全API/全データ充足は未認定 | 既存認証・license・公開資格と実保存値 | なし |
| 監視とNotion案内 | 既存CF receipt/Actions/ops・schema/license照合を維持。優待定期の安全metadataを7日保存 | MAX日付だけで全件充足にしない。案内/現況表の時点更新 | 既存receiptと対象集合/失敗区分。経過はGit履歴参照 | なし |

## 未接続の定義を変えない

東証プライム売買代金の20日平均比は、同一定義の適格系列・公表時計/許諾が未資格。`topixTurnoverRatio`という変数名からTOPIX構成銘柄へ対象を変更せず、翌日公表や終値×出来高で代用しない。[入力契約と出典](../research/prime-turnover-input-contract-20261025.md)を参照する。

個別④需給は買残高/出来高の比率（2倍超で悪化）で、信用倍率・貸借倍率と別。出来高の対象日/平均期間は未確定。個別⑤カタリストは2週間の存在で、決算・格付け・自社株買い・政策等を含む。過去/未来/両方の範囲は未回答として保持し、未来限定や決算回避条件へ置換しない。

## 次の有限操作と検収

本文bulkの自然閉鎖・共有owner/pending解放を受け入れた後、優待source3種を保存packetとfresh4表PRE/通常yield・scoreで資格化して通常採用する。次に通常機械同期を行い、全POSTから未完を再測定する。原本未保管を保管済みとせず、offlineの想定差分だけで残を減らさない。

6721の歴史FY2022/23/24とcurrent FY2025は、受入済みFY2022 PREを置換せず通常11phaseを自然終端0で閉鎖した。423HTTPは全200・4D1 batch、全6表・物理PRE/POST・別inspect・1,826ファイルのFS照合を受入。最終の全5FY各2factsと32growthを実値で確認し、旧178state全bytesを保持した。固定current177/177＋歴史4件＝181claims/182stateファイルであり、全市場の完了や総claim数だけの判定へ広げない。会社発表比率の比較基準不明は原本年額からの通常計算と分け、逆算や特例で補正しない。上流停止・原本不足・曖昧な金額/主体は理由付きHOLD、0/推定値や別原典で補わない。未知の送信は自動再送せず、既知readonly停止の限定resumeだけ全native証跡と通常guardを使う。

受入証跡はprivateの`main630-acceptance-v1/`、受注11と6721全4残件の通常apply/独立inspect closure・最終受入、`yutai-pending7731-normal-post-fs-v1/`、本文bulkの各終端窓を正本とする。詳細の原本・秘密値はGitへ載せない。予定と先行条件は[本番処理一覧](../production-job-inventory.md)、停止/手動/未実装を含む全scopeは[データ一覧](../batch-data-inventory.md)を参照する。
