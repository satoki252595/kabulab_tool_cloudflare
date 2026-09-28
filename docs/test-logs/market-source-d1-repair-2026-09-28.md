# 市場 Source D1 修復の適用と検証 (ATR/年次、2026-09-28)

[市場系監査](./data-audit-market-2026-09-28.md) の保存値ずれ (ATR 判定 3 列・年次
2 列) を、固定 manifest + 銘柄単位の原子 batch で修復した。推定で埋めず、
再計算は既存の共有 helper のみで行い、非 active 凍結行は適用後に復元した。
本記録は正規化証跡 (秘密 ID・raw・token を含まない)。詳細 manifest は
0600 私的証跡に置き、本文書は件数・SHA・遷移のみを載せる。

## 適用範囲 (最終)

- ATR 3 列 (`volatility_ok`/`all_passed_long`/`all_passed_short`):
  active 1679 行。非 active 2 行 (8963/3198) は適用後に凍結値へ復元した。
- 年次 2 列 (`is_blue_chip`/`revenue_trend`):
  active 1490 行。非 active 34 行は適用後に凍結値へ復元した。
  2180 (trend None→0) と 8154 (None→1) は active のため認可変更として維持。
- 対象外 (HOLD 維持): NULL 終値の訂正、R2 偽分割の除去 (上流 404 で検証不能
  のため VOID)、N225 未確定終値の補完 (厳密 STOP)、優待 ABC/全文 (別 grant)。

## 方法 (固定 manifest + 原子 batch)

- 再計算は `diffStaleScreeningFlags` / `pickAnnualSeries` +
  `evaluateBlueChip` の既存 helper のみ。新計算式・新依存なし。
- 1 銘柄 = [full-input preflight + UPDATE] の 1 D1 REST batch。
  ATR は入力 6 列+銘柄同一性+保存 3 bool、年次は eligible 全 scope 系列集合
  +TTM+日付+銘柄対応+保存 2 列を NULL-safe 照合し、不一致は SQL エラーで
  batch 全体 rollback (出力旧値だけの CAS は使わない)。
- 送信直前に fresh 全件を manifest preimage と照合し、1 件でも違えば
  送らず STOP。銘柄順に逐次送信し、初エラーで STOP (後続に触らない)。
- 完了後に fresh 再読で全 new 一致を確認し、同入力の sender-less 再計算で
  0 changes (write0) を確認した。

## 固定 manifest (SHA)

- `market-atr-manifest.json`:
  `35bc19e60b60e676...` (1681 行、preflight+UPDATE 2 文)
- `market-annual-manifest.json`:
  `0786bb8c31b6603f...` (1524 行、eligible 全 scope preflight+UPDATE 2 文)
- `market-protections.json`: `4cccc89894d9a7d1...`
- D1 before v2: `5200ff80...` (Notion 物理記録、再 DL 全 SHA 一致)
- 年次再計算は独立監査の新判定と 1524/1524 一致した。

## 適用結果

- 送信前 fresh 照合: 3205/3205 一致、不一致 0。
- 送信: ATR 1681/1681 → 年次 1524/1524、エラー・STOP 0。
- 完了検証: post fresh 全 new 一致 (mismatch 0)、再計算 0 changes。
- jss 34662 行+内訳不変 (writer 活動なし)。
- 保護: 5 削除行の不在、財務 3 行の NULL3、R2 1909/2180 (2501/2502 本・
  splits 空)、8267 全行が前後一致。2180/8154 の行 SHA 差は認可 2 列の新値
  のみで、数値列・OHLCV は固定 SET 範囲+窓内 writer 唯一性で不変を証明した。

## 非 active 36 行の復元

- 適用後に非 active 凍結の維持が裁定され、ATR 2 + 年次 34 行を保存前値へ
  復元した (復元前 fresh 照合 0 不一致、36/36 送信、post で inactive=before
  完全一致・active 3169=適用維持・fake8 R2 8/8 一致)。
- 復元 manifest: `market-restore36-plan.json` (8a65e9ec...)。
- 復元中に同一銘柄の ATR+年次 2 batch を銘柄 ID だけの完了キーで 1 件
  落としかけたのを検出 (重複送信 0 で即修正)。再開キーは種別つき
  (`atr:291` 形式) にし、共通 runner が重複・付け忘れを送らず投げる
  ようにした (本 PR の `StockBatch.key`)。

## 本 PR の共通修正 (後続)

- 年次 preflight に銘柄の active・区分の CAS を追加し、凍結破りを境界で
  止める (実 SQLite 境界テストつき)。
- `StockBatch.key` (種別つき完了キー) と重複・付け忘れの送信前検査を追加。
- いずれも適用済み manifest の bytes は変えない (将来適用向けの前進)。
