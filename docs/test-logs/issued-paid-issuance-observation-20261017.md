# 第三者割当の払込期日・普通株増加数の限定診断

2026-10-17。[#343](https://github.com/satoki252595/kabulab_tool_cloudflare/issues/343)の残件のうち、保存有報に明記された払込期日と普通株増加数だけを通常共有observerで読む。法的効力日、市場権利落日、価格/EPS/BPSの調整係数へは昇格しない。今回の検証は保存原本の純再生であり、本番データ反映・次の正常定時・全権利処理の受入ではない。

## 原本と完全形

実5820/S100YG3G/E01351、FY2026-03-31の保存type1 ZIP 573,918Bを無加工でfixtureへ固定した。ZIP SHA `4c0644e9c063246887191d10a83ed7e00b84b60de2dd9ffb6fd80797d4d7cbb5`、member SHA `527e6c6058e1627b94116ebcb5fcdfd5982e2c28971946a184e5128f68e5124c`、history fact SHA `e93273082fc4a937f06a3e4affddafe47e59476093ea4f68b4c142303291b3e8`。固定3666 manifestと既存6源の監査への来歴はprovenanceに保存し、新GETは0。

同じ `ChangesInNumberOfIssuedSharesStatedCapitalEtcTextBlock` の注2は、2026-01-21を払込期日とする第三者割当増資、普通株式160,000株、割当先、発行価格、資本組入額、資本金・資本準備金の増加を一つの完全な文で明記する。会社コード/SHAごとの出力分岐ではなく、この完全形の構文captureだけを対象にする。

既存の単一history fact・公式namespace・native context/entity・全文SHA資格を再利用する。元HTMLの単一7列表について、全見出しと株/千円単位、注番号と日付の一意性、160,000株の増分、前後残高、注記と資本金・準備金の増分/前後残高、最終株数と厳密普通株FY factの一致を検査する。期末4,279,965株と提出時4,479,965株を混ぜない。表の隣接注3は2025-04-01〜2026-03-31の行使320,000株であり、新診断へ合算せず旧optionのHOLDを保持する。

原文にある払込期日を `reportedPaymentDate`、明記増加数を `reportedIncreaseShares` として保存する。`legalEffectiveDate`/`marketExDate`はnull、`rightsApplication`はunknownのまま。予定、子会社、優先株、取消/訂正、未知/複数文、単位/数量/日付/表/注番号/残高不一致は新診断HOLD。文や表の欠測を0件成功で補わない。

## 正常経路と予算

`observeIssuedShares` の新optional `reportedPaidIssuance` は、既存Mapから読む。Actions→通常ingest→publisher→同RecoveryInfo/readback、保存prepare、正常resumeの同じ関数を通る。ingest結果にもstatus/理由/件数だけ追加する。Worker adminのfull観測無効は維持し、source/Notion要求・ZIP追加展開・DB/DDL・依存・モデル・株価/株数補正は追加しない。

旧基本観測64KiBと、option/消却の既存値を維持する。新診断は既存追加8KiBを共用し、旧option/消却を追い出さない。容量不足は新診断だけ最小HOLDへ、それも入らなければoptional欠測と構造化operator HOLD通知へする。欠測はunknownであり、新診断の検証済み0件ではない。既存RecoveryInfoの100要素/400,000B送信前guardも保持する。旧observer SHAのprepare/applyは通常guardに従い別planへ再準備が必要で、旧plan SHAを書き換えて採用しない。

## 保存6原本での比較

baseline `62a6de573ad44a87ed26b12cbb62e20f159c77bc` と同じ6ZIP計6,570,116Bを同一展開Mapで各5回、順序交互に再生した。全6源の旧全fields・株数・source・option・消却JSON SHAは完全同一。新診断observedは5820だけで、4568は元history資格不足HOLD、他4源は限定第三者割当の非観測である。これを全増資の非観測へ拡張しない。

| code | observer CPU中央値 旧→新(ms) | 新field追加B | 全追加診断B |
|---|---:|---:|---:|
|6484|39.631→42.101|381|1,975|
|6908|50.590→51.772|381|1,901|
|7313|78.374→79.771|381|1,926|
|5820|40.346→41.680|1,095|2,019|
|4568|68.236→69.080|238|899|
|2375|58.958→60.816|381|3,590|

全比較3.511秒、process peak RSS489,952KiB（旧新module/TS/展開Mapを含み、observer単独の増分ではない）。小さいCPU差を速度改善と主張せず、全735源/全市場/Worker128MiBへ外挿しない。結果は専用WTの `tmp/paid-issuance-proof-v1/paired-result-v2.json` SHA `3ab85227a0f4b928fd85d0911dc409f668adf0d644dd9909673e1db33cfec730`。全source/input/lock SHAを前後照合し、HTTP/model/DB/Notion/業務書込0。

再生は同WTのNixで `env -u NODE_PATH node --import tsx tmp/paid-issuance-proof-v1/paired.mjs <未作成名.json>`。baselineは固定revisionの同一bytesを要求し、原結果を上書きしない。通常producer回帰は実5820を同じRecoveryInfo PATCH/readbackへ通すが、Notionの応答envelopeは明示protocol投影であり、実本番の物理送信資格ではない。

実ZIPと予定/子会社/種類/取消/日付/株単位/注番号/隣接行使/株数残高/資本金単位・残高、history/提出時計/ordinary unit/重複、decoder例外・8KiB不足の負例を検査した。正常publisher/保存prepare/Node入口/ingest/CAS/旧basis/valuationを含むNix12 suites、全TypeScript、対象ESLintを確認。旧option/消却のfault比較は新optional診断を分離して元field保持を検証する。

払込期日の記載だけで法的実施済み・市場取引単位の一致を認定しない。130訂正/取下げの親子失効鎖、併合・他種類株・全増資/会社分割、Yahoo OHLCV/配当額のbasis結合、旧保存データの再受入は引き続き未完である。
