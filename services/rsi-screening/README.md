# RSI Screening

日本株の個別銘柄を対象に、**RSI(10/40/120 営業日)が過去 5 年の分布で
最も低い水準にある優良株**を発見する Web サービス。

> **本サービスは [kabulab](../../README.md) mono-repo の 001 サブアプリ**。
> `https://kabulab-cf.satoki252595.workers.dev/rsi-screening/` で公開。
> 仕様の正本は [docs/001-rsi-screening.md](../../docs/001-rsi-screening.md)、
> 実装規約は [CLAUDE.md](./CLAUDE.md)。

## 特徴

- **3期間のRSI**: 10/40/120営業日
- **パーセンタイル順位**: 現在のRSIが過去5年の分布で下位何%にあるかを算出
- **優良株フィルタ**: 売上高トレンド上昇 AND 営業利益率 TTM ≥ 5%
- **個別銘柄詳細**: 株価・PER/PBR・ROE・年度財務トレンド・RSI履歴

## 開発

コマンドは全て **リポジトリルート** から (詳細は root README):

```bash
nix develop               # Node 22 + pnpm 9 の dev shell
pnpm install && pnpm dev  # 依存導入 + ローカル開発サーバー
pnpm sync:daily:core      # 手動日次 (通常は GitHub Actions が実行)
```

## ライセンス

Private
