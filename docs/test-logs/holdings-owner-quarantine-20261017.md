# 完了済み保有明細の主体資格を明示保留する通常入口

208A/S100Z0JO/FY2026-06-30の保存原本は、最大保有会社を提出会社とは別の名義で明示している。共有parserの[全218文書比較](holdings-largest-holder-20261017.md)と、既存4行の表示を保留へ移す操作は別に受け入れる。今回の通常CLIはまだ実行していない。

`scripts/notion/shareholdings.ts quarantine-saved-source <input.json> <out.json>`だけが共有`quarantineSavedHoldingSource`へ入る。自動ingestや通常publisherの「完了sourceを解析保留へ降格しない」条件は変更しない。1source・既存4行、通常のDEI/typed原本reader・全ZIP SHA・完全な最大保有会社文型・unsupported/unqualifiedを要求する。以前に受け入れた4行の値は新たな所有主体資格とは扱わず、旧facts SHAと全出典・旧金額を保全するためだけに照合する。

入場には最新doc/owner/EDINET/FY、schema、同一sourceの全props/時計、全期末行と正確な4ID、元published intent・root全POST受入を固定した新しいPREが必要。旧range08 POSTは履歴証拠でありfresh PREではない。価格はcanonical株価・時価ともNULL、価格checkbox false、価格cursor0/欠測数0を要求し、0でも非NULLなら停止する。source/priceのunknown、原本・行・schema・旧factsの差分も停止する。

canonical `.env`実体からsource/doc/ZIP専用の永続onceを置き、別outやPREコピーで再送できない。これはMac/Gとの共通lockではない。rootが通常Mac20/21、同source全props/clockを読むactor、source診断PATCHの衝突と終端・予約を確認したwriter-order gateを別に束縛し、全書込前のlatest照合で入力SHA・期限とともに確認する。

同じ共有Notion入口で全source/全期末/旧intentの物理PREを保存・全文照合し、再度fresh source/全期末/対象行CAS後に4行をsingleAttemptでPATCHする。変更は`原本照合済=false`と旧`欠測理由`の全本文を保持した理由追記だけ。全4行を読戻した後、sourceの明細・価格状態をともに「要確認」へ移し、両理由へ旧本文を保持して追記する。価格queueを「再開待ち」に残して通常price再開のsource完了assertを故障させない。両再開info、cursor、株数、金額、原文・原出典・原取得日時・作成時計は変更しない。編集時計はproviderの実応答を保存し、元時計は物理PREに残す。

source/全期末の全POSTと物理POSTを照合した後にもlatest/source/全期末を確認する。新表示は既存formulaの「未検証（旧取込）」と、`欠測理由`の明示主体保留理由である。新schema/DDL、株数・価格の補正、行の削除、完了0行への変更はない。途中でunknownならonce/pending/原値/原intentを残し、別出力へ再送しない。

Nixの実208A ZIPと全4行・全sourceのプロトコル投影を使い、両queue保留・全旧props保持・物理PRE/POST、非NULL価格/価格checkbox/unknown/ID順/facts/ZIP/全期末差、PRE後drift、各PATCH/物理unknown、別outへの未commit/既commit unknown再送拒否、自動publisher降格禁止を確認した。fixtureでは署名URLとHTTP応答時計の投影を明記し、会社名・株数・金額・決算期・出典を生成していない。実providerの新ACK/編集時計や新fresh PREを既に観測したとは呼ばない。原本API/モデル/本番通信・訂正は0。

通常publisher/unknown/replacement/inspectを含む5suites147件、型検査と対象lintはPASS。さらに通常client/archive/upload/download/readbackをmockせず、全fetchを隔離したtransportへ渡す1再生がPASSした。API49・hosted3、要求243,630B・応答1,903,426B、PRE83,878B/POST149,992Bの2物理、5業務PATCHを通った。latest callback7回は別で、D1 nativeを送ったとは呼ばない。Nixで18.68秒のこの再生はprovider実性能や新ACKの受入ではない。private `tmp/owner-quarantine-wire-v2/result-v1.json` SHA `017f7d4b0ecd331c4ea96e9ac98847347f909c518a27570a46ba62c1138ad8b6`。

root有限操作の予算候補は1source/4rows、全native128/API96/hosted8/D1 SELECT12、retained32MiB/request8MiB、1800秒/各native60秒/最後65秒余裕。上記wireに7回の通常latest SELECTを加えても収まるが、実pagination・原本/schema/clock差・upload pending・通信unknownで停止し得る。既存captureで実行時に累積上限を守り、rootのactor順序・実freshPRE・releaseへ別封印する。root release・実4行の全POST・独立監査前には、既存checkboxの訂正済みや価格採用を主張しない。

root reviewで、select.nameが未定義optionを暗黙追加する境界を確認した。明細・価格の両状態に「要確認」が既存であることを物理/業務前に要求し、欠ける場合の書込0回帰を追加した。型だけのmockを実保存source DB schema（range08 native123、SHA `a5479ea398b647b15497756215c06c7e24f6127acae042f2e24052e5096dd3d4`）のid/description/properties投影へ置き換えた。旧manifest/wire/source/fixtureはprivate `tmp/quarantine-v1-preserved/`へ全SHA一致で保持し、v2の別namespaceで再生した。

rootは機能2file・全caller・通常latest SQLの7 callback・全wireを独立確認してPASS。root wire SHAは `1a0b1997ca2edbd7a363f1f79650be1c78f7f5cffd478cc2b17e32560dd75651`、precommit reviewは `tmp/feature-audit-20261017/continuation/holdings-quarantine-root-precommit-review-v2.json` SHA `6a0a3a49030ecc78d613d8a51ededd918d7b5a406d5f33f75b91dfa493462407`。この受入は純再生であり実4行は未訂正。機能2fileのSHAを変えず、実ZIPは既存 `holdings-largest-holder/208A-S100Z0JO.zip`（SHA `f790c39dab53fe4b86a4d7173cc21abbe69c65735a1083402a3ad51b376ced10`）を再利用し、重複fixtureを追加しない。旧v2全bytesは `tmp/quarantine-v2-preserved/`に保持した。
