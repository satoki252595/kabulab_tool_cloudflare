# 保有株価格の英字商号照合: ASCII句読点の同義表記

2026-10-14。日本語の原表名からFSA上場提出者を一意に特定し、同じ証券コードの日足原本を照合した後でも、英字商号の `.` / `,` の有無・位置だけで停止していた。共通 `qualifyHoldingValuation` の既存英字名正規化にASCIIの2文字の除去だけを加えた。原本・FSA値自体は変更しない。

日本語商号、名前からコードの選定、通貨、期末日、分割・価格単位、全原本SHAの条件は変更しない。綴り、語句、略称、法人格の展開、ハイフンは同義化しない。`Yokohama Maruuo Co., Ltd` / `Yokohama Maruuo Co., Ltd.` などは通過し、`Finacial` / `Financial`、`Co.` / `Company`、`TWIN-BIRD` / `Twinbird` は停止を維持する。

## 同じ保存原本2,850社の差分

固定plan SHA `f2ab8e79377a02594a6c43b42c7a54ad4645b2d3f8610ede3a662f893d84c177` の修正前後を再解析した。7実装pinのうち変更はvaluation本体だけで、実行スクリプト、全source plan/item/projection、ZIP、FSAコードリスト、価格116gzipの束縛は同一。全ZIPのSHA・DEI・期、全価格gzipのSHA・member body/要求を既存共有関数で再検証した。追加通信・モデル・本番書込は0。

| 判定 | 修正前 | 修正後 |
|---|---:|---:|
| source適格文書 / 保留文書 | 1,332 / 1,518 | 1,332 / 1,518 |
| 原表明細 | 15,711 | 15,711 |
| 価格適格 | 8,123 | 8,384 |
| 英字商号停止 | 535 | 194 |

英語名の条件を新たに通過したのは **341明細 / 78銘柄だけ**。そのうち価格適格261、期末当日バー欠測56、期末からcaptureまでの株数・価格単位未確認24である。残り15,370明細の判定・事実・原本参照は同一。停止194明細は別句読点13（2銘柄）と語句等181（27銘柄）で、すべて停止を維持した。停止時の正規化後Assertion診断文字列のSHAは比較対象から分離した。

価格範囲はsnapshot `37202207552.1` の保存116ファイル / 3,456銘柄、元の2026-10-02観測である。全保存観測の欠測や2026-10-13時点の鮮度を証明するものではない。この再解析はfresh Notion照合と本番反映を行わず、`publicationReady=false` / 明示停止ありの未完了状態を保持した。修正後の純ローカル解析は76.68秒、peak RSS 473,726,976 bytes。

私有証跡は `tmp/feature-audit-20261013/holdings-latest-all/` 配下に保全:

- `price-fixed-cohort2850-v1/all.rows.json`: SHA `1e53bb13453a7a6e25da244826e17d4b2565afc3cdcf76ca780b97ac3806b693`
- `price-fixed-cohort2850-ascii-punctuation-v1/all.rows.json`: SHA `270f12241c1dc55a931448141f7cf7cbc2446141d33dc85afb6c3c62364c2c0f`
- `price-fixed-cohort2850-ascii-punctuation-v1/comparison.json`: SHA `5db68d962398a90dae29bb414070709325f4e299c4e909ebf0e198ca2c5a2ac2`

## 検証

NixのNode / pnpmで関連3 suite 73 tests、全repo `tsc --noEmit`、owned2ファイルのESLint、diff checkが通過。実FSA ZIPの商号と保存Yahooの商号を使う3許容・4拒否回帰を追加した（テストの価格系列は既存の構造検証用chart）。上記の全保存原本再解析が実bodyによる回帰を兼ねる。別agentによる2ファイルのsource-onlyレビューも追加指摘なし。
