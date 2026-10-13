# 株式情報の機能別監査と対応方針

調査基準時点: 2026-10-14 00:30 JST。対象コード: main `b7c84ae018d61e0ce310ae6f873f5cf29333b0be`。追跡: [Issue #346](https://github.com/satoki252595/kabulab_tool_cloudflare/issues/346)。

[Notion「株式情報」](https://app.notion.com/p/205d74ff84cd809e92b4dd1adc5cf186)には、現行データの未更新、抽出ロジックの漏れ、廃止済みDBと旧案内が混在している。主な未完了は株式・マクロ更新、上場状態の日次適用、Mac定時runtime、有報の連結注記抽出、VWAP全量完了、IRの後続日と原本保管である。空欄全件の補完や旧Notion DBへの大量ミラー復活は対応方針にしない。

## デプロイと確認範囲

- Cloudflare Workers Buildsはmain `b7c84ae0`で成功。本番Workerの最終更新は10/13 22:24:57 JST。取得した本番コードには18:00株式Cron、23:35 readcheck、`ir_notion_stock_pages`、公式PDF同定の実装が存在する。#336・#335関連を「未デプロイ」とは扱わない。
- ポータルと7サービスの入口はすべてHTTP 200。JSS公開・内部APIの`/health`も200。ただし入口の応答は全データ・権限付き業務API・MCPの通し受入を証明しない。JSS Workerの最終更新は両方10/5 06:44–06:46 JSTで、mainとは別デプロイである。
- 18:00変更は10/13夜に反映したため、変更後の最初の18:00定時実行は10/14。初回の全量完了・原本保管・readcheckは未受入。
- Notionの構造・SQL集計、D1のSELECT、保存済み原本の再解析、Actionsログ、Cloudflareの本番コード・メタデータを照合した。ジョブ再実行、データ修復、Notion編集、LaunchAgent更新は今回の調査に含めていない。
- ローカル資格のCloudflare deployments/settings APIは403だったため、デプロイversion ID・トラフィック配分は未確認。上記判断はWorkers Builds、本番コード、Worker更新時刻、HTTP応答に基づく。

## 機能別のできていないこと

| 機能 | 状態 | 確認した未完了と影響 |
|---|---|---|
| 銘柄マスタと上場状態 | 日次適用停止 | D1のactive普通株は3,689社。EDINET月次マスタは10/4成功だが、公式イベントoverlayの適用基準日が10/4のまま。保存済み10/9上場廃止イベント3件がactiveのまま残る。N225鮮度確認の後にoverlayを実行する順序のため、株価停止が母集団更新も止める。 |
| 株価と財務断面 | 更新停止、修正後受入待ち | active3,689社すべてに行はあるが、最新基準日は10/1で3,634社。残55社はそれ以前。18時化はデプロイ済みで、最新データまで回復したわけではない。 |
| RSI、スイング、モメンタム | 共通更新の下流が停止 | 指標も最新10/1の3,634社。現行母集団のRSI14未計算は12社、RSI percentile欠損11社。期間不足等の正常な欠測と取込漏れは分ける必要がある。 |
| マクロ判定 | 更新停止、休日契約未整備 | 保存最新は10/2。最新失敗は日経10/9と米国10/12の対象日不一致。株式18時化だけでは日米休場差は解消しない。公式市場カレンダーが未整備。 |
| 財務サマリ | 稼働中、項目単位の未対応 | D1・NotionともEDINET31,847行、TDnet3,073行、合計34,920行。TDnetは10/13まで更新。active3,689社中3,675社に財務履歴あり。ROAは両取得元で0件かつコード上も未取得仕様。TDnetのROE0件等は、原典非開示・抽出対象外・期間差をまだ分類していない。 |
| EDINET継続取得と本文範囲 | 識別保留あり | 保留15文書はすべて`identity_unresolved`。69日走査finished、in-flight0、直近の一覧・取込例外0。active3,689社中3,667社に有報・本文あり、22社は本文なし。15文書と22社は同じ集合とは限らない。 |
| 有報39項目 | 連結注記の抽出漏れを再現 | 全39項目に実データはあるが、保存済み実CSVで連結セグメント情報と連結の関連当事者情報が非空なのに抽出されない。有価証券関係・重要な後発事象も連結版を除外して個別版だけを採用する例を確認。 |
| 受注と海外売上 | 実表パターンの未対応 | 全履歴38,210通中、受注表未対応1,318通、海外情報あり未構造化7,391通。海外parse_error3通、本文parse_error7通。表自体がない文書をこの未対応件数へ足してはいけない。 |
| TDnetとIR PDF | 到達日の差、原本保管未完 | Python側の開示・財務は10/13まで更新する一方、`ir_disclosures`の最新開示は10/9。公開40日以内でNotion未保管167件、うち8日超1件。直近catchupは162件保管・行エラー0で予算に到達した。 |
| VWAP日足 | 全量未完、書込結果不明 | 直近通常runは3,689銘柄中、書込495・同値skip64の後、`daily/3034.json`のR2 PUT 500で結果不明となり全停止。#342の日付跨ぎ修正だけで全量完成したわけではない。 |
| VWAP 5分足 | 日足停止で未起動 | 同runのintraは未起動。直近の信用残run成功は日足・5分足の成功を意味しない。通常5d窓だけでは長い停止期間の穴を回収できない。 |
| 信用残と日証金需給 | 通常取得は稼働、一部残存行の分類未完 | 信用残は10/14 00:22成功、基準10/9・公表10/13・4,247行。需給は10/13 19:54成功、基準10/9・4,349行。公表差は正常。需給の旧基準日行は残っており、掲載対象外と真の欠測の分類は未確認。 |
| 株主優待取得と要約 | 現行契約では処理済み、情報モデルは未完 | active7,716行・1,650社を現行`selectSummaryTasks`で再検査し、未要約0・再処理対象0。過去の残3,592群は現在の未完件数ではない。一方、保有期間・選択グループ・併用可否・公式URL確認日の独立フィールドがない。金額NULL5,978行は意図的評価不能を含む。 |
| 事業タグとMac定時処理 | 保存済み判定あり、次回起動基盤が欠落 | 補足DB3,712行のうち判定済3,690・本文なし22。activeでは判定済3,667。事業タグ・優待要約の両LaunchAgentが現在存在しないruntimeをWorkingDirectoryに指定。10/13 20時・21時の成功receiptは過去の結果で、次回起動の成功を保証しない。消失時点・原因は未確定。 |
| 競合判定 | 一部未判定、定時自動化は意図的停止 | 判定版あり3,607行、版なし105行。その内訳は事業タグ判定済83・本文なし22。全社自動判定、語彙審査、精度測定、TypeSafeは現運用で停止。明示SemIf経路はある。 |
| 資金フロー | 株価連鎖で停止、新様式実受入未完 | 29取得元は実装済み。最新単体失敗はsector-turnoverの日足coverage3,688/3,689不足。独立Cronを廃止しstock-sync成功に連鎖するため、他取得元も自動更新されない。JPX株式月次・ETF・REITの9月新様式は公表済みだが実ファイル受入が未完。 |
| 原本とAPI索引 | 歴史範囲が揃っていない | Notion⑤78,831行に対しD1原本索引は2,448行、D1索引の期間は9/11以降。現行コードも歴史的Notionのみ保管を明示。原本消失とは断定できないが、歴史原本をD1/R2 APIから一律に辿れる状態ではない。 |
| 有価証券保有明細 | 欠測理由と継続writerが未確定 | Notion27,587行、価格・時価あり20,118行、空欄7,469行。本repoで通常writerを確認できない。非上場・外国株・単位やコード結合の不明をまだ分類していない。 |
| APIとMCP | 稼働、全機能の受入未確認 | 公開・内部health200。ライセンスによる非提供項目は意図した制限。認証付き業務経路・MCPの機能別結果と現在データの整合は今回全件受入していない。 |
| 監視とNotion案内 | 古い観測、説明と実装の乖離 | 鮮度表は直近probe時点の観測で、その後の財務・需給成功を反映していない。MAX基準日だけでは全銘柄欠測を検知できない。Notionカタログは6月の廃止前構成を説明し、生成関数は既存ページの内容を更新しない。 |

## 対応方針と完了判定

優先度はP0を実行基盤・誤った対象・失われ得る原本の保全、P1を日次復旧と再現済み不具合、P2を対象契約の拡張・歴史範囲の整理とする。

| 優先 | 対象 | 対応方針 | 完了判定 |
|---|---|---|---|
| P0 | Mac runtime | 永続する専用runtimeを受入済みmain SHAで復旧し、既存Nix・private設定・モデルcache・共有排他・進捗を引き継ぐ。既存preflight後にplistを更新する。 | 同じSHAで両定時処理が起動し、終了receipt、読取母集団、pending、保存後確認が一致する。過去のexit0だけで受入にしない。 |
| P0 | 上場状態 | 公式イベントの発効日適用を株価取得の可否から独立させる。月次マスタと日次overlayの所有を維持し、古い一覧による再現役化を防ぐ。 | 少なくとも確認済み廃止3件と保存全イベントが発効日に一致し、同処理再入の不要書込が0。 |
| P0 | IR原本 | 保管期限の近い未保存を既存の冪等再開経路で先に保全する。一覧供給・母集団・D1取込の到達差も照合する。 | 後続日の開示が揃い、未保存167件の取得可否・実体保管・読戻しが確定。原本が既に失われた場合は別状態で残す。 |
| P1 | 株価と派生指標 | #336後の最初の18時定時処理をreceipt→全量producer→D1→Notion完了記録→23:35 readcheckまで受入。未完部分だけ回復する。 | active母集団の同日coverage、失敗・欠測理由、RSI・スイング・モメンタムの基準日が揃う。新規上場等の期間不足は理由付きで保持する。 |
| P1 | マクロと営業日 | 公式市場カレンダーに基づき、休場・予定なし・源欠測を分ける。複数市場の必要な確定sessionを仕様化し、保存ガードを単純に緩めない。 | 共通営業日と日米片市場休場の両方で、正しい予定と原本・保存・readcheckを確認する。 |
| P1 | VWAP日足と5分足 | 3034の予定body SHAと現在R2を読取り照合し、結果不明を確定してから未処理対象だけ再開。5分足は欠落営業日と銘柄を限定し、回収可能な最大60d窓を使う。 | 日足全量の完了証跡と5分足の欠落分類・原本・proof・R2読戻しが揃う。結果不明PUTを自動再送しない。 |
| P1 | 有報39項目 | 実ラベル・elementIdで連結版と個別版を明示的に扱い、連結優先を証明する。保存済みCSVを再利用して再抽出する。単に「連結」の文字を除去する修正にしない。 | 再現した連結注記が正しく採用され、個別との混同がない。Notion全文・補足39列・D1索引が一致し、既存判定済みタグを保持する。 |
| P1 | 識別保留と本文なし | 保留15文書と本文なし22社を、保存原文・公式提出者・対象母集団で別々に分類する。一意対応が証明できるものだけ回収する。 | 対象内・対象外・未提出・未確定が理由付きで区別され、未確定を推測で紐付けない。 |
| P1 | 資金フロー | まず必要な株価coverageを復旧。価格を必要とするsector-turnoverと他取得元の依存分離は、既存`only`入口で最小限に検討する。公表済み新様式は原本保管から通常受入へ進める。 | 各取得元の公表済み最新期間・単位・値・原本を照合し、sector-turnover不足を黙って除外しない。独立した取得元も定時更新する。 |
| P1 | 監視と起動保証 | 既存opsにactive当日coverage、マクロ、VWAP、投影の最終成功とMac receiptを加える。18時writer・公式休場・公表遅延に監視仕様を合わせる。GitHub scheduleの実遅配を測り、必要な入口だけCF移行を検討する。 | 最大日付だけ進む部分成功、古い観測、源休場、実停止を区別して検知する。定時開始と完了の両方を観測できる。 |
| P2 | 受注と海外売上 | 未対応を実表パターン・連結/個別・期間ごとに分類し、頻出の確定可能なパターンから追加する。 | 実表fixtureと保存済み原本の再抽出、L2投影、画面が一致。非開示を0や推定値にしない。 |
| P2 | 財務項目 | ROAを必要項目として採用するなら原本専用要素・単位・期間・連結を確認して抽出を追加。ほかのNULLも非開示と未対応を区分する。 | 採用した項目の原典まで追跡でき、計算による架空補完や期間混在がない。 |
| P2 | 優待条件と価値 | [#291](https://github.com/satoki252595/kabulab_tool_cloudflare/issues/291)に沿い保有期間・選択・併用・公式出典を構造化。金額NULLを非金銭・一意評価不能・条件未確定等に分ける。価格依存スコアは株価復旧後に再受入。 | 重要条件を失わず、選択肢を合算しない。現行要約pending0と、公開用の条件充足を別々に確認する。 |
| P2 | 競合判定 | 現在の意図的停止を維持。再開する場合は判定済タグ83社の未判定理由と入力資格を確認し、対象・較正・保存範囲を別途決める。 | 既存値の版と鮮度、対象内の未判定理由が明確。今回の漏れ調査を理由に有料AIや全社再判定を自動再開しない。 |
| P2 | 歴史原本と保有明細 | 原本はNotionのみ・R2あり未索引・索引ありに分類し、必要な歴史範囲から補う。保有明細はwriterの所有と対象契約を確定し、上場/非上場/外国・株数/通貨/分割単位を区分する。 | 歴史原本を消失と誤認せず、実在する原本へ辿れる。適格な保有明細だけ実価格と結合し、残りの欠測理由を示す。 |
| P2 | Notion案内とAPI受入 | 機能→正本→閲覧入口→更新頻度→制約を現行実装に揃える。旧DBには移行先を明示。認証・ライセンス別にAPI/MCPの代表機能を通し受入する。 | 旧カタログと本番構成の矛盾が解消し、非提供項目と未取得が読み手に区別できる。 |

## 空欄をそのまま修復対象にしない項目

- Notion②株価テクニカル・⑥時系列エクスポート・⑦ジョブログは廃止済み。⑧需給・⑨優待の旧Notion DBが0件でも、D1/R2側が未実装という意味ではない。
- 資金フローの原本relation空66件は、業種別空売り比率の9月・10月各33業種だった。複数日次PDFの月次集計で単一原本relationをNULLにする現契約と一致する。追跡性を強めるなら複数原本manifestを使い、適当な1件で埋めない。
- 優待の金額NULLは、唯一適格の企業公表額がない場合に意図的に残す。現行要約未処理は0。古い実行の残数を現在の未処理と扱わない。
- 財務・開示の銘柄relation欠け、本文22社、財務14社の履歴なしは、対象外・提出前・識別未確定等を原典で分類してから不具合と判定する。
- TDnet失敗後にEDINETを止める`success()`は[#301](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/301)の意図的安全境界。既知の業務失敗と保存結果不明を確実に分けずに撤去しない。

## 根拠

- 株式失敗: [38282776608](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/38282776608)。マクロ不一致: [38307976131](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/38307976131)。定時契約: [stock-scheduler.md](../stock-scheduler.md)。母集団更新順序: [daily.ts](../../src/cron/daily.ts)、[universe-overlay.ts](../../src/cron/universe-overlay.ts)。
- VWAP結果不明: [38283511757](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/38283511757)。信用残最新成功: [38421423575](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/38421423575)。需給最新成功: [38385407930](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/38385407930)。
- EDINET保留・IR予算: [38302058892](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/38302058892)。有報抽出: [text-sections.ts](../../services/yuho-quant/src/services/edinet/text-sections.ts)。保存済み実書類`S100Z2Z6`、ZIP96,877 bytesを既存SHA pinと照合し再現した。再現記録は私有`tmp/feature-audit-20261013/text-sections-local-audit.json`に保存し、原文はGitへ追加していない。
- Mac運用契約: [005-biztag-local-runtime.md](../005-biztag-local-runtime.md)。設定は`~/Library/LaunchAgents/com.kabulab-cf.biztag.plist`と`com.kabulab-cf.yutai-summary.plist`。最終成功receiptは10/13 20:01:33・21:00:17 JST、SHA`0cd52ade`。
- 優待の現契約: [summary-tasks.ts](../../services/otakara-yutai/data-scripts/summary-tasks.ts)、[schema.ts](../../services/otakara-yutai/src/db/schema.ts)。資金フロー最新単体失敗: [37251494901](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/37251494901)、[moneyflow取込](../../scripts/moneyflow/ingest.ts)。
- JPX新様式の公式案内: [株式](https://www.jpx.co.jp/markets/statistics-equities/investor-type/00-01.html)、[ETF](https://www.jpx.co.jp/markets/statistics-equities/investor-type/02.html)、[REIT](https://www.jpx.co.jp/markets/statistics-equities/investor-type/03.html)。9月分`stock_1_m202609.xlsx`、`etf_m202609.xlsx`、`reit_m202609.xlsx`の実リンクを確認。今回の調査では新規の実体取得・本番取込は行っていない。
- 原本索引の範囲: [sink.py](../../pipeline/src/jp_stock_pipeline/cloud_store/sink.py)、[financial-raw-page-2026-09-28.md](financial-raw-page-2026-09-28.md)。ROA未取得: [financials.py](../../pipeline/src/jp_stock_pipeline/cloud_store/financials.py)。
- Notionの集計元: [銘柄マスタ](https://app.notion.com/p/e8e70e9f8a284643ad44b8419b9080a5)、[財務](https://app.notion.com/p/e30ed07f6f4d4916967d90d11b9dff39)、[原本](https://app.notion.com/p/57cedf7b733a4db3970a015bf655c934)、[補足](https://app.notion.com/p/3e6d74ff84cd8119a15ec61865c436a1)、[保有明細](https://app.notion.com/p/5ad4d311b06f42b4b78ab3801cd509e2)、[空売り月次指標](https://app.notion.com/p/3e9d74ff84cd81ac87d9d1e3fabf1b5b)。旧カタログ更新停止の実装: [schema.py](../../pipeline/src/jp_stock_pipeline/notion/schema.py)。
- 監視失敗: [38315221721](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/38315221721)。[datasets.py](../../pipeline/src/jp_stock_pipeline/cloud_store/datasets.py)、[slo.py](../../pipeline/src/jp_stock_pipeline/cloud_store/slo.py)。

D1集計・HTTP結果・再現JSONはGit対象外の`tmp/feature-audit-20261013/`に保持する。集計は各取得時点の状態であり、全原本の物理読戻し、全画面操作、保有明細の空欄全行の原因確定は今回の確認範囲ではない。
