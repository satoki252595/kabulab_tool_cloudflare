# C107 有報テキスト本文 10文書の保存済み原文 read-only 精査 (2026-09-29)

C107 laneA で取り込んだ有報 10 文書の定性テキスト本文について、保存済み原文と
read-only で精査した記録。結論: **10/10 MATCH** (364 section 全一致、重複 0)。

## 1. 対象と方法 (read-only)

- 対象: C107 laneA run `laneA-c107-normal10-20260929T0750` の 10 文書 (S100Z 系)。
- expected の復元: EDINET 再取得は行わない。Notion 一次保管の SHA-pinned t5
  raw (values 証跡の pin) を GET し、現行の共有コントラクト
  (`parseEdinetCsvZip` → `extractTextSections`) で expected 全文を再生成。
- actual: D1 `yuho_documents` (SELECT) の pointer → `readStockTextRow` で
  Notion 保存行を全読する。children 応答は guard 内で clone 実観測し、
  最終頁 `has_more=false` を全通で証明する (malformed は即 HOLD)。
- 比較: expected/Notion の section 列を順序厳密 (位置比較 + 順序列の全文
  SHA256 一致) で照合する。D1 `yuho_text_sections` 索引との突合は件数 +
  per-key (sectionKey/itemName/charCount=UTF-16 length) のみで、D1 側に
  orderBy/ordinal 比較はない。順序の厳密性は expected/Notion 側が担う。
- transport guard: Notion GET/read-query・R2/Notion-hosted 原文 GET・D1 SELECT
  のみ許可し、それ以外は deny (mutation 0)。

## 2. 結果 (10/10 MATCH)

| docID | code | sections | D1索引 | Notion | CSV行 | t5 bytes | 全文SHA (prefix) | 判定 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S100Z3TN | 141A | 35 | 35 | 35 | 1642 | 139984 | 1378c946f90428ee… | MATCH |
| S100Z3J0 | 196A | 35 | 35 | 35 | 1331 | 102461 | ea0215f2a72e26cc… | MATCH |
| S100Z3TC | 197A | 38 | 38 | 38 | 1025 | 101233 | f4a3956da59944a0… | MATCH |
| S100Z3UE | 598A | 37 | 37 | 37 | 813 | 84583 | 304981515b574b61… | MATCH |
| S100Z40G | 151A | 37 | 37 | 37 | 1020 | 98810 | 277a889ca0e9dbd3… | MATCH |
| S100Z4OA | 157A | 35 | 35 | 35 | 1491 | 108075 | 81cb813c7355635e… | MATCH |
| S100Z433 | 246A | 37 | 37 | 37 | 1004 | 80691 | 6fa02eac23e876c7… | MATCH |
| S100Z3K3 | 386A | 38 | 38 | 38 | 991 | 82993 | 4b8da3de43b15dda… | MATCH |
| S100Z4H9 | 407A | 34 | 34 | 34 | 1223 | 96431 | a3ca99d6dc9e22d8… | MATCH |
| S100Z4LD | 584A | 38 | 38 | 38 | 728 | 81877 | 98611f1133e297be… | MATCH |

- 合計: sections 364 / D1 索引 364 / CSV 行 11268 / t5 977138 bytes。
- D1 索引の重複キー 0 (10 文書すべて)。`text_parse_status` は 10 件とも ok。
- 全文 SHA は expected=actual の完全一致 (上表は prefix。完全値は私的証跡のみ)。
- guard 実績: requests 53 / denied 0
  (notionGet 13・notionQuery 10・fileGet 10・d1Select 20)。HTTP mutation 0。
- pagination proof: 最終頁 `has_more=false` を 10 通全通で実観測
  (malformed 0)。`has_more` は key 存在+boolean、`next_cursor` は key 存在+
  null/非空 string、true→非空 string/false→null の pairing まで strict 検証
  し全 12 頁 validated (実値+validated は私的証跡のみ)。
- 監査実行: 2026-09-29T23:22Z (strict pagination 検証の再監査。全文 SHA は
  初回と同一)。私的証跡 (0600、集計+SHA のみ) は別保管。

laneA wrap SHA (監査入力の pin):

- run: `339e750e5a2ce2a43cc94ebe9f15094e59c286f573893bc62667ee58ad8697bc`
- reentry: `852271f4b962c6769f738ecf15f13ca7f612c777123b2303f8cdf925325d3977`
- values: `17a248acf1b190ada5949a971de7203ac7f4e77dd736d3a7f42d7b133286939d`
- journal: `c0a5c241a0447bc8528c74ff0bd53f6757d97fac08c114f7d5705054b2c0f78f`
- ingest wrapper: `07ee10cec718a60dcb8b4014fc5d2843569d2c3363ec894e5ce4173d5d8e21d1`

## 3. 限界 (未証明・未観測。MATCH の範囲外)

- 本監査の MATCH は上記 10 文書・364 section に限定する。D1 全体の
  text-ok 37990 文書・索引 1169832 行のうち、37980 文書は本監査の対象外
  (read-only SELECT で母集団のみ計数)。
- 監査指示にあった「Yuho 本文 64」の集合定義は docs/issues/証跡内に見つから
  ず、本監査では特定・観測していない (Root へ確認依頼)。
- 海外 804 文書の全体修復 (§6 計画) は未適用・未観測。適用済みは 59 文書+
  L2 16 銘柄のみ (release-notes #174 のとおり)。
- Yutai 131/13 適用後の再入 (2nd run 差分 0) は実証していない。
  比較 proof (PIP384 系) を actual 再入 0 とは記載しない。
- modeReadback の section-key 一致だけでは MATCH 根拠にしない方針に従い、
  本監査は全文 SHA 比較を必須とした。

## 4. 整合 (本 PR の docs 側)

- 海外 §6 計画書 (`overseas-root-causes-2026-09-28.md` §6) に適用済み範囲
  (59+L2 16) と 804 残の状態注記を追記。
- Yutai ABC 131・fulltext 13 の本番適用を release-notes へ本番作業として追記
  (再入 0 は未観測のため記載なし)。
- moneyflow 指標定義の未確認断定 (速報/確報) を除去し、版+窓 upsert の実契約
  どおりの説明へ修正 (速報/確報の区別は原本未確認のため断定しない)。
  JSDA hako.pdf の docs 状態を「取得・確認済み」へ是正。
