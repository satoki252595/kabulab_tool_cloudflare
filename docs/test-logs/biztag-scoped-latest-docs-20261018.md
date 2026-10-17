# 指定コードの通常最新有報読取をD1から限定する（2026-10-18）

通常`biztag run --codes=...`は、全市場の最新候補をD1から取得した後でJSのSetに絞っていた。固定50社のREADは第2SELECTの応答が単体16MiB上限を超え、D1読取2件・Notion/hosted/業務書込0で停止した。元STOP、部分body、360秒時計は保持し、上限を拡張して同じ操作を再送しない。

`loadLatestDocs(db, codes?)`の共通active普通株条件へ、コードSetのJSONを1bindとする`json_each`条件を加え、coreとannual documentsの2SELECTへ同じ条件を使う。正準コード以外はSQL前に拒否、明示空配列はSQL0。コード数をbind数へ展開しないので、101コードでも2SELECTはそれぞれ3/5bind。省略時のSQLと全量の意味は維持する。通常CLIの空`--codes`の既存全量分岐も維持する。

最新書類を決めた後のreported HOLD、取下げから旧親へ戻さない選択、書込直前の1社最新doc/pointer/active照合、本文/判定/publisher/journalは変更しない。SQLに元からORDER BYは無く、scoped結果の比較はコード毎の全値・集合の一致を確認した。途中limitの処理順同一は保証しない。

## Caller

| 入口 | 今回の接続 |
|---|---|
| 通常`runBiztag` / `biztag run --codes` | 非空codesを共通sourceへ渡し、SQLで限定 |
| `assertLatestDocCurrent` / 明示publication復旧 | 従来の単社1SELECTを維持 |
| `prepareCompetitors`の前後読取 | 比較候補全体が必要な既存省略callerを維持 |
| saved海外/ordersの`assertSavedLatest` | 元snapshot全scopeの省略callerを維持 |

## 保存原本の検証

- Git fixtureは実保存101銘柄のcoreと全960候補書類の投影（gzip33,495B）。固定50のほか実51銘柄を残してSQL外scope除外を確認。原応答SHA・投影範囲は隣接provenanceへ保存し、取下げ等の変更は明示protocol faultとして区別した。
- 全保存3,687core/36,929documentsと既受入6観測をSQLiteへ入れ、凍結4ce旧helperの全量＋Set filterと新helperの50社をコード毎の全値で比較し一致。省略時のSQL/paramsも旧と完全一致した。
- ローカルcallbackの返却行は旧3,687/36,929→50/516、decoded結果JSONは308,589/53,526,797B→4,181/748,072B。計測には生成SQLの結果列名を含む。これは保存入力を使った技術測定であり、現在のD1 wire、課金rows_read、duration、今後の完走速度は未測定。
- Nixでsource/pipeline/reported-financial/reported-qualifiedの4 suites・104 tests PASS、full TypeScriptとowned4 TS lint PASS。実50同値・101コード/重複・empty/不正scope・active/HOLD・通常pipelineのcode接続を確認。HTTP/モデル/業務書込/新依存0。

私有原本根拠: `tmp/feature-audit-20261018/biztag-scoped-latest-docs-proof-v1/result.json` SHA `13a01ef77c17461e86f862b3be407f60e24f2c34b32913f0873a37e86117caf4`。旧READ閉鎖root proof SHA `a832d5297468f8eaf2aab0d1db72e2fd5cd0831c97144ef9aeefd17c3cde96f4`を保持する。

## 未受入

コード配備・新runtime/env・新時計による50社metadata READと39本文補完は別受入。旧READ namespaceへの再entry、旧STOP削除、未観測原39/fetchedAtの後付け、残659や全20機能の完了は行っていない。台帳/補足/銘柄master等、通常pipelineの他の全量読取は今回変更していない。
