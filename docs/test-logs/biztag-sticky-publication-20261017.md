# 既存補足publisherの跨run結果不明停止 — 2026-10-17

## 問題と共通修正

既存`replaceEvidenceBlock`のarchive keyにはPREが含まれる。複数PATCHの途中で結果不明になり現在ページが変わると、次runは別keyを作れた。通常Macの`runBiztag`にcanonical `.env`の実体から導いた既存writer stateを使うFS sinkを必須供給し、metadata・モデル・最初のHTTP前に全未閉鎖状態を検査する。共有Notion publisherはtyped sinkだけを受け、Node FSをimportしない。新しいAPI要求・源取得・モデル・DDL・依存は0。

`replaceEvidenceBlock`は既存の全PRE/children読取後、**物理PRE archiveの最初のmutationより前**にfull PREとintentを`wx`/0600/file fsync＋親directory fsyncで保存する。従来の物理upload/検証・fresh PRE CAS・最新doc guard・新根拠・properties各chunk・全読戻し・旧根拠退役/読戻しを保つ。全成功後だけ別`completed.json`を同じ方式で追記する。旧PRE/intentは削除・上書きしない。旧文書IDは`page.properties`、次文書IDは`expectedProperties`とactual inputへ別々に束縛する。

次runは全dirが正しい3filesであること、owner/permission/symlink、UTF-8/厳密keys、全文PRE SHA/size、intent SHA、page/oldDoc/nextDoc、finite clock、POST SHAを検証する。欠測・不正・未閉鎖は全scopeでSTOPし、別page/PRE/docへ逃げない。同runもpending/FS failure後に次itemやreview-packet書込へ進めない。変更がない本文の既存short circuitは新journal操作を作らない。

## 実保存入力と回帰

- accepted B135 batch02の4502/S100YB5L、実2 PATCH chunksの全PRE・本文・新propertiesをgzip fixtureへ投影。元POST SHA `b4bf9a0db1ee186eca9fbb319712ccde8bd4094fa7c74bf5dbf86d9d93dfa1b0`、元normal物理PRE SHA `4b4ad71187f4724e152a5feb5e25e29f39fad3795aada1261a80615c5cbd4277`。245,721B gzip SHA `6a764699f39ea6031b34707cd153641ac74ad1e8c8ac8e11bac7ff5f629a59f1`。opaque UUIDは決定的投影、actor/metadata URL/request IDを除外、開示本文・実値・時計を保持する。新確率は作らない。
- chunk1適用→chunk2 unknownではPREが変わっても次factory/呼出しのNotion/archive要求0、旧PRE/intent bytes不変。physical PRE archive unknownもbusiness mutation前から同じSTOPとなる。正常2chunksと全POSTはclosure後に別factoryが受け入れる。
- saved104 source qualificationの実1716旧`S100WRZ3`→現`S100Z3L6`をidentityだけの小fixtureへ投影（元qualified SHA `92db45a02844d9c7719c755b8aa3fd67dd25ca06e1a0de96075cf9e8d6f451f9`）。旧→現の正常closureと適用済unknownの次run HTTP0を検証する。本文/意味判定・本番適用を主張するfixtureではない。
- pre/intent/completed各FS write中断、3file各欠測、PRE改ざん、intent SHA不一致、文書identity/時計/permission不正、二重closure、既存key再作成を拒否する。
- pipeline entryはunknown時metadata/model factories0。従来TypeSafe停止テストはisolated sinkを明示し、本来の開始日未設定エラーと通信0を保つ。

Nix/offlineで関連8 suites **196 tests PASS**、full TypeScript/owned ESLint/diff check PASS。テストのAPI ACKとFS faultは明示protocol projectionであり、実本番の結果不明を解決・再送したものではない。

## 費用・性能・運用上限

追加通信0、既存Notion原本保管回数は不変。ローカルfull PREを別途保存するのでdisk/CPUは増える。上限は1 PRE64MiB・intent/closure各1MiB・全store4GiB。新規操作前にcompletionの余白を予約し、上限はSTOPする。閉鎖recordの自動GCはしない。

旧helperでactual4502の1,318,964B full PREを3回測定したFS-only全体は28.37〜37.63ms、閉鎖後scan3.78〜4.12ms。saved B135の実135 normal PREは81,197,707B、最大1,604,226B。同分布の2417件条件投影は約1,453,739,688B（約1.35GiB）で4GiB以内だが、将来のpayload分布や完走を保証しない。各run初回に全closed PREをhash/parseし、各itemの`assertReady`はメモリ状態だけを確認する。

現在helper SHA `c3e9da56d90a3b623af4c4d476dc3837070aa254aa4b336b5e10b306d76aa598`で、実135payload全件のローカル3filesは81,303,177B、初回全closed scan232.55msだった。同135payloadを循環して2417件規模にした**測定用ローカルstore**は1,452,878,631B（PRE1,450,987,054B）、初回scan4,073.54ms・記録生成51.99s・sampled RSS330,956,800B。これは新Notion ACK/将来の2417分布/peak増分を意味しない。全store4GiBでの最悪scan時間は未測定。既存Mac `.env` symlinkの実体と`runtime.ts`が導くcanonical writer stateの同一性を、値を出力せず確認した。private測定helper/resultを保全する。

## 実運用と残件

このPR時点のlive実行/配備は0。Macは旧accepted sourceを維持し、新mainへの通常rollout後に別scope/pinsで検証する。定時20/21時calendar・30分外側制限は変えない。既存kernel writerの排他・canonical stateが前提で、手動の別stateによる迂回を通常CLIへ追加しない。

本修正は既存行の`replaceEvidenceBlock`を保護する。`createSupplementRow`（初回POST＋残PATCH）と`updateSupplementRow`（version_bumpのthemes/vocab PATCH）は同producer内に残り、現時点ではこのsinkを使わない。初回create/版更新の跨run unknownと旧PRE/CAS不足は別の最小共通修正へ進める。全20機能・全タグ意味判断・本番定時完走の完了とは扱わない。未知の既存stateを自動修復・削除・再送しない。
