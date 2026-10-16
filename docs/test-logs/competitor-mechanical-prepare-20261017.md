# 競合入力の通常機械準備（2026-10-17）

Issue #348。旧保存確率の受入81社/574関係と、現在入力の再資格化を分ける。
通常CLIへ`competitors --prepare-only`を追加し、取得・主体/世代・原文・候補・質問の固定だけを行う。
この変更のモデル/取得元API/本番Notion/業務書込は0。Mac runtimeと定時stageは未配備。

## 実行契約

- 明示した既存SemIf較正版を読むがTypeSafe gate/認証キー・モデルclientへ進まない。`--dry-run`は従来モデルを呼ぶ。
- 既存補足DB/schemaを読取検査し、列を作成/修復しない。共有archiveも既存の一次DB必須としてDB作成を禁止する。
- 同じactive/latest D1を前後2回読み、現在doc/期末/pointerを固定する。実39列の全文SHAを通常publisherの同期receiptと照合し、corpus事業本文・タグ・入力metaが読取中に変わればHOLD。
- 既存planWorkの同doc旧タグ再利用契約を使う。旧tag-input来歴不明は`unverified-legacy`のまま保持し、保存済み4節SHAがある場合は今回の実4節へ照合する。意味判定の再検証・後付けの旧SHA生成はしない。
- 元の候補集合と順序を維持し、選出Bの資格不足はA HOLDにする。候補を落として空競合を書かない。
- 現在入力、A state/B questions、qids、全SHA、較正、関連ソースSHAとHOLDを1gzipへ保存。共有recordPrimaryData/verifyArchivedAttachmentsを使う。同入力のkey/gzipは同じで、再uploadは省いても物理照合は省かない。unknownの開始markerだけ残る場合は再送しない。
- finite budgetは新規Notion読取開始をqueue/spacing/retry待機後にも止める。取得済み入力のarchive closureは別に完了する。全体のhard timeoutや全量成功とは混同しない。

準備結果に確率・競合判定日・relationは生成しない。後続推論/公開は同じmanifestへ束縛した別段階であり、
旧確率の別入力転用は禁止。今回そこを起動していない。

## 保存実入力と回帰

受入済みA5の物理POSTから215A/2160の実2社を使う。元POST gzipのSHAは
`4c9c8869d9d63af2825b8e36a7dcd1b0d4701857f36fbee3b5529d88b89ab179`。
CI投影gzipは111,437 bytes、SHA `3ab9bb6ea25c0506655face88ad4f4eb6c35c23d6e32ac0e84f7544763b0b9f3`。
実39本文・日付・タグ値を保持し、UUIDは決定的に匿名化、actor/URL等の未使用top-level情報を省いた。
原native responseそのものではない。公開書類ID/期末、元plan/native本文・propertiesのSHAと投影範囲は
`competitors/fixtures/prepare-actual-20261017.provenance.json`へ記録した。架空本文/架空確率は含めない。

同じNix/Nodeでnormal CLI入口を実行し、モデル/TypeSafe/APIkey accessor/競合・schema mutationが0であること、
全39/receipt・legacy来歴・B不整合HOLDと候補/qids保持、同一inputのgzip/key/skip物理照合、長文未完・
archive unknownの再送禁止を検証した。D1/Notion transportは保存投影へ置換し、live通信は0。
共通Notion guardはqueue/retry待機後の期限超過native0、既存archive DB欠落はschema作成0を検証する。
8 suites / 235 checks成功後、明示0.3rpsを追加した準備/pacingの2 suites / 37 checksも成功。型検査と対象lintは成功した。
明示rateは共有setterを新規通信前に使い、`.env`の2.0rpsでも実native開始が0/3334/6668msとなる保存入力回帰を通した。

## 有限stageの条件コスト

保存された旧3689 profile/3712補足行で既存buildCandidatesを実行すると21.073秒、
Node resourceUsageのmaxRSSは2,686,528 KiBだった。A33の先頭5社は各50候補、A/Bの一意集合は202社。
現在corpus・現在タグを読み直した測定ではない。

| scope | 条件要求数/時間 |
|---|---:|
| schema + corpus + 選出A/B実39列 | 1 + 38page + 5 OR query = 44 Notion読取 |
| 最新doc前後2pass | D1 HTTP 4回（Notion要求数と別） |
| 0.3rpsの読取間隔のみ | 143.33秒 |
| 候補計算CPUの保存入力実測 | 21.07秒 |

archive/全物理照合、現在full39 bytes、HTTP・再試行・setupは含めない。5件/2分はこの条件でも不成立なので
採用しない。初期stage候補は固定5件・別CLI processのNotion0.3rpsとし、同じ唯一writerと既存
30分全体hard stopを維持する具体diffを別レビューする。追加stage自体を7分で止める案では、CLIの新規読取を6分にし、
原本保存/物理照合の余地を残す。7分kill時は未完・unknownとしてcursorを動かさず、開始markerだけの再送は禁止する。
固定scopeのコード順after-codeで毎回次の5件へ進み、末尾で巡回を開始し直す。cursor前進は正常終了と
同SHA/gzipの物理verified receipt確認後だけとし、HOLDは準備済みの保留分類として残す。競合なし/判定完了とは扱わない。
新launchdや停止済みGH writerの再開は行わない。20時/21時calendarとreceipt readcheck期限は変えない。
7分内完了や追加runner/電力の実費は未測定で、保証しない。まずCLIだけをmainへ入れ、live release/配備は別に行う。

旧109社のdoc世代差・B27/A33・未観測B13は[既存差分記録](competitor83-body-staleness-20261014.md)を参照。
同じ保存断面からは変更/未観測のA集合52社（A33と未知Bを持つA27の交差8）、既知wire同値31社だが、
現在タグ/候補を再取得した証拠ではない。81/574の旧受入、130A/145A HOLD、通常競合判定停止を維持する。
