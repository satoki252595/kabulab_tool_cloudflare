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

## 7 件補正 wave (同日・オフラインのみ。writer hold のため実 apply 保留)

前 wave の初版に残った 7 件の実 flow 欠陥を同 PR (#137) で補正。
financial#124 が Notion/D1 writer を保持中のため、実 apply・Notion 作成・
更新・アーカイブ・D1 更新は一切行わず、ローカル検証のみ。

- 保管の実ダウンロード検証 (`archiveSnapshot`/`verifyArchiveDownload`):
  保存後・再開時とも snapshot/公式 ZIP/HTML の 3 件を Notion から実 DL し
  各元バイト列 SHA を突合してから移行する。既存 `listPageFiles` 再利用
- 中間ガード分離 (`guardIntermediateState`): 初期ガードと分離し、
  receipt+snapshot の before/after のみ許可 (lifecycle-only・部分 relation・
  片方退避後も再開可能)。D1 未 fixed の candidate は pendingFix として許可
- 移行の receipt 回収+全 pagination (`applyMigrations`): PATCH 成功→receipt 断
  で fresh after なら再送せず回収 (`decideMigrationAction`)。適用・最終 reread
  とも preview 25 でなく全 pagination (`readRelationFull`)
- 退避の full 検索 (`applyRetire`): original archived に無関係に full 検索し
  既存 1 件なら archive だけ完了 (複数は停止)。退避直前の非 relation・body 突合
  (`verifyRetirePreimage`)、marker (0=結果不明 STOP/1=回収/複数=STOP)
- 検証省略禁止: 完了済み receipt があっても最終検証の失敗・省略は必ず非 0
- schema 列挙 (`enumerateMasterIncoming`/`guardIncomingSchema`): `/search`→
  schema で master 向け single_property を含む未知 incoming を検出し STOP。
  証拠は snapshot に保存し再開時に突合。全行 scan 不要
- create marker + POST 再送禁止: snapshot/退避の helper 呼出前に marker を
  atomic 保存。共有 `client.ts` は POST /pages の結果不明再送 (network/5xx/
  529・非 JSON 4xx) を禁止し明示 429 のみ再送 (GET/query・PATCH 維持)。
  既存 `fetchPageFileUrl` の先頭/null 挙動は維持 (`page-file.test.ts` 1 件)
- 追補 (親レビュー 3 件): 再開時は marker hash 対応の既存 snapshot を再利用
  (`loadSnapshotForResume`)、fresh 証拠は一時領域のみで初回のみ保存 (再開の
  原本上書き防止)、適用済み分岐も D1 前に archive 実 DL+SHA 再検証を通す。
  回帰は `master-dedup.test.ts` 55 件 + `master-dedup-flow.test.ts` 20 件 +
  `client-retry.test.ts` 10 件 + `page-file.test.ts` 1 件で全 pass、
  `pnpm typecheck`/`pnpm lint` 緑。`pnpm test` 全体: 189 ファイル・2649 pass・
  383 skip・0 fail で緑。実 apply は保留のまま明記して ready 化する

## keeper 集合ガード wave (同日・オフラインのみ。10→11 valid-addition 対応)

live keeper 7129 の開示が 11 (v1・live の 11 集合完全一致・全行 keep-only・
第11 は当日 TDnet 主要株主異動) のため、保持先の件数固定
(`keepIncoming` + `guardMasterView` の ④③ 件数) を廃止し、証明済み ID 集合
ガードへ置換した。10→11 の単純 bump ではない。

- baseline は実行時読取 (`loadKeeperBaseline`): snapshotDir の keep11 実
  receipt (private 0600・verdict/membership/issuer/原本を熟読検証) +
  一次データ保管の v1 snapshot (readonly DL・CAS 自己検証・receipt v1 SHA
  照合)。開示集合の突合せ不一致・v1 重複・JSON 非一意は STOP。
  ID 一覧をコード・Git 証跡に埋め込まない
- `guardKeeperIncomingIds` (純粋): baseline 喪失は STOP、追加行は
  issuer/原本 (完全件数)/keep-only membership の live 実証があるものだけ
  許可。未完 pagination は `readRelationFull` 側で throw
- take は保持先全 ID を `keeperIncoming` へ固定し直後再読で完全一致を要求
  (不一致は同時変更として STOP)。`finalVerify` の keepBefore は固定集合
  を使用 (preview 由来をやめる)。retire 側の件数・D1・schema・本文添付・
  already-applied の各 gate は不変
- 回帰は `master-dedup.test.ts` 66 件 + `master-dedup-flow.test.ts` 51 件で
  全 pass (集合一致/喪失/追加証明の境界 + receipt/v1 解析の純粋検証を追加)。
  実 receipt 11 行の parse もオフライン確認 (code・件数・SHA 先頭のみ表示)。
  `pnpm typecheck`/`pnpm lint` 緑。`pnpm test` 全体: 207 ファイル・
  3089 pass・347 skip・0 fail で緑。live take・実 apply は grant 待ち
- 追補 `--take-only`: snapshot 取得までの readonly 入口 (保管・移行・退避
  なし)。schema 全列挙は再走せず v2-manifest 証拠を内部 SHA 自己検証+
  受入 SHA 照合の上で再利用する。証拠ファイル既存時は上書きせず STOP。
  回帰 +2 件 (manifest 検証)。全体 3091 pass・0 fail で緑
- 追補 D1 前 union gate: entry 共通 gate に keeper/retire の union 一致
  (全 pagination。期待=固定 keeper ∪ 移行済み/固定退避−移行済み) を追加し
  初回・resume・適用済みの D1 前全経路へ接続。master/補足は snapshot 固定
  ID から取り直す (入口 state 使い回し廃止)。中間 gate の未移行比較も
  件数から集合へ (同数 ID 置換を検出)。回帰 +6 件。全体 3110 pass・0 fail
