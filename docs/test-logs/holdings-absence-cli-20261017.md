# 明示不該当の通常CLIと共有publisher（2026-10-17）

通常パーサーが提出会社の完全な保有節を`explicit_not_applicable`と資格化しても、最新有報backfillの`apply`は`held`を一律に読み飛ばしていた。保存した型付き根拠を同じZIP・DEI・提出者・期末・contextで再資格し、通常の物理custody確認と共有publisherへ渡す。通常の未対応・原本欠測・主体不明は従来どおり書込前に保留する。

これは明細0件の成功ではない。共有publisherは理由と原本根拠を型付きHOLDとして保存し、CLIも`.held.json`と終了コード1を維持する。株数・金額・価格の0値、原本完了cursor、価格queueを作らない。旧unknown・非0明細・facts・source cursor・完了markerの保護を維持する。

保存実原本4件を改変せずfixtureへ収録した。ZIP全文SHA・サイズ・同提出者の実context・保有節SHAは同ディレクトリの`provenance.json`に記録する。

| 提出会社コード | 文書ID | 期末 | 明示不該当を観測する提出日context |
| --- | --- | --- | --- |
| 206A | S100XCIN | 2025-09-30 | 2025-12-24 |
| 2326 | S100YKKS | 2026-03-31 | 2026-06-25 |
| 2749 | S100YF75 | 2026-03-31 | 2026-06-22 |
| 276A | S100X6P1 | 2025-08-31 | 2025-11-26 |

Nixで通常prepare→ZIP再資格→legacy custody→共有publisherへの伝播を実4件で確認し、同じheld receiptから再送しないことも検証した。定期取込も使う共有publisherを実4ZIPで再生し、全他props・既存価格・Filesを更新後GETで比較する。原本Keyの1文字変造、根拠だけを付け足したplan、既存のDEI不明・複数context・子会社区画141A・旧unknownの負例を維持した。関連3 suiteは124件PASS。

追加依存・モデル・新原典APIは0。4ZIPは計4,366,782 bytesで、通常パーサーの純再計算は同Mac/Nixの1回測定で計103.274 msだった。将来の実行時間保証ではない。CLIの追加解析は型付き不該当候補だけで、普通の明細とHOLDに全市場の追加解析・取得を足さない。legacyから初めて資格化する候補には既存custody経路の物理コピーと読戻しが必要だが、typed原本は再uploadしない。定期publisherの全props比較は既存の更新後GETを使うため追加通信0。

このPRで本番書込・価格受入は行っていない。実行中の固定`b8fb0d85`復旧chain・旧STOP・保存根拠は変更せず、当該4件はそのchainで保留を維持する。新コードでの本番反映と全POST受入は別途必要である。
