# CI が見ていない範囲（typecheck / lint の死角）

`pnpm typecheck` (`tsc --noEmit`) と `pnpm lint` (`eslint src services`) が
**構造上見ていない**ファイルの一覧と、その理由。CI が緑でも下記は検査されていない。

このファイルは「先送りした借金の残高」であり、減らすためにある。
1 ファイル直したら `tsconfig.json` の `exclude` から消し、ここからも消す。

---

## なぜこのドキュメントが必要になったか

2026-09 に 002 お宝優待で、**本番から到達不能な並行実装 4,245 行**が発見された。
その中には D1 (SQLite) が解釈できない `ILIKE` と、同一オブジェクト内の
重複キー 5 箇所が含まれていたが、CI は緑だった。原因は 1 つではなく、
**2 つの検査が互いに「相手が見ている」と仮定して両方とも見ていなかった**こと:

1. `tsconfig.json` の `exclude` に `services/otakara-yutai/src/routes/**` 等が
   入っており、tsc が見ていなかった（`pages.tsx` を直接 tsc に投入すると
   TS1117 が 5 件出る）。
2. `eslint.config.js` の `no-dupe-keys` が **`[0]`（無効）** だった。
   これは `typescript-eslint` の recommended が「重複キーは tsc が TS1117 で
   報告するから lint 側は不要」としてコア規則を落とすため。
   その前提は **tsc がそのファイルを見ている**ときだけ成り立つ。

対策として、

- `exclude` を**ディレクトリ単位からファイル単位に変更**した。
  ディレクトリ単位だと、後から同じ階層に足したファイルが自動的に死角に入る
  （並行実装はまさに `routes/**` 配下に置くだけで tsc から消えていた）。
  ファイル単位なら既知の借金だけが除外され、新規ファイルは必ず検査される。
- `no-dupe-keys` を **`error` で明示的に有効化**した。`exclude` は将来また
  増えうるので、lint 側に独立した検出を持たせる。

---

## 残っている除外（1 ファイル / 型エラー 1 件）

| ファイル | 件数 | 実行経路 |
|---|---|---|
| `services/financial-math/scripts/verify-price-cache.ts` | 1 (TS2345) | 手動 `pnpm exec tsx` |

下記 (a) の移行残骸 1 箇所だけ。sibling の `verify-capm-bs.ts` と**同じ直し方**
（`createDb(接続文字列)` → `createD1HttpDb`）で消えるが、EMH レーンがこのファイル
自体を削除する可能性があるため手を付けていない。削除しない結論になったら、
その 1 行の差し替えと `tsconfig.json` の `exclude` からの削除を一緒にやること。

---

## 解決済み（4 ファイル / 32 件）— 「33 件」の内訳を測り直した

2026-09-13 に 4 ファイルを検査対象へ戻した（`exclude` から削除済み）。
**件数の内訳は当初の記述と違っていた**ので、測り直した結果を残す。

| ファイル | 当初 | 実際の原因 | 対応 |
|---|---|---|---|
| `services/ir-catalog/data-scripts/backfill.ts` | 26 | (a) 1 件 + (b') 25 件 | 直して検査対象へ |
| `services/yuho-quant/data-scripts/backfill.ts` | 2 | (a) 1 件 + (b') 1 件 | 直して検査対象へ（**実行は無効のまま**。下記 (e')） |
| `services/yuho-quant/data-scripts/audit-all.ts` | 2 | (a) 1 件 + (c') 1 件 | **削除** |
| `services/financial-math/scripts/verify-capm-bs.ts` | 2 | (a) 1 件 + (d') 1 件 | 削除（K1a。一度きりスモーク。`export` も内側へ戻した） |

当初この表には「実行経路」列があり、5 ファイルすべてを
「実際に `tsx` 実行される Node スクリプト」と書いていた。**これも誤りだった**:
ir-catalog / yuho の 2 つの `backfill.ts` と `audit-all.ts` は先頭で
ADR-0001 の無効化 `throw` に当たるので、`pnpm ir:backfill` / `pnpm yuho:backfill`
は即座に失敗していた（型エラーを抱えて動いていたわけではない）。
実際に動いていたのは financial-math の 2 スクリプトだけ。

**(a) ADR-0001 (Neon → D1) の移行残骸 — 5 ファイル全部に 1 箇所ずつ**

```
error TS2345: Argument of type 'string' is not assignable to parameter of type 'D1Database'.
```

`createDb()` は D1 バインディング (`D1Database`) を取るが、呼び出し側が
Neon 期のまま接続文字列 (`process.env.DATABASE_URL`) を渡している。
Node 側から D1 を触るなら `createD1HttpDb` (D1 REST) を使うのが正しい
（`scripts/sync/ir-tdnet.ts` / `data-scripts/backfill-overseas.ts` が既にその形）。

> 同じ残骸が 002 otakara の `src/middleware/db.ts` にもあり、そちらは
> 本番未到達だったため削除した（`app.ts` はインライン版を使っている）。

**(b') 無効化の `throw` より後ろが到達不能で、TypeScript が絞り込みをやめる**

当初この文書は「(b) 戻り値ユニオンを絞らずにプロパティを触っている。
**失敗時に `undefined` をログ出力する実行時の不具合**でもある」と書いていたが、
**これは誤りだった**。ir-catalog の該当箇所は

```ts
bs ? ("created" in bs ? `${bs.stocksTouched}社 …` : `ERR:${bs.error}`) : "-"
```

と**正しく絞り込めており**、失敗時は `ERR:…` を出す。実行時の不具合は無い。

真の原因は、3 ファイルの先頭にあった ADR-0001 の無効化

```ts
throw new Error("ADR-0001: … この CLI は無効です。");
```

である。これより後ろのコードは**到達不能** (unreachable) で、TypeScript は
到達不能コードで制御フロー解析＝**型の絞り込みを行わない**。そのため
`bs ?` や `"created" in bs` が効かず、宣言型 (`… | { error } | null`) のまま
参照しているように見えて TS18047/TS2339 が量産される。`let items;` も
到達不能なので代入からの推論が働かず、`items.filter((it) => …)` の `it` が
TS7006 になる。

実測（`throw` を条件付きに差し替えて再計測）:

| ファイル | `throw` あり | `throw` なし |
|---|---|---|
| ir-catalog `backfill.ts` | 26 件 | **1 件** |
| yuho `backfill.ts` | 2 件 | **1 件** |

→ **33 件のうち 26 件は `throw` が作った幻で、実在したのは 7 件だけだった。**
件数の多さを「バグの多さ」と読むと直す順序を誤る。同種の借金を見たら、
まず到達不能コードが無いかを疑うこと。

**(c') Neon 専用 API / PostgreSQL 専用 SQL — `audit-all.ts`**

`db.execute()`（D1 の drizzle には無い）に加え、`distinct on (…)`（PostgreSQL
専用構文）・`core.stocks` / `yuho_quant.documents`（スキーマ修飾名。D1 の実テーブルは
`core_stocks` / `yuho_documents`）・`is_active = true` を使っていた。
**型を通しても動かない**（通してしまうと「動くように見えるのに実行すれば落ちる」
という、除外されていたときより悪い状態になる）。一回限りの全数監査で
package.json からも参照されていないため削除した。
中身が必要になったら `5e66a3b` から取り出して D1 向けに書き直すこと。

**(e') 「(a) を直せば有効化できる」は yuho backfill には成り立たなかった**

(a) を直すと `pnpm ir:backfill` / `pnpm yuho:backfill` の**無効化 `throw` を外せる**、
というのが当初の結論だった。ir-catalog 側はそれで正しい
（日次キャッチアップ `scripts/sync/ir-tdnet.ts` が同じ `ingestBatch` を同じ
`createD1HttpDb` 経由で呼んでおり、ir の取込は per-statement の update/insert だけ）。

**yuho 側は成り立たない。** `ingestDocument` は facts を

```ts
await db.batch([db.delete(orderFacts)…, …db.insert(orderFacts)…, …]);
```

で原子的に置換する（`services/yuho-quant/src/services/ingest.ts`）。ところが
`createD1HttpDb` は `drizzle(callback, { schema })` の形で **batch callback を
渡していない**ので、`db.batch()` は
`TypeError: this.batchCLient is not a function` で落ちる。

型では捕まらない: 受け口の `Database` は D1 バインディング版で `batch` を持ち、
Node スクリプト側は `as unknown as Database` でキャストして渡す定型なので、
tsc も eslint も緑になる。

壊れ方が悪い。`db.batch()` の**手前**で `yuho_documents` の upsert
（`parse_status` / `honbun_file` / `overseas_*` を含む）が既にコミットされており、
呼び出し側の worker は例外を `console.error` で握って次の書類へ進む。結果として
本番 D1 に

> `parse_status` が `ok_pattern_*` なのに `yuho_order_facts` が 0 件

の行が残り、次回実行は `existsInDb` が真なので `skipped_existing`
（`--force` なしでは二度と埋まらない）。**fail-fast を外した結果として
「黙って壊れる」状態**を作るので、`audit-all.ts` を削除した理由（「型を通しても
動かないものを通すと除外時より悪い」）とまったく同じ判断が当てはまる。

sibling の `backfill-overseas.ts` が「sqlite-proxy は db.batch 非対応なので
per-statement の冪等 update/insert で書く」と明記して `ingestDocument` を
**使っていない**のは、この理由による。

→ 対応: `createD1HttpDb` への差し替え（= 本体を検査対象に戻す）は保ったまま、
`assertYuhoBackfillSupported()` で**書き込みの前に** fail-fast させた。
`throw` を `main()` の先頭に直に置くと以降が到達不能になって (b') の幻が復活
するので、**戻り型 `void` の関数呼び出し**にしてある（到達不能扱いにならず
絞り込みが働く）。有効化するには次のどちらかが必要:

1. `createD1HttpDb` に batch callback を実装する（D1 REST の複文対応が前提。
   逐次実行で代替すると delete+insert の原子性が黙って失われるため、
   フォールバック禁止の観点からそれは選べない）
2. `backfill-overseas.ts` と同じ per-statement の冪等書込へ書き換える

この境界は `src/shared/db/d1-http-batch-boundary.test.ts` が機械的に見ている
（sqlite-proxy が本当に batch で落ちること・`ingestDocument` が今も
`db.batch()` を使うこと・呼び出し側が ingest より手前で fail-fast すること）。

---

**(d') ルートのラッパが Worker バインディングを要求する — `verify-capm-bs.ts`（K1a で削除）**

`buildCapmView` は `db: D1Database`（バインディング）を要求するので、Node から
`createD1HttpDb` の db では呼べない。スモークが確かめたい実体は β 推定と期待収益率の
計算なので、`estimateBetaForCode`（このために `export` した）と
`calcCapmExpectedReturn` を直接叩く形に変えた。ルートの組み立て自体は
`src/tests/integration/routes.test.ts` の担当。

---

## lint 側の死角

`pnpm lint` は `eslint src services` なので、以下は lint されない
（実測: lint されているのは `src` と `services` の 228 ファイルのみ）。

| 範囲 | TS ファイル数 | 中身 |
|---|---|---|
| `scripts/**` | 13 | `sync:*` / `ingest:*` の実行本体 |
| `worker/**` | 1 | **本番エントリ `worker/entry.ts`** |
| `*.config.ts` | 数件 | `vitest.config.ts` / `drizzle.*.config.ts` |

`worker/entry.ts` は本番エントリなので、優先的に対象へ入れるべき。
確認は `npx eslint src services --format=json` で対象ファイルを数えればよい
（`eslint` は指定パス外を黙って無視するので、緑でも対象内とは限らない）。
本 PR では lint 対象を広げていない（既存 warning 116 件の扱いを決める必要があり、
死角を塞ぐ話とは別の判断になるため）。

---

## 確認方法

除外を外したときに何件出るかは、一時 config で測れる（`tsconfig.json` は変えない）:

```bash
node -e '
  const fs=require("fs");
  const j=JSON.parse(fs.readFileSync("tsconfig.json","utf8").replace(/^\s*\/\/.*$/gm,""));
  j.exclude=["node_modules","dist",".vercel"];
  fs.writeFileSync("tsconfig.probe.json",JSON.stringify(j,null,2));'
npx tsc --noEmit -p tsconfig.probe.json --pretty false 2>&1 | grep -c "error TS"
rm tsconfig.probe.json
```

規則が実際に有効かは `--print-config` で確かめる（設定ファイルを読むだけでは、
recommended 由来の無効化に気付けない）:

```bash
npx eslint --print-config services/otakara-yutai/app.ts \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>
      console.log(JSON.stringify(JSON.parse(s).rules["no-dupe-keys"])))'
# => [2] なら有効。[0] なら無効（recommended に落とされている）
```
