# 信用残の通常業種集計と保存原本の独立照合（2026-10-02 JST）

Refs #160 #117 #132。
[通常run36908547972](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/36908547972)
は `only=jpx-margin-sector` で **2026-10-01 18:48:43 UTC SUCCESS**。
入力はR2 indexの実最大基準日 **2026-09-30**、key
`jpx-margin-sector-2026-09-30`。通常ログは **476行（新規476／更新0／同値0）** を記録した。
未分類を含む34区分 × 14指標であり、全moneyflowやsector-turnoverの成功とは扱わない。

## 通常producerの観測ログPOST検証

[認証変数の接続修正](moneyflow-margin-secret-wiring-20261002.md)後の通常入口を確認した。
`runSpec` は派生入力2ファイルを共有 `recordPrimaryData` で物理保管し、
`verifyArchivedAttachments` で全文を照合してから観測ログをupsertする。
今回の新規476行は、書込結果に新規・更新がある場合の
`verifyWritesIfChanged` → `verifyObservedBatch` を通り、全476入力と実ページを
照合した後に成功ログへ到達した。

これは通常producerの書込後検証の証拠である。以下の独立照合では観測ログ476行を
再照会しておらず、producerの全POST照合と保存原本の再解析を別の検証として記録する。
通常経路は保存済みR2 snapshotとD1 mappingを読み、JPXのPDFを再取得しない。

## 保存原本の独立読み戻し

**2026-10-01 19:04:54.001〜19:04:57.877 UTC**、既存共有reader経由で
当該keyだけを読んだ。`requirePrimaryDataDbId` → `findArchivedRecordByKey` は
完全一致1行を返し、Status `recorded`、Notion-hosted添付2件をstrictに確認した。
`listPageFiles` の実GET/pageと完全一致queryのMetadata全文が一致し、
永続保存済み `_fileManifest` の自己fingerprintも一致した。
今回はcreate-requestから導いたmanifestではなく、現在のquery／GETで読み戻したmanifestである。

各添付を全バイト取得し、manifestの名前・MIME・byteLength・SHA-256と照合した。

| 添付 | byteLength | SHA-256 |
| --- | ---: | --- |
| snapshot `margin-daily-2026-09-30.json` | 3,603,939 | `7ec99c0a3c8e8d0b7c6c083946ed2fb68e59f71b840bb5e1e5093eaea3d1c957` |
| derived mapping `margin-sector-input-2026-09-30.json` | 114,881 | `dd21ead0f9aa097062b722e1bffd3d7d1babdfac825cbc414a65a9a8f955fcc2` |

snapshotとMetadataはbasis9/30・PDF SHA
`4ae578f3ae690c6010d7ffed1d993f5d29441c302de89aa5daf05bc5d9badefe`・
由来VWAP page `3ecd74ff84cd81258d7fdcb370f8d41d` が一致した。
これは[先に閉じた日次PDF全文照合](vwap-margin-weekly-readback-20261002.md)と同じ由来であり、
今回のmoneyflow再読でPDF本体を再ダウンロードした証拠ではない。
mappingはsnapshotとD1 joinから作った派生入力で、JPX原本そのものではない。

読み戻した2ファイルを共有 `marginSectorSpec.toObservations` に渡した純粋再解析は
**476行＝34区分×14指標**。`validateDrafts` PASS、区分ごとの14行も確認した。
財務値・原文本文はこの公開記録に含めない。

実通信は **Notion3（Search1／完全一致query1／GET/page1）＋hosted GET2**。
上限Notion12／hosted2に収まり、全5応答がknownだった。
source GET・D1・R2・Notion mutation・dispatchはすべて0。
追加照会や再試行は0で、既存共有clientのlimiterを維持した。

原HTTP要求／応答、添付全文、解析結果、時刻は私有0700 directory内の25ファイルへ
0600で保存した。私有reader SHAは
`274bb2e81b2216daa9a18bbbe13b3801d24b87ada6c09be0b161126d346c2505`、
私有result SHAは `5c96c9e1d0722f5e3a4ba15675bcf713f8c669e0fb93dbcea6b88e96a3c8a176`。
ローカル保管を別の物理Notion保存完了とは扱わない。

## 残る境界

源PDFの当時のHTTP取得clockはログ未観測で **UNKNOWN**。
今回の再読clockや通常job完了時刻で補完しない。
旧9/28の結果不明keyは今回照会も再POSTも0で、その完了は主張しない。
VWAP daily／intraの正常化、全moneyflow、未公表JPX様式の実取込は別の受入条件である。
