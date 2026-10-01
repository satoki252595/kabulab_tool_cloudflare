# 8508 単発優待の実基準日 — 実装と限定修復 PLAN (2026-10-02)

Refs #146 / #102。これは実装・ローカル検証・本番適用 PLAN の記録であり、0026 migration・本番デプロイ・8508 の日付更新は未実施。秘密情報・取得原文・D1 応答そのものは公開 Git に置かない。

## 原因と最小モデル

既存 `record_month` は毎年の月表現であり、単発の特定日を表せない。8508 の特別優待を月末・定常月・年間額へ混ぜないため、`yutai_benefits.record_date` 1列だけを nullable `YYYY-MM-DD` で追加する。NULL は既存の月表現、非NULL は単発の実基準日。不明な日付を推測で埋めない。

8508 の actual 旧 PRE は benefit 38642 の `record_month=6`、100株、金額・金額出典とも NULL。9月行ではない。旧掲載文には「今回限り」と配布時期はあるが、9月2日の基準日はない。公式ページの資格から `2026-09-02` を設定し、旧 `record_month=6` は保持する。日付を9月末に置換しない。通常6月の別4行も残す。

## 公式資格と保管

[Jトラスト公式・特別株主優待](https://www.jt-corp.co.jp/ir/jstock/special_yutai/) の取得済み HTML は 52,709 bytes、SHA256 `d434f203cf43d172bed387c1a60b3bc33ecbd4c13c094a60ed722b1bb5e09cca`。株主名簿の基準日「2026年9月2日現在」、100株以上、「今回限り」、受取期限2027年1月18日23:59を確認した。過去の基準日であり、現在の買付で資格を得られるとは案内しない。金額の新規認定は行わない。

原文と実GET manifest は共有 `recordPrimaryData()` 経由で物理保管済み。key `yutai-official-hold15-20261002-67a97a594438`、ZIP 207,340 bytes / 16 members、SHA256 `67a97a594438` prefix。添付 fresh full download・全 member SHA 一致の詳細は [旧HOLD14の実適用記録](./yutai-hold14-actual-20261002.md)（PR #255）を参照。再送・原本上書きは行わない。

## Caller 経路

| 経路 | 変更・保護 |
| --- | --- |
| schema / migration | `recordDate: text()` と生成済み `0026_violet_deathstrike.sql` の ADD COLUMN 1文だけ。既存行は DDL により NULL |
| date 境界 | NULL または厳密な実暦日だけを許可。undefined・不正日付・月末推測は拒否 |
| card / genre / detail | card の権利月は NULL 行だけ。detail は同じ要約でも日付ごとに分離し、実日付と初心者向け説明を表示。単発があれば月末一律ガイドを使わない |
| monthly rebuild | 年間分子・金額認定の株数/月 context とスコア月/ジャンル集計から単発を除外 |
| recompute yields | 全行を preimage へ残し、定常行だけを年間分子/context に使う。既存の価格・data_date を保持 |
| benefit reader / summary export | 日付を必須の受取条件として読み、厳密検査。契約版 `2026-10-02.1` |
| summary import | 日付の変更も stale。金額 qualifier と原文保護は既存共通処理のまま |
| atomic preflight / verified tuple | 新日付列を snapshot、NULL 比較、件数・両方向 EXCEPT へ追加。変化があれば batch 全体を停止 |
| full import / carry | 同じ code・掲載文・株数・月へ、要約無しの行も既存 date を保持。NULL/date 衝突、日付不正、単発の identity 喪失は DELETE 前に停止。月だけの新規通常行はモデル既定 NULL。新規単発日を原文から推測生成しない |
| reentry / fresh audit | 新日付列を expected/actual の照合へ含める。過去11列の証跡に NULL を補って12列実観測を装わない。新規 proof は fresh12列が必要 |

## 本番適用の順序と限定 PLAN

1. PR の全 CI を確認し、remote migration list で pending が生成0026だけと確認する。別 migration・schema drift があれば停止。
2. 旧アプリが稼働する間に additive DDL を適用する。次に main へ merge し、対象 main の本番 deploy を確認する。列追加前に新アプリを本番 deploy しない。
3. 排他 writer 枠で 8508 の core 全11列 / benefit 全12列 / financial 全19列 / score 全7列を fresh read。既存5 benefit の新 `record_date` は **実応答の NULL** を確認する。旧11列 PRE に NULL を補完した値を本番観測として使わない。
4. GET/SELECT 実原文、メタ、公式資格、固定期待値・SQL packet を物理保管し、添付 fresh readback の bytes / 全SHAを確認する。この資格と fresh PRE からだけ CAS を発行する。
5. 1原子 batch / 2 statements: 全4表・件数・NULL・両方向 EXCEPT guard → benefit38642 の `record_date` と `updated_at` のみ UPDATE。core1 + benefit5 + financial1 + score1 = **97セル**を条件とする。新日付以外の既存値は保持。通常6月4行があるため `yutai_months=[6]` は保持し、利回り・スコア・価格・data_date の追加更新0。
6. 実 POST 4表を fresh read し、期待97セルと照合。実 POST を同じ日付 producer へ再入力して effect SQL0、実送信0を確認する。実POST/実行結果/reentry原文も物理保管・full readbackし、実本番詳細/APIで日付表示と通常6月の保持を確認する。

writer は root が排他調整。定時 stock cron と重なる前に返却する bounded 実行とし、未知の送信結果は停止・同一 POST の盲目的再送をしない。

## ローカル検証

Nix の既存 Node22 / pnpm9 で生成 migration、関連回帰、型検査、lintを実施。service/関連月次回帰は20 files / 455 tests 全PASS。full-import38/38 PASSには date carry・identity喪失停止・NULL/date衝突・不正/欠落日付を含む。`pnpm typecheck` と変更対象 ESLint / diff check は PASS。

8508 private actual DDL と旧 PRE の11列をローカル SQLite へ投入し、生成0026をローカル適用して PLAN を検証した。この追加NULLは migration からのローカル期待であり、本番12列の実観測ではない。normal は期待97セル一致。同じ日付 producer の local POST 再入は0。target date、別 benefit、core、price、data_date、score、行追加、行欠落の8 driftはすべて guard拒否・rollback後全値一致。原文・private PLAN は Git 対象外 `tmp/yutai-oneoff-8508-20261002/` に保持。本番 write0。
