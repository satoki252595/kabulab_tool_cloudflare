# 海外売上の分割本文選択修正

2026-10-02 JST。変更と検証は offline。新しいsource GET、Notion、D1、R2、dispatchは全0。
既存の[15原本保管・旧資格証拠](overseas-next15-custody-20261002.md)は変更しない。
全文原文、financial値、再解析の全factsは私有0600ファイルだけに残す。

`pickHonbunHtml` は同一有報の最初の地域語入り本文を返していた。
保存済みS100W1LQ/S100W2ZRでは説明部分 `0102010` を選び、後続財務本文
`0105110` / `0105010` の地域表を見落としていた。後続表と既存実開示fixtureの
展開gridはそれぞれ全一致1件。HTML単体probeの成功を全文資格とは扱わない。

既存の本文対象規則（PublicDocのhonbun/jpcrp030000-asr HTML、該当がない場合は
同PublicDoc HTML）で全本文を列挙する。各本文のtable、heading、caption、wide、
対応する実durationContextsを独立に作り、既存reducerと全Gateへ1回まとめて渡す。
HTMLを連結せず、別本文の年度やcaptionを借りない。本文別の単独PASSを先頭採用しない。
丸めは従来どおり同有報全文で確定する。

内部offsetの一意化には各本文長と明示mappingを使い、返す診断のoffsetは実本文内へ
戻す。ZIP由来の候補/incompleteにだけ実 `honbunFile` を付ける。
結果の `honbunFile` は実採用本文、未採用の場合はnull。公開parse関数の引数は不変。
共通取込、海外backfill、missing-backfill、修復prepare、745-prepareの5callerは
同じ `parseOverseasData` を使い、今回caller変更はない。CSV事前取得判定・保管順序も不変。

## 検証

- Nix関連7 suites / 160 tests PASS、全体typecheck・lint・diff check PASS。
- 既存actual HTML fixtureのtest-only ZIP包装で、後半本文2件の採用、本文間の未知契約競合停止、
  別本文の年度による単一行期不明の救済禁止を固定。ZIP包装は本番filingの代用品ではない。
- 固定15の保存済み全ZIPを通常共有parser/保存集合検証でpure再解析。
  初期実測2,659 ms。実source SHAは全15で従前と同じ。元証拠ファイル変更0。
- 旧9件57明細に対し、今回の本文修正単独では9件59明細が厳格な当期・連結資格を満たす。
  集合は異なり、旧8件52明細は全facts同値、S100W1LQの7明細が新資格、
  旧S100W1Q5の5明細は `multi-group` HOLD。資格件数が同じでも同集合とは扱わない。
- S100W2ZR/S100GAYKは契約曖昧、年度3件は従前の期矛盾でHOLD。
  年度・metric修正統合後の再資格は別に必要。本番反映・全母集団の完了は未成立。

私有 `split-body-offline-v1.json` SHA:
`4719053fb846e47f221f37fa91f840477694dcf877952b7a4413c14eeca26efe`。
ここでの資格は本文修正単独のpure結果であり、旧phase1履歴を置き換えない。

## 新しく見つけたS100W1Q5の競合

原本SHA `585f3040f06e2d4333c99a49cc6e01599e3d3421be54e8714f3dbfbdf200fc12`。
説明本文1候補と財務本文4候補を共通判定へ渡した。財務側2候補は前期として除外。
最高点12の当期・連結2候補は、収益認識TextBlockのcontractとセグメントTextBlockのcompanyで
異なるグループになる。同じ最高点の別範囲を先頭順や都合の良いscoreで採用せず、
既存 `multi-group` 停止でfacts0とする。診断のcontractは実heading/table/採用行を
既存 `contractOf` に渡して確認し、単一行の特別証明を推測で追加しない。

私有 `W1Q5-multi-group-v1.json` SHA:
`e9a9eaf1695f0f15d43c6a54e7796035b9286c10d00880f498e489453e9defdb`。

S100GAYK/S100W2ZRのmetric題名が狭いraw窓と直前layout表の境界で落ちる別原因も
同保存原本だけで確認し、別担当の共有修正へ引き渡した。ここではguard変更なし。
私有 `metric-local-diagnostic-v1.json` SHA:
`cb8a6c95dfe4132a7576ed3199126397652251f0368cc06bb747fce06e10e60c`。
