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

## 残っている除外（5 ファイル / 型エラー 33 件）

いずれも取込パイプラインで **実際に `tsx` 実行される Node スクリプト**。
`tsx` は型検査せずトランスパイルするだけなので、型エラーを抱えたまま動いている。

| ファイル | 件数 | 実行経路 |
|---|---|---|
| `services/ir-catalog/data-scripts/backfill.ts` | 26 | `pnpm ir:backfill` |
| `services/yuho-quant/data-scripts/backfill.ts` | 2 | `pnpm yuho:backfill` |
| `services/yuho-quant/data-scripts/audit-all.ts` | 2 | 手動 `pnpm exec tsx` |
| `services/financial-math/scripts/verify-capm-bs.ts` | 2 | 手動 `pnpm exec tsx` |
| `services/financial-math/scripts/verify-price-cache.ts` | 1 | 手動 `pnpm exec tsx` |

内訳: TS18047 が 13 件、TS2339 が 12 件、TS2345 が 6 件、TS7006 が 2 件。

### 33 件の実体は 2 つの根本原因

件数は多いが独立した 33 個のバグではない。直す順序を誤らないため記録しておく。

**(a) ADR-0001 (Neon → D1) の移行残骸 — 5 ファイル全部に 1 箇所ずつ**

```
error TS2345: Argument of type 'string' is not assignable to parameter of type 'D1Database'.
```

`createDb()` は D1 バインディング (`D1Database`) を取るが、呼び出し側が
Neon 期のまま接続文字列 (`process.env.DATABASE_URL`) を渡している。
Node 側から D1 を触るなら `createD1HttpDb` (D1 REST) を使うのが正しい。

> 同じ残骸が 002 otakara の `src/middleware/db.ts` にもあり、そちらは
> 本番未到達だったため削除した（`app.ts` はインライン版を使っている）。
> **この (a) を直すと `db` の型が正しく付き、下の (b) の一部は自然に消える。**

**(b) 戻り値ユニオンを絞らずにプロパティを触っている — 主に ir-catalog**

```
error TS2339: Property 'created' does not exist on type
  '{ stocksTouched: number; ... } | { error: string; }'
error TS18047: 'bs' is possibly 'null'.
```

成功形 `{ stocksTouched, created, ... }` と失敗形 `{ error }` のユニオンを
`"error" in bs` 等で絞らずに直接参照している。**これは型だけの問題ではなく、
失敗時に `undefined` をログ出力する実行時の不具合**でもある
（集計値 0 件と失敗の区別がログから付かない）。修正時はここを直す価値がある。

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
本 PR では lint 対象を広げていない（既存 warning 127 件の扱いを決める必要があり、
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
