# ROA実表を通常財務取込へ接続

純利益ROAが実表に直接開示されている3社を、既存 `normalize.tidy_to_financial_record` → Notion③ / D1 `jss_financials` の通常経路へ接続する。総資産経常利益率・営業ROAや利益/総資産の計算値は採らない。

| 銘柄 / EDINET文書 | 2026-03-31当期の直接値 | 原表の資格 |
| --- | ---: | --- |
| 6963 / S100YF41 | -11.6% | MDAの5年推移表。2026年3月列、連結財務諸表、親会社株主純利益/総資産の定義を照合。△は負号として正規化する |
| 8014 / S100YBIN | 8.0% | MDAの前連結/当連結/増減表。当連結会計年度列、親会社株主純利益÷期中平均総資産の定義を照合 |
| 8593 / S100YF4V | 1.3% | 2026年3月期の全社業績・賞与KPI表の実績列。同じ年度実績を明示参照する経営方針ROA行と直下注の親会社株主純利益定義を束縛。3年株式報酬表、目標列、目標と差分による算出は採らない |

同一年度/実績の意味は保存一次原典の表・見出し・定義から確認した。8593は独立した別agentの原表読解とも一致する。平均総資産使用が明示されない会社へ、その定義を追加しない。実値・期・連結・全社・純利益定義のいずれかが欠ける、複数値が衝突する、未知の行結合/入れ子表である場合は欠測のままにする。

独立コードレビューで、複数の適格表が衝突した時のNoneを表の不在と混同し、本文の片方の値で成功してしまう境界を検出した。表衝突だけを専用例外で区別し、呼出側は本文を読む前にROAをHOLDする。保存8014の明示改変試験（適格表8.0と9.0＋通常なら適格な本文8.0）で、本文へ救済せず欠測となることをCIで固定した。元の3原典の値・他財務fieldは不変。

定義・連結注記も、表直後の注記段落だけに限定した。次のtable、見出し、非注記本文、未知の外側text/tailを越えて別表の定義を借りない。要素と祖先のtext/tailを文書順に検査し、空p・comment・tableを囲むwrapperのtailも省略しない。実8014 DOMの定義直前へ同原典の別table/実見出しを挿入し、見出しを空span・空p・comment・祖先wrapperの外側tailへ移す拒否試験も追加した。実6963/8014/8593の直属注記は全て保持し、原文fixture自体は変更していない。

3社のtype5 CSVは表のタグ・セル境界・改行を失っており、平坦化された連続数字から列を推定復元できない。`direct_roa_table.py` は保存type1の実HTML表だけを読む。既存lxml/pandas/標準ライブラリを使い、新しい依存・AI・計算補完は追加しない。

定期 `edinet_daily` は取得済みCSVを⑤へ物理保管した後、native FY/期末/連結と限定した定義・見出しが揃い、CSVではROAが直接読めない候補だけtype1を調べる。⑤の同docID取得URL → 既存yuho一次DBの `docID:type1` → 旧 `docID` の一意保存順で確認する。検索失敗・複数行・来歴不一致はHOLDし、公式再取得へ切り替えない。全検索が明示0件の場合だけ、既存EDINET clientの同文書type1取得を1単位呼ぶ（通常HTTP1要求、429/5xx/接続失敗時の既存再試行は最大3要求、別形式への代替はなし）。新規DB・別table・全銘柄type1取得はない。旧manifest不在は新しい計測と区別し、元の取得時計を保持する。

保存type1は5MiBのstream上限、全SHA/サイズ・docID・提出主体・証券コード・期末を照合する。年次CSVとtype1をそれぞれ同じ正規化処理へ渡し、ROA以外の全 `FinancialSummaryRecord` fieldが同値の時だけ、全type1を単一原本として採用する。相違があれば列名を理由にHOLD。変換や資格確認に失敗しても取得済み原本は⑤へ保全し、構造化writeへ進めない。元CSVの任意kabuMCPキャッシュ連携も維持する。Notion/D1の取得時計は採用原本の時計を使う。

実原典3通の全type5/type1比較で変化は `roa_pct` のみ（None → -11.6 / 8.0 / 1.3）、他全財務fieldは完全同値。保存ZIPを使う比較は0.737秒、上流取得/モデル/本番書込0。根拠はprivate `direct-roa-table-actual-financial-parity-v2.json` に保存した。

latest3666資格済み保存ZIPを全SHA確認して候補予算を点検した。407,341,177B、73.704秒、最大RSS193,675,264Bで、限定定義を満たす候補は上記3通だけ。全type1は既存保存済みなので今回の追加上流GETは0。type1合計5,218,763Bの共有保存読取と通常⑤保管の範囲で回復できる。将来の通常runでも、非候補の追加GET/保存は0、該当候補の未保存時だけ既存clientの同文書type1取得1単位となる。5MiB超は原本保全してHOLDし、財務解析を続けない。private receipt `direct-roa-table-candidate-budget-v1.json` に全体manifest SHAと候補SHAを保持した。

CIでは公開可能なEDINETの必要TextBlock/native DEI/当期連結fact/contextを機械切出しした3fixtureを必須として、normalizer → 既存Notion/D1 DTOまでのpositive3と年度・連結・定義・営業ROA・目標/報酬区分の拒否を毎回実行する。全ZIPではないこと、元ZIP/member/切出し/fact/contextのSHAと出典を `pipeline/tests/fixtures/direct-roa-table/provenance.json` に明示した。全原ZIPはprivate/Notionで保管し、JPX/JSF/personal-only原本はGitへ追加しない。全原本を使う3社のproducer同値/保存再利用/同文書限定取得・HOLD試験はローカル保存時だけ実行し、CI不在時は明示skipする。

境界修正後の関連Python検証は405pass・既存EDINET/TDnet fixture不在7skip（実表の必須positive3を含む表29件は全pass）、owned Ruffとdiff checkが成功。本番3行の更新はこの通常producer修正のCI/main受入後、別の固定PRE/CAS/単発送信/全文readback計画でrootが管理する。この変更段階の本番write・新source GET・モデル実行は0。

境界v3の実行範囲は以下の13 filesで、v2の413pass/2skipからsuite範囲を変えた結果であり、同一suiteの増減や原本失効ではない。7skipは既存 `edinet/xbrl_sample.meta.json` の2件、`edinet/csv_sample.meta.json` の1件、`tdnet/tanshin_xbrl_2751_20260610.zip` の4件がローカルに存在しないため。今回の3社実fixtureと全原ZIPによるproducer検証はskipしていない。

```sh
nix develop -c uv run --project pipeline --frozen --offline pytest -o addopts=-rs -q pipeline/tests/test_direct_roa_actual.py pipeline/tests/test_direct_roa_table.py pipeline/tests/test_roa_table_producer.py pipeline/tests/test_saved_edinet.py pipeline/tests/test_notion_client.py pipeline/tests/test_fixture_policy.py pipeline/tests/test_normalize.py pipeline/tests/test_xbrl_to_csv.py pipeline/tests/test_xbrl_inline.py pipeline/tests/test_financial_context_units.py pipeline/tests/test_cloud_financials.py pipeline/tests/test_backfill_financials_from_notion.py pipeline/tests/test_reparse_financials_from_notion.py
```
