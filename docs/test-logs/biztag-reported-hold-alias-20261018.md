# 最新書類HOLD計算列の応答サイズ（2026-10-18）

`reportedLatestSelectionHold`をSELECTするときにSQLの列別名が無く、SQLiteは式の全文を結果列名に使っていた。D1 HTTPが各行をobjectで返すため、同じ長いキーが書類ごとに繰り返される。Drizzleの選択キー`reportedHold`だけではSQLの別名にならない。

同helperを選択する全3か所に`.as("reported_hold")`を付ける。通常`loadLatestDocs`、書込前の単社`assertLatestDocCurrent`、保有明細backfillの`selectLatestHoldingsDocuments`が対象。値・列順・params・WHERE・最新選択・reported HOLDの条件を保持し、Drizzleから返す型とプロパティ名も変えない。helper自体はWHEREで組み立てる式を返すため変更しない。

## 保存原本の比較

既受入G50の3,687core・36,929documentsと、別受入の6報告観測をSQLiteへ入れ、凍結main9d5の通常helperと新helperを同じ入力で比較した。全量3,687社と指定50社の結果は全値・配列順が一致。36,929行の列順・値SHAも一致し、生成SQLの差は列別名だけでparamsは同一だった。指定50社の書込前照合も旧新各50SELECTの全値・paramsを比較した。

| 対象 | 別名前 | 別名後 |
|---|---:|---:|
| 36,929書類のdecoded結果JSON | 53,526,797 B | 8,325,701 B |
| 結果列名配列のJSON | 1,351 B | 127 B |
| 指定50社・516書類のdecoded結果JSON | 748,072 B | 116,488 B |

全量の差45,201,096 Bは、列名の差1,224 B×36,929行と一致する。core応答308,589 Bは同じ。ここで測ったのは保存値による結果objectのJSONで、実D1 wire・圧縮量・課金rows_read・duration・RSS・今後の完走速度は未測定。外部HTTP、モデル、業務書込、新依存は0。

私有再生: `tmp/feature-audit-20261018/biztag-reported-hold-alias-proof-v1/paired-v2.mts`、結果`result-v2.json` SHA `4edaca3bc6e9603da82e38a3261ef053af3822b4904f53c53f8b2e3b3f2ccd1a`。元4入力のSHAと旧新SQL・列名・値SHAを保存し、入力bytesの不変を検査した。初版1別名の結果も上書きせず保持する。

## 回帰と残範囲

実保存101社・960書類の既存fixtureで全量と書込前照合の短い列名を検査し、既存保有selector回帰でも結果列名を検査する。通常選択、active普通株、取下げから旧親へ戻らないHOLD、書込前変更拒否、保有cursor/必須索引を含むNix 5 suites・106 tests、full TypeScript、owned4 TS lintを確認した。

全caller検索で、別helperの未alias SELECTはtextの1列、受注/海外の各3列、共有financial guardの単社2列にも存在する。今回の実全量膨張を生んだhelper3 SELECTとは分けて記録し、それらやWHERE式へ変更を広げていない。原READ停止・凍結9d5 runtime/env・本文659社の状態は保持する。配備後の新runtime切替、実metadata READ/本文補完は別受入。
