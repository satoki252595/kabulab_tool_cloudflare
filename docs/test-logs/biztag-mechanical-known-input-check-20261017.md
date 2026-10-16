# 既知入力の機械照合 — 2026-10-17

## 問題と共通修正

通常plannerは、同一有報の保存本文pointerが変わり旧4対象節SHAが既知なら、`checkSourceInput`付きの`retag`を作る。しかし`runBiztag`の機械モード早期HOLDがこの項目まで止め、本文同値を確認できなかった。さらに`processStock`内でも同値確認前に語彙prefilterと新判定receiptを作っていた。

通常CLIから渡す機械モードを共通processorへ透過し、この項目だけ実本文を照合する。原4同値なら既存publisherで39本文と同期receiptを更新し、旧判定JSON bytes・タグ・根拠・モデル・版・判定日を保持する。原4の差なら語彙prefilter・較正・journal・モデルへ到達する前に旧props保持のHOLDを返す。原SHA不明・receipt不正は従来どおり停止し、同値を捏造しない。

新規初回・別docの機械モードHOLD、通常モードの実変更時Clef判定、有限limit/budget、書込直前の最新doc確認、物理PRE/POSTを行う共有publisherの契約は維持する。`dry-run`も同じ比較を使うがwriterは既存no-opである。

## Caller / factory確認

- 製品callerは通常`data-scripts/biztag.ts` → `runBiztag` → `processStock`。定時Macと有限実行もこの入口を再利用する。新たなローカル専用判定はない。
- CLIの`loadCalibration("clef")`と`createClefJournal`は既存getter/callbackの初回参照で作る。共通processorの同値・差分HOLDは両方を参照しない。
- `createClefClient`は既存`askNoul`内でlazyに作る。同値・機械HOLDは`askNoul`に到達しない。TypeSafe client/API keyの参照もない。
- 有効語彙は通常runの既存schema/review packetに必要なので読取を維持する。語彙版の解決と、有料語彙審査・再判定は区別する。この修正で語彙seed・schema契約を変更しない。

## 検証と限界

Nixで`process`/`pipeline`/`plan`と既存Mac runtime/stage/journalの6 suites / 176 testsがPASS。全体型検査、変更fileのlint、diff検査もPASS。

保存済み実215A/2160全39本文fixtureと、既存の実オークマ有報本文を用いる。前者のSHAは`prepare-actual-20261017.provenance.json`の既存来歴に従う。新しい旧pointer/既知receiptは比較protocol用の投影であり、実在しない歴史的判定入力の回復とは扱わない。差分負例は別の実社本文を明示注入し、同値へ転用しない。

回帰は同値の共有publisher到達と旧JSON保持、実差の全props保持、未知/不正receipt停止、較正・語彙prefilter・journal・モデル未参照、通常変更時の既存判定を検証する。新しい外部取得・モデルforward・業務書込は実施しない。実残6038/9344の同値/差はまだ未観測で、保存metadataだけからモデル必要件数を確定しない。実行中Macのsource/envは固定し、修正の配備と有限再資格化は別受入とする。
