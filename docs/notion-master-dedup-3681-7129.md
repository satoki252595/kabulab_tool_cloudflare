# ①銘柄マスタ重複 3681/7129 の単発解消 (Issue #102)

対象 2 コード限定の最小手順。汎用の重複マージ基盤は作らない。
実データ適用は財務 writer の解放後に限る。本書は公開可能な監査メタ・結論のみ。
全 properties・本文・ファイル・relation 配列を含む snapshot は private 領域
(`tmp/master-dedup-3681-7129/`・git 除外) と一次データ保管にだけ置く。

- 実行窓口: `pnpm notion:master-dedup-3681-7129`
  (`scripts/notion/master-dedup-3681-7129.ts`、純粋ロジックは
  `scripts/notion/master-dedup.ts`、回帰は `scripts/notion/master-dedup.test.ts`
  55 件 + `scripts/notion/master-dedup-flow.test.ts` 20 件)
- 共有 Notion 窓口は最小 2 点のみ: `client.ts` の POST /pages 結果不明再送禁止
  (GET/query・明示 429 retry は維持) と `page-file.ts` の全件取得 `listPageFiles`
  (実ダウンロード検証用)。既存 `fetchPageFileUrl` の先頭/null 挙動は維持する
  (URL 無し先頭で 2 番目へ fallback しない)。pipeline writer への変更なし。
  Notion 要求は全て `notionRequest` / `recordPrimaryData` / `moveToTrash` /
  `updateSupplementRow` の既存窓口経由 (直 fetch 迂回なし。署名 S3 URL の GET
  のみ素 fetch)
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
- ⑧需給・⑨株主優待からの参照は 0。コードが `/search` で accessible DB を
  列挙→各 schema の master 向け relation を検出 (`enumerateMasterIncoming`) し、
  既知の ③④⑤⑧⑨ (dual_property) + 補足 (single_property) 以外が 1 件でもあれば
  STOP (`guardIncomingSchema`)。証拠は snapshot に保存し再開時に突合する。
  全 DB 全行 scan は不要 (schema のみ)。integration 非公開の DB があれば
  対象外という制約が残る
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

1. ガード: 初回は 4 ページの id・作成・最終更新・listed・状態・逆 relation
   件数・子 DB、補足、D1 写し、一次出典、incoming schema の再確認。不一致が
   1 件でもあれば書込せず停止する。再開時は receipt+snapshot に基づく中間
   ガード (`guardIntermediateState`) に分離し、記録された before/after のみ
   許可する (lifecycle-only・部分 relation・片方退避後も再開可能。固定初期
   ガードでは resume 不能になるため)。D1 `jss_notion_pages` は 2 コードのみ
   照合し、未 fixed の candidate は fresh 原値 (snapshot.d1 が保持) を前提に
   許可して candidate→keep 修復へ進める (入口で keep 必須にすると修復分岐が
   dead になる)。現状は保持先を指しており no-op の見込み。fresh 証拠の再確認
   は一時領域のみで行い、初回のみ snapshotDir へ保存する (再開で原本 3 件を
   上書きすると hash が変わり旧 snapshot 確認が STOP になるため)
2. snapshot: 4 ページ全文・全ブロック、移行対象 incoming 行の全 relation
   配列 (⑤ は全ページ送り)・全 properties・子ブロック像、補足行、D1 の 2 行、
   証拠、incoming schema 証拠を確定 JSON + SHA-256 で `tmp/` に保存し、
   `recordPrimaryData` で物理保管する。再開時は marker hash 対応の既存 local
   snapshot を再利用して固定し (`loadSnapshotForResume`)、新規作成で hash が
   ずれて回収停止するのを防ぐ。保存後・再開時とも Notion から snapshot/公式
   ZIP/HTML の 3 件を実ダウンロードし各元バイト列 SHA が一致してから移行する
   (`verifyArchiveDownload`。Metadata 文字列+Files 3 件だけではすり替えを検出
   できないため)。署名 URL 等の一時認証は残さない。非冪等 create 前に
   key+snapshotHash+issuedAt を atomic 保存し (marker)、再開時は full 検索で
   0=結果不明 STOP (自動解除・再 create 禁止)/1=回収/複数=STOP
   (`decideSnapshotAction`)
3. lifecycle: 3681 保持先の状態だけ「上場廃止」へ部分更新 (listed 不変)→再読
4. 移行: 各行の実配列 (全 pagination。preview 25 では ⑤ の 3818 件を誤判定)
   内の退避 ID だけ保持 ID へ置換し重複除去。他銘柄 ID を全て保つ (⑤ の
   多銘柄配列を全面上書きしない)。③ の数値・期末・開示日時・出典は一切変え
   ない。旧原本の relation も保持先へ付け替え、両原本を辿れるようにする。
   PATCH 成功→receipt 断で fresh after の場合は PATCH 再送せず receipt 回収
   する (非対象 props/body 不変が条件。`decideMigrationAction`)。上限超過の
   配列は切り詰めず停止する。適用・最終 reread とも全 pagination で行う
   (公式: relation preview は 25 件・`has_more` 時に `/pages/{id}/properties`
   で全件取得)
5. 再読検証: 移行集合が old→canonical 以外不変、③④ の数値・出典・日時
   不変、① 逆 relation の和の保存 (中間は `verifyIntermediateUnion`・最終は
   `verifyReverseUnion` とも全 pagination)、D1 照合。7129 補足の空 relation
   は既存補足窓口で保持 ID を設定し他 props 不変を確認する
6. 退避: snapshot 確定・移行・補足・lifecycle・D1 の完了後に限り、正式窓口
   `moveToTrash` で退避する (snapshot なし適用禁止)。original の archived
   状態に無関係に origin/key/snapshotHash で full 検索し、既存 1 件なら
   original archive だけ完了する (create 成功→archive 断で二重 create する
   ため。複数は停止)。退避直前に fresh 非 relation props/body と物理 snapshot
   を突合し変化なら停止する (`verifyRetirePreimage`)。理由に保持先・snapshot
   保管 page・hash・衝突根拠を含め、退避行 (内容・hash・Origin・Key) と元の
   archived を再読する。非冪等 create 前に marker を atomic 保存し、再開時は
   full 検索で 0=結果不明 STOP/1=回収/複数=STOP (`decideRetireAction`)
7. 最終検証: コード絞込 (全件) で各 1 有効行、旧 2 行 archived、原本・子 DB・
   補足の保持。同じ apply 再実行で書込 0。適用済み分岐も D1 修正前に保存
   snapshot/receipt で物理 archive の実 DL+SHA 再検証を通す (bypass しない)。
   完了済み receipt があっても最終検証の失敗・省略は必ず非 0 で止める (検証
   なしの 0 終了はサイレント成功のため禁止)。`loadStockMasterIndex` の重複 0
   は全読取が要るため通常の次 biztag run で確認し #102 へ run リンクする。
   共有 `client.ts` は POST /pages (非冪等 create) の結果不明再送
   (network/5xx/529・非 JSON 4xx) を禁止し、明示 429 (拒否・未作成確定) のみ
   再送する (公式 `/reference/request-limits`。GET/query・PATCH の retry は
   維持)。marker だけでは同一 helper 内の内部再送を防げないため両方で守る

## 受入

- 2 コードの有効マスタ各 1、relations・全情報の保持、7129 補足修復
- 不要元の実体 snapshot・退避・理由の再読、再実行無変更、次 biztag で重複 0
- 現 wave (本 PR): 実 snapshot での plan/diff/中断再開の回帰
  (`scripts/notion/master-dedup.test.ts` 55 件 +
  `scripts/notion/master-dedup-flow.test.ts` 20 件の実 flow 回帰 +
  `client-retry.test.ts` 10 件の POST /pages 再送禁止 +
  `page-file.test.ts` 1 件の先頭/null 維持)、nix typecheck/lint/vitest 緑、
  plan 実実行のガード合格。データ適用は writer 解放後の後続 dispatch (実 apply 保留)

## 残る作業 (後続 dispatch)

- 財務 writer 解放の通知後に上記 apply → 最終検証の証拠を本書へ追記
- 次 biztag run で重複 0 を確認し、成功 run リンクを #102 へ記載
- 出典で解消できない衝突が出た場合はそのデータだけ更新を止め、事実と必要
  な入力を親へ示す (現時点では衝突なし)
