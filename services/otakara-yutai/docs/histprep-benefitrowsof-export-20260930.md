# source50 HISTORICAL 候補 prep: `benefitRowsOf` の export (ops 記録)

PR209 (main `8a471f5`) の共有厳密判定を、HISTORICAL 02:45 snapshot 上の
source50 offline prep から正準の公開 API として使うための export。
振る舞い変更なし。private runner が builder を複製して「再利用」と称する
ことを禁じるレビュー指摘に対応する (clone ではなく 1 箇所の export)。

## 変更

- `services/otakara-yutai/data-scripts/yutai-full-import.ts`
  `benefitRowsOf(data)` に `export` を付けた 1 語変更。
  本体・型・呼び出し側の変更なし。
- export-mirror テストは作らない (Root 指示)。
  既存の full-import 回帰 + 必須 gates (type/lint/3CI) で担保する。

## prep の方法 (private, repo 外)

1. archived upstream (34銘柄) → `benefitRowsOf` → 正準 triple
   `(recordMonth, minShares, description)` 集合。
2. 02:45 snapshot の全 1668 優待行を (stock, description) で全群再構成。
   群の各 member を triple 照合し、全一致でのみ source identity を認める
   (DB 文言への fallback qualify なし)。
3. 群ごとに共有厳密判定 (`qualifyCompanyPerGrantValue`) を全 recipient
   ctx (minShares[]/recordMonths[]) で実行。50行全てに disposition を付与
   (NULL-candidate / KEEP-qualified-noop / 7075-separate 等)。
4. `computeYieldEntries` (overlay) → `snapshotStockPreimages` →
   `planAtomicBatches` で候補差分を計画 (送信しない)。
   reentry-0 (full-apply 後の再 plan が 0 batches/0 statements) と
   protected-diff (4種の SQL 形状のみ) を実 builder 出力で assert。
5. pin は fail-closed: archived34 SHA・source SHA・82 spans・50行対照の
   いずれか不一致で runner が throw する。

## prep の結果 (PRELIM-v3。frozen ではない。詳細は private 報告のみ)

- pins: archived34 68/68, source SHA 50/50, 82 spans 82/82,
  50行対照 50/50 (ID・stockId・親code・ctx・descSha)。
- dispositions: NULL-candidate 42 / KEEP-qualified-noop 4 /
  HOLD-7075-separate 4 (7075 は全文+要約+値の源泉修復が別 track)。
- 候補 (42行): updates 31 / batches 12銘柄 / 57 statements。
  postimage は yield 変化 9銘柄・score 変化 5銘柄。
- reentry-0: full-apply 後の再 plan は 0 batches / 0 statements。
- 既存 CLI に明示の行パッチ経路なし (最小 code plan は private 報告)。
  修復書込の grant は無い。

## 監査証跡

- 本 PR は export 1 語 + 本 ops doc のみ (生産ロジック変更なし)。
- 8e322c7 (test-header doc) の lineage を merge で温存。
- マージ判断は Root。データ修復は別途承認が必要。
