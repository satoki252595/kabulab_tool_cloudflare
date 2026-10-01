# 646A 業種の限定実修復 — 2026-10-02

Refs #146 #196。646A の `core_stocks.sector33` だけを NULL から化学へ更新した。
既存の通常 parser、発行体資格関数、sector33 planner/builder を使用した。
622A は同じ最新原本でも非上場・証券コード空欄のため変更していない。

## 原本と資格

[FSA公式コードリスト](https://disclosure2dl.edinet-fsa.go.jp/searchdocument/codelist/Edinetcode.zip)
を1 GETで取得。2026-10-01付、11,396行・13列、571,998 bytes、SHA256
`388821356ec1b2d968e5d6543296757f628f4a96005aca55dc9523b301d026c8`。
E42126 / 646A0 / 法人番号5320001020638 / 上場 / 化学の一意な対応を確認した。
E42099 / 622A側は非上場・サービス業・証券コード空欄で、資格を拡張しなかった。

原ZIP保存後のローカル型変換エラーにより、HTTP headerと正確なGET時刻は永続化
できなかった。原ZIPを再GETせず読み直し、保存時刻と解析時刻を取得時刻として
代用していない。この制限をmanifestに明示したうえで、原ZIPとmanifestを共有
`recordPrimaryData(force:false)`から物理保管し、unique row・fresh downloadによる
両添付の全bytes/SHA一致を確認した。

| 保管物 | archive key | ZIP bytes / members | ZIP SHA256 |
| --- | --- | --- | --- |
| 原本 | `edinet-codelist-investigation-2026-10-01-388821356ec1` | 571,998 / 原ZIP | `388821356ec1b2d968e5d6543296757f628f4a96005aca55dc9523b301d026c8` |
| PRE | `issuer646-pre-20261002-a19483fb73bb` | 9,355 / 14 | `a19483fb73bb8d1585a19d3bcb7c5dc13194a8e597808998495ce554252eedb3` |
| POST | `issuer646-post-20261002-23626fd31435` | 17,490 / 31 | `23626fd314350111eb9b0ca0a236b670bb76a1c6b44b8c30d42c9c7f20067093` |

PRE・POSTも同じ共有保管と全添付readbackを完了した。原文・個別応答・秘密値は
公開Gitへ追加せず、物理ZIPへ保存している。

## 実行と全列照合

現在の622A/646A core 2行×11列、overlay state 1行×10列、official event 2行×12列を
読み、全56 cells・行数・NULL・双方向EXCEPTを条件にしたCASを先頭へ置いた。
通常builderが生成したUPDATEと合わせ、共有 `createD1HttpBatchSender`から1 batch、
2 SQLを送信。HTTP/SQLの成功応答を保存し、結果不明の再送は0。

SQLiteでは正常系とcore/state/event drift・行欠落・行追加の計6ケースを検証した。
異常5ケースはguardがSQLエラーとなり、全列rollbackした。

実POSTの同じ3 SELECTで全56 cellsを期待値と照合。変更は646Aのsector33だけで、
622Aの全列、646Aの他10列、state/eventの全列は一致した。
その実POSTを同じ通常parser・資格・planner/builderへ再入力し、変更 `{}`・SQL `[]`
を確認した。再入ではD1 writerへ送信していない。実行完了は2026-10-02 00:30 JST。

この実績は646Aの1列だけに限定する。622Aの資格、海外売上の未資格原本、
信用残の結果不明POSTを解消した実績には含めない。
