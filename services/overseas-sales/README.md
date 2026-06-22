# 008 overseas-sales — 海外売上高検索

金融庁 EDINET の有価証券報告書から「海外（地域別）売上高 / 海外売上高比率」を
構造化し、最大 5 年の推移を可視化する kabulab サービス（005 yuho-quant の姉妹版）。

- 本番: https://kabulab-cf.satoki252595.workers.dev/overseas-sales/
- 詳細: [docs/008-overseas-sales.md](../../docs/008-overseas-sales.md)
- 開発ルール: [CLAUDE.md](./CLAUDE.md)（mono-repo ルール + 本サービス固有ルール）

## できること

- **検索**: 銘柄コード/会社名から個別銘柄へ。
- **個別銘柄**: 海外売上高（億円）の積み上げ棒 + 海外売上高比率の折れ線（最大5年）、
  地域別内訳テーブル。構造化できない開示は「未対応」と正直に表示。
- **スクリーニング**: 海外売上高比率レンジ・海外売上高 年率(CAGR)・業種 +
  ファンダ条件で、海外売上比率の高い順に銘柄発掘。

## ローカル

```bash
pnpm dev                       # wrangler dev (D1 バインディング)
pnpm exec vitest run services/overseas-sales   # パーサのユニットテスト

# 答え合わせ監査 (全銘柄で取りこぼし署名を集計。D1 読取 + EDINET 取得・書込なし)
D1_DATABASE_ID=<id> pnpm exec tsx services/overseas-sales/data-scripts/audit-all.ts --limit=300

# バックフィル (Node → D1 HTTP 書込。要マイグレーション適用済み)
D1_DATABASE_ID=<id> pnpm exec tsx services/overseas-sales/data-scripts/backfill-overseas.ts
```

## 設計の核

海外売上高 = **会社が開示した海外地域行の合計**（`total − 国内` ではない）。
同一有報の複数表からは **当期・連結・地域注記** に最も近い表を採点で選ぶ。
「地域行の合計 ≈ 開示総額（1% 許容）」を満たさない表は誤読として却下し、
数値を作らない（CLAUDE.md ルール1/2）。
