# moneyflow 先物・オプション / IMF CPIS 初回実データ確認 (2026-09-28)

Task B (GPT-sol計画 Issue #132)。`muse-spark-1.3-contributor/max` で実施。
`nix develop -c pnpm exec tsx scripts/moneyflow/ingest.ts --dry-run --only=<spec>`
の3本を実ネットワークで実行し、原本バイトと突き合わせた。dry-run は取得・解析・
`validateDrafts` のみで、Notion/D1 には一切書いていない (共有 writer 保留中のため)。

## 結論

- `jpx-derivatives-investor-weekly`: 成功。key `...-2026-W37`、484行。原本と一致。
- `jpx-derivatives-investor-futures-oi`: 成功。key `...-2026-W38`、134行。原本と一致。
- `imf-cpis`: 初回は DBnomics の欠損マーカー `"NA"` で停止 (想定どおり検知)。
  根因修正 (欠損として読み飛ばし・0埋めなし) 後に成功。
  key `imf-cpis-2024-H1-updated-2025-04-08`、387行。ミラーは 2024-S1 で停止中。

## 取得した一次ファイル (private cache・未アーカイブ)

いずれも `services/moneyflow/lib/sources/fixtures/private/` 配下 (gitignore 済み・commit しない)。
物理バイトを保持済み。Notion `recordPrimaryData` による実体保存は未実施 —
財務 writer 解放後の後続 (writer 枠) で正式経路から保存する。再開点は下記「安全な再開点」。

### JPX 投資部門別取引状況 (週間) CSV

- 一覧: https://www.jpx.co.jp/markets/statistics-derivatives/sector/index.html
- CSV: https://www.jpx.co.jp/markets/statistics-derivatives/sector/t13vrt000001yi1d-att/Tousi_DV_W_20260907_20260911.csv
- 対象週: 2026-09-07 〜 2026-09-11 (最新週。9/27 時点と同じ週)
- 一覧 HTML: `private/jpx-derivatives-investor/jpx-deriv-sector-index-20260927.html`
  36,049 bytes, sha256 `ce2f85a3fce41273…` (9/27 取得分とバイト同一を 9/28 再取得で確認)
- CSV: `private/jpx-derivatives-investor/jpx-deriv-investor-week-20260907_20260911.csv`
  117,179 bytes, sha256 `6258b0877d10ee68…`, 生 1,760 行
- key: `jpx-derivatives-investor-weekly-2026-W37`、観測 484 行
  (固定 11 商品 × 11 投資部門 × 純売買/グロス × 数量/代金)
- 照合 (CSV 生テキスト → draft):
  - 日経225先物/自己/数量: 売 161,521・買 153,856・合計 315,377・純売買 −7,665 (枚)。符号どおり。
  - 日経225先物/海外投資家/数量: 売 351,234・買 359,577・合計 710,811・純売買 +8,343 (枚)。
  - 日経225先物/個人/代金: 純売買 +48,281,984,900 (円、換算係数 1)。
  - 投資部門 11 区分すべて出現。固定外商品 (例: 東証銀行業株価指数先物) は記録しない。

### JPX 指数先物 取引参加者別建玉残高 xlsx

- 索引: https://www.jpx.co.jp/automation/markets/derivatives/open-interest/json/open_interest_yearlist.json
  → 2026年週一覧 (最新 TradeDate 20260918)
- xlsx: https://www.jpx.co.jp/automation/markets/derivatives/open-interest/files/2026/20260918_indexfut_oi_by_tp.xlsx
- 基準日: 2026-09-18 (ファイル名とシート内表記が一致)
- `private/jpx-derivatives-investor/jpx-futures-oi-20260918-indexfut.xlsx`
  31,425 bytes, sha256 `9f1802b3362604d5…`
- key: `jpx-derivatives-investor-futures-oi-2026-W38`、観測 134 行 (単位: 枚)
- 照合 (xlsx → draft):
  - 日経225先物/2026-12限月/売超1位/ＨＳＢＣ証券 31,500 / 買超1位/野村証券 33,866。
  - TOPIX先物/2026-12限月/売超1位/ゴールドマン証券 53,241 / 買超1位/シティグループ証券 63,708。
  - 3 商品 (日経225先物・mini・TOPIX先物) すべて含む。売超/買超とも正の枚数。

### IMF CPIS (DBnomics 99系列・2リクエスト)

- API: `https://api.db.nomics.world/v22/series?series_ids=<IMF/CPIS/… 60件>…` /
  同 39件 (`observations=1`)。向き2 × 資産3 × 相手国 (対外17・対内16、TW 除く) = 99系列。
- ミラー更新日: `datasets["IMF/CPIS"].updated_at = 2025-04-08` (9/27 から不変・停止中)
- 最新期: 2024-S1 (両チャンクの最終スロットで一致。IMF 本体の公表より遅れている可能性あり)
- `private/imf-cpis/imf-cpis-full-20260928-01.json` 142,539 bytes, sha256 `2ec7e974ddbe607b…` (60系列)
- `private/imf-cpis/imf-cpis-full-20260928-02.json` 95,525 bytes, sha256 `58f0c10887e867a9…` (39系列)
- key: `imf-cpis-2024-H1-updated-2025-04-08`、観測 387 行
  (99系列 × 4期 396 − 窓内欠落 9。単位: 米ドル、換算なし)
- 窓内欠落 9 (行を作らず・0埋めなし。正直な欠落):
  - AU 対内 (合計/株式/債券) の 2023-S1・2024-S1 = 6 (応答に期スロット自体が無い)
  - SG 対内 (合計/株式/債券) の 2024-S1 = 3 (同上)
- 照合 (生JSON直読み → draft): 米国・対外合計・2024-H1 = 2,072,394,613,197 (9/27 実測と一致)。
  世界計・対外合計・2022-H2 = 4,004,702,976,767.45。AU・対内合計・2023-H2 = 55,287,719,999.9999。

## IMF `"NA"` 停止の根因と修正

- 初回 dry-run は `値が有限の数値ではありません: NA
  (series_code=B.JP.I_L_T_T_T_BP6_DV_USD.T.T.SG, period=2009-S2)` で停止。
  調査の結果、DBnomics は未報告の期を文字列 `"NA"` で返す (Derived 系列 5 系列・
  2002-S2〜2020-S1 に計 42 点。窓内には無い)。欠損の別表現であり、様式破壊ではない。
- 修正 (`services/moneyflow/lib/sources/imf-cpis.ts` のみ): `"NA"` を `null` と
  同じ欠損として読み飛ばす。`"NA"` 以外の文字列は従来どおり throw。
  共通経路 (`run-spec.ts` 等) は触っていない。
- 回帰:
  - sources 合成テスト (CI 可): `"NA"` は 1 点読み飛ばし・残りは値どおり・0 混入なし。
    `"N/A"` は従来どおり throw (既存テスト維持)。
  - adapter 実データテスト (private・手元のみ): 99系列ファイルで 387 行・上記実値を検証。

## JPX 10 skip の解消

`services/moneyflow/lib/sources/jpx-derivatives-investor.test.ts` の実フィクスチャ
10 件は private 原本の不在による skip だった。今回の原本を cache したことで
手元では全 10 件が実行・合格 (adapter 側の実ファイル 7 件も合格)。CI では
private 不在のため引き続き skip (規約どおり)。

## 実行した検証

- `vitest run` (4ファイル): 143 passed・20 skipped (残 skip は旧 IMF subset 等の未取得分)。
- `tsc --noEmit`: 合格。`eslint src services --max-warnings=0`: 合格。
- dry-run 3本: いずれも最終的に ok (IMF は修正後に再実行)。

## 安全な再開点 (後続の writer 枠向け)

1. 上記 private cache の 6 ファイルが一次実体 (ハッシュは本記録のとおり)。
2. `src/shared/notion-archive` の `recordPrimaryData()` で key ごとに実体保存
   (weekly-2026-W37 / futures-oi-2026-W38 / imf-cpis-2024-H1-updated-2025-04-08)。
3. Notion 保管ファイルの再読 → `toObservations` → 観測ログの冪等 upsert を確認する。
   期待行数: 484 / 134 / 387。

## PIP-384 実 entry 再入直接証跡 (strict 再 run・2026-09-30 JST)

本節は実 entry `upsertObservation` 384 件の直接再入証跡であり、旧来の
比較ベース second0 proof とは別の直接証拠である。旧証跡・旧 artifact は
保全し、本節では一切変更しない。公開値は集計・SHA・キー・既存 doc 参照のみ
(IDs・値・署名 URL・秘密・private 原文なし)。repo コード変更なし。

- 実行: strict 再 run `2026-09-29T23:39:12Z`–`23:42:29Z` (約197秒・上限15分内)。
  前回 run `23:23:32Z`–`23:26:52Z` も同一 384 unchanged (旧 report 保全)。
- 手法: 固定 source の pure `toObservations` で 384 drafts を再導出
  (resolve/fetch/ingest 不使用) → 実 entry `upsertObservation(dbId,input)` を
  384 順次 await。transport guard 設置後に dynamic import (deny-before-fetch、
  拒否型は `NotionConfigError` 派生、fatal latch)。
- 固定 source: main `9ec241044a1ad931689b196b42e58738aa963483` と実行 worktree
  `353c19419d7d680ecd3ebfd23ee0ff529f7b272c` で下記 blob SHA 一致・clean。
  - `src/shared/notion-archive/moneyflow.ts` `2d84ef508e5940c84e71687a1ddd1726456b1fab`
  - `src/shared/notion-archive/client.ts` `163492793d3c04fc9772bdc34f051ccb1b71cd67`
  - `src/shared/notion-archive/env.ts` `b7a2faca946e9de8c010995e2411f03e572275e6`
  - `services/yuho-quant/src/services/edinet/archive.ts` `34275c18ee6690746e582c09526ebddc282122bc`
  - `services/moneyflow/lib/adapters/imf-cpis.ts` `699c727209ef0b8000321fc4581cad37bdcd4b`
  - shared archive `src/shared/notion-archive/archive.ts` `065e3044a6ffbf5ea46d7920ba4f6684199f7c76`
- 源泉 6 pins (個別 sha256・f1–f6 順):
  `201d1f37a149a23f5dd70606a1ba79dbb2f72b6818dc9339ef1befe7e809994c` /
  `8f136d7f1d696436d03ee375c00a39344c37c1239440d0571b5adc4a21e4aa19` /
  `2990b9bc47e5ece69fdf6c7d3176ea7a0bdfc6904a8b208d54df386ec23a95d3` /
  `9aa6090c39fc94a65597555361581a754695dbad0cf5ab99d650e43999871278` /
  `4a99b3fdcfa989263e98e1fa644df0b62401a670747e24384bcf5409fd9c53e0` /
  `8ea93b11ba6073a12e3fa12d609626bccf58d7ae2331e670d8965d272de604c6`。
- 連結 alias pin `97260a8f93a38be3533acc10acde59ebb23502e95a295b6123cd32d7ce9d2718`、
  batch key `imf-cpis-2025-H1-sha-97260a8f93a3`、p1 pin
  `75b2041ecef71f615d76799c3a51620f7427f16b441743a8a960748e5d32817e`、
  golden `5b64e321d83555015b624c974679afb58c7143ed8316588274623836503af120`
  (draftCount 384・unique 384・4 periods)。
- 再導出: drafts 384・unique keys 384・keyset golden 一致・periods
  `2023-H2,2024-H1,2024-H2,2025-H1` 一致。
- 実 entry 結果: calls 384・returned 384・unchanged 384・created 0・updated 0・未知 0。
- 読取: 398 件 (search 4 / query 391 / GET 3)。上限 450 内。
  `sharedRequests` 398・rateLimited 0・transientRetries 0。
- strict 応答検証 (C107 同等): search/query 395/395 validated。
  query 391 全件 literal false。search 3 sequences 全て terminal literal false
  (内 1 sequence は true→cursor(100件) + follow-up terminal false(28件))。
  clone/JSON 失敗 0・guard 拒否 (blocked) 0。
- 0 群: mutationAttempt 0・forwardedMutations 0・sourceGET 0・
  Notion create/update/archive 0・新規 receipt 0・D1/R2 mutation 0・workflow 0。
- validator tiny check: 欠損/型/pairing 不正 12 件全拒否 + 正常 2 形通過。
- canonical 再生 SHA 不変 (前回と byte-identical):
  drafts `fa093dfb1f94aacef0f64227a5f0c61773607e55180ed40110148497764b040c`、
  inputs `cc31f5b69978a55b6027f455ea680a5b3a40dc4d739e3f25c37227ed697ba535`。
- artifacts (private `/tmp`・10 files 全 0600・dir 0700): 前回 report
  `3f7c42f77c11d8647df3753a4d1022cade8528790215fef217ac9d787b81aa97`、
  今回 report-strict
  `c1d7a3af2d5dbb477a19a67f64b656a0033d2b47aca0e7a52d351b2a7b3734ff`。
- 非主張: #132 の unknown POST 1 の解消は主張しない。
- Refs: #132 #146。関連: `docs/test-logs/official-source-storage-2026-09-28.md`
  §CODE1/P1 (同一キー 384 行 dry-run 成功)。
