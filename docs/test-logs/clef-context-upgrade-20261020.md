# Clef入力上限と既知拒否の明示解消 — 2026-10-20

4599/S100WW19の保存済み入力は、全7問で18,324token、1問でも16,556tokenだった。
旧16,000上限では本文を保持したまま判定できないため、Clef専用の上限を18,432へ広げる。
本文・質問・しきい値・モデル原本・native source・依存・通常の対象選択は変えない。
SemIfの上限は16,000のまま。上限内に収まらない場合は質問だけを分割し、全文を事前encodeする。
一問でも上限を超えればforward前に全体を拒否する。

## 較正の再利用と差分実測

旧gold87の95要求を、同じ固定native encoderで16,000/18,432の両方について再encodeした。
token IDs・質問spans・選択肢・順序・media・分割を比較し、94要求/882問は完全一致した。
変わるのは9434/S100YE76の16問だけで、旧14,780/14,851tokenの8+8問分割から
17,160tokenの一回へ変わる。この1要求だけを同じNix Python/MPS/BF16で実推論した。
全体評価は842旧期待ペアと16新期待ペアの合成であり、新しい全量実行ではない。

| 項目 | 結果 |
| --- | --- |
| 新規モデル実行 | 1要求・16問・1forward。外部API/業務書込0 |
| 判定帯 | 16問すべて変更なし。確率の最大差0.089863807で、確率自体の同値は主張しない |
| 全858期待ペア | precisionYes 0.951557、recallYes 0.759669、mustHitRecall 0.904762、mustNot違反0、filterMiss0 |
| no側 | precisionNo 0.960526、正例の断定的no率0.049724。旧しきい値0.50/0.24を維持 |
| 9434 native所要 | 旧2forward合計64.357秒→新1forward30.811秒。新実行全体45.309秒 |
| 新実行の資源 | child RSS peak20,898,889,728B、MPS driver peak25,549,471,744B、swap増0 |
| 実4599の製品CLI検査 | encodeのみ10.010秒。旧上限拒否→新上限で全7問18,324token適合。重みロード/forward0、元6ファイル不変 |

同じ較正集合による確認であり、独立holdoutや全銘柄精度の保証ではない。
旧`basis.measurement`の95要求/96forward・1,446.688秒は旧16,000上限の実測として保持する。
新上限の根拠は`basis.contextUpgrade`と混合評価のprovenanceに分ける。
4599の実forward・資源・Notion公開はこの検証では未実施。

## 通常CLIによる明示解消

```sh
nix develop --offline --command pnpm biztag run --repair-empty-tags \
  --codes=4599 --limit=1 --budget-min=20 \
  --context-upgrade=3de695b91669429287034fe8afbddfea905e32f6d5af6abb96e69b15cba49c81
```

これは実推論・通常のNotion公開を行い得る操作で、merge/受入済みruntimeへ切り替えた後に運用担当が行う。
通常のMac/Nix/受入済みmain/同じプロジェクトwriter lockを通し、未設定環境や別stateでは実行しない。

指定は既知拒否の旧key、固定1code/limit1、明示20分以内budgetだけに限定する。
旧5ファイルとACKの全SHA、完全なエラー応答、旧16,000較正SHA、同じ原本/全文/順序質問を検証する。
旧accepted・partial・unknown・別原本/入力・upgradeの連鎖は拒否する。
旧generic errorも、同じ要求が旧上限のencode段階で必ず拒否され、新上限では全問適合することを
重みロード/forwardなしのnative encodeで再現した場合に限る。

元の`rejected.json`の`noReinference`を含む旧6ファイルは変えない。
旧keyを識別する固定の別keyで、同じjournal rootへ新recipeを保存する。
input bindingには旧6SHA/固定cap/較正SHA/決定的encode結果を含め、差があれば同じkeyでHOLDする。
現在時刻・PID・較正やencode結果の変動でkeyを変えず、CLIを繰り返しても同じkeyになる。
新acceptedは保存出力だけを再利用し、未確定出力は通常のglobal HOLD/sticky STOPにする。
通常のPRE/CAS/POST publisherを再利用し、全stateリセットや既存acceptedの再推論は行わない。

## 私有証拠と検証

`tmp/feature-audit-20261019/clef-context18432-gold-delta-v1/`:

- `comparison-proof.json`: SHA256 `dac889f5bf432687cb540fa2a67efa296ef682c79f4e6aadb08df5320f795970`
- `composed-evaluation-v2.json`: SHA256 `22056afe1067d497b369a94929fd34d4b1a57f3ce82609ef3bf3fafd1db0d762`
- `4599-product-encode-proof.json`: SHA256 `c2b91079062138c1ab917218a45fa31ed027309913411b2a6cd0c1691ac54dfd`

Nix Python unittestは20件成功。Nodeのjournal/実CLI scope/共通JSONL/較正/通常pipelineなど8suite181件、型検査、
関連ESLintが成功。旧accepted/unknownの拒否、新成功出力の再利用、旧6ファイル保持、
非決定的な証拠fieldの拒否、未完新recipeのglobal停止、新recipe拒否ACKの整合を回帰した。
モデル原本とUV lockは不変で、追加の有料API費用は0。資源実測は上記の固定入力だけに限定する。
