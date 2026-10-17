# 全20機能の復旧状況 — 10月17日16:00 JST

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

## 共通の実行方針と費用境界

取得・抽出・計算・保存・検証は本番と同じ通常CLI/共有関数を使い、ローカルは同じ依存lockをNixで実行する。意味判断が必要な事業タグだけローカルのCloudflare/clef-flashへ限定する。今回の追加補完・独立再生でモデルを起動していない。新規有料サービス・依存・取得元の追加はない。

現ローカル有限処理のNotion予約は本文1.35＋保有0.75＋受注0.25＋RAW0.25＋優待用0.25＋VWAP0.04＝2.89 req/s。これは本番定時を含む合算保証ではない。土曜の18/19時Worker処理は曜日指定の対象外だが、Macの20/21時は毎日動く。保有CLIはMacのkernel writer lockを取得しないため、通常定時を優先し、補完のネットワーク処理が閉じた保存監査の境界で切り替える方針を検査している。calendar・実行中source・.env・旧期限は変更していない。

保有の新2範囲は合計790 native要求で59行13文書を受入。本文の31社/次50社は実590.678秒/794.410秒で、outer保管込みNotion652/925要求。これを全量時間や将来の完走保証へ拡張しない。RAWの単件復旧は24要求、通常索引登録は12要求で、原manifest取得費用も保持する。HTTPヘッダ・SDKエラーbody等の未計測分は全通信量へ算入できない。[Paid料金の確認と読取見積り](../deterministic-production.md)とは別に、各操作の既消費・HTTP/byte/time capを引き継ぐ。

## 配備・証拠

Cloudflare main `14ce552846fca288d4f4890a84f1f4afbaad48e9`は15:34:18 JST、version `755184da-8d06-4a8b-b062-7fafb04436fd`へ配信済み（[#486](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/486)、3 CI成功、startup35ms）。Macの稼働中e4c、保有b8、受注f7等は凍結し、Worker配備をMacの切替えや定時完了とは数えない。

私有証跡のfull SHAは各JSONへ保持し、原文・署名URL・秘密値はGitへ含めない。以下はGit対象外の`tmp/feature-audit-20261017/`からの相対パス。主要root最終証跡:

- 本文950: `G1548-mechanical-v3/batch-02/root-final-acceptance-v1.json` — `ba324f5d13c4bd5f0898002b06c0d2c623541d187c0cc8d4cc831dbad8dc310e`。
- 保有1,667行: `holdings-next12-rate050-proposal-v1/actual-next12-v2/range-10/root-final-acceptance-v1.json` — `ca55a737cb0587eab4142d50954640a679fc7641c1223ee90e70d4adc9f88826`。
- 受注40文書: `orders-remaining92-normal-plan-v2/stage-01/root-final-acceptance-v1.json` — `06322eecebf3058a904d978153d337a1d3daf2d88a46ee78f06256a7b8986f70`。
- VWAP1,399: `vwap-intra-remaining506-operation-v1/batch-01/root-final-acceptance-v1.json` — `752cfce4711648dcee31a13252b40dae3a163c74f401de2b7aff2af386cbbccb`。
- RAW単件索引登録: [run39011454325](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/39011454325)、`raw-child57-normal-apply1-v1/root-final-acceptance-v1.json` — `e3f8672d1b4243b837add4a8cdf3e134dc54d19b69417c0d3be8ae01b4c97ed3`。通常actorの全SHA/15列検証と全job logを受入した範囲であり、遠隔payloadの独立再取得や全量anti-joinは未受入。

優待の最初の通信0停止に続き、修正後の有限監視器が共有パーサーを使わずscopeを再構成したため、JSONのkey順だけでgzip SHAが変わり、保管Key照会を送信前に拒否した。保存search200→同じ通常recordPrimaryDataの純再生で元AssertionError SHAまで一致した。元claim・新sidecar・全STOP・6準備ファイルを保持し、一般のunknown再送へ広げず、READだけの停止を明示資格化する。調査結果SHA `63657808a2c6a10711c18e5680ad2c8c23cb9df155c4f8bb3401b5a79e48a88e`。この修正の予定を4行の実データ完了とは数えない。
