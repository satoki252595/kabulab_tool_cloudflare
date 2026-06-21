# 003 Swing Trading

**kabulab** プロジェクト群の 003 番。数日〜2週間の短期売買を定量ルール化するサービス。

ポータル: <https://kabulab-cf.satoki252595.workers.dev/>
本サービス: <https://kabulab-cf.satoki252595.workers.dev/swing-trading/>

## 機能

1. **マクロ判定 (A/B/C/D)** — 今日、短期で取るべき環境か?
2. **5 条件スクリーニング** — 流動性・ボラ・トレンドで銘柄を絞り込む
3. **E&E 6 パターン** — ブレイクアウト / 押し目買い / 出来高急増 / ギャップ / 決算後 の日足シグナル
4. **リスク計算機** — 2% ルールでポジションサイズを算出

## ページ

| URL | 内容 |
|---|---|
| `/` | マクロ判定 + セクター上位 + 強度上位シグナル |
| `/screening?direction=long/short` | 5 条件通過銘柄一覧 |
| `/signals?pattern=*` | E&E パターン別シグナル一覧 |
| `/stock/:code` | 銘柄詳細 (指標 + 全パターン + リスク計算プリセット) |
| `/risk` | リスク計算機フォーム |

## セットアップ

コマンドはリポジトリルートから実行する (`nix develop` 内 / pnpm 9)。同期は統一 sync に集約済み (旧 `pnpm sync:swing` は廃止)。

```bash
# D1 マイグレーション SQL を生成し、Cloudflare D1 に適用 (core / swing は接頭辞テーブル)
pnpm db:generate:d1
wrangler d1 execute kabulab-cf --remote --file=drizzle/d1/<file>.sql

# 母集団 seed + 日次同期 (OHLCV/指標/screening/patterns/sector/マクロ)
pnpm sync:universe
pnpm sync:daily

# ローカル開発サーバー (wrangler dev)
pnpm dev
```

## スコープ外

Yahoo Finance 無料 API の制約により、以下は未対応:

- 分足必須のパターン (VWAP 戦略、当日 14 時急増エントリー、ギャップ寄り後判定)
- 信用倍率 / 買残 (5 条件④)
- 決算カレンダー (5 条件⑤)

UI 上で「外部未対応」として明示し、ユーザーが手動で JPX / 松井 / 株予報 等で確認できるよう
外部リンクを提供する。

詳細は [CLAUDE.md](./CLAUDE.md) を参照。
