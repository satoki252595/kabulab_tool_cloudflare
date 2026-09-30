# Universe overlay 9/30 actual proof (2026-09-30)

JPX 上場廃止/新規上場/市場変更 overlay の daily population 実適用 + 検証の
tracking 記録。Refs #196 (Fixes は prod + acceptance 後のみ)。

## 明示 scope

- 対象: 2026-08-31 monthend base + 2026-09-30 公式 events overlay の D1 実適用
  (owner 31stmt batch 1 send) と適用前後 3-SELECT 照合。
- 含む: pins / counts / actual attempt ledger / clock contracts /
  local-input-reject 訂正 / sender コメント訂正 (本 PR の唯一の code 変更)。
- 含まない: source GET 0、price GET 0、R2 0、dispatch 0、D1 追加 mutation 0、
  post retry 0。denylist なし、post-delist positive なし、推測なし。
- 生 payload (production raw / body / preimage / full post) は Git 対象外。
  private 0700/0600 と物理 Notion archive のみ。本 doc は hash/count のみ。

## Base

- 原子 batch 本体: PR214 merged (main `854576b`)。本 PR は `cd25a81` 系 main の
  通常追従 + コメント訂正 + 本記録のみ。
- 適用 body は frozen `913ba9b8...de80` (1187494B) を exact 送信。restamp なし。

## Pins

| 対象 | SHA256 |
|---|---|
| owner runner (`owner/run-owner-apply.ts`) | `ed9cbbf4e5e28c297677d5ecb0f545ccb502cb6691b37264a8e460e87e8de4d9` |
| post runner (`post-read/run-post-read.ts`) | `3a64f83f835d9b0e602750e74d3e0a8c0d41d623d51f4c8ebfa8080381c05ef1` |
| capture runner | `95442d76ad39c4382ad181c0beb59647e28416220784c78d72b75031c828dcc4` |
| guard probe runner | `8197b0bfa68c5189e459f89bfdc616e6ff40a9a1db15e4790fb1b3f3cd015373` |
| guard archive runner (corrective v2) | `f9a7fedcf7f23c8c646509a01fe3f813b815dcb0616e6ba93fcee8ce1b3d0a8d` |
| frozen owner body (31 stmts, maxBind 99) | `913ba9b86018346e10bb092ae2e4a8949a6d5f4b6f755d8128240f99c484de80` |
| combined SQL packet (3 SELECT) | `d62269057a8931b9047b6322ec0e87006343ebb5aa7ae408bb00ff51eb0cb568` |
| SQL q1 / q2 / q3 | `ccbe3e31...` / `e5c8bee7...` / `adf368ac...` (full は runner allowlist) |
| bundle manifest (28 members) | `9d1b5d3cbbb3a8eb2fc1353dfe96c89114fce66c4cea9cfb1c8cbc1d8397eb32` |
| bundle ZIP (627480B) | `d606990dde14bd755a2b3e637f1ef2ab7b594f7607fcc52c885ffb8375abd934` |
| module `src/cron/universe-overlay.ts` | `a019f0ed68b774af92d42dd78fe558593caabf15c616de23d38ca4c2dfe3c2d2` |
| module `src/shared/db/d1-http-client.ts` | `fddd876f20edca7aad54debee213854929e142d8c360cc5f5ae3396be6b5be2a` |
| module `src/shared/env.ts` | `183af3b9847673b5ea3863f81b0866c7d078075193b702631bfd7941bb1e8d15` |
| module `src/shared/jpx/basic-profile.ts` | `064a5395012cfa6df974e19dbaa19aa37273330835c69d9cb848267595e2a1c3` |
| module `src/shared/sha256.ts` | `da3711c4f39656b665f46aa2922adbdf41f3af5045fcf28301540da521a001de` |
| D1 target (SHA256 UTF8 exact D1_DATABASE_ID) | `a7bcf8e2f330e5c81f78e063131dc8837c90d7db9c07388ad7eeca4c8768ba0e` |

注: 上記 module pin は適用時計測値。本 PR の `d1-http-client.ts` は
コメントのみ変更のため、適用証明の pin 対象は変更前 file のまま。

## Counts (actual)

- pre core 3810 → post core 3819。activeEquity 3695。events 0 → 226。
- delist 14 / listing 9 / transfer 5。touched 19 (14 deact + 5 market)。
- protected: 既存 3810 createdAt + 非 target 3791 updatedAt strict 不変。
- 変更集合 (code + changed cols) が frozen 期待と完全一致。
- new9: id 9 unique、business 8 fields exact (market exact 一致)。
- runtime epochs 37 値 (new9 created/updated 18 + touched19 updated 19) が
  実 clock interval 内。event id 226 unique (1..226)、他 11 fields strict 一致。
- state 10 exact (appliedAt は frozen plan 時刻と exact 一致)。
- reentry: applied false、collect 0、send 0、mem tuple 不変。
- guard bind 948639B (D1 string 上限内)。

## Actual attempt ledger

全 send は durable counter burn (wx) 後 1 回のみ。retry 0、redirect manual。
whole HTTP raw を判定前に wx 保存。

1. capture 3-READ (packet `d6226905...`, counter [1,1,1]/3):
   q1 968008B `8373355a...9a2b28` 200 (3810x11) /
   q2 363B `d60925aa...44ab2` 200 (0 rows) /
   q3 363B `23094163...c2180` 200 (0 rows)。
   snapshot SHA `2764e39c21fef6fc03581046fee573a30516c5e1973f9ee580071177f77c9c4e`。
2. guard 1-READ (counter 1): PASS、sole TEXT "null"、raw 1225B
   `918b49430b3dacfdabc3ae08767980a5e8be0e22b8df89de5659b800a9c51590` 200。
3. owner 1 send (counter 1): APPLIED-known、forwarded 1、HTTP 200、
   raw 10591B `3818d7128b19124150d1dfec3a67a62b644dbfdd4d1a541c9c1231a8428270dd`。
   top success true、result len 31、全 entry success true、errors []。
   meta changes 合計 255 (= 9 + 19 + 226 + 1)。
   startedAt `2026-09-30T08:35:31.658Z` /
   HTTP Date `Wed, 30 Sep 2026 08:35:32 GMT` /
   completedAt `2026-09-30T08:35:32.358Z`。
4. post 3-READ (packet `d6226905...`, counter [1,1,1]/3): POST-VALIDATED。
   pq1 970194B `03c33801...43839117` 200 /
   pq2 684B `d32237c9...39332f` 200 /
   pq3 109185B `76832581...bc2a52` 200。
   post snapshot SHA `9bc6b50b7fa3ac86edd17bf87ef60625428423e72efa9df86de7ca741a5b1ec8`。

## Clock contracts

- new9 `id/created_at/updated_at` + target19 `updated_at` は DB runtime 値
  (`unixepoch()` を D1 実行時に評価)。code 側の時刻生成なし、± 許容差なし。
- 検証 bounds は実 clock からのみ導出:
  `[floor(owner startedAt), floor(owner completedAt)]` =
  `[1790757331, 1790757332]`。HTTP Date (floor 1790757332) が区間内であること、
  および 37 epoch 全値が区間内であることを確認。missing/invalid/inconsistent/
  out-of-bounds は STOP + raw 保持の human review。
- `state.appliedAt` は plan 構築時刻 (frozen bind) であり、適用が書き換えない。
  post 検証は frozen 値との exact 一致を要求した。
- `universe_official_events.id` も autoIncrement のため 226 件全 id が runtime。
  他 11 fields を (kind, code, effectiveDate) 対応で直接 strict 比較した。

## Local-input-reject 訂正 (guard receipt)

- v1: `STOP-unknown` (LOCAL unsupported `.bin`/octet-stream 拒否、API 0、
  first await 前の決定的拒否)。receipt 保持、再送なし。
- v2 corrective (same key `guard-receipt-2026-09-30-6a7debc4...7c61d4c`):
  4 files を `application/json` で再構成し `RECORDED`
  (recorded/written 08:08:55Z、verdict 08:08:58Z、manifestMatch written)。
- main bundle (`fresh-snapshot-2026-09-30-d606990d...5abd934`) は
  `RECORDED` (07:40:58Z、28 member pins、fileTooLarge false) のまま不変。

## 本 PR の code 変更 (コメントのみ)

`src/shared/db/d1-http-client.ts` の batch sender doc 訂正:
旧「失敗時は同引数の再実行 (冪等) で回復」→
新「known-failure / unknown とも throw して STOP、同引数再送なし
(resend 0)。unknown は読み取り専用照合で状態確定後に人が判断」。
ふるまい変更なし。

## Collection remainder (未収集・別 lane)

- 本証明の 9/30 qualification / sourceAsOf UNKNOWN は current-only を
  証明する。9/29 historical の証明ではない。
- 将来の past-target IPO には dated admission / stock class / domestic
  primary の evidence が必要。保存済み 618 一部 PDF の dated legal
  classification は unresolved のまま HOLD。current Basic の observedAt は
  historical proof にならない。
- 9/29 price40 と new9 EDINET 公開 sector33 は別 owner lane。
  Basic industry → sector33 の自動読替えなし、自動完了主張なし。

## 物理保管 (Git 外)

- private: `/tmp/fresh-snapshot-read-20260930/` (0700/0600)。
  owner raw/meta/verdict/counter、post pq1-3 raw/meta/attempt + snapshot +
  criteria、capture/guard/archive 一式。
- Notion: 上記 2 record keys (bundle + guard receipt)。
- D (price47 resolve-only actual post) handoff は readonly packet を別途用意し、
  dispatch は Root が行う。

## Actual proof archive (RECORDED)

- conditional one GO のもと 1 回記録。verdict RECORDED
  (outcome recorded、manifestMatch written、fileTooLarge false、
  19 member pins、strict readback 通過)。
- recorded/written 2026-09-30T08:49:31.174Z、verdict 2026-09-30T08:49:33.809Z。
  counter 1。unknown なし、replay 0、newkey escape 0。
- runner `c26f11530dde94ba0d263182e0cf26723cd5abb6e8d14a93256191bb39e6c9e1` /
  ZIP 183671B `3eaff8c3cb73982d03a2b211d3dee0d5876718fa91b743d84682483202f810a3` /
  manifest `1a5fe8c3138a9b0c37c80c9c63be05206dfb63b773c7e825442b2d3851904702` /
  19 members unique + full SHA /
  key `actual-proof-2026-09-30-3eaff8c3cb73982d03a2b211d3dee0d5876718fa91b743d84682483202f810a3`。
- members は actual のみ (owner 5 + post 13 + pins 1)。pre28/guard4 の
  bytes 再送なし (SHA/key 参照のみ)。pure toNotionUpload を burn 前に済ませ、
  LOCAL 拒否は 0 attempts で返す。known receipt wx を unique/readback より先に固める。
