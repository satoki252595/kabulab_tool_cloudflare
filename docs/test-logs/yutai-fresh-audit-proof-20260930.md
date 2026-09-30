# Yutai fresh audit 実測 proof (2026-09-30, live grant 済み)

保存済み preimage/証跡に対する本番 D1 現値の fresh 監査を、review 済み
frozen probe のみで 1 回実行した記録。結論: **FRESH_MATCH**
(8 送信・content 差 0・drift 0・実送信 0)。

## 1. 実行条件 (grant どおり)

- Branch/HEAD: `feat/yutai-fresh-audit-probe-20260930` /
  `81d7c44660ff849628f28f6222ad8accc599781b`
- Probe SHA: `c8525f9509f53fe61b43a1e240e5abeeca20a8a1af3144feddca315eb2bbe1f3`
  (metadata 内の runtime self-SHA と一致)
- Scope SHA: `183147371fa0d681d0e113a7f676f62f8d350744d18a0dd6e30ae5e33acb6689`
  (union 144 = A131/F13/N34、A∩FT 6、N外 6、benefitMap 1668 = ABC 1557 + rowOnly 111)
- 送信: `POST /query` ×8 exact (params 82,80,80,80,66,64,64,64)。
  retry/redirect/9 回目なし。Source/Yahoo GET 0・D1 R2 write 0・dispatch 0。

## 2. 結果

| # | kind | chunk | status | rows |
| --- | --- | --- | --- | --- |
| 1 | parent | 80 | 200 | 80 |
| 2 | fin | 80 | 200 | 80 |
| 3 | score | 80 | 200 | 80 |
| 4 | benefits | 80 | 200 | 1203 |
| 5 | parent | 64 | 200 | 64 |
| 6 | fin | 64 | 200 | 64 |
| 7 | score | 64 | 200 | 64 |
| 8 | benefits | 64 | 200 | 465 |

- benefits 合計 1668 (期待と一致)。caps 内。
- 比較: content 差 0・drift 0・実 planner→実 apply 0 送信・
  FT 62 全適用済み (親 identity 一致)・normal45 pending 28/38src +
  stale 9 = 37/50 cross-check pass。
- drift 0 の範囲: benefits 全行集合 1668 + fin/score ABC 131
  (期待 post 基準) + 利回り再計算 144 + updatedAt receipt。
  非 ABC 13 銘柄の fin/score は履歴 baseline が無いため比較対象外
  (`finScoreUncovered: 13`)。144 全体の夜間更新なしは主張しない。
- N6 outside: 6 銘柄の active-equity + benefitID (14/2/2/16/4/4) を証明。
- 8 連読は非 transaction (記録のみ。apply なし)。

## 3. 証跡 (private + Notion)

- `/tmp/yutai-fresh-audit-20260930/` (0700/0600, write-once) 11 件:

| file | bytes | SHA256 |
| --- | --- | --- |
| raw-response-01.json | 3473 | `bc59b61f…4133525` |
| raw-response-02.json | 21947 | `544e665c…b6e1e0ce` |
| raw-response-03.json | 6926 | `e6e3d198…2e7c6bf4` |
| raw-response-04.json | 707608 | `3f002fd7…810e84b5` |
| raw-response-05.json | 2921 | `e32fdb40…0060765a` |
| raw-response-06.json | 17710 | `f2cbaf97…3eaa98f27` |
| raw-response-07.json | 5665 | `f554e265…32c05db` |
| raw-response-08.json | 291643 | `6efd48fa…edc1b0ce` |
| fresh-snapshot.json | 2074789 | `7b1c77e8…5b2acee` |
| metadata.json | 8590 | `589eeacf…044379d45` |
| partial-ledger.jsonl | 2017 | `d5e9d11f…bfa92fb` |

- 全文 SHA は Notion 記録の metadata 内 `localFiles` と私的 custody receipt
  に記録 (fresh 側の metadata.json に `localFiles` は無い。訂正済み)。
- Notion 一次データ保管: key
  `yutai-fresh-audit-20260930-scope183147371fa0-run20260930T024544Z`
  (force=false, outcome recorded)。strict unique 1 row・hosted 11 件・
  全件 DL の bytes+SHA 照合 11/11。実行 stdout は私的 receipt に保全。
