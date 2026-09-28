# ①銘柄マスタ重複 3681/7129 の単発解消コード (2026-09-28)

Issue #102 の銘柄マスタ重複 (biztag run 36091606541 で検知の 3681・7129) を
解消する単発 plan/apply (`pnpm notion:master-dedup-3681-7129`) の検証記録。
本 wave は read-only preflight とコード/回帰まで。実データ適用は財務 writer
解放後の後続 dispatch。詳細手順は
[docs/notion-master-dedup-3681-7129.md](../notion-master-dedup-3681-7129.md)。

## read-only preflight (live API)

財務 writer と integration を共有するため追加 pacing で約 0.5rps、全 DB
fetch なし (対象 2 コードの絞込読取のみ)。429 なし。

- 4 ページ GET + 子ブロック: 3681 保持 listed=false・状態 null・逆 0/0、
  3681 候補 listed=true・状態=上場廃止・開示12・財務8、7129 保持
  listed=true・状態 null・開示10・財務8・子 DB「株価テクニカル履歴」1、
  7129 候補は原本のみ。全 relation has_more=false (候補の原本除く下記)
- 3681 候補の原本 (codelist) の関連銘柄は 3818 件・39 property page
  (has_more=true → 適用時は全ページ送り)。7129 候補の原本は 5 件
- 補足: code=3681 は 0 行、code=7129 は 1 行で master 空。
  4 ID への relation contains も 0 件
- 株式情報ページ配下の子 DB 12 件のスキーマ列挙: ①宛 relation は既知の
  ③④⑤⑧⑨ (dual) + 補足 (single) のみ。未知の single_property なし
- D1 `jss_notion_pages` stock_master 区画の 2 コード SELECT:
  両方とも保持先 (最古) ID を指しており修正不要 (適用直前・直後に再照合)
- 一次出典の再確認 (公開取得・メモリ内のみ):
  EDINET コードリスト (Last-Modified 2026-09-28 04:31:03 UTC、
  SHA256 `383c793f…b94cdd98`) で `36810` 0 件・`71290` 上場あり。
  JPX 上場廃止一覧に `2026/07/01 / ブイキューブ / 3681` を確認

## plan 実実行 (納品物自体・読取のみ)

`nix develop -c pnpm notion:master-dedup-3681-7129` を live 実行しガード合格
(`problems: []`、`alreadyApplied: false`)。plan JSON は `tmp/` (git 除外) に
保存。EDINET 判定は pipeline の既存 `parse_codelist` を再利用し、上場
3817 件・3681 なし・7129 ありを確認。`--apply` 単独では終了コード 3 で拒否
(`--window-confirmed` 必須) を確認。`--apply --window-confirmed` は本 wave
では実行しない (writer hold)。

## 回帰・静的検証 (nix)

- `scripts/notion/master-dedup.test.ts` 41 件: 最古規則 (同分タイ・実測定数
  の自己検証含む)、他銘柄 ID 保持 (3818 件規模含む)、ガード不一致 12 種、
  補足ガード、移行 op 計画・検証、逆 relation 和の保存、receipt 再開・
  再実行不変、PATCH 上限判定。vitest で全 pass
- `pnpm typecheck` (tsc --noEmit) 緑
- `pnpm lint` (eslint src services) 緑
- `pnpm test` 全体: 187 ファイル・2608 pass・383 skip・0 fail
- 共有 Notion 窓口・pipeline writer への変更なし (新規 3 ファイル +
  package.json の script 1 行 + docs のみ)
