# 23:13以降の追加受入 — 優待・JPX・EDINET・RAW

追跡: [#348](https://github.com/satoki252595/kabulab_tool_cloudflare/issues/348)。[21:52時点の記録](recovery-functional-status-20261017.md#2152-jstの追加受入と実行先の区別)を保持し、後続の通常操作とroot保存監査の受入を別記する。Macは23:21 JSTに通常`install-next`でquiet切替を終了し、次の10/18定刻実行と分けて受け入れた。

21:52以前の記録は履歴として保持する。以下は保存済みroot受入証跡による追加記録で、全サービスを同時再照会した結果ではない。全20機能の完了日時は未確定。

| 項目 | 追加の受入 | 残件・境界 |
|---|---|---|
| 優待1899 | 通常CLIで実1行をv1からv4へ移行。全旧値・金額・理由・取得時計を保持し、全列CAS・両物理PRE/POST・canonical once・保存native再生を58.903秒で終了。16要求＝Notion12・hosted2・D1 SELECT1・batch1 | 評価額NULL・本人適用未確認を維持。一般tier/併用の資格や、実認証v4 payloadの網羅確認ではない |
| JPX短期掲載原本 | 通常collectorを単発実行し、公式index1＋XLS5の原HTTPを7ファイルとして共通Notion保管・全bytes照合。33要求＝JPX6・Notion20・hosted7、原900秒内113.774秒で閉鎖。旧研究index/XLSと同一原本も物理保管を確認 | 掲載literalの保持であり、普通株・法的日付・市場落日・比率・価格/株数補正は未資格。起動前の失敗と元時計を保持 |
| JPX定期設定 | 公開GitHub変数`JPX_EX_RIGHTS_URL`を1回設定しexact読戻しを確認。次営業日10/19（月）18時JSTに金融主要write後に保管する経路へ設定 | 10/19（月）18時JSTの実終了receiptは未受入。canonical/Mac環境・秘密・Cloudflare bindingは変更していない |
| EDINET訂正・取下げ | #506をmain `4ceab32a`へ統合し、PR/mainの3CIと実Cloudflare配信をroot受入。原一覧のexact docIDと明示状態/親関係を保存し、対象金融consumerを共通guardへ接続 | 親doc・株番・FYの推測、過去34一覧の偽時計import、金融値の自動訂正は行わない。新しい実HTTPの保持とimmutable観測を後述の単発で別受入。金融取込全体の完了ではない |
| EDINET保存schema | 10列・複合PK・2索引を3CREATEで追加。旧catalog全同値・新表空・両物理PRE/POST・全24nativeを確認し、元900秒内93.93秒で独立閉鎖 | producerはTLA循環でexit13/SUCCESSなし。別CLIの保存監査で受入し、DDL再送0・旧失敗/claimは保持 |
| 訂正guardの実測 | 固定4通常関数の旧新出力を同一条件で比較。最終v3は13 SELECTを3.020秒で閉鎖し、比較対象の読取47,498→47,516行（+18行、+0.037896%）、D1実duration合計23.0237→26.17ms（+3.1463ms） | 旧v1/v2の負荷超過は不採用・証跡保持。空の観測表で各関数1回、限定引数の測定であり、将来規模・全引数・月額請求の保証ではない |
| EDINET実原HTTPの単発 | 7/23の一覧を10/17 23:13:05.752 JSTの実取得時計で1回受信。HTTP200、294,612B、通常parse資格true。gzip原本を共通Notionへ物理保管し、取下げ明示1件・未資格の訂正関係5件の計6観測を通常writerで保存、全10列とSQL/paramsを独立再生。13要求＝source1・Notion8・hosted1・D1 SELECT2・INSERT1、全親子/監査を原900秒内12.458秒で終了 | 金融値・DDL・モデル0。親doc・株番・FYを補完せず、過去34一覧の時計/保管を再資格化しない。`@list`金融取込完了0・全20機能完了false |
| RAW72 | 固定execution `4d76e9b1`で500件検証＝484新規・16既完、cursor22,411・残56,421、3,189.478秒。元200回poolのordinal72として通常73へ継続成功 | 全体独立受入18,412/78,832は未変更。索引anti-join、原本/索引の遠隔fullpayload独立再生は未実施。旧unknownを解除しない |
| RAW73 | botの唯一successorと元pool ordinal73・continue127・API.25/hosted1.0の予約を保存metadataで資格化 | actual checkout/input・500件結果は終端まで未受入。監視だけで新dispatch/cancel/retryしない |
| 本文2,417社 | 独立物理受入1,500社と別の通常durable completion258社による暫定union1,758、残659を維持 | 追加258社の独立全physical GET、全3,687社の現在coverageへ拡大しない |
| Macquiet切替 | 23:21:02.763〜23:21:13.364 JST、通常`install-next`で両登録をmain506 `4ceab32a`へ切替。元600秒内10.601秒、2installer・8launchctl・kernel解放確認1の11既知ACK、両plistの全bytes/項目と全親子PID終了を確認。20/21時calendar・args/logs/Umaskを保ち、`RunAtLoad=false`で即時jobを起動しない | 次10/18実20時・21時の全receiptは未受入。GitHub期待版は旧4aのまま、両定刻の受入後に別更新する。旧4a runtime/env・今夜の実20/21時receiptを保持。新HTTP・モデル・業務write・env/secret更新0 |

新しい一覧原本はraw SHA `e210a297b082ac273bd2126c4547e8151558229fca4325b85248782c1a47a358`、gzip SHA `8459d2058a4ff37796e90372a242555fd8faa7c2cf1e22a2c93b97b23f3a3935`。日付7/23は取得対象であり、原取得時計を7/23へ戻していない。source-only処理は通常financial ingestの`@list`完了を記録しない。

本体CloudflareとMacの設定はmain506に揃えたが、quiet切替による即時job/receipt置換は0。既存GitHub期待版secretは旧4aを維持し、10/18の実20時・21時の全receiptと原本/永続journalを受け入れた後、別の単発更新を行う。次calendar成功は今回の設定受入に含めない。

RAWのcursorは全体独立受入件数ではない。4〜5日の既存条件付き目安を今回の速度改善率や全20機能の完了日へ読み替えない。

私有root証跡（Gitに原本文・署名URL・秘密値を保存しない）:

- [1899の1行移行](../../tmp/feature-audit-20261017/yutai1899-normal503-one-row-proposal-v1/root-final-acceptance-v1.json): `2b680413a30a4b92a9c1d752591db64755682f32179ba8ea8934d85f03eb60f7`。
- [JPX全原本・物理照合](../../tmp/feature-audit-20261017/jpx-ex-rights-normal-capture-once-proposal-v2/root-final-acceptance-v1.json): `a9f2828938e9907585d1dc1d59d14687d9623e592ebea807c2d70ce0187dbb9b`。[公開URL設定/readback](../../tmp/feature-audit-20261017/jpx-ex-rights-normal-capture-once-proposal-v2/root-public-var-acceptance-v1.json): `45dc282649928414fd96f8a981e6de9ec202adc57966fbf4c4ddd8775be0a2d5`。
- [#506 main全3CI・実配信](../../tmp/feature-audit-20261017/edinet-lineage-main506-ci-v1/root-product-acceptance-v1.json): `b9951b8984671deeed0923303782c247912d8afa18be44494ed803271dbc2f71`。main `4ceab32a9038cd190e4f4c5e488c4dae4d576c90`、version `15d123ab-2bae-4e2d-b057-1a19235cfd25`。
- [0032 schemaの独立閉鎖](../../tmp/feature-audit-20261017/edinet-reported-lineage-schema-once-v1/root-final-acceptance-v1.json): `9305a12b3f631dfd03080e5bce3757555e80ffae6be09c1e265eba85850faef4`。[v3実性能の限定受入](../../tmp/feature-audit-20261017/edinet-lineage-market-readonly-probe-v3/root-performance-decision-v1.json): `1a25cecfa2008727eb6fd874f835de4bfb49c359ec20256569c6fe5aaa2f5acc`。
- [新一覧source-onlyの通常経路・全物理/immutable照合](../../tmp/feature-audit-20261017/edinet-reported-list-once-v1/root-final-acceptance-v1.json): `4fcbbdce5d84522e320d8b351cb65bfa54f9bc4d5beb29da8682768d413ccb77`。
- [RAW72の限定受入](../../tmp/feature-audit-20261017/raw-main4d76-continuation72-watch-v1/root-independent-run72-acceptance-v1.json): `5218847c140e7f2d5c8390c00f6ab3e012a97eff472cb97894bfd15790b0b90a`。[RAW73予約](../../tmp/feature-audit-20261017/raw-main4d76-continuation73-watch-v1/child73-reservation-qualification-v1.json): `0f33aa701dfa550729140937327d0759fbc467bdfe6d1547cac5d24a2da5e8a2`。
- [Macの両quiet登録・全ACK/PID/設定・kernel閉鎖](../../tmp/feature-audit-20261017/mac-main4ceab32a-quiet-cutover-proposal-v1/root-final-acceptance-v1.json): `9239a7ce1f6e87c6262ef5b3cb341504388a5d6c1bdda227060c6eefa85c4954`。次10/18実calendar・期待版secret更新は未受入。
