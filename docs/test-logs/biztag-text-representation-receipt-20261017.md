# 本文の原文SHAとNotion送信表現（2026-10-17）

Issue #348。9273/S100Z2Z6の[実U+200B記録](biztag-notion-zero-width-20261017.md)では、本文列だけが
Notionの送信表現へ揃う一方、同期receiptは原39 SHAを保持する。通常競合prepareが実Notion39列のSHAを
その原SHAへ直接比較すると、正常同期済みでもHOLDになる。原SHAを表示SHAへ置き換えず、正常producerに別の証拠を追加する。

## 共通の証拠と資格

- `stock-supplement.ts`の本文列U+200B変換だけを純関数として再利用する。原文map、他metadata、U+200C/U+200D/U+FEFF、意味判断用の原入力は変更しない。空表示のNULL化は従来の列クリア表現に対応する。
- `process.ts`の単一`textReceipt`を通る本文同期、同原4SHAのpointer更新、候補語0、正常判定成功の全producerが、原39 `textsSha256`を保持し別の`notionTextsSha256`を生成する。
- 実原文の原4 SHAと原business SHAが既存InputReceiptの両方へ一致した場合だけ、既存`equivalentJudgmentInputSha256`、新`equivalentJudgmentBusinessSha256`と送信4/business SHAを対応付ける。旧InputReceiptのJSON原文字列、モデル、時刻、原SHAを後付けしない。
- prepareは実39を別送信SHAへ照合する。旧receiptに別SHAが無い場合は従来の原SHAとの厳密同値だけを`legacy-raw-exact`として受け入れ、不一致を正規化で推測しない。
- 既知の判定4/businessが実Notion列と違う場合は、両原参照と送信4/business・39の全証拠が一致する時だけ表現差として資格化する。欠測、原businessの変更、原4の変更はHOLD。旧input receiptなしは`unverified-legacy`のままであり、意味判断を検証済みへ変えない。

`planWork`のdoc/pointer判定、Clef journalの原入力SHA、モデルへ渡す文章と質問は保持する。
既定定時の全社refresh、モデル呼出し、旧競合relation・確率の更新は0。

## 既存行の有限な通常再資格化

既にskipの旧receiptは全社再読取しない。通常CLIの明示`--refresh-text-receipt`だけが、固定1〜100コード、
有限limit/budget、`--mechanical-only`を通信前に必須とする。CLIではcodes/limit/budget-minの省略も拒否する。
通常plannerの資格済みskipだけを同じ`sync_text` producerへ渡し、最新doc変更や資格HOLDを意味判断へ代替しない。

実原39が旧同期receiptの原39と同値であることをまず確認する。既知原4/businessの同値証拠が無ければHOLD。
共有publisherの既存expected-properties guardへ正準39本文も渡し、現在Notion列との同値をmutation前に確認する。
再資格化でPATCHするのはreceipt metadataだけで、本文39列は再送しない。PRE物理保管・最新doc再確認・単発PATCH・
全読戻し・旧根拠保持は既存publisherを使う。全proof同値の再実行も現在39のguardを通り、PRE upload/PATCHはNOOPにする。
可視文字の不一致はwrite前のHOLD、mutation結果不明は従来の停止であり、再送や旧STOPの成功への書換えはしない。

通常コマンド例（この記録では本番実行していない）:

```sh
nix develop --offline --command pnpm exec tsx services/yuho-quant/data-scripts/biztag.ts run \
  --mechanical-only --refresh-text-receipt --codes=9273 --limit=1 --budget-min=6
```

budgetは既存の新規銘柄着手予算であり、全通信の絶対終了保証ではない。実運用の単発実行は、固定source/原本SHAと
最新PREを確認し、親の有限timeout/native予算と未知送信markerを持つ通常writerのreleaseで行う。未知runを再dispatchしない。
今回Mac117b、旧first5、旧本文受入proofは変更0。実配備と既存行の再資格化は別受入。

## 保存実入力の検証と費用の境界

9273の既存実U+200B fixtureを再利用し、原/送信の全SHA、旧判定説明の保持、送信metadataだけの更新、現在本文可視差で
archive/write0、unknown PATCH単発、同値NOOPを確認する。process側の9273は実1節と未供与38節の投影であり、実有報全39の
回復証明とは呼ばない。実215Aの保存全39から通常planner→同producer/publisherへの明示refreshと既定skipを検証する。

known4/business対応は実2社全文を使い、CI内で表示protocol用U+200Bを注入して共通producer→prepareを検証する。
この注入をnative原本の来歴や歴史的判定と称さず、架空の確率・新判定は生成しない。原business変更、証拠欠けはHOLD、
旧InputReceiptのJSON bytesは維持する。model/TypeSafe/API-key factoryを拒否し、CLI外部通信は保存transportへ置換する。

追加処理は本文の正準化とSHA計算であり、新しい源GET・モデル・依存・DDL・既定Notion要求は0。
明示refreshは必要な原文読取と既存publisher要求を使うが、本文再送を省く。全量CPU/RSS・所要・本番の再資格化数は未測定。
Nixで7 suites / 240 checks、全体typecheck、対象lintとdiff検査がPASS。
