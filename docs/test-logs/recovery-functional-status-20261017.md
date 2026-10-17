# 全20機能の復旧状況 — 10月17日16:00 JST／17:29追記

追跡: [#348](https://github.com/satoki252595/kabulab_tool_cloudflare/issues/348)。[当初の機能別監査](feature-gap-audit-20261014.md)と[受入台帳](recovery-acceptance-20261016.md)の保存証拠を集約した時点記録。全サービスを16時に一括再照会した結果ではない。全20機能の完了には未到達で、原典にない値を埋めない。

## 機能別の受入と残件

| # | 機能 | 確認済みの範囲 | 残件・次の処理 |
|---|---|---|---|
| 1 | 銘柄マスタ・上場状態 | 公式overlayの233イベント、廃止3件・市場変更1件、同値再適用を確認 | 最新の通常定時receiptを別確認 |
| 2 | 株価・財務断面 | 10/16は3,687銘柄中3,645銘柄が完全、42銘柄は未完・部分結果 | 原本OHLCV等が全NULLの41社を公式市場資料と照合。別日の値で補わない |
| 3 | RSI・スイング・モメンタム | 共通の株価系列・資格診断へ接続 | 最新通常系列の全量receipt、8303等の源欠測、旧245保留、権利basisを照合 |
| 4 | マクロ判定 | 日米市場カレンダーと保存原本の資格処理を修正 | 日米それぞれの最新確定sessionと翌朝の結合receiptを全体で受入 |
| 5 | 財務サマリ | ROE102、直接ROA6と実表3社等の限定回収 | 非開示・未対応・期間/連結差を区別。全NULL項目の一律補完はしない |
| 6 | EDINET継続取得・識別 | 保存本文3,666社。保存原本の主体・期末・DEI照合を共通化 | 最新catchupの識別保留・対象HOLD21と、後続取込失敗を別照合 |
| 7 | 有報39項目 | 固定3,666社の本文39項目を回収。原要素自体の不在23件を区別 | 本文補足DBの同期は下記14の有限処理で継続 |
| 8 | 受注・海外売上 | 受注40文書236数値、海外100文書601数値を全6表・原本・両物理ファイルで受入 | 受注72文書243数値、海外66文書392数値。競合する本文writerの閉鎖後に通常CLIで進める |
| 9 | TDnet・IR PDF | 381原本の物理保管等を受入 | 旧1447 PDFなど失われた原本は未取得を保持。公式代替原本と元pointerを同一視しない。最新EDINET後続失敗も残る |
| 10 | VWAP日足 | 旧10/14の原本4件を限定復旧 | 残3原本HOLDと最新通常日足の全量完了を別確認 |
| 11 | VWAP 5分足 | 固定suffix1,856中1,399銘柄をR2全bytes・ETag・実SDK metadata・物理summaryまで受入 | 残457＝7531原本HOLD＋未受入456。新有限処理は18:18:51 JSTまで、旧期限は延長しない |
| 12 | 信用残・日証金需給 | 保存済み4,247/4,349行と通常取得を確認 | 最新10/16 runの基準日・全件数、旧20銘柄の掲載対象外を照合 |
| 13 | 株主優待・要約 | 7,716行のDTO、選択15群19行の限定採用。通常取込/定期要約は同じcompiler | 保有期間4行は監視器の照合不備でREAD1後に停止、データ更新0。旧claimを保持した明示継続を修正中。tier・併用・公式資格と次21時receiptは未完 |
| 14 | 事業タグ・Mac定時 | 今回の本文固定2,417社中950社を通常機械処理・全39列・物理PRE/POST・永続completionまで受入 | 残1,467社。ローカルClef保存結果104社は生成受入済み・公開0。現在入力の資格確認後に保存結果を再利用 |
| 15 | 競合企業 | 固定83対象の81社574関係を限定受入。新5社の機械準備は物理保管まで実行 | 新5社は候補Bの資格不足でready0。残33社の準備と意味判定、次定時stageは未受入 |
| 16 | 資金フロー | 株価非依存28取得元の10/16結果等を確認 | 株価依存sector-turnoverと最新全量receipt。欠測銘柄を黙って除外しない |
| 17 | RAW原本・API索引 | 受入18,412/78,832。復旧対象1件を通常rawCAS→索引INSERT→cursor18,878まで進めた | cursorとの差466件は全体照合へ未加算。次は現在/直前checkpointの通常inspect、続いて元run pool内の通常bulk。元送信ACKは未知のまま保存 |
| 18 | 有価証券保有明細 | 原本列1,667行115文書を全値・全原表・物理PRE/POSTで受入。1911のunknown行は通常の保全置換で閉鎖 | 次の固定範囲を通常publisherで継続。新規価格資格0、単位HOLD5,362行。分割前期末株数の明示根拠8社と、候補28行を価格確定へ読み替えない |
| 19 | API・MCP | JSS private strict v1/v2/v3を配備、実コード・6bindings・health200・未認証401を確認 | 既存キーはCloudflareのみ。実認証付きv2/v3 payloadの通し受入は未完。鍵の取得・新規発行・変更はしていない |
| 20 | 監視・Notion案内 | coverage/receipt監視、現行カタログ89blocks/5views等を反映 | 最新正常定時の終了receipt、Mac配備版と次20/21時、翌朝readcheckを別確認。配備成功だけで全機能完了にしない |

## 17:29 JSTの追加受入

上表は16時の記録として保持する。以下はその後に通常処理の保存応答を独立再生し、書込み後まで照合した追加分。全20機能の一括最新照会や全量完了を意味しない。

| 項目 | 累計受入 | 稼働中・残件 |
|---|---:|---|
| 本文補足の機械処理 | 1,300/2,417社 | 後続バッチを継続。モデル起動0 |
| 保有明細 | 2,288行・160文書 | 後続範囲を継続。新規価格資格0 |
| VWAP 5分足 | 1,578/1,856銘柄 | 未着手276の新しい有限処理を開始。7531・9311は取得時の有効バー全欠測としてHOLD |
| 受注 | 60文書・298数値 | 残52文書・181数値の通常prepare/apply/inspectを実行中。追加20文書のwriter照合だけでは加算しない |
| 海外売上 | 100文書・601数値 | 残66文書・392数値の通常処理を実行中 |
| 優待条件 | 選択19行＋保有期間4行 | 47行の全scopeを照合し、4行以外の43行と金額・日付を保全。tier・併用・次21時は未受入 |
| 事業タグ | 保存済みClef判定104社、公開0 | 新しいMac候補で通常consumerの106応答・580設問を通信0で再生。現在入力の資格確認と公開反映は別に必要 |
| RAW | 18,412/78,832件 | 通常bulkを本番Actionsで実行中。cursor18,878との差466件は未加算 |

VWAPの前操作ではsource429で止まった9250を新操作の一度だけの取得で回収し、R2全POSTまで受入した。9311はsource200でも127時点中126がNULL、1が出来高0のため、共通パーサーが書込み前に拒否した。欠測を別値で埋めず、旧R2全body・ETagの不変を新しい読取で確認した。残276用の監視器は「HOLDには通常GET応答が存在しない」分岐を修正し、実保存50銘柄のPOST（価格49＋HOLD1）で旧不具合と修正後・負例を再生した。通常取得器の欠測拒否は維持する。

206A/S100XCINは通常の主体・期末照合で「全節該当事項なし」を確認し、診断3項目のPATCH200後、読取3要求で対象全propertiesと期末明細0を照合した。監視器の関数参照不備で停止した元操作とpendingを残し、更新は再送していない。診断の受入を明細生成や価格反映の成功へ読み替えない。

受注と本文補足の共有44文書は原本・本文をともに読むだけで、更新列も別であることを6074個の保存pinから確認した。受注52と海外66は会社ID・文書ID等の積集合0。両者は同じ会社ならgrowth再計算・全6表CASが競合するため、今回は会社範囲が分離していることを実行条件にした。Notion枠は本文1.35＋保有0.75＋受注0.25＋海外0.25＋RAW0.25＋VWAP0.04＝2.89 req/s。優待4行は終了しており、その枠を海外へ移した。

海外の次操作の既消費は4,003要求。旧3,785という記述では第4段階のPRE218要求が抜けていたため、保存応答から2,524 Notion＋1,302 D1読取＋80 D1 batch＋97 hostedへ訂正し、新操作の費用境界へ全量を引き継いだ。旧証跡・期限は変更していない。

Paid D1は月250億行読取を含むため、1.3億行はその0.52%。仮に全量が含有量を超えた追加読取でも単価から$0.13であり、書込・保存・同月の他用途は別である。[D1公式料金](https://developers.cloudflare.com/d1/platform/pricing/)を再確認した。RAWのリポジトリはpublic、runnerは標準`ubuntu-latest`なので実行分数は無料対象だが、artifact/cache・Cloudflareの保存等まで無料とは断定しない。[GitHub公式課金範囲](https://docs.github.com/en/billing/concepts/product-billing/github-actions)と[R2公式料金](https://developers.cloudflare.com/r2/pricing/)を参照。新規有料モデル・取得元・依存追加0。

Workerは[#487](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/487)の通常優待継続修正を16:12:52、[#488](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/488)の運用記録を16:46:13 JSTに配信済み。後者のversionは`3c9bd5be-fc4c-44c9-8753-b783dadb361d`、startup40ms。Mac候補`7d1ca586f1f3c5b9df42a0ff42df49d12121ceff`は全tracked source・lock・通常preflightを通信0で照合した段階で、launchctl・既存plists・監視secretは未変更。稼働中の旧sourceを置換せず、各有限actorが閉じてから通常installerで切り替え、実20/21時のreceiptを別に確認する。

追加の私有最終証跡（同じ`tmp/feature-audit-20261017/`基準）:

- 本文1,300: `G1548-mechanical-v3/batch-09/root-final-acceptance-v1.json` — `17243403a7a5d2683884188aa4417e8a416e4de2a03aade5f5fb5ea56c7af182`。
- 保有2,288: `holdings-next12-rate050-proposal-v1/actual-next12-v2/range-15/root-final-acceptance-v1.json` — `c870010c2f885666a3a271f64fe691d670ed33ecc7d111479697d3d3f8e26cb3`。
- VWAP1,578: `vwap326-partial01-saved-audit-v1/root-final-partial49-acceptance-v1.json` — `886862ea085ca19b8404dd6b756bed2f674fc2b2749d0fc5a72400e9219b91d6`。
- 優待4行: `yutai-holding4-normal-readonly-resume-v1/root-final-acceptance-v1.json` — `897a66889a86d88d6df1ebb5e706e51f2654f04c628453239bd2ee6fe5bbae83`。
- 206A診断: `holdings-206A-after-ACK13-readonly-v1/root-final-diagnostic-acceptance-v1.json` — `e3f3997129b7803e1e4a9bdd87b0b04188be9a54556a10ce3c82204cb3372d53`。
- 海外の全既消費・範囲: `overseas-remaining66-normal-operation-v1/scope-and-cost-v1.json` — `f3e6ef29f6df2ab640ebcc8046c0d22b030d86b49102226b19372a2817190e38`。
- 公式料金と実runner: `continuation/cost-official-scope-20261017-v1.json` — `1409dd858f48620eba381be33b31fcfd2e32322f2a515aaf48490c14d271accd`。

## 16:00時点の共通実行方針と費用境界

取得・抽出・計算・保存・検証は本番と同じ通常CLI/共有関数を使い、ローカルは同じ依存lockをNixで実行する。意味判断が必要な事業タグだけローカルのCloudflare/clef-flashへ限定する。今回の追加補完・独立再生でモデルを起動していない。新規有料サービス・依存・取得元の追加はない。

現ローカル有限処理のNotion予約は本文1.35＋保有0.75＋受注0.25＋RAW0.25＋優待用0.25＋VWAP0.04＝2.89 req/s。これは本番定時を含む合算保証ではない。土曜の18/19時Worker処理は曜日指定の対象外だが、Macの20/21時は毎日動く。保有CLIはMacのkernel writer lockを取得しないため、通常定時を優先し、補完のネットワーク処理が閉じた保存監査の境界で切り替える方針を検査している。calendar・実行中source・.env・旧期限は変更していない。

保有の新2範囲は合計790 native要求で59行13文書を受入。本文の31社/次50社は実590.678秒/794.410秒で、outer保管込みNotion652/925要求。これを全量時間や将来の完走保証へ拡張しない。RAWの単件復旧は24要求、通常索引登録は12要求で、原manifest取得費用も保持する。HTTPヘッダ・SDKエラーbody等の未計測分は全通信量へ算入できない。[Paid料金の確認と読取見積り](../deterministic-production.md)とは別に、各操作の既消費・HTTP/byte/time capを引き継ぐ。

## 16:00時点の配備・証拠

Cloudflare main `14ce552846fca288d4f4890a84f1f4afbaad48e9`は15:34:18 JST、version `755184da-8d06-4a8b-b062-7fafb04436fd`へ配信済み（[#486](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/486)、3 CI成功、startup35ms）。Macの稼働中e4c、保有b8、受注f7等は凍結し、Worker配備をMacの切替えや定時完了とは数えない。

私有証跡のfull SHAは各JSONへ保持し、原文・署名URL・秘密値はGitへ含めない。以下はGit対象外の`tmp/feature-audit-20261017/`からの相対パス。主要root最終証跡:

- 本文950: `G1548-mechanical-v3/batch-02/root-final-acceptance-v1.json` — `ba324f5d13c4bd5f0898002b06c0d2c623541d187c0cc8d4cc831dbad8dc310e`。
- 保有1,667行: `holdings-next12-rate050-proposal-v1/actual-next12-v2/range-10/root-final-acceptance-v1.json` — `ca55a737cb0587eab4142d50954640a679fc7641c1223ee90e70d4adc9f88826`。
- 受注40文書: `orders-remaining92-normal-plan-v2/stage-01/root-final-acceptance-v1.json` — `06322eecebf3058a904d978153d337a1d3daf2d88a46ee78f06256a7b8986f70`。
- VWAP1,399: `vwap-intra-remaining506-operation-v1/batch-01/root-final-acceptance-v1.json` — `752cfce4711648dcee31a13252b40dae3a163c74f401de2b7aff2af386cbbccb`。
- RAW単件索引登録: [run39011454325](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/39011454325)、`raw-child57-normal-apply1-v1/root-final-acceptance-v1.json` — `e3f8672d1b4243b837add4a8cdf3e134dc54d19b69417c0d3be8ae01b4c97ed3`。通常actorの全SHA/15列検証と全job logを受入した範囲であり、遠隔payloadの独立再取得や全量anti-joinは未受入。

優待の最初の通信0停止に続き、修正後の有限監視器が共有パーサーを使わずscopeを再構成したため、JSONのkey順だけでgzip SHAが変わり、保管Key照会を送信前に拒否した。保存search200→同じ通常recordPrimaryDataの純再生で元AssertionError SHAまで一致した。元claim・新sidecar・全STOP・6準備ファイルを保持し、一般のunknown再送へ広げず、READだけの停止を明示資格化する。調査結果SHA `63657808a2c6a10711c18e5680ad2c8c23cb9df155c4f8bb3401b5a79e48a88e`。この修正の予定を4行の実データ完了とは数えない。
