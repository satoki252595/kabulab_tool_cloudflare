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
