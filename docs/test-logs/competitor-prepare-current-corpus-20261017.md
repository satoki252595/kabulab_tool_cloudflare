# 通常競合prepareの選定母集団（2026-10-17）

Issue #348。通常`competitors --prepare-only`の新しい入力準備に限り、既存D1読取が証明する
active equityと最新の有報/訂正有報へ候補母集団を束縛する。モデル、競合relation、旧保存確率、
旧83社のreplay、定時の固定33社、Mac runtimeはこの変更では動かさない。

## 根拠と保存断面

保存された10/16 21:20:33〜21:24:29の読取を現在の共有`loadLatestDocs`/`planWork`で通信なしに再生し、
固定876社の全work itemが同値であることを確認した。最初の銘柄SELECTは`core_stocks`単体で、
`is_active = ? AND instrument_type = ?`、paramsは`[1,"equity"]`。最新有報とのJOINで母集団を削った結果ではない。
記録されたnative responseは全SHAで照合した。SQLは固定共有ソースから再生成したもので、元のproducerは
SQL送信本文を保管せずresponseとpath SHAを保管していた点を区別する。

| 保存scope | 機械的に確認したこと | 未確認の範囲 |
|---|---|---|
| 歴史B23 | 10/14の同時刻planでは23社すべて最新docへの`retag`。10/16保存D1でも同じdoc/pointer・本文ok、保存原本23の全SHA一致 | 現在補足67列の再読取・旧結果不明の個別照合・現在の再推論資格は未受入。現在未完23とは断定しない |
| 旧skip99 | 共有planで99社skip。旧input receiptなし60、保存receiptあり39 | 39も今回意味判定や4節を再検証した結果ではない。未知60のSHAは後付けしない。99の再推論を計画しない |
| 未観測B13 | 全13が保存active equity集合3687に不在。共有qualifierは`active/latest-document-missing` | どの個別DBフラグが条件を満たさなかったか、非上場化/移行等の原因は未観測。原本不存在とは言わない |
| 固定A33 | 保存A876内のmetadataはskip6/sync22。root607件受入断面ではsync22の19受入/3残。A33の5社はこのfresh補足scope外 | 新しい候補/全39実入力の受入と意味判定は未完 |

B13は1909/1948/2180/3480/3787/4800/7082/7183/7490/7709/7851/9508/9914。
旧corpus3689と保存active集合の交差は3663、母集団外26。そのうち固定83の候補に入る13がB13で、
影響Aは27社。別の文書世代差B27によるA33と8社で交差し、両者の和は52社。
これは旧固定断面の比較であり、configured33を52へ広げる根拠や現在の候補ランキングではない。

歴史B23と10/16通常20時の`qualificationHeld23`は別集合（交差0）。通常biztagは毎回fresh planを作り、
入力doc変更をローカルClefの対象とする。`--mechanical-only`ではその意味判断をHOLDする。
20分の新規作業予算とDB順を使うため、197/3687件処理のsummaryから全量完了や個別の処理済みを推定しない。
既知canonical journal8入力にB23の一致は0だが、歴史的なモデル試行の不存在証明ではない。
原本文3666の回復と補足本文776の同期は別scopeであり、合算しない。

## 最小の通常prepare変更

`prepareCandidateInputs`へ既に取得している`latestBefore`を渡す。共有qualifierから薄く切り出した
同じ主体・doc/FY・提出日時照合と、通常planの`hasUsableText`を使う。現在active/latestに無い行、
本文pointer/stateが未資格の行、現在文書と一致しない補足行、未判定タグ行を選定前の母集団から除く。
除外は理由付きで保存し、個別原因が不明な行を`inactive`と記載しない。

この母集団には`active-equity-current-annual-v1`を明示し、選定時の全active/latest snapshotとSHA、
除外理由、policy全体SHA、corpus SHAを既存manifest/gzip/input SHAへ束縛する。
manifestの保管形式v1は維持するが、新policyを持つ新入力であり、旧確率を流用しない。
較正済みK/重み/posting caps・モデル/しきい値の変更は0。
母集団変更はIDFや順位を他社にも波及させるため、影響を候補に旧26を持つA27だけと保証しない。

選出済みBの39本文/receipt/現在タグが不足した場合は、候補とqidsを維持してAをHOLDする。
資格失敗した候補を後から削って別候補で採用する処理は足さない。A自身が母集団外、または候補が0件でもHOLDであり、
競合なしや判定完了とはしない。Afterでは実際に消費するA/Bのactive/latest世代を選定時と照合する。
未採用の無関係docの更新を理由に全stageを停止する新しい制限は足さない。空/重複snapshotは保管前に停止する。

既存2passのD1/Notion読取数は増やさず、同じ共有archive/全物理確認を使用する。
選定前のmap/filterとsnapshot保管量は増えるが、全量のCPU/RSS・所要・候補再現率は実本番未測定。
既存5件/7分・0.3rps/全体30分のstage予算とscopeは変えない。

## callerと受入

- 通常prepare CLIだけが新policyを使う。モデルを呼ぶ通常`runCompetitors`は変更しない。`--dry-run`はモデルを呼ぶ従来契約であり、機械準備には使わない。
- 旧`recover-unjudged-competitors.ts`の`active`は`loadIngestCodeToId`で、実際は開示取込用のinactive equity等も含む契約。旧replay/source hashを守るため今回変更しない。
- stageはmanifest/gzip全文SHAと物理receiptを照合する既存入口を使う。新policyを含む実出力→stage ACKを既存の実2社投影fixtureで回帰する。
- 現Mac117b・旧first5 private plan/source pinは固定。将来の切替えはbody776全受入/所有process閉鎖後に新source pinと新prepare入力を別受入する。今回runtime配備・本番HTTP・モデル・業務書込は0。

fixtureは[既存の実2社/原本来歴](competitor-mechanical-prepare-20261017.md)を再利用し、新しい架空本文・確率は追加しない。
通常CLIのモデル/TypeSafe/API-key factoryを拒否する回帰、母集団外/annual欠測/本文未資格/旧文書、
空候補HOLD、A自身の欠測、選出BのAfter driftとqids保持、空/重複snapshot STOP、無関係doc drift非停止、
同入力skip物理確認、実manifest→stage ACKをNixで検証する。
関連7 suites / 148 checks、TypeScript、対象lint、diff検査が成功した。

私有純監査は`tmp/feature-audit-20261017/biztag-remaining-classification-v1/audit.mts`
（SHA `d602610453cdf9fcceed15f9255dcabc642a6b1b5a81a0e5d1638a3b9c519b90`）、
`result-v2.json`（SHA `7663fef6ef2fbc4eb7053a24fc822d8e55d40e4a957964b527fea97e9e4f5137`）。
原本本文はGitへ追加していない。分類は保存断面だけの結果で、現在の全量受入ではない。
