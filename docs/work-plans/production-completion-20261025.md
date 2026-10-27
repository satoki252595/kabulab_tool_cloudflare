# 定期取得の完了条件と残件 — 2026-10-28更新

対象は[Issue #348](https://github.com/satoki252595/kabulab_tool_cloudflare/issues/348)。[原20機能](../test-logs/feature-gap-audit-20261014.md)と[全データ一覧](../batch-data-inventory.md)を維持する。コード/配備の受入、対象限定の実データ受入、全件充足を分ける。旧欠測数は現在残数へ繰り越さず、経過と旧実測はGit履歴・各検証記録を参照する。

最新コードはmain #643 `356f691f`のCIおよびMac/SSH同HEADで受入。以下は対象と実測時点を限定した記録であり、全体完了ではない。優待の全7,731行POSTで機械要約pending0。財務は原本診断242行のうち224行380項目をNotionとD1へ通常反映し、残る18行は不変を確認した。VWAP日足の不足338社は[通常回復40518953202](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/40518953202)で309社（9267・523A含む）を2026-10-27基準で書込・原文12ページを保管し、薄商い29社をsession HOLDとした。有報補足は`resume63`（窓63–81）と端数17社の`resume82`（窓82）まですべて閉鎖し、全3,686社のうち正常同期3,665社・基本情報のみ2社・保留19社・**未着手0社**で完走した。あわせてD1の`ir_disclosures`（10/22夜間〜10/26の302件を補充し52,241行、`jss_dataset_freshness`も`2026-10-26`へ更新）、`swing_sector_daily`（9/14〜10/27の欠落18営業日を`swing_daily_ohlcv`から99.73%〜99.97%カバレッジで復元し全28営業日942行・休場日0行）、`swing_market_context`（休場日16行を削除し、Notion保管済み一次原本から欠落10営業日と9/29確定終値・前日比を再構成して123行・休場日0行）を復旧した。

## 定期接続と実行環境

日次04:17 JSTのActionsはmainの`github.sha`とNode22/pnpm9のfrozen lockで本文50社→優待60群を実行し、新compilerへ接続する。月次10日10:30 JSTは母集団→公式source対応の優待通常取得/物理保管→再計算。#621–643の通常caller接続に欠落は見つからず、未来予定日の実行を待つだけの改修残件は置かない。優待の日次Actionsは固定allowlistの対象metadata・終了集計をartifactへ7日保存し、本文・要約・raw・秘密を含めない。設定・正常呼出経路・既存実行/回帰での確認と、将来runの実結果を混同しない。

MacはNix/既存lockの月次手動＋Calendar/メールが合意済み運用。旧自動起動を復活せず、月次driverはbiztag/競合準備のみで優待要約を起動しない。SSHは同Nix/lockの有限補完。補足の固定runtime `4b0fb282`は`resume49`（窓49–62）、`resume63`（窓63–81）、およびタイムアウト端数17社の`resume82`（窓82、`17/17 synced`）まですべて閉鎖し、対象3,686社の未着手0社を確認した。全normal publisherの共有owner/pending・元state/原本を保持する。

## 原20機能の現在受入と残

| 機能 | 現在受入 | 残・未完 | 先行条件 | LLM |
|---|---|---|---|---|
| 銘柄マスタと上場状態 | 通常日次overlayと月次母集団を配備。641A/648Aの現JPX上場ownerは正常 | EDINET由来sector33の641A/648Aは原本の直接識別情報不足で保留。alphaコードparse漏れや月次未取込ではない。他社の差分更新は保留2件に巻き込まれない。全対象の最新基準日・廃止/再現役化も未検収 | 公式発効日・主体・株式種類を資格化、名前だけで結合しない | なし |
| 株価と財務断面 | 10/27の株式日次[40477558951](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/40477558951)は3,619社更新、67社は配信価格欠損で保留、JPX権利落ち6原本を保管 | 67社のsource NULLを無取引と断定しない。価格/財務の全期間充足も未完 | 保存snapshot・対象session・全母集団で検収 | なし |
| RSI、スイング、モメンタム | 株式通常CLIの同じ派生経路を配備。`swing_sector_daily`はJPX休場日guardと`latest_date`一致判定を追加し、9/14〜10/27の欠落18営業日を`swing_daily_ohlcv`から復元（全28営業日942行・休場日0行） | 全対象の基準日/期間不足/欠測理由を区別した充足 | 適格価格系列と必要期間 | なし |
| マクロ判定 | 日米session/時刻guard・JPX休場日guardと通常起動を配備。`swing_market_context`から休場日16行を除去し、Notion保管済み一次原本から欠落10営業日（9/28、9/30、10/1、10/5〜9、10/13、10/23）と9/29確定終値・1日騰落率を復元（123行・休場日0行） | 東証プライム売買代金20日平均比、個別需給/カタリストは下記の未接続 | 対象市場・系列・公表時計/許諾の確定 | なし（未実装あり） |
| 財務サマリ | 原本242行を照合し、経常への税前混入222行376項目・CF2行4項目を通常Notion/D1へ反映、18行は不変。経常の対象コード計1,803行は全34列POST一致、非対象1,581行不変。同一原本の取得時刻保持も通常writerへ配備 | 今回の固定224行の修正残なし。全市場のNULL/歴史relation分類は別途未完 | 通常parser・原典の期間/単位/連結scope、全34列CAS/POST | なし |
| EDINET継続取得と本文範囲 | 日次catchup→通常ingest、報告HOLDを保持する経路を配備。保有明細の`primary`包装Metadataも`edinetArchiveNativeMetadata`経由で一貫射影 | 識別保留/本文なし/原本不足を各対象の根拠で解決 | 公式主体・doc/FY・保存ZIP/本文 | なし |
| 有報39項目 | 全3,686社の有限補完（窓1–82）を完走し、正常同期3,665社・基本情報のみ2社・保留19社・**未着手0社**を確認 | 基本情報のみ2社・保留19社（保留理由23件は21社に属し、社数へ加算しない）。原本なし/主体不足/項目非該当を区別し、全39列充足とは扱わない | 共有owner/pending閉鎖・同定済み本文/7メタ/全文 | なし |
| 受注と海外売上 | 11文書41区分と6721残4件を通常apply＋別inspect・最終FS照合まで受入。固定current177/177＋歴史FY2021–24の4件、state182ファイル/181claims、旧178ファイル不変 | 固定集合と歴史4件の受入で、全市場の充足は未認定。会社発表比率の基準不明は保存年額からの通常計算と区別する | 全6表fresh CAS・source本文・物理PRE/POST・通常mapper/projection | なし |
| TDnetとIR PDF | 期限/単一ID再開と元PDF同定guardを配備。D1未保存行を既存7日窓の再upsertより先に処理する順序へ改善し、10/22夜間〜10/26の302件を`ir_disclosures`（計52,241行）と銘柄別Notionへ反映、`freshness_probe`で`tdnet_disclosures`最新日を`2026-10-26`へ更新 | やのしん上流の10/27分停止は上流停止エラーで検知・保持。1279652は両入口404、限定公式調査でも同一原本未確認/HOLD | 同一元PDF資格。別日差替で代用しない | なし |
| VWAP日足 | 10/26通常runは3,348社を書込。不足338社の[通常回復40518953202](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/40518953202)は2026-10-27基準の`^N225`原本を資格化し、9267・523Aを含む309社をR2へ書込、原文12ページをNotionへ物理保管（skipped/empty/invalid/rateLimited/unknown0） | 残り29社はYahoo最終バーが2026-10-26のため`daily session HOLD`で保留。旧42社session HOLDの履歴・旧ACK不明も切り分けて保持 | 原本・価格basis・完全readback | なし |
| VWAP 5分足 | #639で通常/期間指定5分足もActions直接取得へ接続。固定45社の[通常run40362427923](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/40362427923)は45件書込、エラー・制限・結果不明0、原文2ページを物理保管 | 保存summaryの記録値は10/26有効26社・最新有効値欠損19社。旧日付40社のうち24社が10/26へ到達し、16社は有効値が旧日付のまま。NULLを無取引や0へ置換しない。旧CF停止記録・旧PUT不明・窓外欠測も保持 | 必要期間/銘柄を限定、sourceと有効日を照合 | なし |
| 信用残と日証金需給 | 独立の通常取得/予定slot・保存経路を配備 | 各系列の公表期間・残存旧日付・対象外/欠測分類 | 基準日と公表日、単位・母集団 | なし |
| 株主優待取得と要約 | 保存原本5243/3045/9842の12行を通常採用し、既存compilerで21群36行を更新。全7,731行の通常POSTと独立fresh照合一致、機械要約pending0 | 今回対象の機械処理残なし。意味判断を必要とする新規/変更は合意済み月次手動 | 通常原本物理保管・fresh4表PRE/CAS/POST・共有owner/pending閉鎖 | 日次モデルなし／意味判断は月次手動 |
| 事業タグとMac定時処理 | 旧自動2label停止、月次Calendar/メール・受入runtime45629c8・通常preflight確認 | 適格新規/実入力変更の意味判定は合意済み月次手動 | Nix・受入HEAD/同lock/private env/state・kernel/shared writer | Clef判定のみあり |
| 競合判定 | 月次driverで設定済みscopeの機械入力準備へ接続 | 意味判定・TypeSafe・全社自動判定は意図的停止 | biztag成功、既存cursor/pending・固定scope | 準備なし／意味判定停止 |
| 資金フロー | 独立28source通常runは26正常・投信/REIT2source503 | 2sourceは取得元都合の保留。[公式10/23案内](https://www.imaj.or.jp/news/2026/20261023_001929.html)・[統計入口](https://www.imaj.or.jp/statistics/)で停止継続を10/26確認。価格依存sector-turnover、全期間/全系列の充足も未確認 | 取得元ごとの公表期間/単位、sectorは価格資格と株式成功 | なし |
| 原本とAPI索引 | 通常取得は共有Notionへ実体/SHA保存。必要RAW限定補完を使用 | 歴史原本のcustody/未索引分類は未完。全量ミラーは意図的停止 | 本番が読む原本だけ、通常writerと同定/SHA/読戻し | なし |
| 有価証券保有明細 | snapshot40169768650.1を保持。#637の通常queue修正を配備後、5文書14明細を通常再資格・45mutation応答全200で閉鎖。`primary`包装Metadataを持つ旧`explicit_not_applicable`（`S100XCIN:type1` / 206A等）も`edinetArchiveNativeMetadata`で射影し`msgSha=2bd19d701deb`の停止を解消 | 窓内8明細は分割/株数basis5・株数非開示1・capture単位2で保留。現在Notion上の保有明細状態は実行中0・再開待ち0・要確認23件（旧不該当2＋明細表なし/未対応等21）。全価格未解決数・権利資格はなお未完 | 主体・株式種類・通貨/単位・対象日・原典 | なし |
| APIとMCP | 認証旧3＋REST7ケース77行、MCP3ケース、公開5ケースを段階受入 | 全API/全データ充足は未認定 | 既存認証・license・公開資格と実保存値 | なし |
| 監視とNotion案内 | 既存CF receipt/Actions/ops・schema/license照合を維持。優待定期の安全metadataを7日保存 | MAX日付だけで全件充足にしない。案内/現況表の時点更新 | 既存receiptと対象集合/失敗区分。経過はGit履歴参照 | なし |

## 未接続の定義を変えない

東証プライム売買代金の20日平均比は、同一定義の適格系列・公表時計/許諾が未資格。`topixTurnoverRatio`という変数名からTOPIX構成銘柄へ対象を変更せず、翌日公表や終値×出来高で代用しない。[入力契約と出典](../research/prime-turnover-input-contract-20261025.md)を参照する。

個別④需給は買残高/出来高の比率（2倍超で悪化）で、信用倍率・貸借倍率と別。出来高の対象日/平均期間は未確定。個別⑤カタリストは2週間の存在で、決算・格付け・自社株買い・政策等を含む。過去/未来/両方の範囲は未回答として保持し、未来限定や決算回避条件へ置換しない。

## 次の有限操作と検収

今回の財務224行、優待の機械処理、VWAP日足不足338社の通常回復（309社書込・29社session HOLD）、および有報補足全3,686社の有限補完（窓1–82、正常同期3,665社・基本情報のみ2社・保留19社・未着手0社）はすべて完了済み。あわせてD1の`ir_disclosures`（10/22夜間〜10/26の302件補充・`jss_dataset_freshness`更新）、`swing_sector_daily`（9/14〜10/27の全28営業日942行復元・休場日0行）、`swing_market_context`（休場日16行削除・欠落10営業日と9/29確定終値の復元・1日騰落率再計算で123行・休場日0行）も完了した。上流停止・原本不足・主体/単位/basis不明は理由付き保留を維持する。

受入証跡はprivateの`main637-acceptance-v1/`、`main638-acceptance-v1/`、`main638-finite-status-v1/`、`yutai-after-owner-recovery-prep-v2/`、`supplement-remaining1248-resume49-prep-v2/`、`supplement-remaining690-resume63-prep-v1/`、`mechanical-supplement-remaining17-resume82-runtime-normal-20261028-v1/`、`financial222-ordinary-only-normal-apply-prep-v1/`、`financial6532-cf2-normal-prep-v1/`、`daily9267-current-r2-read-v1/`、`daily338-main642-direct-once-20261027-v1/`、`holdings-price-main637-normal-window-v1/`、1375の通常apply/syncと独立再読、受注11と6721全4残件の通常apply/独立inspect closure・最終受入、`yutai-pending7731-normal-post-fs-v1/`、本文bulkの各終端窓を正本とする。詳細の原本・秘密値はGitへ載せない。予定と先行条件は[本番処理一覧](../production-job-inventory.md)、停止/手動/未実装を含む全scopeは[データ一覧](../batch-data-inventory.md)を参照する。
