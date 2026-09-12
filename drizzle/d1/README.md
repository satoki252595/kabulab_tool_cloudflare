# drizzle/d1 の運用

Cloudflare D1 (`kabulab-cf`) 用のスキーマ生成物。生成は
`pnpm db:generate:d1` (= `drizzle-kit generate --config=drizzle.d1.config.ts`)。

## 原則

1. **`drizzle-kit push` を D1 に対して絶対に使わない。**
   `push` はライブ DB と宣言の差分を取るので、drizzle が知らないオブジェクトを
   DROP しようとする。`drizzle.d1.config.ts` にも同じ注意を書いてある。
2. **生成された SQL は手で読む。** 意図した表以外への DDL が混ざっていたら落とす。
3. **`meta/` を手で書かない。** 手書きの snapshot は journal との対応を崩し、
   次の `generate` が「何からの差分か」を見失う。

## 適用先が 2 系統あることに注意

| 適用先 | やること |
| --- | --- |
| 本番 `kabulab-cf` | **`0010_common_black_bird.sql` は流さない**（適用済み。流すと `duplicate column name` で落ちる）。それ以外の未適用ファイルを番号順に `wrangler d1 execute kabulab-cf --remote --file=...` |
| 新規 DB (ローカル / preview) | `0000` から**全ファイルを番号順に流す**。`0010` も含める |

`0011_clean_iron_fist.sql`（`p_momentum` の CREATE TABLE）は**本番未適用**。
`CREATE TABLE` 1 文だけで既存表に触らないので本番へそのまま流せる。
流す前にこれを適用しておかないと、日次 sync が Phase 1 の `assertDailySchema` で
`p_momentum.closes` を確認できず即座に落ちる（3,700 銘柄を取り終えてから
落ちるのを避けるために、あえて取得前に落としている）。

本番に `d1_migrations` 表は**無い**（`sqlite_master` の 32 表に存在しない）。
つまり適用は完全に手動で、D1 が自動で再生することはない。逆に「どこまで流したか」
の記録も DB 側に無いので、本番へ流すときは必ずこの表と各ファイル冒頭のコメントを
読むこと。

## 0010 が特殊な理由（列定義ドリフトの後始末）

`core_stocks` の 12 列 (`instrument_type` / `sector33` / `sector17` /
`edinet_code` / `listing_status` / `listing_date` / `delisting_date` /
`license_tag` / `src_source` / `src_data_date` / `src_fetched_at` / `quality`) と
2 索引 (`idx_core_stocks_active_market` / `idx_core_stocks_edinet`) は、
stockStock 側の移行 P4a (2026-09-12) が本番 D1 へ**直接 ALTER で**入れた。
drizzle 側は 9 列・索引 1 本の snapshot のまま取り残され、本番 (21 列・索引 3 本)
と乖離していた。

0010 は `src/shared/db/core-schema.ts` へ宣言を足した結果の生成物なので、
**本番との差分ではなく snapshot との差分**である。

生成 SQL を空にして snapshot だけ 21 列にする案は採らなかった。空にすると
`drizzle/d1/*.sql` を順に流して作る新規 DB は `core_stocks` が 9 列のままになり、
「snapshot は 21 列・DB は 9 列」という**今と同じ形のドリフトを非本番側に量産する**。
DDL を残しておけば新規 DB は正しい形になり、本番へ誤って流したときは 1 文目で
落ちて気付ける（無言で通るより良い）。journal には 0010 のエントリを残す。
手で snapshot を書くと journal との対応が崩れるため。

## CI がドリフトを捕まえる仕組み

`.github/workflows/ci.yml` が `pnpm db:generate:d1` を実行し、
`git status --porcelain drizzle/d1` が非空なら落とす。スキーマファイルを変えたのに
`generate` を忘れた PR がここで止まる。

`drizzle-kit export` による golden diff 方式は採らなかった。`export` は**スキーマ
ファイルから DDL を吐くだけで snapshot を見ない**ので、「宣言と snapshot の乖離」
という捕まえたい事象をそもそも観測しない。`drizzle-kit check` も journal/snapshot
同士の衝突しか見ない。Secret 無しで snapshot の再生成漏れを強制できるのは
generate + `git status` だけ。

なお CI は**本番 D1 を見ていない**。「宣言 ⇄ snapshot」の一致しか保証しないので、
本番との一致は手 ALTER をやめる（= 変更は必ず generate した SQL 経由で入れる）
ことでしか守れない。
