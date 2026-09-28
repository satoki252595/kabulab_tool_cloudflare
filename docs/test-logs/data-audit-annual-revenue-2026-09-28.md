# 年次売上reader切替の全銘柄比較監査（2026-09-28）

PR136（001 RSI の年度売上を正本 `jss_financials` の本決算実績から読む）の
reader 切替が `revenueTrend` / `isBlueChip` に与える差分を、fresh な source D1
で全銘柄比較した検証ログ。Refs #124 #132 #136 #144 #147。
source D1・Notion・R2 への書込、daily 起動、ingest、master apply は行わない。
34k ZIP の再 parse も行わず、#144/#147 の既存 proof を再利用する。

## 検証範囲

- 新 reader（`pickAnnualSeries` + 新 `evaluateBlueChip`、asOf=2026-09-25）が読む
  `jss_financials` 本決算 × `license_tag='commercial-ok'` の全銘柄系列と、
  旧判定（旧 `evaluateBlueChip` 式を Yahoo 年次に適用）の `revenueTrend` /
  `isBlueChip` を core 全 3,810 銘柄で比較。TTM 営業利益率は新旧とも保存値
  （`core_stock_financials.operating_margin`）を共用し、年次系列の差だけを見る。
- 保存値（`rsi_percentile.is_blue_chip` / `revenue_trend`）とも比較し、
  「detail 年次表示は切替わるが保存 bool は次回正常 daily まで旧値」の現状を区別する。
- 1909（Yahoo 派生価格の破損銘柄）は年次判定だけ分離確認し、価格は入力に使わない。
  本監査の入力に価格は含まれない。

## source 基準時刻と fresh 確認

- live source D1 読取：2026-09-28 09:34–09:35 UTC（SELECT のみ）。
  `jss_financials` MAX(data_date)=2026-09-25、MAX(fetched_at)=1790354220
 （2026-09-25 16:37 UTC / 09-26 01:37 JST）。core 最終 daily 日も 2026-09-25。
- 既存 cache `/tmp/d1_fin.jsonl`（採取 2026-09-28 08:51:56 UTC、34,659 行・33 列、
  SHA256 `bb910db12f012f6b8a550d3b5a74ccc66913ec3858b8d580dce844054c45607d`）と
  live D1 の reader 集計 6 点が完全一致したため再取得なし：
  全行 34,659 / 本決算×commercial-ok 12,845 行・4,097 code /
  売上非 null 11,998 行・合計 2795007607583000（整数・完全一致）/
  期末 2016-06-30〜2026-06-30。期種×license の 9 分布も一致。
- live は 34 列（#147 で原本 pageID 列を追加）。dump は 33 列だが reader 使用 4 列
  （code / fiscal_period_end / consolidated / net_sales）は不変のため影響なし。
- 当該 dump は親経由で A 監査の全 34,659 行 SELECT dump と確認
  （2026-09-28 09:41 UTC の親連絡。B 照合依頼はこれで充足）。
  本監査の fresh 性は上記の live D1 直接照合で独立に成立している。
- 小規模 core 表は同窓で fresh 取得（private 0600、git 外）：
  core_stocks 3,810 / core_stock_annual_financials 15,967 /
  core_stock_financials 3,756 / rsi_percentile 3,756。

## 全銘柄比較の結果（asOf=2026-09-25、n=3,810）

### trend 行列（旧 → 新）

| 旧＼新 | +1 | 0 | -1 | null |
|---|---|---|---|---|
| +1 | 1310 | 199 | 32 | 256 |
| 0 | 133 | 455 | 65 | 84 |
| -1 | 13 | 20 | 192 | 39 |
| null | 474 | 177 | 66 | 295 |

### flag 行列（旧 → 新）

false→false 2301 / true→true 819 / **false→true 398** / **true→false 292**。
flag 変化は 690 件（18.1%）。

### null 理由の内訳

- 旧 null 1,012 件：定義段差（2 倍超）815 / 3 年未満 171 / judge-null 26。
- 新 null 674 件：窓内 null 売上 235 / 2 期のみ 173 / 1 期のみ 150 /
  窓内 2 倍段差 62 / 空系列 22 / 決算期変更 14 / 同年端数期 9 /
  年欠落（2 年飛び）7 / 年欠落（3 年飛び）2。
- null 解消（旧 null → 新 valued）717 件：主因は連結/単体混在の段差解消
  （例：null→+1 で flag 付与 242 件）。
- 新規 null 化（旧 valued → 新 null）379 件：主因は窓内 null 売上・2 期以下・年欠落。
  いずれも年率化・穴埋めをせず判定不能に倒す設計どおり。
- うるう窓（02-28/29 対を含む窓）：192 銘柄中 172 valued（89.6%）。
  残り 20 件は窓内 null 等の他理由による null。
- 未来期フィルタは未発動（max 期末 2026-06-30 ≤ asOf）。発動経路は結合テストでカバー。
- `pickAnnualSeries` の throw は 0 件。

### 保存値との関係

- 保存 vs 新：flag 一致 3,063/3,756（81.5%）、trend 一致 2,232/3,756（59.4%）。
  次回正常 daily で保存 bool が新値に更新される見込み。daily 起動は禁止のため未実施。
- 保存 vs 旧再計算：flag 99.8%、trend 99.2% で一致。旧再計算は保存値の忠実な代理であり、
  上の差分は reader 切替の効果とみなせる（残差は最終 daily 以降の annual 更新分）。
- jss 商用本決算 4,097 code のうち 309 code は core 外（上場廃止等の過去 code。
  screening 対象外）。core 22 code は jss 年次なし（空系列 → null）。

## 層別 20 銘柄の確認

`old` / `new` / `stored` は `t<trend>/f<flag>/<理由>`。margin は gate（5%）のみ記載。
`ends` は新 reader の系列（古い→新しい）。会計基準は reader の絞り条件ではない
（絞りは license のみ）が層属性として記録する。

| code | 層 | 基準 | ends | scope | margin | old | new | stored |
|---|---|---|---|---|---|---|---|---|
| 8154 | 訂正反映済・混合 license | 日本基準 | 2023-03-31〜2026-03-31（4 期） | 連結 | <5% | tnull/ffalse/def-break | t1/ffalse/valued | tnull/ffalse |
| 3911 | 連結 | 日本基準 | 2023-12-31〜2025-12-31 | 連結 | ≥5% | t-1/ffalse/valued | t-1/ffalse/valued | t-1/ffalse |
| 3463 | factual-cite のみ | 日本基準 | （reader 0 行 → empty） | - | - | core 外のため旧判定なし | tnull/ffalse/empty | なし |
| 7384 | - | 日本基準 | 2024-03-31〜2026-03-31 | 連結 | ≥5% | t0/ffalse/valued | tnull/ffalse/null-window | t0/ffalse |
| 543A | 1 期のみ | IFRS+日本基準 | 2026-03-31 | 単体 | <5% | t0/ffalse/valued | tnull/ffalse/<3p(1) | t0/ffalse |
| 1909 | isolated（年次のみ） | 日本基準 | 2024-03-31〜2026-03-31 | 連結 | ≥5% | t1/ftrue/valued | t1/ftrue/valued | t1/ftrue |
| 1375 | IFRS・連結 | IFRS | 2024-03-31〜2026-03-31 | 連結 | <5% | t1/ffalse/valued | t1/ffalse/valued | t1/ffalse |
| 436A | IFRS・単体 | IFRS | 2026-04-30（1 期） | 単体 | ≥5% | tnull/ffalse/<3y | tnull/ffalse/<3p(1) | tnull/ffalse |
| 4901 | US-GAAP | US-GAAP | 2022-03-31〜2026-03-31（5 期） | 連結 | ≥5% | tnull/ffalse/def-break | t1/ftrue/valued | tnull/ffalse |
| 135A | 単体・うるう窓 | 日本基準 | 2024-02-29,2025-02-28,2026-02-28 | 単体 | ≥5% | t1/ftrue/valued | t1/ftrue/valued | t1/ftrue |
| 130A | 単体・窓内 null | 日本基準 | 2023-12-31〜2025-12-31 | 単体 | <5% | tnull/ffalse/def-break | tnull/ffalse/null-window | tnull/ffalse |
| 1418 | うるう対 | 日本基準 | 2024-02-29,2025-02-28,2026-02-28 | 連結 | ≥5% | tnull/ffalse/def-break | t1/ftrue/valued | tnull/ffalse |
| 3391 | 決算期変更 | 日本基準 | 2023-05-15,2024-05-15,2025-02-28,2026-02-28 | 連結 | <5% | tnull/ffalse/def-break | tnull/ffalse/fiscal-change | tnull/ffalse |
| 2130 | 年欠落 | IFRS | 2023-03-31,2024-03-31,2026-03-31 | 連結 | <5% | t1/ffalse/valued | tnull/ffalse/year-gap(2) | t1/ffalse |
| 175A | 同年端数期 | 日本基準 | 2024-03-31,2024-12-31,2025-12-31 | 単体 | <5% | tnull/ffalse/<3y | tnull/ffalse/same-year-stub | tnull/ffalse |
| 1914 | 窓内 null | 日本基準 | 2024-03-31〜2026-03-31 | 連結 | ≥5% | t0/ffalse/valued | tnull/ffalse/null-window | t0/ffalse |
| 145A | 2 期のみ | 日本基準 | 2024-12-31,2025-12-31 | 連結 | ≥5% | t1/ftrue/valued | tnull/ffalse/<3p(2) | t1/ftrue |
| 1382 | factual-cite 除外 | null+日本基準 | 2023-06-30〜2025-06-30 | 連結 | <5% | t0/ffalse/valued | t0/ffalse/valued | t0/ffalse |
| 1332 | 段差解消 | 日本基準 | 2024-03-31〜2026-03-31 | 連結 | <5% | tnull/ffalse/def-break | t1/ffalse/valued | tnull/ffalse |
| 2425 | 最新期単体化 | 日本基準 | 2024-03-31:連結,2025-03-31:連結,2026-03-31:単体 → 系列は最新期のみ | 単体 | <5% | t0/ffalse/valued | tnull/ffalse/<3p(1) | t0/ffalse |

層別の補足：

- 8154：factual-cite 行を除外し commercial-ok 4 期で窓確定。旧 def-break → 新 +1。
  訂正は writer の disclosed_at ガード付き完全置換（#131）で本決算行へ反映済みの
  ため reader 側に新旧選択は無い。dump に `修正` 期種は 0 行。
- 3463：core 外（上場廃止）のため旧判定・保存値なし。本決算 1 行が factual-cite のみで
  reader 0 行 → empty を dump 上で確認。commercial-ok 限定の除外側の代表例。
- 1382：factual-cite 本決算を持つが commercial-ok 3 期で窓確定（t0 維持）。
  除外が窓を壊さないことの代表例。会計基準 null 行があっても reader は license のみで絞る。
- 2425：最新期単体化で旧 2 期（連結）を捨て最新期のみの系列になる
  （最新期末の区分単一化の設計どおり）。現窓は 1 期のため null。
- 02-28 固定の 3 期窓は fresh 実データに 0 件（FY2024 が窓に入るため全 2 月末窓が
  うるう対を含む）。同一月日 (a) 経路は通常テストと実窓内の 25→26 対でカバー。
- 不明区分は fresh 全 34,659 行に 0 件。最新期末に連結+単体の両方を持つ code も 0 件。
  両経路は単体・結合テストのみでカバー（下記）。
- 空系列の core 22 code は上場廃止・重複等の旧 code と直近 IPO（例：8963、407A〜607A 帯）。

## 回帰検証（merge 後）

- merge：`dab6b52`（main c84b6a4、#133〜#147 の 13 件を取り込み）。
  競合は `docs/release-notes.md` の 1 ファイルのみ、両エントリ保持で解消。
- 関連テスト 41 件（annual-jss 結合 6 / blue-chip-filter 27 / daily-jss-annual 2 /
  stock-detail-view 3 / stock-detail-freshness 3）：全 pass。
- `tsc --noEmit` 通過、`eslint src services --max-warnings=0` 通過、
  `db:generate:d1` は No schema changes（読取ミラーは generate 対象外を維持）。
- 不明区分・最新期複数区分・未来期・02-28 固定窓の 4 経路は実データ 0 件のため
  テストのみがカバー：`blue-chip-filter.test.ts`（年欠落・期変更・不明・窓内 null・
  うるう対）、`annual-jss.test.ts`（同一期末の単体・予想・四半期・修正・他銘柄・
  factual-cite の不混入、最新期単体化・不明、未来期除外）。

## 未確認（残件）

- 公開 GET 切替後の表示確認：親の merge/deploy 確認後の followup。今は read-only 取得 →
  ローカル新 reader 比較のみで、公開面への切替確認はしていない。
- 保存 bool の実更新：次回正常 daily 待ち。daily 起動は禁止のため未実施。
- B dump との同一性：親経由で A 監査の dump と確認済み（上記）。
- financial writer の返却：数値 proof の完了のみで write 所有権としない。
  今回は reader 切替・merge 準備だけであり、writer 返却を要する apply は行わない。

## 再現手順

1. `node /tmp/d-audit/01-profile.mjs`：dump の集計プロファイル（network なし）。
2. `./node_modules/.bin/tsx /tmp/d-audit/02-fetch.mts`（cwd=worktree）：
   root `.env` を `process.loadEnvFile` で読み、既存型付き getter 経由で D1 REST へ
   SELECT のみ。fresh 集計 + core 4 表を private 0600 で保存。
3. `./node_modules/.bin/tsx /tmp/d-audit/03-compare.mts`：全銘柄の旧 vs 新判定
   （既存 reader コードを import、旧式は `judgeTrend` / `hasDefinitionBreak` を再利用）。
4. `node /tmp/d-audit/04-strata.mjs`：層別 20 銘柄の選定と詳細表。
5. git に残すのは本ドキュメントの集計のみ。行 dump・SHA 以外の原本値は git 外。
