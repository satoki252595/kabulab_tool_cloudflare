# 003 Swing Trading

**kabulab** プロジェクト群の 003 番。数日〜2週間の短期売買を定量ルール化するサービス。

> **本サービスは [kabulab](../../README.md) mono-repo のサブアプリ**。
> `https://kabulab-cf.satoki252595.workers.dev/swing-trading/` で公開。
> 仕様の正本は [docs/003-swing-trading.md](../../docs/003-swing-trading.md)、
> 実装規約は [CLAUDE.md](./CLAUDE.md)。

## 機能

1. **マクロ判定 (A/B/C/D)** — 今日、短期で取るべき環境か?
2. **5 条件スクリーニング** — 流動性・ボラ・トレンドで銘柄を絞り込む
3. **E&E パターン** — ブレイクアウト / 押し目買い / 出来高急増 / ギャップ / 決算後代理の日足シグナル
4. **リスク計算機** — 2% ルールでポジションサイズを算出

## 開発

コマンドはリポジトリルートから実行する (詳細は root README):

```bash
nix develop               # Node 22 + pnpm 9 の dev shell
pnpm install && pnpm dev  # 依存導入 + ローカル開発サーバー
pnpm sync:daily:core      # 手動日次 (通常は GitHub Actions が実行)
```
