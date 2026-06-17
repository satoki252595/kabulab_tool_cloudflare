# 004 financial-math — kabulab

**kabulab** プロジェクト群の 004 番。教科書レベルの金融工学
(**DCF / CAPM / EMH アノマリー / Black-Scholes**) を東証の実銘柄データと
組み合わせて使えるようにする計算ツール群。

ポータル: `https://kabulab.vercel.app/` / 本サービス: `/financial-math/`

## このサービス固有の絶対ルール (mono-repo CLAUDE.md に追加)

### 計算不能は null / throw で表現する

前提条件を満たさない入力 (k ≤ g、D1 ≤ 0 等) は **throw**、データ不足
(β のサンプル < 30 営業日、配当履歴 2 件未満等) は **null + 理由** で返す。
「それっぽい近似値」「とりあえず β=1」のような代替は禁止 (ルール1/2 帰結)。

### FCF ベース DCF は未実装 — 配当ベースのみ

実装済みは Gordon 成長モデルと 2 段階 DDM (いずれも配当ベース)。
**無配銘柄は理論株価を直接計算できない**。FCF ベースを実装する場合は
明示的な別モジュールとして追加し、配当ベースの結果と混ぜない。

### core / swing スキーマは読み取り専用

書き込みは `finmath` スキーマ (`price_snapshot` / `daily_ohlcv`) のみ。
`src/db/core-schema.ts` / `swing-readonly.ts` は参照専用の定義。

## 技術スタック

- Runtime: Hono v4 + Vercel Serverless Functions
- DB: Neon (PostgreSQL) + Drizzle ORM (`finmath` スキーマ)
- Validation: Zod
- Language: TypeScript (strict)
- **JSX 禁止** (mono-repo 共通) — ビューは `src/views/*.ts` の template literal

## DB スキーマ

| PG スキーマ | 所有 | 用途 |
|---|---|---|
| `core` | 001 が更新 | 銘柄マスタ (読み取り専用で参照) |
| `swing` | 003 が更新 | 日足 OHLCV (読み取り専用で参照) |
| `finmath` | 004 のみ | `price_snapshot` / `daily_ohlcv` (Yahoo 取得キャッシュ) |

## コマンド

このサービスは kabulab mono-repo のサブアプリ。コマンドはすべて
**リポジトリルート** から実行する。

```bash
pnpm dev                   # ローカル開発サーバー起動
pnpm db:generate:finmath   # マイグレーションファイル生成
pnpm db:push:finmath       # スキーマを Neon に反映 (finmath スキーマ)
pnpm db:studio:finmath     # Drizzle Studio
pnpm test / pnpm typecheck / pnpm lint
```

## ディレクトリ

```
services/financial-math/
├── app.ts / base-path.ts      # Hono サブアプリ本体 (BASE_PATH=/financial-math)
├── src/
│   ├── db/                    # finmath-schema.ts + core/swing 読み取り専用定義
│   ├── routes/{pages,api}.ts  # SSR ページ + フォーム POST (応答も SSR HTML)
│   ├── services/              # 純関数: dcf / capm / black-scholes / emh /
│   │                          #   volatility / price-cache (唯一の I/O 層)
│   ├── views/                 # template literal ビュー (dcf/capm/bs/emh/home)
│   ├── validators/ / middleware/ / tests/
│   └── index.ts
├── drizzle/                   # migration SQL
└── scripts/
```

詳細は [docs/004-financial-math.md](../../docs/004-financial-math.md) を参照。
