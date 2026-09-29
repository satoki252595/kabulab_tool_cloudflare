# Issue #163 9/29欠損47 replay 修復 PREP（2026-09-30）

live 診断（PR192 実行。証跡 `stock-gap-54-live-2026-09-30.md`）の
has_real_bar 47 を、保管原文 replay で D1 へ INSERT 修復する準備。
本番 INSERT は Root 最終 review + gate まで行わない（PREP のみ）。
個別の価格値は載せない（集計のみ）。

## 原因の切り分け（断定の範囲）

- 旧 run の 54 欠損の原因は本 PREP では断定不可のまま。
  GPT-sol 公式照合で 54 中 14 件は 9/29 時点で東証廃止済み
  （保護 7 = 非 has_real_bar の 3480・1909・2180・9914・3856・
  7426・7082 の全 7 件が廃止済み。47 候補内にも 1948・4800・5202・
  6486・7240・9223・9508 の 7 件が廃止済み）。
- 9691 は 10/9 廃止予定のため 9/29 修復の早期除外はしない。
- master active 3700 自体の時間軸不整合が疑われている
  （月次 XLS 8 月末 asof の日次 active 誤用疑い。調査中）。
- したがって保存対象は date-effective 資格検証の後に確定する。
  暫定 denylist をコードに埋め込まず、番号 hardcode・is_active 書換・
  欠落データからの廃止推測はしない。eligible 集合は Root が grant 時に
  支給し、空・未知・非 has_real_bar の混入は即 STOP する。
- producer 側の確定バグは別途修正した（下記）：日次増分判定が
  watermark 以降 + NULL close だけを見て、watermark 以前の行不存在を
  落としていた（F-09）。

## 実装（live 未実行）

- 共有 guard 抽出：raw 実在値検査（`assertRawBarsSane`）+
  `sanitizeBars` + 応答整合を `guardChartBars`
  （`src/shared/yahoo/bar-sanity.ts`）へ抽出。`fetchChart` は同一判定へ
  委譲（既存 yahoo suites で同値確認。normal 経路の volume/OHL/adj
  実値穴も共有 1 箇所で対策）。修復 replay と共有し、9/29 切断より前・
  全履歴に適用する（null・adj null・v0 は許容）。
- 増分判定修正（`src/cron/daily.ts`）：`buildOhlcvRows` に規則 (c)
  を追加（保持 90 本窓内・watermark 以前・存在確認で未保存の日を回収。
  訂正対象日は F-04 の管轄のため除外）。`savedDates` を FlushItem・
  1 行 flush・初回 pool・recovery の全配線へ追加（単一共有判定）。
  存在確認は bind 100/文の chunk 分割 + 既知 empty/未知の区別。
  130 本全域の復活はしない（窓外 = prune 済み）。
- 修復 CLI（新規 `scripts/sync/stock-gap-repair.ts`）：
  固定 diag key の 55 添付を Notion hosted から再 DL し、件数・名前・
  hosted・manifest pinned-SHA・コード別 full-bytes SHA を再照合。
  has_real_bar かつ eligible のみ replay（exact-date unique・raw close
  正有限。evidence 値は流用不可）。D1 は code→ID・既存 7 値同値 write0・
  既存 NULL/差異 HOLD。12 行/chunk の [銘柄同一性・不存在 CAS・INSERT]
  を atomic batch で送信（bind 100 以下。競合は batch 全 STOP）。
  `writeStockSnapshot`/`flushSnapshots` は不使用。指標・財務は不変。
  書込後に 7 値 readback する。raw 全 tuple の exact-match だけを
  適用確定とし、SELECT 時点の不存在は rollback 確定にしない
  （切断 POST の遅延 commit があり得るため observed-absent-at-readback
  として unknown/HOLD。different は drift、SELECT 失敗は unobserved。
  明示 rollback 応答を型で区別できない sender のため rollback 確定の
  区分は持たない）。適用 0 の断定・再送はしない。
  repair receipt は 0600 証拠の persist（wx 排他新規・既存は
  key/SHA/bytes 完全一致のみ再利用・不一致は HOLD）→ Notion 共有窓口
  へ 1 件記録 → 添付 readback（件数・名前・hosted・全 bytes SHA）で
  物理完了を確認する。D1 送信前に同 runId proof の存在確認 probe を
  行い、既存があれば resume-only へ誘導して HOLD する。
  `resume-receipt --run-id` は既存 key + 0600 証拠の readonly 回収のみ
  （再 POST なし。不在/読取失敗は HOLD。別 runId での書直しはしない）。
  eligible は pinned grant file（date・source・sourceSha256・archivePins・
  codes）のみ受け、`--execute --eligible-file ...` が無いと起動しない。
  Yahoo 追加 GET 0（fetch 系を import しない）。

## 物理 receipt 計画（live 実行時）

- 入力証拠: diag key `price-sync-diag-20260929-local-1790720602657`、
  manifest SHA（pinned）、コード別原文 SHA・バイト長（55 件照合済み）。
- before: 候補ごとの既存行有無・7 値同値/HOLD 事由。
- write: chunk ごとの batch 送信（preflight 2 文 + INSERT 1 文）と適用数。
- readback: 送信行の再 SELECT 7 値照合（exact-match の適用確定数・
  unknown 明細と事由。rollback 確定の区分なし）。
- receipt: `price-sync-repair-20260929-{runId}` に上記 + 行値を custody
  （値を含むのは Notion 内のみ。stdout/Git/docs には集計のみ）。

## カバレッジ見込み

- 最大 40 適用で 3646 → 3686/3700（#163 基準。47 候補から
  date-effective 資格外 7 を除く）。raw close 要件外・既存差異があれば
  さらに減る（HOLD）。保護 7 は対象外のまま。

## 検証（nix、live ゼロ）

- 新規回帰: guard 共有（raw 頭検査・sanitize・coherence 同値）・
  増分/loader（watermark 後回収・既存保護・未知既定・窓外非復活・
  F-04 null 維持・3700 相当 bind 遵守・既知 empty）・preflight+INSERT
  （SQLite 実実行・CAS・bind 上限）・repair 38（replay/HOLD・pinned
  eligible・disposition・CAS STOP・reentry write0・exact-only readback・
  observed-absent/drift/unobserved unknown・receipt 0600/wx/probe/
  readback/resume）。
- 近傍 focused 7 files / 202 passed（repair/guard/client/diagnostic/
  preflight 168 + flush/custody 34）。
- `nix develop -c npm test` → 225 files / 3616 passed / 281 skipped / 0 failed。
- `nix develop -c npm run typecheck` → exit 0。
- `nix develop -c npm run lint` → exit 0。
