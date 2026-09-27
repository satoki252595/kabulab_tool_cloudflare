# 「お金の流れ」Phase 2〜5 検証証跡 (2026-09-27)

前任セッション (週次クレジット上限で停止) の検証証跡を集めた使い捨て参照用ブランチ。
クラウド側の引き継ぎセッションが再検証の参照元として使う。`main` にはマージしない。

- `handover.md` — クラウドセッションへの引き継ぎプロンプト (正本は別途共有)
- `results/` — 検証結果の正本
  - `claude-mf-sources.json` — 17部品の build/verify 結果 (35件の問題の詳細)
  - `claude-mf-fix-targets.json` — 修正対象15件の一覧
  - `claude-moneyflow.json` / `claude-moneyflow-compact.json` — 計画・集約メモ
  - `*-entry.json` / `*-verify*.json` / `fresh-*.json` / `wb-*.json` / `imf-*.json` — 部品別検証データ
  - `dsd.json` / `bis_dsd.json` / `bis_codelist.xml` / `verify_codelist.json` — BIS SDMX 構造定義
  - `verify2.csv` / `verify_liab_live.csv` / `verify_parentjp_resp.txt` — 突き合わせ CSV・応答記録
- `raw/` — 検証時に取得元からダウンロードした実ファイル (FFAJ xls / JVCEA PDF / 日銀 xlsx / 各種 HTML)
- `scripts/` — 部品別の再検証スクリプト (`.ts` / `.mjs`)
- `logs/` — 検証ログ
- `fixtures-tmp/` — 作業中の一時フィクスチャ (`/tmp` 由来)

注意: 重複ファイル (同一 md5) は1件のみ収録。秘密情報のスキャン済み (ヒットは環境変数名・"Risk-weighted" 等の誤検知のみ)。
