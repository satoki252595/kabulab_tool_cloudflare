# 保有明細のsource有限window（2026-10-14）

通常NodeのEDINET取込と保存原本再開は、同じ `publishVerifiedShareholdings` を使う。
1通がrun残枠を超えた場合も全件を恒久HOLDにせず、最大100行のwindowを進める。
上限を1000へ増やしていない。価格phaseの独立cursorと原本完了の意味は維持する。

## 保存と再開の契約

- 既存type1行の原本3props内のJSONへ `sourceQueueVersion:1` と
  `sourceNextHoldingOffset` を保存する。新DB・新propertyは追加しない。
- ZIP全文SHA/bytes、提出主体/文書/期、全parsed件数と原表順の全facts SHAを固定する。
  run残枠が0でも先に全原表を解析して明示cursor0を残し、明細writeは0にする。
- 同じ原本の再開時は全facts/orderが不変であること、cursorの範囲と状態を検証する。
  通全体が完了済みなら、価格指定なしの再実行は明細を再送しない。
- window開始前にsourceだけを結果未確定にし、全行のACK/対象idと全propsを読戻す。
  全windowが成功した場合だけsource cursorを進める。途中失敗はunknown/cursor不変で停止し、
  次定時に再送しない。開始と終端はtype1行の全props/時計をfresh CAS確認する。
- 途中windowは `held + pending + usedRows` を返す。通常callerが通全体の完了と誤認せず、
  通常再開は部分windowの消費行数をrun100行の予算へ計上する。
- 最後のwindowだけsource完了と独立価格pendingを同一PATCHで登録する。
  価格JSONにsource版/cursorを混ぜない。途中の価格3propsは保持する。
  明示価格原本を指定する既存手動callerは、source完了後に独立価格phaseへ委譲する。
  価格まで既完了なら全source束縛・価格cursor終端/欠測0を確認し、write0のno-opにする。
- 通常再開は既存 `readSavedHoldingsZip` を再用し、保存ZIP全SHA、metadata、nativeDEIを確認する。
  上流のEDINET GETや別原本への置換はしない。

## 旧cursor欠測HOLDの明示再資格

旧再開情報に版/cursorがない場合は0へ黙って戻さず、明細write0でHOLDする。
`publishVerifiedShareholdings` / `publishSavedShareholdings` の明示引数
`sourceWindowPre: ArchivedSource` を使う時だけ、旧「再開待ち/要確認」をv1へ移行できる。
本番の自動queueはこの引数を生成しない。旧unknown/完了はこの移行の対象外。
旧source完了のversion欠測は別の限定enqueue計画で扱う。今回の一般移行で完了をHOLDへ戻さない。

物理PREはUTF-8 JSONの `{page, info}`。`page` は旧type1行のfull GET、`info` は同じ
保存ZIPを現parserで解析した提出主体/全件数/facts SHAと明示v1/cursor0である。
添付全文SHA/bytesをNotion上で照合し、旧pageのid/parent/active性、全props、作成/編集時計と
全原表束縛を確認してから開始する。fresh CAS不一致は上書きしない。
旧情報と旧物理PREを保持し、本文/原本/過去clockを変更しない。

## 費用・範囲

追加source GET・モデル推論・有料API・依存追加は0。
既存type1行のJSONに版/cursorを数十bytes追加し、1通の実行に資格GETが1回増える。
複数windowでは既存Notion保存ZIP（1通5MiB以内）を次runで再読する。run100行/最大5通と
既存時間予算は据え置く。価格R2の116chunk/256MiB予算にも変更なし。

保存済みimmutable cohortの2300通分析ではsource-qualified1058通/12946明細、最大73行、
100超の通は0だった（private classification SHA
`75d85dd2f8d8ab63f73c0b0410ae0c9fb1c0119d5997d434cc907ad6048938a0`）。
これは全3666通の完了を意味しない。今回の修正は残run枠と将来の大きい通でも停止理由を
恒久化しないための通常経路修正であり、未観測の全件を確認済みとは報告しない。

## 検証

Nixのlocked環境で、共有writer・cron・Node CLI・price loader・厳密原表/価格資格・通常ingest・
既存backfillの10suiteを実行し146件PASS（担当writerは41件。並行追加された価格loader回帰2件も含む）、skip0。
新source回帰は2つの保有種別をmaxRows1で分割するtransport契約試験であり、
架空明細を本番へ保存していない。実原表parserは既存独立suiteで確認する。
順序/facts変更STOP、unknown後再送0、部分消費行数、最後だけ価格enqueue、
旧cursor欠測の拒否と物理PRE/clock不一致拒否、明示v1移行を固定した。
owned ESLint・TypeScript・diff checkも実施する。
市場担当の独立source-only reviewでは具体的なfalse-success/cursor/replay問題は検出されなかった。
本作業による本番write・上流取得・モデル推論は0。
