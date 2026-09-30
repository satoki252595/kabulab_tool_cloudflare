# Owner 2-READ CODE-CLEAR 準備記録 (LOCAL・未実行)

日付: 2026-09-30。ブランチ `packet/owner-2read-20260930` (LOCAL)。
live 実行 0 (D1 READ 0・write 0・dispatch 0・Notion 0・source GET 0)。
本記録は hash-first 報告用の固定値 (生値なし。SHA・件数・真偽のみ)。

## 実行物

- `scripts/sync/owner-2read-execute.ts` (2-READ executor)
- 送信路は既存再使用のみ: `createBoundedFetch` (budget 2) +
  `createCaptureFetch` (exact URL/SQL/params 照合→marker 予約→attempt.log
  fsync→forward redirect manual→strict の前に whole body wx0600 保存)。
  新規 capture framework なし。
- guard は既存 idiom 再使用: exact 射影 JSON 比較・per-code exact-1・
  `holdPrivate`/`durableAppend` (public safe label・private 詳細)。

## 固定 pin (pure preflight 確定)

- (1) packet 正準 typed SHA:
  `6c7fb424b175bf23e0d6b5ca827146e7b0167a85819d8b97a1df48b4d9079440`
- (2) typed D1_DATABASE_ID literal SHA (Root grant):
  `a7bcf8e2f330e5c81f78e063131dc8837c90d7db9c07388ad7eeca4c8768ba0e`
- (3) exact-forward query URL full SHA (正準 .env で計算・prefix 照合なし):
  `8a2fc196212244e660668396fcdd92228f1b2120b6dd16145bbdeef321ddeb49`
  (先頭 8 chars `8a2fc196` は Root grant と一致。値の表示なしで計算)
- (4) modules full SHA (6 件。loaded 全 module + runtime lock):
  - capture (overseas-fresh-read-capture.ts):
    `3e25047d6c77a8c74626c0f67ac075923501e315612f0ab5c399643b91732060`
  - selectProof: `6c864f43b8141162783368c311c2abd8e673e34dd58c82469618173e7a96bf05`
  - d1Client: `2d16180bdf864bcade9f8850b922f99b768be8de3bcbe427900fc9ec7afda1c1`
  - sharedEnv: `183af3b9847673b5ea3863f81b0866c7d078075193b702631bfd7941bb1e8d15`
  - ipoBridge: `462c1219b923165ac8a949f479fe459542272e49c0c7ab73475aaaa251f055b7`
  - pnpmLock: `805dd5b36ca9ec385b29de1ded715305537eac514dbc7c77dfc55b2d56617e58`
- (5) sources (packet file bytes SHA):
  - r1: `997bcf8442ba0f7baddca249b30bea3e844d4cb47ae609acf955e6599fa5312e`
  - r2: `d9e35a8d8a8fd18492f10588317d05f853046c2cce3f7f85252792ceb4bd8d0e`
- (6) ownerpost SHA (Root 提示 baseline):
  `9bc6b50b7fa3ac86edd17bf87ef60625428423e72efa9df86de7ca741a5b1ec8`
  (hash に加えて full source を parse: 47 identity 照合 + sector6 適格 6
  full-11 baseline を private 0600 `sector6-baseline-proposal.json` に出す。
  値は public 報告に出さない)
- runner self full SHA (報告のみ。pin 不可):
  `a9545861aa7f7ed8282f2a06195ea37be13a65aefcca824877ecdcc799766026`

## 予算 (固定・upfront + 送信時強制)

- sends cap 2 (R1 47 binds + R2 41 binds)。D1 READ 2・write 0。
- dispatch 0・Notion mutation 0・source GET 0・Yahoo 0。
- Notion custody なし (outDir local 0600 のみ)。key 導出なし。

## R1/R2 guard 要約

- R1 全 47: exact-4 射影・code 既知・欠落/重複なし・cardinality 47・
  id 整数正・id global 一意・ownerpost identity semantic 一致。
  違反は STOP (R2 前 throw。whole body 保存済み)。
  gate は active-equity のみ (適格 40 未解決は HOLD 記録し R2 不送。
  除外 7 は現状記録。malformed 7 は不可)。
- R2: exact-8 射影・stock_id ∈解決 40・date=2026-09-29・
  (stock_id,date) 重複 0・cardinality ≤40・OHLCV 6 値は有限数 or
  明示 NULL (DDL 通り。NULL 保持、0 埋めなし)。違反は STOP。
  sparse 欠落は許容し code 記録する。

## 検証 (offline)

- `tsc --noEmit`: repo 全体 PASS (2026-09-30)。
- `--preflight` (dummy env): packet/構造/modules/sources/ownerpost+parse
  まで PASS し `DB target pin 不一致` で STOP (送信 0・書込 0)。期待通り。
- `--preflight` (正準 .env。`node --env-file=<正準> tsx …`): **PASS**
  (exit 0。全 pin 一致・47 identity parse・sends 0・FS 書込 0)。
  stdout は private 固定 artifact に保存:
  `/tmp/owner-2read-preflight-20260930/PREFLIGHT.json` (0600)
  SHA `d76559ae3f808c1e5d268eb13858d2ef8ba796fa947157960607a643b54a7e6c`
- stdout 公開形は counts/SHA のみ (`publicReport`。HOLD 時は safe generic
  label)。per-code 配列は private 0600 の outDir ファイルにだけ残す。
- 送信失敗は capture 後に `holdPrivate` で包む (provider body は private
  hold-details.log のみ。console は safe label のみ)。
- 既存 `overseas-fresh-read-capture.test.ts`: 21/21 PASS (export 追加・
  kind 拡張・PINS 更新後)。
- ONE 2-run は CODE CLEAR + `--grant=` の後に限定 (Root first)。

## 実行順序の truthful 記録 (監査指摘への訂正。backdate なし)

- ONE 2-run は owner PASS + ローカル条件付き CODE-CLEAR/hash 固定の後に
  実行したが、Root の最終 independent CODE CLEAR + hash-first Root 通知
  の前に実行した。最終 accepted 指示はその順序を明示要求していた。
- 事前の CLEAR を主張しない。日時の backdate をしない。
- GPT-sol 事後監査は artifacts に対する PASS (実行順序の limitation 付き)。
- READ2 budget は消費済み。再実行・再 READ・再 archive なし。
- 以降の source5・WRITE・archive・verify は固定 pins + 明示 CODE CLEAR /
  run 通知まで 0 のまま。tests/preflight は実行しない。

## ONE 2-run 実績 (2026-09-30。認可済み 1 回のみ。counts/SHA のみ)

- HEAD `f469464`。outDir `/tmp/owner-2read-live-20260930` (0700・全件 0600)。
- result READ。exit 0。sends 2・responses 2 (cap 2 以内。認可消費済み)。
- R1: rows 47・held 0・excluded 7 記録・unrequested 0。
  body SHA `3187e4c8…afbe7` (3505 bytes)。
- R2: sent・rows 0・held 0・missing 40 (sparse 全欠落。許容+記録。
  STOP 条件なし)。body SHA `497e22b7…ed44fe` (364 bytes)。
- sector6: rows 6・missing 0。proposal SHA `d38309e3…481d4`。
- holds 0。attempt.log 4 行 (send 2 + receipt 2)。marker 2 件。
- 再実行なし (新規 outDir での live は別認可が必要)。

## 既存 capture 側の互換維持

- `overseas-fresh-read-capture.ts`: `sha256Hex`/`setSHA` を export 化、
  kind union に `R1`/`R2` を追加 (既存 Q1F/Q2F 経路の挙動不変)。
- byte 変更に伴い PINS を successor 更新 (f352 方式と同一手順):
  - captureSelf (normalized): `4f18b30f…` → `a435b3b13b57576d9bd02531d69fb26b20c61dd718ef4a9f631040b2fa73cc3c`
  - d1Client (full): `f2dc8d7a…` → `2d16180bdf864bcade9f8850b922f99b768be8de3bcbe427900fc9ec7afda1c1`
  - e5e4463 bytes での正規化再計算が旧 pin と一致することを確認済み
    (機構の正しさの証明)。旧値は git history に保持。docs の旧 proof
    は書き換えていない。
- `d1-http-client.ts`: merge 解決 (両 export 保持) + `assertBindableParams`
  の export 化 (1 語。挙動不変)。
