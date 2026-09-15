# お宝優待 (otakara-yutai)

日本株の株主優待において、ファンダメンタルズ及びテクニカルの観点から割安な
銘柄を優待ジャンル毎に紹介する Web サービス。

> **本サービスは [kabulab](../../README.md) mono-repo の 002 サブアプリ**。
> `https://kabulab-cf.satoki252595.workers.dev/otakara-yutai/` で公開。
> 仕様の正本は [docs/002-otakara-yutai.md](../../docs/002-otakara-yutai.md)、
> 実装規約は [CLAUDE.md](./CLAUDE.md)。

## 開発

コマンドは全て **リポジトリルート** から (詳細は root README):

```bash
nix develop               # Node 22 + pnpm 9 の dev shell
pnpm install && pnpm dev  # 依存導入 + ローカル開発サーバー
pnpm sync:monthly:core    # 手動月次 rebuild (通常は GitHub Actions が実行)
```

## 内部API

| Method | Path | 説明 |
|--------|------|------|
| GET | `/api/screening` | スクリーニングページ用フィルター検索（内部利用） |

### クエリパラメータ (GET /api/screening)

| パラメータ | 型 | デフォルト | 説明 |
|-----------|------|-----------|------|
| `month` | number | - | 権利確定月（1-12） |
| `genre` | string | - | ジャンルslugでフィルタ |
| `perMax` | number | - | PER上限 |
| `pbrMax` | number | - | PBR上限 |
| `yieldMin` | number | - | 配当利回り最低% |
| `rsiMax` | number | - | RSI上限 |
| `sort` | string | `total` | ソート対象 |
| `order` | `asc` \| `desc` | `desc` | 並び順 |
| `limit` | number | 50 | 1ページの件数（最大100） |
| `offset` | number | 0 | ページ送り（最大100,000） |
| `withTotal` | `1` | - | 総件数を返す。**絞り込み条件を変えた最初の1回だけ**付ける |

### レスポンス (GET /api/screening)

```json
{ "items": [ /* 銘柄カード */ ], "total": 848, "offset": 0, "limit": 50 }
```

- `total` は `withTotal=1` のときだけ数値、それ以外は `null`。
  同一 WHERE の `COUNT(*)` はデータ取得と同額の走査を払う (D1 は走査行課金)
  ため、ページ送り・ソート変更では取得済みの値を使い回す。
  設計の詳細は docs/002 の「スクリーニングのページングと総件数」を参照。

## ライセンス

Private
