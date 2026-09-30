# 海外売上 producer: 表ローカル連結区分 Gate0 (2026-09-30)

`docs/test-logs/overseas-745-offline-prep-2026-09-30.md` の拡張記録。
producer (`parseOverseasData`/`parseOverseasHtml`) が grid 文面だけで
`isConsolidated` を決め、表ローカルの scope 証拠 (caption の range 表題・
TextBlock) を落としていた問題の修正。全面 offline (source GET・D1/Notion/
R2 書込・dispatch 0)。本記録は counts・SHA・limits + 証拠所在のみ
(public 可)。per-doc の値・表は private 0600 のみ。

- 実装: `services/yuho-quant/src/services/overseas-parser.ts`
  `resolveTableScope` (Gate0。候補生成直後・期首フィルタ前) +
  reducer trace 付き任意 diagnostic (`opts.capture`。保存対象外・DB 列追加なし)
- 判定: 直近 range 表題を既存 `lastRangedFiscalTitle` で再利用
  (連結会計年度→true / 事業年度→false)。positive は表関連の明示 exact
  phrase (当連結会計年度/連結財務諸表/連結決算) + exact 既知 Consolidated
  TextBlock 名 (4 件) + 既存 grid 判定のみ。裸の連結言及・非連結・
  連結調整前は positive にしない。個別 FY 表題の false と他 positive の
  共存は mismatch → doc-STOP。不足は null。数値の行/列選択は不変。
- diagnostic は実 selector の中間値のみ (table offset・parent TextBlock・
  contextRef・caption 断片・grid/scope・fiscal・score・採否・値/総額の
  index+label・採用 leaf)。後付けの同値数字 regex 推定はしない。
  dims は header 側 context 解決が必要なため対象外 (contextRef まで運ぶ)。
- caller 4 件 (ingest/backfill-missing/backfill-overseas/745prep) は同一
  parser 経由で無変更 (audit-overseas も同様)。

## 固定入力 pins (bytes SHA256・全一致)

- `manifest_full.json` (3602) `398843d5…02ca4` (PREP 記録と同一・不変)
  + `<docID>_t1.zip` 3602 pinned (73 fixed-now は HOLD・対象外:
  745 内 21・804 外 52。PREP 記録と同一)
- sealed 59 proof `select-live.json` (actual D1) `4a4cbc04…b517`
- 旧 parser baseline `prep-manifest.json` `c2345269…7083a`
  (`currentStatus` は旧 parser 出力。`overseas-parser.ts` は PREP 実行
  HEAD `e822744` 以降 main `d395d3c` まで無変更のためそのまま baseline)

## 59 FULL sealed gate (facts 全行 + status + honbun)

- 新 parser offline 再生成 vs sealed `select-live.json`
  (q1: status/honbun/factsCount + q2 全行: FY/地域/kind/scope/単位/
  salesRaw/salesYen/ratio/pattern): **29 MATCH + 30 DELTA**
- DELTA 30 文書・184 行は **scope flag のみ**
  (値・status・honbun・件数・pattern の差分 0)。
  内訳: null→true 29 文書・180 行、null→false 1 文書 (S100OH3F) 4 行。
- 6 source (S100AO7M/S100OE0P/S100R1GC/S100TPW6/S100W2OC/S100YEVT 36 行) は
  sealed-true と一致し MATCH へ復帰 (旧 parser の null 落ちを解消)。
- 30 DELTA (6flag36行以外) は HOLD + 原因分類の独立 SOL review 対象。
  対象 doc (flip 方向は全て上記のとおり。値は private のみ):
  S100DA2Y/S100DDYF/S100G1ZO/S100G6V9/S100IUNR/S100IY1B/S100LN4K/S100LO6W/
  S100M26Y/S100M270/S100OC13/S100ODMQ/S100OH3F/S100QIEX/S100QIMX/S100QZHY/
  S100R1RD/S100R98H/S100RAR0/S100T6SM/S100TAI3/S100TR7I/S100TU43/S100VIFY/
  S100VKI5/S100VWVY/S100W4M7/S100YBHC/S100YDNF/S100YJKO
- 採用 table の特定は capture (実 selector) のみで確定。全 30 文書の採用
  証拠は table-local の明示 (当連結 tier caption / 連結調整後 / 当事業年度
  range 表題)。裸連結・連結調整前のみの採用表は null のまま
  (S100QHYM 級 5 文書が MATCH 維持)。
- W81W/XRWN (59 外): status・値不変。採用 trace (値行/総額列の index・
  label・採用 leaf・parent/context/fiscal/score・競合採否) を private
  capture に記録。継続事業の選択根拠 (XRWN の 2 合計列の採択等) の
  是非は SOL review に委ね、flag だけで数字を承認しない。
- VHA9/XTT8 (59 外): true 維持・不変。他 921 への same-cause 一般化なし。
- 成果物 (private 0600): frozen capture 63 文書
  (59 + W81W/XRWN/VHA9/XTT8。候補全件の offset・parent・contextRef・
  caption 全文・grid/scope・fiscal・score・採否・reducer trace)
  `b7c3cc16…a2d30b9` / delta list `2fab4823…04e029` /
  trace8 readable `d6c39025…f64dd`
  (旧 `overseas-scope-trace.json` の W81W/XRWN 概略は本 capture が置換。
  dims 解決の既存 XML/header helper は不在のため contextRef まで。
  FilingDateInstant からの FY 推定はしない)

## 3602 census (pinned 全件・選択影響調査)

- 新 parser vs 旧 baseline (`currentStatus`): **STATUS 差分 0**
  (選択・値は全面不変。scope-mismatch STOP 0 件)。
- 採用 scope 分布: true 2593 / false 21 / null 248 / facts なし 740。
  (applied59: true 40/null 10/false 1/なし 8。
  remain745 pinned 724: true 497/null 36/なし 191。
  stable2871 pinned 2819: true 2056/false 20/null 202/なし 541)
- 旧 proto (裸/連結 + 個別一般語) では 54 文書の誤 STOP が出たため
  却下し、title-first + exact phrase 設計に改めた (経緯のみ記録)。
- 成果物 (private 0600): census jsonl `e71f3215…4872541`

## テスト

- 実 fixture 8 件 (公開済み有報の見出し+表の切出し。架空値なし):
  AO7M/OE0P(生産+販売)/R1GC/TPW6/W2OC/YEVT/OH3F/QHYM。
  各 fixture は全文書 parse との一致 (値・scope・status・fiscal・
  TextBlock・候補数以下) を機械検証済み。
- `overseas-parser.test.ts` Gate0 describe 9 件:
  6 source の true + 値・OH3F の false・QHYM の null・
  生産表 non-candidate (noleak)・実文字列の resolveTableScope・
  未観測 mismatch の fail-closed pin・reducer trace 2 件。
- 114 既存 + 9 新規 = 123 passed。full suite 3670 passed / 281
  skipped / 0 failed。typecheck + lint clean。
