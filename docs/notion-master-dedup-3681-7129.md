# ①銘柄マスタ重複 3681/7129 の単発解消 (Issue #102)

対象 2 コード限定の最小手順。汎用の重複マージ基盤は作らない。
実データ適用は財務 writer の解放後に限る。本書は公開可能な監査メタ・結論のみ。
全 properties・本文・ファイル・relation 配列を含む snapshot は private 領域
(`tmp/master-dedup-3681-7129/`・git 除外) と一次データ保管にだけ置く。

- 実行窓口: `pnpm notion:master-dedup-3681-7129`
  (`scripts/notion/master-dedup-3681-7129.ts`、純粋ロジックは
  `scripts/notion/master-dedup.ts`、回帰は `scripts/notion/master-dedup.test.ts`)
- 共有 Notion 窓口 (`src/shared/notion-archive`)・pipeline writer への変更なし。
  既存の `notionRequest` / `recordPrimaryData` / `moveToTrash` /
  `updateSupplementRow` を呼ぶだけ
- 親 Issue: #132 (JPX 切替以外の残作業)。JPX 切替自体は対象外

## 対象 (2026-09-28 preflight 実測)

保持先は pipeline の既存正本規則 (created_time 最古、同分なら正規化 page id
辞書順最小。`upsert.py::oldest_page`) で決める。全 writer 共通の規則のため
ここだけ別規則にしない。

| コード | 保持先 | 退避候補 | つながり |
|---|---|---|---|
| 3681 | 38dd74ff-84cd-8147-842a-ea9c88839ce6 (作成 06-28T02:34) | 38dd74ff-84cd-81e9-a5bc-fa1c52a29572 (作成 06-28T02:34、同分タイを id で決定) | 保持: 原本1・開示0・財務0。候補: 原本1・開示12・財務8 |
| 7129 | 38dd74ff-84cd-8130-a65e-dd0b0ab4e089 (作成 06-28T02:44) | 38dd74ff-84cd-8167-a03c-cc53b4e5028b (作成 06-28T06:44) | 保持: 原本1・開示10・財務8・子DB1。候補: 原本1・開示0・財務0 |

- 3681 保持先は listed=false・状態 null (最終更新 09-15)、候補は listed=true・
  状態=上場廃止 (基準日 09-01)。listed と状態は別所有者 (コードリスト消失 /
  一次開示) のため最終更新の新旧で決めない。下の一次出典で確定した
- 7129 は両行 listed=true・状態 null。保持先の子 DB「株価テクニカル履歴」は
  そのまま残し、移動しない。候補の本文は 0 ブロック (増えていたら再判断)
- 補足 DB: 3681 行なし、7129 行 1 件
  (3e6d74ff-84cd-81aa-ab14-e89f1cc47ccf) の master relation 空。
  コード横断の relation contains でも対象 4 ページへの参照なし
- ⑧需給・⑨株主優待からの参照は 0。株式情報ページ配下の全子 DB
  (12 件) のスキーマ列挙で、①宛 relation は既知の ③④⑤⑧⑨
  (dual_property) + 補足 (single_property) のみ。integration 非公開の DB
  があれば対象外という制約が残る
- 3681 候補の原本 (codelist) の関連銘柄は 3818 件・39 property page。
  移行時は全ページ送りで読み、単一 PATCH (~190KB) で置換する

## lifecycle 決定 (一次出典・推測なし)

- [JPX 上場廃止日確定通知 (2026-05-19)](https://www.jpx.co.jp/news/1023/20260519-13.html):
  3681 の上場廃止日は 2026-07-01 (旧 6/26 案は株式併合日程変更で不採用)
- [JPX 上場廃止銘柄一覧 (2026-09-28 読取)](https://www.jpx.co.jp/listing/stocks/delisted/):
  `2026/07/01 / ブイキューブ / 3681 / プライム / 上場維持基準への不適合`。
  既に効力発生済み
- EDINET コードリスト (Last-Modified 2026-09-28 04:31:03 UTC、
  SHA256 `383c793f…b94cdd98`): 証券コード `36810` 該当 0、
  `71290` は上場で存在。URL は取得ごとに生成日時が変わり得るため
  hash 一致は条件にせず、対象 2 コードの判定だけ使う
- 決定: 3681 保持先は listed=false 維持・状態だけ「上場廃止」へ部分更新。
  候補側 09-01 の listed=true を写さない。7129 は listed=true・状態 null
  のまま。新しい上場廃止日列は作らない。証拠バイト列 (ZIP/HTML) は適用時に
  取得し直して一次データ保管へ実体保管する

## 手順 (apply)

writer 解放の通知後に実行する。既定は plan (読取のみ)。

```sh
# 1. 新鮮な plan (読取のみ。約 0.5rps)
nix develop -c pnpm notion:master-dedup-3681-7129
# 2. 適用 (snapshot→保管→lifecycle→移行→補足→D1→退避→最終検証)
nix develop -c pnpm notion:master-dedup-3681-7129 -- --apply --window-confirmed
# 3. 中断時は同じ apply コマンドを再実行 (receipt で再開・二重退避なし)
nix develop -c pnpm notion:master-dedup-3681-7129 -- --apply --window-confirmed
```

1. ガード: 4 ページの id・作成・最終更新・listed・状態・逆 relation 件数・
   子 DB、補足、D1 写し、一次出典の再確認。不一致が 1 件でもあれば書込せず
   停止する。D1 `jss_notion_pages` は 2 コードのみ照合し、退避候補を指す行
   だけ更新→再読する (現状は保持先を指しており no-op の見込み)
2. snapshot: 4 ページ全文・全ブロック、移行対象 incoming 行の全 relation
   配列 (⑤ は全ページ送り)・全 properties、補足行、D1 の 2 行、証拠を確定
   JSON + SHA-256 で `tmp/` に保存し、`recordPrimaryData` で物理保管→再読
   検証する。署名 URL 等の一時認証は残さない
3. lifecycle: 3681 保持先の状態だけ「上場廃止」へ部分更新 (listed 不変)→再読
4. 移行: 各行の実配列内の退避 ID だけ保持 ID へ置換し重複除去。他銘柄 ID
   を全て保つ (⑤ の多銘柄配列を全面上書きしない)。③ の数値・期末・開示
   日時・出典は一切変えない。旧原本の relation も保持先へ付け替え、両原本
   を辿れるようにする。PATCH 前に実配列を再読し、snapshot と違えば同時変更
   として停止する。上限超過の配列は切り詰めず停止する
5. 再読検証: 移行集合が old→canonical 以外不変、③④ の数値・出典・日時
   不変、① 逆 relation の和の保存、D1 照合。7129 補足の空 relation は既存
   補足窓口で保持 ID を設定し他 props 不変を確認する
6. 退避: snapshot 確定・移行・補足・lifecycle・D1 の完了後に限り、正式窓口
   `moveToTrash` で退避する (snapshot なし適用禁止)。理由に保持先・snapshot
   保管 page・hash・衝突根拠を含め、退避行と元の archived を再読する。
   receipt 済みは再利用し二重退避しない
7. 最終検証: コード絞込で各 1 有効行、旧 2 行 archived、原本・子 DB・補足の
   保持。同じ apply 再実行で書込 0。`loadStockMasterIndex` の重複 0 は全読取
   が要るため通常の次 biztag run で確認し #102 へ run リンクする

## 受入

- 2 コードの有効マスタ各 1、relations・全情報の保持、7129 補足修復
- 不要元の実体 snapshot・退避・理由の再読、再実行無変更、次 biztag で重複 0
- 現 wave (本 PR): 実 snapshot での plan/diff/中断再開の回帰
  (`scripts/notion/master-dedup.test.ts` 41 件)、nix typecheck/lint/vitest 緑、
  plan 実実行のガード合格。データ適用は writer 解放後の後続 dispatch

## 残る作業 (後続 dispatch)

- 財務 writer 解放の通知後に上記 apply → 最終検証の証拠を本書へ追記
- 次 biztag run で重複 0 を確認し、成功 run リンクを #102 へ記載
- 出典で解消できない衝突が出た場合はそのデータだけ更新を止め、事実と必要
  な入力を親へ示す (現時点では衝突なし)
