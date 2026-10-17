# CSV再解析失敗時の既存有報データ保全（2026-10-18）

通常の`ingestDocument`は日次`src/cron/yuho-edinet.ts`と
`services/yuho-quant/data-scripts/backfill.ts`が共用する。
既存文書の`force`または`textParseStatus=ok`・本文ポインタ欠落による再取込で
CSV解析に失敗すると、旧実装は空の受注・海外・本文配列を正常な置換入力として
同一D1 batchへ渡していた。原子性はあるが、旧良データの全削除を原子的に行う。

本文0件では`backupDocTextToNotion`を呼ばない。旧Notion本文とポインタは残る一方、
本文状態が`parse_error`となり、通常`textBackfillWhere`と`hasUsableText`の対象から外れる。
これは本番で当該故障が発生済みとの報告ではなく、共有コードと局所再現で確認した退行経路である。

## 修正の境界

`csvError && existsInDb && needDbWork`の場合だけ、取得済みtype5の全bytesを既存
`recordEdinetZip`→`recordPrimaryData`→物理読戻しで保管してから明示例外で停止する。
type1の追加取得、保有明細publisher、破壊的D1 batchより前で止める。
旧facts、全status、本文索引・ポインタ・原本を保持し、旧値で成功とは返さない。
保管の未知失敗はその例外をそのまま伝播させる。未知結果の再送・旧intent解除は追加しない。

新規文書での`parse_error`保存、正常CSVの再取込、既存完成文書のskipは変更しない。
非forceでCSV保管が既にあり今回bytesと異なる場合は、従来のmanifest/fullbytes検証が
D1より前で停止する。したがって非forceの全失敗でデータが消えるとは主張しない。
forceは新しい原本行を記録する枝なので、その検査だけで旧良D1を保護できない。
日次callerでは汎用例外により既存inFlightを保持して停止する。自動解除や自動再取得はしない。

## 保存実データと試験

実6963・ローム株式会社・`S100YF41`（2026-03-31期末）のroot受入済みPOSTから、
受注6件・海外6件・本文索引37件と文書・銘柄全列を同じ値で切り出した。
正の受注金額・海外売上金額を含む。fixtureの出典・全SHAは
`services/yuho-quant/src/tests/fixtures/ingest-csv-reingest-6963/provenance.json`に記録した。
実type1 ZIPは1,322,750B、SHA256は
`84cc6e927d5d1d282c5bc845b3dbe2c1dbd9bd390291f5dde37ce0f75d4e6fe6`。

故障試験ではこの同じ実type1 ZIPをtype5応答へ意図的に投影し、通常CSV parserの
「.csvが含まれない」例外を使う。原本保管ACKとreported状態0・空relation表は宣言した
輸送・入場投影であり、現EDINET応答・現D1・現在の文書資格を証明しない。
ポインタ欠落caseのNULLだけは明示的な状態故障投影で、財務値は補作しない。

- force／ポインタ欠落の双方で実SQLiteの全旧列・全行が一致し、D1 batch0、type5取得だけ1回、保管1回、本文／保有publisher0。
- 保管unknownを同じ例外のまま伝播し、全旧値保持・D1 batch0。
- 新規文書のCSV失敗は従来どおり`parse_error`で1 batch保存。
- 既存関連5suites・50tests、全体TypeScriptと対象ESLintをNixで確認。

変更前の同じ保存データを使う私有局所再現では、受注6・海外6・本文37が全削除され、
旧pointer保持／status=`parse_error`／通常pending0となることをHTTP0で確認した。
本修正の本番配備と実データの再取込は別受入。source API・本番Notion/D1・モデル実行は0。
