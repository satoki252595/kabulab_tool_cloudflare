# 保存価格registryの日次更新と必要明細（2026-10-18）

## 更新が止まる根因と共有修正

実read-onlyで観測したactiveは37202207552.1、対象session2026-10-02、3456memberだった。唯一の通常更新入口は`vwap-ingest.yml`→`ingest-daily.ts`→`publishDailyPriceSnapshot`であり、stock-syncのD1日次価格・指標更新はこのR2 registryを更新しない。旧条件は全銘柄のerrors/invalid/emptyが0であることを要求したため、1銘柄のsource HOLDが全銘柄の価格参照更新を止めていた。最新opsの3646/3687だけからR2日次の成功・失敗を判定しない。

新条件は通常全universeを一度ずつ会計し、全outcomesがwritten/skipped/empty/errorの既知終端で、abort/fatal/429・503中断がないこと。written/skippedには物理原本のsymbol・SHA・実時計参照を必須とする。error/emptyは新世代のmemberから除外し、旧memberを黙って継承しない。結果不明、未着手、集合欠測、subset、custody失敗では更新0。activationの4CAS・全文readback・inflight unknown latchは変更しない。日次のerrors/invalidがあればCLIは非0のままで、registry更新を全銘柄成功とは呼ばない。

optional `coverage.outcomes`はaccepted/empty/errorを区別し、accepted集合とmember集合の厳密一致を要求する。errorをsource_empty・取引なしへ読み替えない。writtenとskippedはacceptedへ正規化し、同session/原本参照/coverageなら追加PUT0。coverage無しの旧snapshotは同じschemaで読める。新fieldが不明な凍結旧readerを継続利用する契約ではなく、共有consumer更新済みの通常producerでだけ新世代を発行する。

旧日足に完了証跡があっても物理原本参照がなければ、通常fetch→原本保管→同じ版へのmetadata付きCASを通す。これは物理参照不足銘柄の移行費用（最大そのrunの選択件数）で、毎回全銘柄を再取得する仕様ではない。公開日足本文、SQL/金融計算、価格丸め・分割係数は変更しない。新依存・DDL・別registry writerはない。新schemaの全市場実日次受入とactual API要求数は未測定。コード修正時点の新producer/R2 registry mutationは0。

## 現在の必要価格queueに限定した純再生

現217再開待ち書類/2822行は、既保存22,755候補からdoc集合を限定すると欠doc0・件数差0で一致した。全217の原表順・固定列factsSHAを現在queueの再開情報へ照合した。受入済active snapshotの3456memberだけを使い、必要113gzip/169,195,325 bytesを全SHA確認して通常qualifierへ通した。HTTP・モデル・業務更新0、6.721秒。これは現在のNotion明細全POSTや最新docのfresh qualificationではなく、本番apply候補を絞る同保存入力の予測である。owner ZIPは再読取していない。

| 結果 | 行数 |
| --- | ---: |
| qualified（当日期末775＋公式休場session172） | 947 |
| 保存日足原本なし | 275 |
| 公式上場提出者名への完全一致なし | 404 |
| 期末株数非開示 | 160 |
| 期末以後の単位一致未資格 | 176 |
| 市場権利落日のみで法的日・単位未資格 | 817 |
| 公式カレンダー未収録 | 16 |
| 公式英字名不一致HOLD | 27 |

最初5書類は2502（3/10）、1447（2/2）、2168（0/2）、1887（5/12）、1377（4/16＋alias HOLD1）。通常queueは最大5source/runなので、maxRows100でもこの順序では42行・qualified14が候補上限。高件数順への私有skipはしない。後続の公式issuer alias資格は今回省略しHOLDに保持した。

純receiptは`tmp/feature-audit-20261018/holdings-rights-needed-current-v1/price-needed217-pure-v1.private.json` SHA `079038a4dc561bff52b69c2aaf2f599e13406b8034c8bcbb3a7dab7b8b3abbb0`。生原文・署名URLはprivateのみ。正常price writerのfresh source/latest/period/properties照合を経るまで947行のpublished受入ではない。

## 確認

関連4suite77PASS/4skip、full TypeScript・owned lintがNixでPASS。旧snapshot互換、新coverage/member不一致拒否、error/empty除外、unknown/notStarted/未accounted/abort更新0、同証拠written→skippedのPUT0、旧参照欠測の正常metadata CASを回帰した。既存unknown applied/unappliedのinflight停止回帰を保持する。最初のtest3失敗は参照を持たない旧protocol fixtureの前提相違で保全し、positiveは資格済参照を明示、新しい参照欠測の負例で通常fetchを確認した。実全銘柄の日次source取得・registry更新・価格publish受入は次の通常実行で別確認する。
