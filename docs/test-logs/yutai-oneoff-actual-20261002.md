# 8508 単発優待の実基準日 — 本番限定修復 (2026-10-02)

Refs #146 / #102 / PR #258。[PLAN](./yutai-oneoff-plan-20261002.md) の限定修復を実施した。公式原文・D1 応答・財務実値・秘密情報は公開 Git に置かず、物理 ZIP とメタを一次データ保管へ保存した。本番 writer は root 排他調整下で実施し、2026-10-01 17:04 UTC に返却した。

## 資格・範囲

[Jトラスト公式・特別株主優待](https://www.jt-corp.co.jp/ir/jstock/special_yutai/) の取得済み原文（52,709 bytes、SHA256 `d434f203cf43d172bed387c1a60b3bc33ecbd4c13c094a60ed722b1bb5e09cca`）から、2026年9月2日の基準日・100株以上・今回限りの制度・受取期限を確認した。原文/実GET manifest の物理保管・readback は [PR #255 の実績](./yutai-hold14-actual-20261002.md) を再利用し、元原本の上書き・再送0。実行直前に同じ source ZIP・全 member bytes/SHA と既存 custody receipt を再検証した。

benefit 38642 の `record_date` を `2026-09-02` に設定し、`updated_at` だけを同じ UPDATE で変更した。旧 `record_month=6`、掲載文、要約、株数、金額・金額出典は保持。通常6月の別4行は全12列不変。単発日を9月末や毎年9月の権利へ読み替えていない。新たな金額認定0、現在の買付で過去基準日の資格を得られるとの案内0。

## DDL・本番コード

Wrangler 4.101.0 の `migrations list --remote` はローカルの migrations_dir 未指定で停止し、remote query/write0。installed handler は list の前に台帳初期化を行うため、一時configで再試行して台帳を作る処理は行わなかった。SELECT-only で台帳不存在と対象旧11列・`record_date` 不存在を確認した。

fresh `sqlite_master` 実DDLをローカル SQLite へ展開して、0025 snapshot の owned23 tables / 292 columns の列集合・型・nullability が一致することを確認した。既存 `_cf_KV` と `jss_*` 9 tables は root の精密化した grant に従い別所有の既存追加表として隔離・列挙し、変更0。動的 PRAGMA の2 queryはSQLITE_AUTHで停止したため、別値による補完はせず実DDL読取へ切り替えた。

Nix 管理の project-local Wrangler で生成済み `0026_violet_deathstrike.sql` の単一 ALTER を1回適用し KNOWN SUCCESS（CLI total queries1 / total_attempts1）。台帳 CREATE・DROP0。fresh確認で `record_date TEXT` nullable / default NULL、benefit12列が一致した。旧11列PREと gate 原文は適用前に物理保管/readback済み。

root が PR #258 の exact head `dfa1716` を squash mergeし、main `621d3499afe77685e59cfe0d3d73bd61a067c3cb`、本番 Worker `338e8d87` の100%稼働をUI確認した後に CAS grant を受領した。新アプリを列追加前に本番配備していない。

## 実 PRE → 原子 CAS → 実 POST

DDL後の fresh PRE は core1×11 + benefit5×12 + financial1×19 + score1×7 = **97セル**。5行の `record_date` は補完値ではなく実応答の NULL。旧11列の各値も旧実PREと全一致した。source資格・fresh PRE・固定 packet を共有保管し、full readbackの後だけ sender へ進んだ。

固定 packet SHA256 `22300eef23d7383483f3ef87b940eb9e62dc80014cb5d53f9aa46f1b169b318c`。root は private actual planner / date producer / executor / 生成2SQLを全読し final gate PASS。1原子 batch / 2 statements（全4表・件数・NULL・両方向 EXCEPT guard → id38642 の日付と更新時刻だけ UPDATE）を1回送信した。

KNOWN SUCCESS の後、全4表を fresh readし期待97セルと全一致。実 POST を同じ producer へ再入力して effect SQL0・実送信0。実行計5 native requests（batch1 + POST読取4）、resend0。実POST完了は `2026-10-01T17:01:40.479Z`。`updated_at` は固定 typed Date producer stamp を書いたもので、実D1 POST値と一致を確認した。サーバ生成時刻・送信完了時刻と偽っていない。

financial 全19列、core 全11列、score 全7列、対象外の通常6月4行の全12列を保持。年間利回り・定常月の共通再計算は追加SQL0、定常月集合 `[6]` は保持した。対象外データの修復・追加課金API呼出0。

root は[本番8508詳細](https://kabulab-cf.satoki252595.workers.dev/otakara-yutai/stocks/8508)を読み、デジタルギフトに `単発基準日 2026-09-02`、通常優待に6月が表示されることを確認した。基準日のバルーン説明と、単発日を案内するGUIDEも表示されている。全体スクリーンショットは私有保存し、公開Gitへ一次データや財務値を追加していない。

## 物理保管と全文 readback

全て shared `recordPrimaryData(force:false)` / unique row / `verifyArchivedAttachments` の既存経路。ZIP・manifest添付の fresh全文downloadが元bytesと一致し、manifestの全 member bytes/SHAを確認した。重複 key の代替作成・上書き・再送0。

| 種別 | key | ZIP bytes / members | ZIP SHA256 |
| --- | --- | --- | --- |
| 旧11列PRE・schema/DDL gate・ローカルPLAN | `yutai-oneoff8508-old-pre-20261002-eb1cd83b3de3` | 35,850 / 46 | `eb1cd83b3de39d2e56437fce240bee7a59cdd3c2a9a9dbaa00681ca703da211e` |
| 実12列PRE・固定packet・actual入力SQLite検証 | `yutai-oneoff8508-pre-20261002-c5ba62cb2deb` | 20,931 / 26 | `c5ba62cb2deb503ebcef7653015e1a4a10f6a27c6f6a19d4499a7fe3b7a752d6` |
| 実POST・実行原文・同producer再入0 | `yutai-oneoff8508-post-20261002-eb4e0d300985` | 13,837 / 20 | `eb4e0d300985e6a9e3f1d3a7126112dd667356903c77ebad417209deda09cf0d` |

private retained paths は worktree の `tmp/yutai-oneoff-8508-20261002/` と `tmp/yutai-oneoff8508-actual-20261002/`。旧11列の証跡を実12列として扱わず、追加NULLのローカル期待と実応答を別記録にした。

## 検証と残る範囲

PR #258 の3 CI（check / python-pipeline / Workers Builds）は全SUCCESS。Nixの関連20 files / 455 tests、typecheck、変更対象lintはPASS。actual fresh12列PRE/固定packetでもローカルSQLite9 casesを再実行し、normal期待97セル一致・同producer再入0、8 drift（対象日付/別benefit/core/価格/data_date/score/行追加/行欠落）のguard拒否・rollback後全値一致を確認した。

旧HOLD15の最後に残った8508の単発表現と日付保持経路を、この1行で閉鎖した。金額未評価・選択/抽選等の既存HOLD、対象外の原本資格不足、外部API課金切れを解決済みと扱わない。full import は日付の同identityを失った場合、単発行を削除する前に停止する設計であり、新規の実基準日を月情報から推測しない。
