# 海外売上 numeric root 修正 (地理未分類の fail-closed) — 2026-09-30

PR208 (scope Gate0 と同一 PR)。Root 承認の numeric root 計画。
scope-only コードは数値根因を閉じないため本修正が必須。

## 根因

`overseas-parser` の rows/cols reducer は、その他/事業/全社などの
非地域セル (`nonGeoSegCells` 系) を facts 化せず、1853 級の合流点で
elim 脚に混ぜて照合していた。`proof.reconciliationAdjustment` は
算術だけを通すため、海外 numerator の欠落 (その他 1462 級) を
検出できない。旧実装は以下を certified していた (実測):

- W81W: ot=73106=米国のみ、その他 1462 を照合に回して欠落。
- XRWN: ot=120817、その他 18570 を照合に回して欠落。

## 規則 (共有・minimal。新 framework/deps なし)

- 修飾なしその他 (`その他/その他の地域/その他地域` の3形) は地理の
  立証がないため rows/cols とも不採用・不加算。nonzero・欠損は
  候補ごと却下 (`geo_incomplete`)。
- 修飾つき (`その他海外/外国/諸外国/直接輸出/輸出`) は海外活動の
  明示として従来どおり採用を維持する。
- 事業 (`事業/サービス`)・期表示 (`年度/当期/前期/第N期`)・
  会社共通 (`全社/本社`) の実数・欠損も同一の未分類として却下する
  (label 免除なし。metadata 扱いの免除なし)。
- 既知地域の売上 leaf 欠損 (dash を含む共有 null 契約) は黙殺せず
  同一 path で HOLD する。subtotal/hybrid より前。
- 明示消去 (`消去/調整額`)・明示別収益 (`その他の収益` 橋渡し)・
  丸めは正当な照合脚として維持する。`reconciliationAdjustment != 0`
  の blanket 却下はしない。数値の推定
  (その他全額外国・total−Japan) はしない。
- P-hier の sub 読替えで裸その他が地域名になる表は解決前に却下する
  (OJV9 その他 5122)。
- unknown-role leaf fallback (Root 追加承認。same partial-geo root):
  selected sales row/block/axis 内で explicit geo / 証明済
  subtotal-total-elimination / metric-metadata 以外の sales leaf は
  共通最小 guard で HOLD する (default-deny)。empty-header numeric は
  `(col N)`/`(row N)` の labeled HOLD。免除は実証済
  metric/header/aggregate に限定し、部分一致の metric 免除はしない
  (exact `^(売上高|売上収益|営業収益|営業利益|事業利益)$` のみ)。
  `事業収益合計` のような substring は HOLD 側の対照 (YR3G)。
- 短行 missing (Root 最終指摘。same missing-leaf root):
  `row.length <= vc` の無言 skip を廃し、短行を missing cell として
  共通分類へ通す (`row[vc] ?? ""` → null。dash/空セルと同一 path)。
  tableToGridExpanded は行ごとの幅で push し全表 padding しないため
  到達可能。header/axis 外除外は保持。空行は従来どおり skip。
- firstNum 境界 guard (同上): 先頭地域行が全 null/短行で firstNum より
  上に吸収されても known 地域を missing 検査から除外しない。
  firstNum/header/vc の推定契約は不変。header 列見出し文面は
  roles[] (col-0 行軸分類) に現れないため対象外。除外範囲は
  roles other のため自然に除く。
- 保持する除外: section 除外・header 上・集計/小計・消去・P/L guard・
  集計後 block・metric 列・集合表題/脚注・null その他の収益の
  bridge-0。`classifyRegion` 自体は不変 (受注 path 影響 0)。

## 保存 backstop

- `OverseasProof.geoUnclassified` (未分類 abs 額の source 由来実式) を
  3 reducer (rows-main・小計・cols) の proof に必須化。通過時は常に 0。
- `validateOverseasSaveSet` は算術照合の前に必須・0・有限を強制する。
  旧 proof (field なし) は default 0 を置かず STOP。nonzero・非有限も STOP。
- 修飾なしその他の fact label も保存させない (label 側 backstop)。
- 4 caller (ingest/backfill-overseas/backfill-missing-docs/
  overseas-745-prep) は共有 validator のまま。caller 挙動の変更なし。

## 証跡 (CI に retain)

- 実 fixture 2 件 (旧採用表の verbatim 抜粋。provenance は fixture 頭注):
  - `geocols-segnote-sonota-S100W81W.html` (cols@482 その他 1462 HOLD)
  - `geocols-segnote-sonota-S100XRWN.html` (cols@467 その他 18570 HOLD)
  - W81W の表ローカル注「その他は…海外現地法人の事業活動等を含む」は
    海外活動の含有であって全体外国の立証ではない (HOLD の根拠)。
- 旧 bad ACTUAL pair (W81W/XRWN の実 facts+legacy proof) の
  validate 拒否テスト。算術は clean なことを確認の上で backstop が
  先に STOP することを pin (symbolic の nonzero/NaN/elim 対照も維持)。
- J2E7 (北米ブレーキ「－」)・AJAN (北米: 空+その他) の欠損 HOLD を pin。
- 他 38 件の flip は各 cause (start/kind/labels/amount) を capture で pin。
  TA7H は tie の一角脱落→ clean T 採用へ転換 (立証つき除外)。
- unknown-role fallback の pin: W1AE (col5 3438649)・LVA5 (row5 499224)
  の labeled HOLD、VI7V/VI6W/QHYM/LN1R の product-block HOLD、
  YR3G `事業収益合計` の substring 非免除対照、QIEX null
  その他の収益の bridge-0 免除。flips-solely-on-proven-metric 0。
- 短行・境界の pin (実 fixture の欠落 mutation。値の捏造なし):
  W1LQ 中国行の末尾値欠落 → 短行 missing HOLD、W1LQ 日本行の値欠落 →
  境界 guard HOLD (途中欠落の対照)、VI7V 製品行の短行化 → missing
  HOLD (ラベル集合は有値 5512 と同一、amount のみ null)。
- `overseas-parser.test.ts` 131 passed (短行・境界含む最終)。
  typecheck + lint clean。

## 59 gate (新 parser vs sealed。offline)

- MATCH 15/59。STATUS flip ok→unstructured 32 件 (全件に
  incomplete 記録あり)。scope-only 12 件 (Gate0 のまま)。
  (22/25/12 は fallback 前の中間値のため historical。)
- flip 内訳 (doc): bare-Other 主導 21 件、既知 leaf 欠損 4 件
  (北米 dash 級)、product-block (fallback) 7 件 (metricpair 系)。
  cause cells: その他 30・その他の地域 8・北米 4・製品 6label×7。
- gate と capture の status/count 不一致 0。
- 例: Y53G は 2 表 HOLD + clean 表採用 (設計どおりの survivor)。

## census (3602 pinned。offline。gate 真値+同 honbun capture。最終 freeze)

- 最終 freeze SHA `bb1cccb1…` (3602 行 JSONL)。AGREE 3602/3602、
  error 0、gate/capture 不一致 0。新規 HOLD の全件に labeled
  incomplete 記録あり (empty 0)。短行・境界 guard 追加後の再 run も
  byte-identical (両 guard は corpus で発火 0。armed のまま)。
- 新規 HOLD (ok→unstructured) 1487 件 (rows 1289 + cols 198)。
  (中間値 1391 は fallback 前のため historical。freeze が正。)
- 逆 flip (un→ok の clean survivor) 36 件 (rows 33 + cols 3)。
  AFOW/YIXB を現物確認 (勝者に裸その他なし)。
- pattern 変更 (ok rows↔cols) 32 件。no→un (期別) 5 件。
- incomplete 4044 entries (label-set 149 種)。上位:
  rows その他 1715・cols その他 1020・rows その他の地域 199・
  cols その他の地域 183・rows その他地域 50。`(col N)`/`(row N)`・
  名付き非分類 leaf (期別・スポーツ施設事業級) は fallback の pin。
  金額 null 478 / 非 null 3566。
- FY/company arm は corpus で発火 0 (armed のまま。正直記録)。
- 46 `その他の地域` 監査: 45 件中 35 新規 HOLD・9 既 HOLD・
  1 clean-survivor (YIXB。勝者は日本/アジアのみ)。残 1 件 (AKTK) は
  非 pinned (scope 時代から unstructured)。
- save-proof sweep: 最終 ok 1411 件は全件 validate 通過・throw 0・
  勝者の裸その他 0。(中間値 1499 は fallback 前のため historical。)

## caller 真値 (Root 監査。将来意味と現 offline の分離)

- 現 offline 実行: source GET / Notion mutation / D1 書込 / R2 書込 /
  dispatch はすべて 0 (true。PREP + probe のみ)。
- 将来 producer 意味 (2 status を区別):
  - reducer の `geo_incomplete` (clean な代替なし) →
    `geo_present_unstructured` + 空 facts。
  - `validateOverseasSaveSet` の例外 → callers の共有 catch が
    `parse_error` + `facts=[]` に downgrade (`ingest.ts` /
    `backfill-overseas.ts` / `backfill-missing-docs.ts`)。
  - いずれも既存 writer は doc status を upsert し旧 overseas facts を
    DELETE して空集合で置換しうる (`ingest.ts` の delete、
    `backfill-overseas.ts` の delete、`backfill-missing-docs.ts` は
    同一組成)。`no_overseas` 扱い・0% 成功の主張はしない。
- よって真の主張は「部分的な数値 facts は persist されない」(true)。
  「将来 D1-write-0」「旧 facts 温存」は主張しない (false のため)。

## caller archive scope (Root 追加承認。同一 PR208 の最終 HEAD に同梱)

- raw-before-DB: ingest / backfill-missing-docs は物理 ZIP の Notion
  記録を DB batch より先に 1 回行う。記録失敗は DB 旧値のまま
  throw (ingest) / tally.error (missing)。
- strict byte guard (ingest): custody 完備でも DB 書込ありなら
  parser 使用 bytes の同一確認を既存 physical へ通す。通常枝
  (force=false) では recordPrimaryData は skipped_existing
  (重複 mutation なし)→ unique physical + full-bytes SHA verify。
  force=true は既存 force 契約どおり args.force を透過する
  (再記録の枝)。旧 plan-gated 経路 (無検証のまま DB 到達) は塞ぎ、
  `planArchiveUploads` は削除。
- 共有 helper `recordEdinetZip` に readback 照合
  (verifyArchivedAttachments reuse) を内蔵。mismatch・取得失敗は
  throw。旧 manifest unknown でも実 bytes 一致は許容し unknown
  表示は保持 (書換えない)。
- ingest の `archiveToNotion` は既定 true。false 明示は DB 書込前に
  明示 STOP。backfill.ts / backfill-missing-docs.ts の
  `--no-archive` は write mode 未対応で明示 STOP。
- metadata は DBid 非依存。text 本文のみ DBid 解決後に保管し、
  実 id を渡して書戻す。
- T1 未提供は型付き `EdinetNotFoundError` のみ T5 単独で進み、
  未知失敗は throw (無断 T5 単独にしない)。
- backfill-overseas は順序不変 (既に raw-before-DB)。helper 内蔵の
  verify は repair-zip-archive と共に機械的に得る (mismatch 時は
  throw する fail-closed 引き締め。順序・呼出形の変更なし)。
- backfill-missing-docs の 1 通処理は lib `processMissingDoc` に
  抽出 (IO 境界注入で offline 試験可能。振る舞いの正本は lib)。
- 試験: edinet-archive 18・ingest-atomic 8 (HOLD2 + 契約 7)・
  ingest-batch 7・missing-backfill-order 5・batch-boundary 5。
  caller 4 件のうち ingest-atomic・missing-backfill-order は実 SQLite +
  IO mock、ingest-batch は proxy double + IO mock、batch-boundary は
  静的走査で順序を証明する。helper (edinet-archive) は IO mock のみ。
  offline のみ (source GET / Notion mutation / D1・R2 書込 / dispatch は 0)。

## 残差・coverage 損失 (正直記録)

- 橋渡し/elim 加算/slop/fiscal 継承/scope-false の旧 pin fixture は
  各表の未分類で HOLD に転換した (機構は code に残る。elim 対照は
  symbolic control で維持)。
- unknown-role の silent skip は selected sales row/block/axis 内を
  fallback で閉じた。axis 外の other-role skip は残差として残る
  (将来課題として報告のみ)。
- FY/company arm は corpus で発火 0 (armed のまま)。
- 73 missing pins の HOLD は継続。
