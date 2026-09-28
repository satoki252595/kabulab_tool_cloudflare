# 実データ監査レポート:財務・銘柄対応・有報定量・IR・優待/配当（2026-09-28）

Issue [#146](https://github.com/satoki252595/kabulab_tool_cloudflare/issues/146)。
担当A（財務・銘柄対応・有報定量・IR・優待/配当）の実データ検証記録。
株価/indicators・moneyflow は他 worker の担当で本レポートの対象外。

## 0. 要旨

- 監査ブランチ `audit/fundamentals-2026-09-28`（`origin/main` 18d5939 = #145 から分岐、開始時 clean）。
  `#144` の全原本 proof（journal・cache・receipt）を read-only で再利用し、新しい全原本 job は起動していない。
  監査中の 08:55 UTC に `origin/main` は c84b6a4（[#147](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/147)）へ進んだ。
  監査コードは local 18d5939 に固定したまま行い、09:30 UTC の再読で #147 の記録と独立に一致を確認（§1・§2.6）。
- 全件構造検査（D1 fresh read）と原本標本照合（保存済 raw/cache・公開一次資料・Notion fresh GET）を分けて実施。
  Notion/D1/R2 への書込、ingest・sync・ranking・master apply は一切行っていない（全 D1 応答 meta で
  `rows_written=0` / `changed_db=false` を確認、Notion は GET/query のみ・1 プロセス 1rps 以下）。
- 発見は 5 件（F1 は監査中に owner 側の同期で解消済み・解消後を再検証、F5 は候補）。データ修復 writer は起動していない。

| # | 内容 | 重要度 | 状態 |
|---|---|---|---|
| 1 | `#145` の `raw_page_id` が source D1 で全件 NULL（朝の観測）→ 09:30 UTC 再読で 34,659/34,659 反映・全件 journal 一致を確認 | 中（解消済み） | owner 同期で解消、再検証 PASS |
| 2 | 有報海外売上で 59 文書が 1% 合計整合 rule に違反（最大乖離 99.4%、画面の内訳と合計が不一致）。S100J2E7 は現行 code の純 replay で保存行を完全再現（aggregate-before-dedup。他 58 の原因は未確認・候補） | 高（対象行） | 未修復・owner 対応待ち（再取込だけでは再発する。code fix が必要） |
| 3 | 優待利回り 32 行が現入力再計算と不一致（うち fresh 7 行。2683 は画面 1.01% に対し現入力再計算 5.04%。原因は候補） | 低〜中 | 未修復・owner 対応待ち |
| 4 | 純抽選 13 行（5 銘柄）に推定金額あり（spec は null。3903 は画面に「推定 16,000,000円」）。抽選 keyword 38 行は候補母集団であり 38 違反ではない | 中 | 未修復・owner 対応待ち |
| 5 | （候補）147A の `estimated_value=180` は原文 `180USD` の未換算（円建ての列に USD 値。spec の外貨 handling は未定義） | 低 | 未修復・owner の spec 判断待ち |

- 観測（Finding 外）: 事業タグ根拠文の 2 文結合（継ぎ目マーカーなし・§4.4）、8508 の要約/掲載文不一致（§6.5）、IR 軽微 2 件（§5.3）。
- 結論の層別（全件/標本/未確認 × 取得/保存/表示/鮮度。未確認は合格に数えない）:

| Finding | 層 | 全件 | 標本 | 未確認 |
|---|---|---|---|---|
| F1（解消済み） | 保存（sync 遅延） | 34,659 全件一致 | 27 原本到達 | なし（§8-3 の relation 側を除く） |
| F2 | 保存（parser＋dedup）→表示 | 59 文書の違反確定 | 原因確定は 1 文書（replay） | 58 文書の原因 |
| F3 | 保存（stale）→表示 | 32 行の差分確定 | — | 差分の内容・時期（候補） |
| F4 | 保存（推定値）→表示 | 候補 38 行の全読＋ranking 全件再計算 | — | 境界 7791 の分類 |
| F5 | 保存（単位）→表示 | 外貨 census 1 行 | — | spec 判断（候補） |
| 財務取得 | 取得 | journal↔cache 全件＋D1↔journal 全件 | 27 標本＋原表 1 セル | 全件の原表対照 |
| IR 当日分 | 鮮度 | — | — | 09-28 の 197 件（catchup 前） |
- 分野別の結論:
  - 財務・銘柄対応: 全 34,659 行の D1↔journal 照合は数値完全一致（license 40 行は stricter 維持の設計どおり・証拠あり）。
    層別 27 標本の独立再導出・Notion 原本到達・公開索引の振る舞いも PASS。543A 異常値は原表表示との 1 セル対照で源泉異常値と確定（§2.5）。
    財務履歴なし 10 社は種類株 6（契約外）と正規 4 桁 4（正規 missing）に分離（§3）。誤り 0（Finding 1 は解消済み）。
  - 有報定量: 受注は標本・構造とも PASS。海外は Finding 2 の 59 文書が誤り（原因の確定は 1 文書のみ、残り 58 は候補）。
    テキスト索引・事業タグ・競合は最小 3 例検証で PASS（ただし根拠文の結合表示に観測 1 件。§4.4）。
  - IR: 直近 30 日 2,909 行の構造・2 日分の全件突合・タグ再計算は PASS。sentiment の本文方向 3 例は一致（§5.2）。軽微な観測 2 件（§5.3）。
  - 優待/配当: 構造・スコア再計算・銘柄対応は PASS。Finding 3・4・5 が誤り/候補（派生値・推定値・単位）。要約条件 3 例のうち 1 件に不一致の観測（§6.5）。

## 1. 監査条件

- 取得起点: `origin/main` 18d5939（#145 merge 直後）。本ブランチは同起点からの独立 audit branch。
  監査コードは local HEAD 18d5939 に固定したまま行った（「変動なし」は local 固定の意味）。
  監査中の 2026-09-28 08:55 UTC に `origin/main` は c84b6a4（[#147](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/147)
  `docs(financials): record original-page proof and temporary D1 cleanup`）へ進んだ。#147 の merge を否定しない。
  #147 は財務の original-page proof と isolated D1 削除証跡の記録であり、§2.6 の 09:30 UTC 再読（34,659/34,659・journal 一致）は
  #147 の記録と独立に一致する。
- 変動点の明示: 財務 source D1 の `raw_page_id` 列は監査開始後に値が入った（§2.6。D1 の変化であり Git の変化ではない）。
- 境界:
  - 新規 install なし（nix shell + 既存 `node_modules` の wrangler/tsx/vitest、stdlib python のみ）。
  - `pnpm audit:overseas` は欠 cache で新取得するため起動していない（海外の検証は D1 全件 SQL + 個別原本 GET で代替）。
  - 財務の全原本再 parse（34,663 件 job）は禁止のため未実施。代替として journal↔cache の全件突合 + 層別標本の独立再導出を実施。
  - JPX 新様式・信用残日次化は 9/29 延期のまま（対象外）。
  - Notion fresh read は標本 GET/query のみ（全件再証明は重複のため実施しない）。送信開始 1rps 以下を厳守。
  - `.env` は original の読取専用利用（値の出力なし・shell source なし・copy なし・Git/Issue/PR へ配置なし。
    初回は `node --env-file`、追検は `process.loadEnvFile`＋既存型付き getters のみで参照）。
    D1 は wrangler OAuth 経路を維持（`.env` token へ置換なし）。
- 単位・許容誤差: 金額は円・整数完全一致、比率は再計算値との絶対差で評価（財務 ±1e-9、海外比率 ±0.05・1 位丸め、
  優待利回り ±1e-9）。原文引用は最小限（比較に必要な行のみ、全文・署名 URL・秘密値は出さない）。
- 時刻は UTC。D1 fresh read は 2026-09-28 08:30〜09:35 UTC＋追検 09:45〜10:35 UTC、
  Notion fresh GET/query は同日 09:00〜09:35 UTC＋追検 10:00〜10:20 UTC（いずれも ≤1rps 厳守）。
  EDINET は追検で type=5 CSV 3 通＋type=1 XBRL 1 通のみ取得（3s pacing。SHA は §4.4・§2.5）。

## 2. 財務・銘柄対応（jss_financials / core_stocks）

母集団: source D1 `jss_financials` 34,659 行・34 列、journal 34,663 行、raw cache 34,663 ZIP。

### 2.1 #144 proof の再利用検証（read-only）

- 最終 journal `/tmp/kabulab-financial-full-instant-final-audit.jsonl`（private）:
  34,663 行・80,645,487 bytes・SHA256 `3be26f4d…e954364e` が記録値と一致。
- 内訳の再集計: TDnet 2,931 / EDINET 31,732、連結 29,827 / 単体 4,836、
  1Q 5,177 / 2Q 3,817 / 3Q 4,301 / 中間 8,340 / 本決算 13,028、parser `fdfa3c89…` 全行、
  raw_sha 重複 0、未来の実績期末 0（最大 2026-08-31）、無変更 256 行。すべて記録値と一致。
- raw cache 34,663 ZIP: ファイル名 pattern 全件適合、journal raw_sha 集合と完全一致（両方向差分 0）、
  全件 content SHA256 とファイル名が一致（mismatch 0、1.9GB フルスキャン）。
- journal の `raw_page_id` は 34,663 行全件に存在（D1 反映前から journal 側は完備）。

### 2.2 source D1 全件構造検査（fresh read）

| 検査 | 条件 | 結果 |
|---|---|---|
| 行数・列数 | 34,659 行・34 列（PK 4 列） | PASS（`raw_page_id` 列あり） |
| PK 重複 | `(code, fiscal_period_end, disclosure_type, consolidated)` | 0 件 |
| source 内訳 | EDINET 31,730 / TDnet 2,929（journal 差 −2/−2 = 同一キー合流 4） | PASS（§2.4 で合流を確認） |
| EDINET doc_id/raw_sha | 全件存在 | 31,730/31,730 |
| TDnet doc_id | 144 件存在 / 2,785 件 NULL（番号不明を維持） | 記録どおり |
| TDnet raw_sha | 全件存在 | 2,929/2,929 |
| `stock_id` NULL | 1,967 行・404 コード（過去コード等、nullable 契約どおり） | PASS（§2.3） |
| 未来の実績期末 | `fiscal_period_end > 2026-09-28` | 0 件（最大 2026-08-31） |
| `disclosed_at` NULL | 公表日不明 | 0 件 |
| raw_sha 一意性 | `COUNT(DISTINCT raw_sha256)` | 34,659 = 行数 |
| 連結/単体・期種・会計基準 | journal 差は合流 4（連結/1Q×1・中間×3）のみ | PASS |
| ROA 全 NULL | `roa_pct` 非 NULL 0 | 設計どおり（`cloud_store/financials.py:93`「未取得のまま」+ journal も 0） |
| exact 0 の分布 | 売上 1・営利 2・経常 2・純利 9・EPS 2・BPS 0・自己資本比率 3・配当実 100・配当予 367 | 記録（0/NULL の取違えは標本で確認 §2.5） |

### 2.3 D1↔journal 全 34,659 行の値照合（fresh dump 比較）

- 方法: D1 全行を SELECT のみで dump（35 page、meta 全件 `rows_written=0`）し、journal `new` の
  19 数値 + 8 メタ（`disclosed_at`/`fetched_at` は epoch 変換・`raw_sha256` 等）とキー単位で比較。
  `stock_id`/`doc_id`/`raw_page_id` は別検査（§2.3 後段・§2.6）。
- 結果: **34,619 行が全 27 field 完全一致**。不一致 40 行は `license_tag` のみ。
- 40 行の内訳: すべて EDINET かつ journal `commercial-ok` に対し D1 `factual-cite`。
  修復前 source snapshot の同一 40 キーが `factual-cite` のまま残ったもので、
  `stricter_tag_sql`（厳しい側を維持）の設計どおり・fail-safe 方向。数値への影響なし。
  journal `old` も `commercial-ok` のため、旧 D1 と旧正本の tag 差を sync が厳しい側へ寄せた形。
- `stock_id` 対応則の全件検証: NULL ⟺ code が core 外（1,967/0 違反）、
  非 NULL は `code→id` が完全一致（32,692/0 違反）、orphan 0。
- EDINET `doc_id` と原本 URL の linkage: 全 31,730 行で `doc_id == raw_url` の `/documents/{id}`（mismatch 0）。

### 2.4 同一キー合流 4 件（訂正・再開示の境界）

- journal の複数行キーは 4 件のみ（3911 中間・5035 中間・6071 中間・7509 1Q。いずれも TDnet×EDINET の同キー対）。
- D1 の採用側は 4 件すべて **遅い `disclosed_at`**（新しい開示を保持）。記録どおり。
- D1↔journal 照合は採用側との一致で PASS（§2.3 に含む）。

### 2.5 層別 27 標本の独立再導出（保存済原本 ZIP → stdlib 再 parse → D1 比較）

- 選定: 指示銘柄 8154/3911/3463/7384/543A + IFRS 連結/単体・US 連結・日本単体（本決算/中間）・基準 NULL・
  TDnet（doc 有/無・本決算/四半期）・stock 未対応（EDINET/TDnet）・EDINET 1Q/2Q/3Q・合流 4・決算期変更候補・
  nil-heavy・3681・7129。計 27 キー（EDINET 15・TDnet 12）。
- 方法: cache ZIP を stdlib のみで tidy 化（EDINET CSV デコード・TDnet iXBRL の context/unit/sign/scale 復号。
  `convert/xbrl_to_csv.py` の公開 rule を鏡写し）し、`normalize.py` の選択 rule
  （company-wide・unit 適格・当期/予想・連結優先・累計優先・本表優先・単一値・pure→%・中間 Instant・
  翌期予想揃え・dps AnnualMember）を独立実装して 19 数値 + 期末/期種/連単/基準を再導出、D1 と比較。
- 結果: **27/27 PASS**（全 field 差分 0）。許容誤差 ±1e-9 での不一致なし。
- 境界 rule の作動確認（手動）:
  - 543A 本決算単体: `EquityToAssetRatioSummaryOfBusinessResults`・unit pure・`-407582616.0000` → ×100 で
    D1 `-40758261600` と一致。閾値除去なし。
  - 543A 原表 1 セル対照（追検）: 同一開示 S100YK16 の type=1 XBRL 1 通のみ追加取得（SHA256
    `b15cb67a6cd6de6c6cb7f69e6f8585ade77c9760f3094c34575a4e18b857fd89`、private 保持）し、原表表示と対照。
    インスタンスは単一 fact（context `2026-03-31` instant × `NonConsolidatedMember`・unit pure・decimals 4・
    値 `-407582616.0000`。CSV も同一 1 行で競合候補なし → 選択誤りの余地なし）。
    原表（`0101010` 主要な経営指標等の推移・自己資本比率（％）行・当期末個別列）の表示は `△40,758,261,600.00` で、
    ix 属性 `scale="-2"`・`sign="-"` を介して XBRL 値と完全一致（40,758,261,600.00×10^-2×(−1) = −407,582,616.00）。
    結論: 異常値は原表表示そのものに存在する**源泉異常値**であり、取得選択・単位変換（pure→%。(％) 見出しと整合）は正しい。
    clamp/補正は行わない。本件は当該 1 セルの確認であり、全件の原表対照ではない（「財務取得誤り 0」を
    全入力正確性の保証へ広げない）。
  - 3463 本決算単体: 本表 CurrentYear の期間が 2026-08-01〜2027-01-31（未来）のため除外され、
    ResultMember（2026-02-01〜2026-07-31）の営業利益 1,625,000,000 を採用。D1 と一致。
  - 7384 中間: InterimInstant 優先で BPS/自己資本比率を採用（D1 一致）。
  - nil-heavy 4901 1Q（非 NULL 2 項目）: 欠損のまま PASS（0 埋めなし）。
- 決算期変更候補: 本決算月が複数ある code は 51 件。標本 175A は PASS。
  51 件の網羅的是非（真の期変更か）は未検証（§8）。

### 2.6 Finding 1: `raw_page_id` の未反映→反映（解消済み）

- 観測1（2026-09-28 朝・08:42Z 以前）: `SELECT COUNT(*), COUNT(raw_page_id)` → 34,659 / **0**。
  列は存在（34 列・ALTER 適用済み）だが値が未反映。#145 文書の「実 D1 反映結果は反映後に追記する」と整合。
- 観測2（2026-09-28 09:30:53 UTC・本レポート直前の再読）: 34,659 / **34,659**。
  全件を journal provenance とキー単位で照合し **34,659 一致・mismatch 0・UUID 形式不良 0**。
- 独立 owner の source 同期が監査中に着地したもの。監査側の DDL/sync はなし。本件は解消済みとして記録。

### 2.7 Notion 原本到達（fresh GET・27 標本）

- 27 標本の `raw_page_id`（⑤）へ GET: **27/27 到達**（200・非 archived）。
  各 page に原本 ZIP + converted CSV + converted parquet の 3 添付を確認（ファイル名のみ記録）。
- TDnet doc_id 無し 2,785 行の既存到達経路（③「原本」relation→⑤ page_id→添付 ZIP）は、
  標本（tdnet-nodoc 2 + unmapped-tdnet 1 を含む）で到達を確認。全 2,785 件の page 到達は未検証（§8）。

### 2.8 公開索引 coverage（fresh D1 + 公開 endpoint）

- `jss_raw_files` は 1,153 行。財務原文の索引接続は EDINET 178/31,730・TDnet 144/2,929。
  TDnet 索引 144 = doc_id あり 144 と完全一致。doc_id 無し 2,785 の索引は **0**（前回 08:01 UTC 観測から不変）。
  索引済みは disclosed 2026-09-11〜09-25（通常 writer の新規取込分）のみ。
- 公開 endpoint（`jss-api-public` `/health` 200 確認済み）:
  - 索引済み commercial-ok EDINET → **200**（メタデータ応答、r2_key/doc_id あり）。
  - 索引済み factual-cite TDnet → **403** `restricted`（license gate が設計どおり作動）。
  - 未索引（TDnet doc 無し・歴史 EDINET）→ **404**。
- R2 物理オブジェクトの有無は索引の外からは証明しない（索引未接続の確認に留める）。

## 3. 銘柄対応・core（core_stocks）

- 3,810 行・active 3,700、`equity` 3,700 / instrument NULL 110。
- 財務履歴なし 10 社の分離（追検で訂正。10 社を一括りに「not fetched」とは呼ばない）。
  anti-join（core − 財務 distinct code）はちょうど 10 社で一致。内訳:
  - 種類株 6（25935/50765/75505/92025/94345/94346）: いずれも 5 桁・`is_active=0`・instrument NULL。
    `jss_financials` の code は全 34,659 行・4,204 コードが 4 文字（issuer 4 桁財務 code 契約）であり、
    6 社の 4 桁 prefix（2593/5076/7550/9202/9434）には各 7〜10 行の財務が存在する。
    5 桁行は exact-code 対応で構造的に結合不能（契約外）であり、データ欠落ではない。補間なし。
  - 正規 4 桁（A 含む）missing 4（542A/575A/589A/590A）: active・equity かつ財務 0 行の正規 missing。新規上場銘柄の未取込とみられる。
- 3681/7129（read-only、統合 apply なし）:
  - 3681: id 2532・`is_active=0`・instrument NULL・財務 8 行。D1 上は独立行のまま（#137 は Notion 側手順）。
  - 7129: id 1145・active・equity・財務 8 行。
- 取込母集団 predicate（`disclosureIngestCondition`）の現 snapshot 評価は 3,810/3,810（全行が対象）。
  3681（delisted + NULL 型）も対象に含まれる（上場廃止銘柄の開示は取り込む rule と整合）。
- `is_yutai` と優待行の双方向一致は §6.1（0/0）。

## 4. 有報定量（yuho-quant）

母集団: `yuho_documents` 37,974、`yuho_order_facts` 41,368、`yuho_overseas_facts` 21,258。

### 4.1 全件構造検査（fresh D1）

- 文書: `doc_id` 重複 0・stock orphan 0・fact の文書 orphan 0・period 最大 2026-06-30（未来 0）。
  `notion_doc_page_id` 37,964/37,974（10 件欠け）。
- parse 状態: 受注 ok 系 12,017（a/b/c/total_only/orders_only）・`no_order_table` 24,646・`table_unrecognized` 1,311。
  海外 ok 3,675（rows/cols）・`no_overseas_table` 27,092・`geo_present_unstructured` 7,204・`parse_error` 3。
  テキスト ok 37,965・error 7・none 2。
- fact 重複: 受注は `(document, segment, kind)` で 445 group → **年度を含めると 0**
  （pattern B/C の当期+前期 2 期分の正当な対）。海外は `(document, region, kind)` で 0。
- `fiscal_year_end ≠ period_end` は受注 447 行のみ・**全件が前期**（pattern B/C の前期列。設計どおり）。海外は 0。
- 単位→円換算の全件再計算: 受注高・受注残・海外売上すべて **mismatch 0**（千円/百万円/億円/円）。
- raw/y の NULL 対応: 3 列とも mismatch 0。exact 0 は受注 29・残高 71・海外 2（§4.2 で標本確認）。
- 海外 ratio 再計算: `overseas_total/total×100` との最大絶対差 **0.05**（1 位丸め。同一 snapshot の
  3,675 文書中 mismatch 0。旧版の「3975 文書」は誤記で、ok 2,683+992=3,675 = `overseas_total` 行数 =
  `ratio_pct` 非 NULL 行数と一致）。
  `ratio_pct` は `overseas_total` 行のみに存在（3,675/3,675）、負・100 超は 0。
- 状態↔fact 形状: `orders_only` 文書の残高 NOT NULL 0、`ok_total_only` の非 total 行 0、
  海外 ok 文書の total/overseas_total 欠落 0。

### 4.2 原本標本照合（EDINET API read-only GET・3 文書）

取得は `GET /documents/{id}?type=1` のみ（archive/writer を伴う経路は未使用。計 4 文書）。

- S100VWDC（7012・2025 有報・pattern_a + geo_rows）:
  - 受注 6 セグメント + 合計が原文表と**全額一致**（百万円単位・前期比列の混入なし）。
    セグメント合計 = 合計（2,630,757）と一致。
  - 海外は当期列を正しく選択（日本 592,612/海外合計 198,816/合計 791,428 で一致。前期列ではない）。
- S100RRLM（1419・0/NULL 境界）: 不動産事業の受注高 原文 `0` → D1 **0**、受注残高 原文 `－` → D1 **NULL**。
  0/NULL の区別が正しい。住宅・合計も一致。
- S100J2E7（7277・total_only + Finding 2 文書）: 受注合計 45,934/残高 4,796 が原文合計行と一致。
  海外は §4.3。
- Notion 到達: 3 文書の `notion_doc_page_id` は有報テキスト page（3/3 到達）。
  一次 DB（`一次データ｜yuho-quant`）に 3 文書の key が各 1 行・`_csv.zip` + `_xbrl.zip` 添付あり。
  `notion_doc_page_id` は一次 page への直接 link ではない（導線の注記）。

### 4.3 Finding 2: 海外売上の合計不一致 59 文書（未修復）

- 検出（§9 の SQL・追検で fresh 再実行）: 文書単位の `SUM(overseas)` と `overseas_total` を比較し 1% 超乖離を抽出。
  → **59/3,675 文書（1.6%）**。fresh 集合と旧抽出の対称差分は 0（母集団確定）。
- fullkey 再集計（追検）: 比較 key を `document_id`＋`fiscal_year_end`＋`is_consolidated`（NULL distinct）＋`pattern` とし、
  `SUM(overseas)` vs `overseas_total` のみで再集計（private `/tmp/overseas_fullkey_reagg.py` SHA256
  `8f69d715977a4018032f8cc4b9942b0b57e81453e5d5547abcbbe864f2bcbd7b`）。
  59 群 327 行の実集合証明: 期単一（文書内複数 0）・scope 単一（0）・pattern 単一（0）・NULL 額 0。
  → 59 group = 59 文書で 1:1、59/59 が 1% 超違反。最大乖離 99.4%（S100T6Q9）。
  乖離率分布は 1〜5%:22・5〜10%:6・10〜50%:17・50〜100%:14。
- 契約の分離（追検）: 全売上 `total` との差は別契約。`total == domestic+overseas_total` は 59 文書中 12 のみ一致・
  47 不一致（`total` は「その他の収益」等の非地域分を含む場合がある）。比較に混ぜない。
  「うち、米国」等の subset 行は保存 0（59 群・全件とも）で除外対象なし。米国 plain 地域行は正規の overseas。
  SQL の `SUM` は NULL を無視するが、本集合に入力 NULL は 0 のため無関係。
- pattern 内訳: geo_rows 283 行・geo_cols 44 行（文書単位では単一 pattern: ok_geo_rows 51 文書・ok_geo_cols 8 文書）。
  `ingested_at` は 05-17〜09-23 に分散。銘柄 cluster は 16 コード（7203×11・2802×7・9147×7・4041×5・5013×5・
  8946×5・7277×4 他。旧版の「7203×2」は誤り）。
- 純 replay（追検・S100J2E7）: 取得済 raw ZIP（SHA256 `770bd1dad6a3d947b812b54b4bb75364f39c1b66389ff38c8a6e1505ed04eb53`）→
  現行 `parseOverseasData` → 取込 dedup の純 replay（private `/tmp/overseas_replay_j2e7.mts` SHA256
  `5b6b7fafb4362aa126bb231946f21f715264a643de81fb223e842e1cb5399dc2`。parser
  `c81db371…`・ingest `de8d3373…`・HEAD b22fd91 で実行）で、保存 5 行を**完全再現**した
  （`honbunFile`・`is_consolidated`・`ratioPct` 38.6 まで一致）。
  機序: 製品 2 ブロック縦積み表を parser が単一値列で全行読む（日本 16698/14814・アジア 5439/11524・北米 2864）→
  pre-dedup の regionSum 51,339 が連結 51,340 と 1% gate を通過 → `overseasTotal = regionSum−domesticSum` = 19,827 を確定 →
  取込の (会計期末, 地域名) dedup（scope key なし・先頭採用）が日本 14814/アジア 11524 を落とし、保存の地域計 8,303 と
  合計 19,827 が乖離。すなわち **aggregate-before-dedup** であり、parser 単体の誤読ではない。
- 旧判定の撤回と限定: 旧版の「現行 code では生成不能な stale 誤 parse」は S100J2E7 については**誤りだった**（現行 code が決定的に再生成する）。
  残り 58 文書の原因は未確認であり、1 原本から 59 全体の原因を一般化しない（候補: 同一機序。同一銘柄の複数年違反が table-shape 起因を示唆するが証明ではない）。
  取込/backfill（`backfill-overseas.ts`・`backfill.ts` の `--force`）は文書単位 DELETE+INSERT の原子置換のため、
  stale leftover（旧行の残存）の断定は不可。remedy は「再取込」ではなく code fix（重複地域名の却下 or dedup 前 gate 等）＋ force 再取込。owner 対応。
  parser code の変更は本監査では行わない（候補を親へ共有済み）。
- 影響: 株式詳細・海外 screening は保存行をそのまま表示（`overseas-query.ts` に再計算ガードなし）するため、
  対象 59 文書の breakdown 表示が合計と一致しない（59 doc_id 清单は private `/tmp/yuho_viol59.json` 保持）。
  `ratio_pct` は保存合計との再計算で整合するため alarm なし（§4.1）。
- 重要度: 高（対象行）。全件性: D1 全件 SQL で母集団確定済み。原因の確定は 1/59、58 は候補（未確認を合格に数えない）。

### 4.4 開示テキスト索引・事業タグ・競合の最小検証（追検・各 3 例）

旧版 §8-5 の「件数・状態のみ」は scope 不足のため、最小 3 例ずつ検証した。Notion は query/GET のみ（≤1rps）、
EDINET type=5 CSV は 3 通のみ取得（3s pacing。SHA256: S100YIEX `1094e3c6360f1aac393ceccb09eed756bb1cc407c1b259aa1aa0cdcc8eb2d4c1`・
S100YG9I `4a507aae555f695c9c9028e2768a22397803905727297a4d630b44a812283a93`・S100YEU4 `e50f5f8bb9747621c74f72e1fe4a7e5736b304ce1ba5bb869dbcc25da41860b1`、private 保持）。
標本は Notion 補足 DB の判定済 3 行（8708/S100YIEX・8707/S100YG9I・8706/S100YEU4。いずれも 2026-03-31 決算）。

- テキスト索引/doc 期の一致（3 例）: 3 文書とも `text_parse_status=ok`・`fiscal_year_end == period_end`（2026-03-31。
  文書内複数 0）・36/35/36 セクション。保存 `element_id` 107 件は各 CSV 原文中に全件存在（36/36・35/35・36/36）。PASS。
- 事業タグ原文（3 例）: 保存タグ（8708: 資産運用/証券・8707: 証券・8706: 証券）と根拠文の引用を各 CSV 原文と照合。
  8707 は 208 字の完全逐語一致。8708・8706 は各引用が 2 文結合で、両半とも原文に存在するが非連続
  （8708: 410 字離散・8706: 中 1 文欠落）。結合は設計どおり（`row.ts` の最大 2 文 `join("")`）だが継ぎ目マーカー
  （中略等）がないため、verbatim 監査では不一致に見える。観測として記録（Finding 外。タグ名自体は原文に存在）。
- 競合 relation 相手 code（3 例）: 8708→8609・8707→8616・8706→8614（各行の先頭 relation 先。3 行とも 25 件の relation あり）。
  7 コード全件が core の active・equity 行に解決（orphan 0）。PASS。競合としての妥当性判断（業種近似等）は対象外。
- 限定: LLM/判定の正確性保証は設計上なく（別 §）、本検証は「原文存在・期一致・code 解決」の範囲。3 例超の一般化はしない。

## 5. IR（ir-catalog）

母集団: `ir_disclosures` 48,319（2010〜2026-09-25）、直近 30 日 2,909、`ir_disclosure_texts` 3,605。

### 5.1 直近 30 日の全件構造検査 + 2 日分の原本全件突合

- 日次 histogram（JST）: 08-29(土) 1・08-31〜09-25 の平日は 79〜370・09-21(敬老) 1・
  09-22(国民の休日) 0・09-23(秋分) 0・09-26(土) 0・09-28(当日) 0。
  09-22 の 0 は yanoshin API でも 0 を確認（休日）。09-28 は API 197 件・D1 未取込（当日 catchup 前の鮮度境界）。
- 2026-09-24（API 203 → 母集団内 138 = D1 138）・09-25（API 239 → 202 = D1 202）:
  集合の双方向差分 0、title/pubdate(JST→epoch)/code/document_url-tail の mismatch 0。
  母集団は `disclosureIngestCondition` の exact predicate で再現。
- key・join: `tdnet_id` 重複 0・stock orphan 0・`stock_id` NULL 0・code 先頭 4 桁の core 外 0。
  title 空 0・document_url NULL 0・未来 pubdate 0。
- tag: 30 日 2,909 行の保存 `tags` + `primary_tag` を repo の `classify()` で再計算し **全件一致**（JSON 不良 0）。
  未分類（`[]`/NULL）は全期間 19,741（40.9%）。
- 方向・訂正: `増配` 596・`減配・無配` 75（`減配` 表題 2 件は両方とも正しく multi-tag）。
  訂正表題の 2 標本は `訂正・取消` を tags に保持しつつ primary は event tag（設計どおり）。
  中立（`配当(決定・予想)` 等）は方向付けなし（rule どおり）。

### 5.2 標本・到達・画面

- 減配原本（1253177・05-15）: yanoshin day API で code/title/pubdate が D1 と一致。
  増配/業績修正/訂正/中立/未分類の 30 日標本は §5.1 の日次突合に含まれ全一致。
- PDF 到達: 09-25 文書 200、31 日 edge（08-28）も 200（purge 前）。
- Notion 一次: `tdnet-daily-2026-09-24/25` + `tdnet-2026-09` の 3 batch が各 1 行・JSON 添付あり。
- Notion 二次: 30 日の `notion_page_id` 欠けは 168（09-25×167 の日次 budget lag + 09-08×1 straggler）。
- 公開画面: 6533 株式 page に 09-25 増配（1281955）が表示されることを確認。
- sentiment（`pdf_sentiment`）は推定のため正確性保証の対象外。分布のみ記録:
  NULL 30,712 / skipped 14,559 / positive 1,492 / negative 680 / unknown 859 / mixed 17。
  「保証外」（設計上の性質）と「原文未検証」（監査 scope）は別の事柄であるため、本文方向の最小 3 例を追検した
  （D1 保存テキストのみ使用。全文引用なし）:
  - positive 1276649（dict_v1・0.563）: ストックオプション付与（士気・業容拡大目的）の手続文書。本文方向は中立〜positive で矛盾なし。
  - negative 1277538（rule_v1・1）: 特別損失 51 百万円の発生。明確に negative で一致。
  - unknown 1277227（dict_v1・−0.125）: 第三者割当の払込日通知（上場廃止日程を含む手続文）。score は 0 近傍で label unknown
    （閾値未満の abstain）は妥当。方向の断定を強制しない設計どおり。
  3 例とも label と本文方向に矛盾なし。3 例超の一般化はしない。

### 5.3 軽微な観測（誤りではない）

- `ir_disclosure_texts` 3,605 行に対し `pdf_text_status='ok'` は 3,604 行。差分 1 行（tdnet 1277884）は
  text あり（2,508 字）+ status `error`。保存成功後の状態更新失敗または再取込時の部分失敗の形で、
  次 run で自己回復する。text 欠落なし。
- 30 日二次 168 件の `notion_page_id` 未反映は日次 budget 打ち切りの既知運用（WINDOW 重なり+冪等で回収予定）。
  09-08 の 1 件は straggler として owner 側の回収対象。

## 6. 優待・配当（otakara-yutai）

母集団: `yutai_benefits` 8,295 行・1,661 銘柄、`otakara_stock_financials` 1,636 行。

### 6.1 全件構造検査（fresh D1）

- 8,295 行: stock/genre orphan 0・record_month 1–12（NULL・範囲外 0）・`min_shares` 全件正・
  `short_summary` 欠け 0・`estimated_value` NULL 2,964（35.7%。金額化不能の正直な NULL）。
- `is_yutai` 1,661 銘柄と優待行の双方向一致（両方向 0）。最終更新 2026-06-22（3 か月前の月次 snapshot）。
- 110-tier の 9006（京急）は 55 品目×2 か月の正当な構造（割引券中心で value NULL が大半）。
- 配当 financials: otakara 1,636 行は core 3,756 行の優待 subset（copy 元不在 0）。
  otakara snapshot は 09-13 中心、core は 09-25 中心のため 1,616 行が field 差あり（日付差の stale。
  同日 join 検証は日付集合が disjoint のため不可。copy 自体は月次 rebuild の 1:1 上書き code）。
  優待 48 銘柄が otakara financials 未保持（core 未取得 skip の設計どおり）。

### 6.2 優待利回りの全件再計算 → Finding 3（未修復）

- `calcYutaiYield`（`src/cron/monthly.ts`）を D1 現入力（otakara price + 非 NULL 行）で 1,636 行に再適用。
  2 つの独立手法（Python 純 port・private `/tmp/yield_recompute.py` SHA256
  `33a11e2e13674e55658e8b984b91e14e8f9c7271faa5ba08fb7f6d51e350d571` と §9 の SQL CTE）が一致。
  → **32 行が不一致**（±1e-9）。内訳: 旧日付の frozen 25 行（設計上の stale）+ **fresh（09-13）7 行**
  （旧版の「fresh 3」は誤り。benefits 全行の `updated_at` は 06-22 以前のため監査間の D1 変化ではない）。
  fresh 7: 2683/8566/3848/5941/5957/7135/7893。frozen 25 のうち 2 行（4333/6210・05-01）は
  ~1e-8 の丸め級差（実質一致。Neon 時代の保存値の丸めとみられるが経路は未確認）。
- fresh の最悪例 2683: D1 1.0070493…%（画面 1.01% を保存 HTML で確認・事実として残す）に対し、
  現保存入力での再計算は **5.0352467…%**。5.04 は企業一次資料の確定値ではなく現入力の再計算値である。
  保存値 = 再計算値/5 の exact 関係にあり、100 株行の推定値 1,000→5,000 変化と整合するが、
  原因の断定はしない（候補: rebuild 後の入力変化。決定的関数の再計算が食い違うため「現入力≠rebuild 入力」は確定だが、
  どの入力がいつどう変わったかは未確認。確定手段は 09-13 以降の `summary:import --apply` 実行履歴との突合せ。owner 対応）。
- timestamp の扱い（追検で是正）: `summary:import` の writer は code 上 `{shortSummary, estimatedValue, estimateValueSource}`
  の 3 列のみ更新し `updated_at` に触れない（`import-summary-results.ts` で確認）。したがって `updated_at` では
  import 変更の有無を肯定も否定もできない。「証拠なし」は writer の性質であり、原因断定の根拠にはならない。
  表示 join は保存値に忠実（誤りは上流 stale）。
- 重要度: 低〜中（画面の誤表示 fresh 7 行＋frozen stale。丸め級 2 行は実害なし）。
  remedy は owner の rebuild/process fix。

### 6.3 推定金額の rule 違反 → Finding 4（未修復）

- 抽選 keyword 38 行（非 NULL かつ description/short_summary に `抽選`。17 銘柄）は**候補母集団**であり、
  38 違反ではない（追検で是正。通常＋抽選の併記があり得る）。原文で分離した結果:
  - 純抽選（金額が抽選自体を価格付け。spec §6 違反）: 13 行・5 銘柄。
    3189×2（100,000 = 最高賞品額）・3903（16,000,000 = 抽選総額）・3939（200,000）・
    7578×8（500,000 = 条件付き抽選賞品）・8508×2（0 値。§6 は 0 も不可）。
    3903 の画面は「推定 16,000,000円」を抽選文言と並べて表示（保存 HTML で確認済み）。
  - 境界 1 行: 7791（10,000）。価格付け対象の宿泊補助券（30 名様）の抽選性が原文で明示されず、断定不可。
  - 併記（金額が固定分を価格付け。適正）: 23 行・11 銘柄（1783/2503×3/2683×3/2751×2/324A×5/4301/4676×2/7780/8285/8331×2/9039×2）。
- 純抽選 3 例の条件比較（既存 D1 description vs summary/金額・株数・月。幾ら/何株/何年/回数）:
  - 3903: 総額 1,600 万（内訳 10 万×各 15 名/3 万×各 50 名/1 万×各 500 名）を 16,000,000 と総額計上（1 人分の賞品ではない二重の誤り）。
    500 株・保有条件なし・年 1 回（4 月）。保存 minkabu 原文と一致。
  - 3939: 20 万円×10 名（＋長期 3 名）を 200,000 と計上。100 株・1 年以上継続保有条件・年 1 回（9 月）。
  - 3189: 10 万×50 名/5 万×120 名/1 万×1,000 名のうち最高額のみ 100,000 と計上。500 株・口座条件・年 2 回（2 月＋8 月）。
- ranking 影響（追検・銘柄別。旧版の「4 社 cap → 全 38 影響なし」は断定不可のため撤回）:
  screening は `yutaiYield DESC NULLS LAST`（NULL は実質 unranked）。純抽選の帰結は銘柄別に異なる:
  3903/3939/7578 は cap で NULL（再計算一致）、3189 は抽選行が min 段を超えて不参加で NULL（cap は非抽選行由来）、
  8508 の 0 行は不参加・無加算。すなわち厳密な純抽選値は ranking に入っていない。
  ただし境界の 7791 は 12.15%（再計算一致）で ranking に入っており、owner の分類次第で ranking 影響が確定する。
  per-benefit 表示は純抽選行が誤誘導（3903 で確認）。
- rule は 09-13 制定（#29。値より後）、かつ機械 guard（`estimated-value-guard.ts`）に抽選 handling が 0 行のため
  再 import でも再発する。重要度: 中。remedy は owner の re-import + guard fix。

### 6.4 外貨単位の未換算 → Finding 5（候補・未修復）

- 147A の `estimated_value=180` は原文 `30USD×6=180USD`（600 株・4 月。保存 minkabu 原文と一致）の未換算。
  列の単位は円（spec §6）のため、USD 値をそのまま格納した単位誤りの候補。方向は過小（利回りの過小表示）。
  外貨 keyword（USD/US ドル/米ドル）の非 NULL 行は全件 census で当該 1 行のみ（母集団確定）。
  spec の外貨 handling は未定義のため、換算・null 化の判断は owner の spec 決定待ち。重要度: 低。

### 6.5 原本・履歴・画面の標本＋要約条件の最小検証（追検・3 例）

- minkabu 現 page（read-only GET・3 秒 pacing・計 5 page）:
  - 2683: 権利月 8 月・最低 100 株が一致。tier 構造は現 page が保有期間型（D1 の 500/1000 株 tier は 6 月 snapshot 由来の可能性。drift 未分離）。
  - 3903: 現 page は 4 月+10 月の 2 か月・500 株〜抽選（D1 は 4 月 1 行のみ。10 月 QUO は drift/取漏れのいずれか §8）。
  - 150A: 3 月・100/500/1000 株・割引クーポン（value NULL）が一致。
  - 3544（廃止）: D1 `is_yutai=0`/0 行、現 page も「優待情報はありません」で一致。
  - 147A（新設）: D1 600 株/4 月が現 page と一致（金額は §6.4 の Finding 5 候補）。
- Notion 一次（`一次データ｜otakara-yutai`）: `benefit-descriptions-2026-06-03/22` の 2 export のみ。
  group diff は removed 135 + added 244、銘柄 churn は gone 1（3544）/ came 47（A コード中心）。
  廃止×3 の標本は保存一次資料に 1 件しかないため不可（§8）。
- スコア再計算: 2683/3903/150A の `scoreStock` 再実行が保存値と一致（3/3 PASS）。
- 表示 join: tiers は「N株〜」+ price 別掲（必要額の合算表示なし）。2683/3903 の表示値は保存値と一致。
- 要約条件の最小検証（追検・D1 保存行のみ。金額/株数/月の一致）:
  - 1783: 固定ギフト 1,000＋割引＋抽選宿泊の併記を、固定分の 1,000 のみ金額化（割引・抽選は null 化。spec §6 どおり）。条件一致。PASS。
  - 147A: 株数（600）・月（4）・枚数（6）は一致。金額のみ USD 未換算（Finding 5）。
  - 8508（観測）: 500 株×2 行（6 月/9 月）の要約「美容皮膚科、医療脱毛…20%割引」が掲載文（宝塚抽選。美容/割引の語なし）と不一致。
    同一の誤要約が 2 行に付与されており、系統的な misassignment の形。兄弟の抽選行（5,000/10,000 株）は正しい抽選要約＋null 値。
    原因は未確認（owner 調査）。なお当該 2 行の 0 値は spec §6（0 不可）違反でもある（Finding 4 の純抽選に計上）。

## 7. Findings 一覧（repro・重要度・影響集合）

### F1（解消済み）raw_page_id 未反映 → 反映確認

- repro: `SELECT COUNT(*), COUNT(raw_page_id) FROM jss_financials`。
- 観測1: 2026-09-28 朝（08:42Z 以前）→ 34,659 / 0。観測2: 2026-09-28 09:30:53 UTC → 34,659 / 34,659。
- 34,659 件の値を journal provenance と照合し全件一致（mismatch 0・UUID 不良 0）。
- 重要度: 中（D1→Notion 原本導線が NULL）。影響集合: 全財務行（一時的）。監査側の書込なし。

### F2（未修復）海外売上の合計不一致 59 文書

- repro: §9 の SQL（文書単位）＋ fullkey 再集計（`document_id`＋期＋scope＋pattern。59 group = 59 文書で 1:1、59/59 違反）。
- 重要度: 高（対象行）。影響集合: 59 文書（`ok_geo_rows/cols` 3,675 の 1.6%。7203×11・2802×7・9147×7 他 16 コード。
  doc_id 清单は private `/tmp/yuho_viol59.json`）。画面の内訳と合計が不一致（最大 99.4%・S100T6Q9）。
- 原因: S100J2E7 は aggregate-before-dedup と確定（純 replay で保存 5 行を完全再現。§4.3）。残り 58 は候補・未確認。
  旧判定「現行 code 生成不能/stale」は撤回。再取込だけでは再発するため remedy は code fix＋force 再取込。owner 対応。

### F3（未修復）優待利回りの stale 32 行（fresh 7 行）

- repro: §9 の `calcYutaiYield` 再計算 CTE（Python port と一致。±1e-9）。
- 重要度: 低〜中。影響集合: fresh 7 行（2683: 画面 1.01% vs 現入力再計算 5.04%。5.04 は企業一次確定値でない）+ frozen 25 行
  （うち 2 行は丸め級で実害なし）。
- 原因: 候補（rebuild 後の入力変化。「現入力≠rebuild 入力」は確定、内容・時期は未確認。確定手段は import 履歴突合せ）。
  remedy は owner の rebuild/process fix。

### F4（未修復）純抽選優待の推定金額 13 行（5 銘柄）

- repro: §9 の keyword 抽出は候補母集団 38 行。原文分離で純抽選 13 行（3189×2/3903/3939/7578×8/8508×2）＋境界 1 行（7791）
  ＋適正併記 23 行。3903 は画面「推定 16,000,000円」。
- 重要度: 中。影響集合: per-benefit 表示の誤誘導（純抽選行）。ranking は純抽選値が入っていないが、
  境界 7791（12.15%）は ranking 内のため owner 分類次第で影響が確定する（旧「全 38 影響なし」は撤回）。
- 原因: 09-13 rule 以前の値 + guard の抽選 handling 欠如。remedy は owner の re-import + guard fix。

### F5（候補・未修復）147A の外貨単位未換算

- repro: §6.4。`estimated_value=180` vs 原文 `180USD`（600 株・4 月）。
- 重要度: 低。影響集合: 1 行（利回りの過小表示）。spec の外貨 handling が未定義のため owner の spec 判断待ち。

## 8. 未検証範囲（明示）

1. 財務の全 34,663 原本の再 parse（job 禁止）。代替: journal↔cache 全件突合 + 27 標本の独立再導出。
2. TDnet doc_id 無し 2,785 行の Notion page 全件到達（標本 3 のみ到達確認）。R2 物理の有無も未証明（索引 0 のみ確認）。
3. `raw_page_id` 反映後の Notion ③ relation 側の変化（D1 値のみ検証。③ fresh 再証明は重複のため非実施）。
4. 財務の決算期変更 51 候補の真偽（標本 1 のみ PASS）。
5. 有報テキスト 39 項目（`yuho_text_sections` 1,168,937 行）は最小 3 例検証まで（§4.4）。全件の原文照合は未実施。
   事業タグ・競合・IR sentiment・優待要約も各 3 例まで（§4.4・§5.2・§6.5）。3 例超の一般化はしない。
6. `audit:overseas` の取りこぼし集計（新取得のため未起動）。代替: D1 全件 SQL + 原本標本。
7. IR の当日（09-28）197 件（catchup 前で D1 未取込）。PDF purge 後の到達（31 日 edge は 200 確認）。
8. 優待の 6 月 snapshot と現 minkabu の drift 分離（tier 構造差の真偽は時系列一次資料なしに不可）。
9. 優待の廃止標本×3（保存 export の gone は 3544 の 1 件のみ）。変更標本の個別特定（group churn 135/244 は volume のみ）。
10. 文書跨ぎの同一銘柄・同一期の重複（訂正の新旧対等）は財務の合流 4・IR の tdnet_id 一意・
    yuho の doc_id 一意まで確認。EDINET 訂正報告書と元報告書の対応評価は未実施。
11. F2 の残り 58 文書の原因（raw replay は S100J2E7 の 1 文書のみ。58 文書分の EDINET 取得は全件再 fetch のため非実施）。
12. F3 の入力変化の内容・時期（確定手段は `summary:import --apply` 実行履歴との突合せ。owner 対応）。
13. F4 の境界 7791 の分類、8508 要約不一致の原因、F5 の spec 判断（いずれも owner 対応）。
14. 543A の原表対照は 1 セルのみ（§2.5）。全件の原表対照ではない。
15. 上記があるため「誤り 0」とは呼ばない。分野別の結論は §0 の限定付き判定。

## 9. 最小再現手順（read-only）

```bash
# 前提: リポジトリルート・既存 node_modules・wrangler OAuth 済み
export WRANGLER_WRITE_LOGS=false CLOUDFLARE_ACCOUNT_ID=5880d85c320ca5fee8baf9efddd005ed
D1='./node_modules/.bin/wrangler d1 execute kabulab-cf --remote --json --command'

# F1: raw_page_id coverage
$D1 "SELECT COUNT(*), COUNT(raw_page_id) FROM jss_financials"

# F2: 海外合計の 1% rule（59 文書。fullkey 再集計は §4.3 の private script で 59/59 を再現）
$D1 "SELECT COUNT(*) FROM (SELECT document_id FROM yuho_overseas_facts GROUP BY 1 HAVING ABS(SUM(CASE WHEN region_kind='overseas' THEN sales_yen END) - MAX(CASE WHEN region_kind='overseas_total' THEN sales_yen END)) > ABS(MAX(CASE WHEN region_kind='overseas_total' THEN sales_yen END)) * 0.01)"
# F2 fullkey: python3 /tmp/overseas_fullkey_reagg.py（SHA256 8f69d715…2bcbd7b。要 /tmp/viol59_facts.json + /tmp/viol59_docs.json）
# F2 replay: ./node_modules/.bin/tsx /tmp/overseas_replay_j2e7.mts（SHA256 5b6b7faf…5399dc2。要 /tmp/edinet_S100J2E7_t1.zip + /tmp/j2e7_saved.json）

# F3: 優待利回りの実比較 CTE（32 行・fresh 7 行。旧版の COUNT(yutai_yield) では再現不可のため実比較へ置換）
$D1 "WITH b AS (SELECT stock_id, min_shares, estimated_value FROM yutai_benefits WHERE estimated_value IS NOT NULL), m AS (SELECT stock_id, MIN(min_shares) AS minreq FROM b GROUP BY 1), s AS (SELECT b.stock_id AS sid, SUM(b.estimated_value) AS totalv FROM b JOIN m ON m.stock_id=b.stock_id AND b.min_shares<=m.minreq GROUP BY 1), r AS (SELECT f.stock_id AS sid, f.yutai_yield AS saved, f.data_date AS dd, CASE WHEN f.price IS NULL OR f.price<=0 THEN NULL WHEN s.totalv IS NULL OR s.totalv<=0 THEN NULL WHEN (s.totalv*1.0/(f.price*m.minreq))*100>50 THEN NULL ELSE (s.totalv*1.0/(f.price*m.minreq))*100 END AS recomp FROM otakara_stock_financials f LEFT JOIN m ON m.stock_id=f.stock_id LEFT JOIN s ON s.sid=f.stock_id) SELECT COUNT(*) AS ndiff, SUM(CASE WHEN dd='2026-09-13' THEN 1 ELSE 0 END) AS fresh FROM r WHERE NOT (saved IS NULL AND recomp IS NULL) AND NOT (saved IS NOT NULL AND recomp IS NOT NULL AND ABS(saved-recomp)<=1e-9)"
# F3 python: python3 /tmp/yield_recompute.py（SHA256 33a11e2e…51e350d571。要 /tmp/yield_fin.json + /tmp/yield_ben.json）

# F4: 抽選 keyword（候補母集団 38 行。純抽選 13 行への分離は原文確認による。§6.3）
$D1 "SELECT COUNT(*) FROM yutai_benefits WHERE estimated_value IS NOT NULL AND (description LIKE '%抽選%' OR short_summary LIKE '%抽選%')"

# 財務の journal↔cache 照合（private 証跡。80MB+1.9GB の read-only 走査）
# - journal: wc -l + shasum -a 256 /tmp/kabulab-financial-full-instant-final-audit.jsonl
# - cache: ファイル名=SHA256(content) の全件確認 + journal raw_sha 集合との双方向差分
# 層別 27 標本の独立再導出スクリプトは private /tmp（verify_sample*.py・監査用使い捨て）
```

## 10. 証跡・ private ファイル（Git 対象外）

- `/tmp/d1_fin.jsonl`（D1 財務 dump 34,659 行・SELECT のみ）、`/tmp/d1_rawpage.jsonl`（page id dump）。
- `/tmp/samples.json`（27 標本の key・SHA・page id）、`/tmp/sample_verify.json`（再導出結果）。
- `/tmp/ir30d.jsonl`（30 日 title/tag dump）、`/tmp/tdnet09*.json`（yanoshin day API 応答 5 日分）。
- `/tmp/ir0924_d1.json`・`/tmp/ir0925_d1.json`（日次突合用 dump）、`/tmp/yuho_viol59.json`（F2 の 59 doc_id）。
- EDINET 原本 ZIP 4 通・minkabu HTML 5 page・公開画面 HTML 数件（いずれも /tmp のみ）。
- 追検の再現 script＋dump（いずれも /tmp・0600。Git 対象外。full SHA は本文引用箇所に記載）:
  `/tmp/overseas_fullkey_reagg.py`＋`/tmp/viol59_facts.json`＋`/tmp/viol59_docs.json`（F2 fullkey）、
  `/tmp/overseas_replay_j2e7.mts`＋`/tmp/overseas_replay_j2e7.out`＋`/tmp/j2e7_saved.json`（F2 replay）、
  `/tmp/yield_recompute.py`＋`/tmp/yield_fin.json`＋`/tmp/yield_ben.json`（F3）、
  `/tmp/lottery38.json`（F4 候補母集団）、`/tmp/notion_biztag_sample.mts`＋`/tmp/notion_biztag_sample.json`（§4.4 標本）、
  `/tmp/edinet_csv3.mts`＋`/tmp/edinet_S100Y*_t5.zip`（§4.4 原文）、`/tmp/edinet_543A_t1.mts`＋`/tmp/edinet_S100YK16_t1.zip`（§2.5 原表）、
  `/tmp/ir_sent3.json`（§5.2 標本）、`/tmp/ts3.json`（§4.4 索引）。
- D1 全応答の meta で `rows_written=0`・Notion は GET/query のみ（1rps 以下）・R2 書込なし。
