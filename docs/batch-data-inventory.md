# データ取得・更新・監視の全件一覧

確認日: 2026-10-25。対象は本repoの15 workflow、宣言23 jobs（歴史RAWの無効1 jobを除き有効14 workflow／22 jobs）、CFの14 trigger、通常CLI、Macの2 LaunchAgent。GitHubが動的生成するDependency Graphは業務バッチに含めない。各行はデータ機能単位で、列の欠測や同じ原本の再利用を「新規取得成功」と数えない。

**Macの2定期設定はユーザー指示でdisable＋bootout済み。本文39/基本補足/優待機械要約は[独立Linux定期](mechanical-publishing.md)へ分離し、共有状態移行・有限本番確認後に有効化済み。Clefと既存競合入力準備は[月次手動](mac-monthly-manual.md)。** 他のCF／Actions定期は継続する。以下の「自動」は設定上の入口であり、全件充足・直近実行成功の保証ではない。全時刻はJST。

## CF／Actionsの通常取得・更新

この表はすべてLLM不使用。実原本・同一主体・期間・単位・権利basisが成立した値だけ保存する。

| ID | データ・更新内容 | 起動・先行条件 | 現状 |
|---|---|---|---|
| D01 | JPX上場銘柄母集団、銘柄名、市場、33業種、商品区分、対象外化 | 毎月10日10:30、月次の最初 | 自動 |
| D02 | 公式の上場・廃止・市場変更overlay、active対象更新 | 平日18時、価格対象選択前 | 自動 |
| D03 | EDINET提出者コード表、公開業種、銘柄マスタ・財務relation補完 | 毎月1日06時、Asia/Tokyo明示 | 自動、主体不明は保留 |
| D04 | core/rsi/swing用日足OHLCV・調整終値の増分 | 平日18時、確定した対象日原本 | 自動 |
| D05 | 株価、PER、PBR、配当利回り、EPS、BPS、ROE、ROA、時価総額、営業利益率の最新断面 | 同上、Yahoo同応答の値・期間・株数基準を検算 | 自動、検算不能は欠測 |
| D06 | Yahoo年次財務の既存consumer用保存 | 月曜の株式runのみ | 自動、JSS年次系列とは別 |
| D07 | JSS年次財務から優良株判定・売上傾向 | 株式run、保存済み年度系列 | 自動 |
| D08 | RSI14、5年RSI百分位・標本数 | 株式run、同じ調整終値系列 | 自動 |
| D09 | SMA5/20/25/60/75、ATR14/率、MACD/signal/histogram | 同上 | 自動 |
| D10 | 20日高安・値幅、Fibonacci38.2/50/61.8、平均売買代金・出来高・出来高倍率、前日騰落率 | 同上 | 自動 |
| D11 | long/shortトレンド・パーフェクトオーダー、流動性/ボラティリティ/トレンドの3条件と総合flag | 株式run、D09/D10 | 自動。需給・カタリスト（2週間、過去/未来の範囲は確認中）の2条件は未対応 |
| D12 | ブレイクアウト、押し目/戻り、出来高急増、gap follow/fade、決算後型の価格パターン | 株式run、同run指標 | 自動。決算後型は決算日原本の取得ではない |
| D13 | 成立シグナルのentry・stop・目標・RR・強度、旧signalの除去 | D12後 | 自動 |
| D14 | モメンタム用90本投影、鮮度確定、旧対象除去 | 株式runの保存後 | 自動 |
| D15 | OHLCV履歴窓の存在確認・月曜の保持期間剪定 | 株式run | 自動、履歴欠測を生成しない |
| D16 | 33業種騰落集計 | 株式run、当日指標90% coverage | 条件付き自動 |
| D17 | 東証33業種対応の照合・更新 | 株式step実行後のsector33_sync。株価失敗でも実行、取消/株式対象外では停止 | 自動・価格非依存 |
| D18 | JPX配当落・権利落原本保管、Yahoo分割/配当の診断 | 株式run内。JPX原本保管は金融write後、Yahoo診断は銘柄取得時 | 自動。公式全イベントの金融資格化は未完 |
| D19 | VWAP用10年日足原本・系列、保有価格snapshot登録 | 月水金17時、Yahoo共通排他。同session証跡を再利用、未完銘柄は10年系列を取得して全置換 | 自動 |
| D20 | 5分足系列の取得・蓄積 | D19の既知閉鎖（exit0/1）後。abort/unknown/原本保管fatal・異常出口では停止 | 条件付き自動 |
| D21 | JPX市場信用残高原本・時系列 | 平日17時CF起動、17:10受付/17:30新規IO締切。Yahooと別排他、公開元の対象日資料 | 自動 |
| D22 | 日証金貸借残高・増減・倍率・回転日数 | 平日12:17CF起動、予定JST日・zandaka.csv。CSV基準日は保持 | 自動 |
| D23 | 日証金逆日歩、貸借銘柄区分の原本 | D22のjob内、shina/meigara.csv | 自動。銘柄区分は原本保管のみ |
| D24 | 日証金の全取引所別R2履歴と主取引所のD1最新断面 | D22/D23の原本保存後 | 自動 |
| D25 | TDnet当日一覧・開示索引・原本、短信XBRL財務サマリ、公式上場/廃止状態 | 平日09〜19時毎時CF起動、Python・予定slotの日付 | 自動。公開資格は原本別 |
| D26 | IRカタログ全対象登録、タイトル分類、PDF本文・極性、Notion銘柄別反映 | 平日19時、Node catchupの最初 | 自動。辞書/ルール分類でLLMなし |
| D27 | EDINET提出日一覧・原本CSV/XBRL・財務サマリ | 平日21時CF起動、Python・予定JST日の提出資料。19時Nodeとは独立 | 自動 |
| D28 | 有報の受注高・受注残高・海外/地域別売上・比率 | D26実行後のNode EDINET。共通資格・保存設定が成功すればD26失敗でも実行 | 条件付き自動、構造不明は保留 |
| D29 | 有報39本文の構造抽出・D1/Notion有報テキスト保存 | D28と同じ原本、本文原文 | 条件付き自動。補足DBへの同期はM02 |
| D30 | 有報の情報修正の再資格化 | 通常catchup、主体/form/FY・保存ZIP・全facts/全文完全一致 | 条件付き自動、不一致は保留 |
| D31 | 有報の保有明細・未完抽出再開、発行済株式数観測 | Node catchup、原本・主体資格 | 条件付き自動。全権利適用の確定ではない |
| D32 | 保有価格queueの資格化・保存 | Node非shard catchupの期限内末尾、最大100行・原本/主体/権利basis | 条件付き自動。過去全未資格行の完了とは別 |
| D33 | 優待一覧・個社原文・権利月・株数条件の構造取込 | 毎月10日10:30、D01→原文保管 | 自動 |
| D34 | is_yutai再導出・優待銘柄財務の表示投影 | D33成功後、保存財務から再計算 | 自動 |
| D35 | 条件適用可能な優待価値・優待利回り | 月次、条件/期間/株数/金額が確定した原文 | 自動。要約更新はM06 |
| D36 | PER/PBR/配当利回り/ROE/優待利回りの各点数 | 月次、保存入力 | 自動 |
| D37 | MA乖離/RSI/MACDの各点数とファンダ/テクニカル/総合score | 月次。MA乖離比較は財務日＝指標日。他項目は保存入力 | 自動 |
| D38 | 日本市場脚：日経平均確定終値・前日終値・日経VI | 株式側原本から対象日へ保持 | 自動 |
| D39 | S&P500・VIX・日経先物snapshot | 火〜土06時、保存日本市場脚と予定日を照合 | 自動 |
| D40 | 日経/S&P騰落、先物gap、マクロ判定と理由 | D38/D39一致・必須値充足 | 条件付き自動。東証プライム売買代金の20日平均比は未対応 |

根拠: [stock-sync](../.github/workflows/stock-sync.yml)、[VWAP](../.github/workflows/vwap-ingest.yml)、[Node catchup](../.github/workflows/catchup.yml)、[日次本体](../src/cron/daily.ts)、[月次本体](../src/cron/monthly.ts)、[Python jobs](../pipeline/src/jp_stock_pipeline/jobs/)。

## 資金フローの全29取得元

全行LLMなし。F03を除く28取得元は**平日18:15に確認**する。下の頻度は原資料の更新頻度であり、その頻度専用のcronではない。同じ公表期間は原本を再利用する。非Yahoo→Yahoo→両laneの予定・全source完了照合の順。F03は株式job成功・許容失敗なし・価格coverage成立後だけ実行する。

| ID | データ | source | 原資料頻度 |
|---|---|---|---|
| F01 | JPX業種別時価総額 | `jpx-sector-marketcap` | 月次 |
| F02 | JPX業種別空売り・当月集計 | `jpx-short-selling` | 日次→月集計 |
| F03 | 業種売買代金・シェア・上昇/下落日売買代金 | `sector-turnover` | 日次から週次窓 |
| F04 | 暗号資産市場全体 | `coingecko-global` | 日次 |
| F05 | 業種別信用残 | `jpx-margin-sector` | 日次、保存済みR2 snapshot replay |
| F06 | 株式投資部門別 | `jpx-investor-equity-weekly` | 週次 |
| F07 | 対内外証券投資 | `mof-portfolio-flows-weekly` | 週次 |
| F08 | 先物・option投資部門別 | `jpx-derivatives-investor-weekly` | 週次 |
| F09 | 指数先物建玉 | `jpx-derivatives-investor-futures-oi` | 週次 |
| F10 | 円・日経先物COT | `cftc-cot-jpy` | 週次 |
| F11 | 世界指数・為替・金利・金・原油 | `global-indices` | 週次、Yahoo lane |
| F12 | 株式投資部門別 | `jpx-investor-equity-monthly` | 月次 |
| F13 | ETF投資部門別 | `jpx-investor-etf-reit-etf` | 月次 |
| F14 | REIT投資部門別 | `jpx-investor-etf-reit-reit` | 月次 |
| F15 | 対内外証券投資 | `mof-portfolio-flows-monthly` | 月次 |
| F16 | 公募投信資産増減 | `imaj-fund-flows` | 月次 |
| F17 | REIT資産増減 | `imaj-fund-flows-reit` | 月次 |
| F18 | 公社債発行・償還 | `jsda-bonds` | 月次 |
| F19 | 店頭FX | `ffaj-otc-fx` | 月次 |
| F20 | くりっく365 FX | `tfx-click365-fx` | 月次 |
| F21 | くりっく株365 CFD | `tfx-click365-cfd` | 月次 |
| F22 | 国内暗号資産会員統計 | `jvcea-crypto` | 月次 |
| F23 | 地域別国際収支 | `bop-regional` | 四半期 |
| F24 | 資金循環残高・フロー | `boj-flow-of-funds` | 四半期 |
| F25 | 国際銀行統計 | `bis-banking` | 四半期 |
| F26 | 国際証券保有残高 | `imf-cpis` | 半期 |
| F27 | くりっく365 FX | `tfx-click365-fx-annual` | 年次 |
| F28 | くりっく株365 CFD | `tfx-click365-cfd-annual` | 年次 |
| F29 | 世界上場企業時価総額 | `worldbank-marketcap` | 年次 |

根拠: [登録26 spec](../scripts/moneyflow/sources.ts)＋[Phase1の3 source](../scripts/moneyflow/ingest.ts)。内部取得と公開利用資格は別であり、全29取得元を公開APIへ出す意味ではない。

## 旧Mac自動起動と月次手動の対象機能

**M01/M02/M06はLinux/Actionsの日次機械処理として移行・有効化済み。M03/M04/M05はMac月次手動。** plist・env・モデル・原本・進捗・未完journalを保持し、2labelを永続disable/unloadした。月次手動では受入済みMac runtimeと既存の未完状態・writer排他を使う。23:30の旧Mac日次receipt期待は廃止し、月次手動を旧日次成功へ偽装しない。初回Actionsは本文31社同期/今回未着手19・優待60件保留/適用0・モデル0でFAILURE終了。詳細と全データ充足の境界は[受入台帳](work-plans/production-completion-20261025.md)を参照。

| ID | 機能 | 現在の予定 | LLM | 移設の境界 |
|---|---|---|---|---|
| M01 | 補足DBの基本情報・マスタrelation | 毎日04:17 Linux/Actions | なし | 変更＋巡回の有限50社、本文/意味判断を分離 |
| M02 | 補足DBへの39本文同期・不一致修復・実値/欠測観測 | M01と同じ最大50社 | なし | 毎回、選択済み原本の所属/7メタ/strict全文とtargetを資格確認。原文SHA・Notion SHA・旧receipt・targetが一致する時だけ書込0。旧タグ根拠は保持 |
| M03 | keywords/excludes、候補抽出、上流/下流タグ・テーマ導出、同入力判定再利用 | Mac月次手動の通常biztag内 | なし | 既存no/uncertainを単語一致だけで覆さない。日次本文同期から独立 |
| M04 | 適格新規・実入力変更の事業タグClef判定 | M03と同じ月次手動 | **あり** | 現行torch-MPS専用、モデル約19GB。受入済みruntimeで実行し、旧モデル結果不明の停止を維持 |
| M05 | 競合入力・質問・候補の機械準備 | 月次biztag成功後、設定対象から最大5社 | なし | 現envキーは設定あり。同じMac runtimeのcursor/pendingを再利用。意味判定は行わない |
| M06 | 優待の機械要約、金額/条件検証、PRE/CAS/POST | 本文job終了後、Linux/Actions最大60群 | なし | 既知本文HOLDとは独立。原文取込とも同じ共有writer、機械未対応は保留。10/25の通常2窓で4群/7行採用・runtimeモデル0、15:16 JSTの完全POSTを通常selectorでFS再計数し残118群/175行/46社 |
| M07 | 旧日次の30分期限・R2 receipt（保全）、共有lock・原文/journal | 両処理共通 | なし | 月次はstageごとの独立期限。旧日次receiptは更新せず、既存stateを使う |

根拠: [launcher](../scripts/biztag-local/main.ts)、[OS/lock条件](../scripts/biztag-local/runtime.ts)、[優待CLI](../services/otakara-yutai/data-scripts/summary-local.ts)、[Clef](../services/yuho-quant/scripts/clef_server.py)。優待の定期実行は`--allow-model`なしだった。月次`sync:monthly`は優待取得→再計算。要約は独立Linux jobとし、月次手動driverからも除去する。詳細は[機械同期](mechanical-publishing.md)。

39本文の正本は[TEXT_SECTIONS](../services/yuho-quant/src/services/edinet/text-sections.ts)。項目一覧:

| 項目 | 項目 | 項目 |
|---|---|---|
| 1. 事業の内容 | 2. 事業等のリスク | 3. 経営方針、経営環境及び対処すべき課題等 |
| 4. 配当政策 | 5. 経営者による財政状態、経営成績及びキャッシュ・フローの状況の分析 | 6. 研究開発活動 |
| 7. 大株主の状況 | 8. 発行済株式、株式の総数等 | 9. 所有者別状況 |
| 10. 発行済株式、議決権の状況 | 11. 自己株式等 | 12. 株主総会決議による取得の状況 |
| 13. 取締役会決議による取得の状況 | 14. 取得自己株式の処理状況及び保有状況 | 15. 関係会社の状況 |
| 16. 従業員の状況 | 17. 沿革 | 18. 重要な契約等 |
| 19. 役員の状況 | 20. 株式の保有状況 | 21. 社外取締役（及び社外監査役） |
| 22. コーポレート・ガバナンスの概要 | 23. 監査の状況 | 24. サステナビリティに関する考え方及び取組 |
| 25. 主要な設備の状況 | 26. 設備の新設、除却等の計画 | 27. 設備投資等の概要 |
| 28. 有価証券明細表 | 29. 有価証券関係、財務諸表 | 30. 有形固定資産等明細表 |
| 31. 賃貸等不動産関係、財務諸表 | 32. セグメント情報等、財務諸表 | 33. 重要な後発事象、財務諸表 |
| 34. 関連当事者情報、財務諸表 | 35. 提出会社の親会社等の情報 | 36. ライツプランの内容 |
| 37. 行使価額修正条項付新株予約権付社債券等の行使状況等 | 38. 発行済株式総数、資本金等の推移 | 39. 主要な顧客ごとの情報 |

## 監視・基盤処理

全行LLMなし。O01〜O07は自動、O08〜O09は手動診断。

| ID | 処理 | 頻度・条件 |
|---|---|---|
| O01 | 予定dispatchのR2 receipt確保・GitHub実run/期限照合 | CF5系列×dispatch/readcheckの10cron |
| O02 | データ鮮度・件数・容量の観測 | 毎日23:30 |
| O03 | SLO・株価coverage・マクロ日付・開示/PDF欠測判定（旧Mac日次receipt期待は廃止） | 毎日23:30、観測失敗でも判定 |
| O04 | core schema drift検証 | 同job、先行失敗でも実施 |
| O05 | 列license map投入・照合 | 同job、先行失敗でも実施 |
| O06 | 失敗Issue作成・回復時close | 各workflow/監視の結果に従う |
| O07 | Node/Python/JSS型・lint・tests・監査資料・migration生成漏れ検査 | PR/main pushのCI2jobs |
| O08 | Cloudflare D1/R2基本疎通 | cloud_check手動dispatch |
| O09 | 特定RAW実体GET/SHA検証 | 明示対象時だけ手動 |

一次保管・SHA照合、条件付writer、Yahoo共有cooldown、ジョブ内Notion pacingは各通常処理の共通境界。Notionの全job共通rate制御は未成立のため追加並列化しない。

## 手動専用・意図的停止・未実装

| ID | 機能・設定 | 現状／自動取得と区別する点 | LLM |
|---|---|---|---|
| X01 | 株価/財務/本文/受注/海外/不足有報/保有明細/IRの過去補完 | 対象・原本SHA・期間を固定する手動CLI/dispatch。SSHは有限補完のみ、日次cronなし | 原則なし |
| X02 | 保有価格の初期snapshot bootstrap、過去保有価格の資格化・隔離・既存物公開 | 固定PRE/journal/原本/basisを使う手動。通常D19/D32とは別 | なし |
| X03 | 財務の保存原本再解析、Notion修復、D1同期、歴史relation補修 | 手動、過去全件を日次で再走査しない | なし |
| X04 | ZIP/PDF欠損原本回復・parser不一致・主体不明の解決 | 適格原本と同定が必要。定期が推測して解除しない | なし |
| X05 | 空タグの明示再確認、既知Clef拒否のSHA付き閉鎖 | 固定対象・明示修復。定期新規/入力変更とは別。Mac自動起動は廃止 | 判定時のみClef |
| X06 | 優待規則未対応の生成要約 | 手動`--allow-model`のMLXコードが残存。現在非稼働、移設未受入 | あり |
| X07 | 優待要約の旧外部タスクexport/import、公開facts/利回り再補修 | 手動。外部LLM自動経路はない | export/importの生成先次第 |
| X08 | 競合の意味判定、TypeSafe、語彙外部審査、定期golden評価 | 意図的停止。M05準備は判定完了ではない | 停止中 |
| X09 | 歴史RAW全量ミラー/索引 | workflowはdisabled_manually、全量コピーを再開しない | なし |
| X10 | 必要RAW限定補完・保存済み固定ROA原本公開 | raw:required/roa_saved_raw_publish手動 | なし |
| X11 | Notion索引更新・移設・重複解消、schema適用、unknownの照合/ACK | 手動管理。保存結果不明を自動再送しない | なし |
| X12 | 内部API/MCPの成功認証通し確認 | 旧認証3ケース＋新REST7ケース/77行・MCP3ケースを段階受入済み。公開5ケースもPASS。定期probeではなく、全API/全データの保証へ広げない | なし |
| X13 | ローカルPostgreSQL/端末B FastAPI、XBRL全facts/textblock別ミラー | 任意コード残存。root/退役Mac/SSH.envの関連11キー未定義、GH secret/注入もなし。本番必須依存ではない。接続/起動状態は未調査 | なし |
| X14 | LOCAL_OUT | ローカルFSへ向ける検証用。R2本番保存実績の代用不可 | なし |
| X15 | sync:daily等の手動一括wrapper | 定期とは別入口。sync:monthlyは今回Mac要約起動を除去 | なし |
| X16 | 個別④買残高/出来高の比率、⑤カタリスト（2週間、過去/未来の範囲は確認中） | 自動接続は未対応。需給の対象日/集計期間やカタリストの期間範囲を推定しない。#572の手動案内に残った未来限定を訂正 | 未実装 |
| X17 | マクロの東証プライム売買代金の20日平均比 | `topixTurnoverRatio`は現在null。コード名から対象をTOPIX構成銘柄へ変えない | 未実装 |
| X18 | 全分割・併合・増資の公式イベント解析/法的日付・価格basis/保有適用 | 一部診断・観測・原本custodyは定期接続済み。全イベントの金融資格化は未完 | 未実装部分あり |
| X19 | 公開coreへのTDnet予想配当利回り | 利用資格・定義・期/株数basis未解決。公開経路は未採用 | 停止 |
| X20 | DCF/Gordon・CAPM/β・Black-Scholes/Greeks・EMH探索、VWAP/POC/価格帯出来高の表示計算 | 保存データ/入力からリクエスト時に機械計算する機能。独立した蓄積バッチではない | なし |

権利・主体・期間・公開資格・原本不足を別値や別モデルで埋めない。既存全列の欠測が今後の定期だけで全て解消するわけではない。旧実績の件数・未完データは[復旧状況](test-logs/recovery-functional-status-20261020.md)へ分離する。

## 月次手動の順序

Mac専用分は[月次手動スクリプト](mac-monthly-manual.md)で、受入済みruntime・既存stateを明示し、通常biztag→設定済みscopeの競合準備の順に実行する。優待機械要約は独立Linux日次。失敗時は後続STOP、未完intentを維持し再試行しない。既存クラウド月次は毎月10日10:30。案内は2026-11-11から毎月11日09:00 JSTのGoogle Calendar予定・開始0分前メール通知と、短いコマンド/本手順への参照を読戻し済み。初回メール受信・月次の本モデル実行は未観測。

private証跡は`tmp/feature-audit-20261020/mac-retirement-inventory-v1/`と`local-manual-dependencies-audit-v1/`。停止前snapshotと各disable/bootout1回、postcheck、env/plist保全を記録した。
