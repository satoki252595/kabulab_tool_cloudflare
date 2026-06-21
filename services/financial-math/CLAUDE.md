# 004 financial-math — kabulab

**kabulab** プロジェクト群の 004 番。教科書レベルの金融工学
(**DCF / CAPM / EMH アノマリー / Black-Scholes**) を東証の実銘柄データと
組み合わせて使えるようにする計算ツール群。

ポータル: `https://kabulab-cf.satoki252595.workers.dev/` / 本サービス: `/financial-math/`

## このサービス固有の絶対ルール (mono-repo CLAUDE.md に追加)

### 計算不能は null / throw で表現する

前提条件を満たさない入力 (k ≤ g、D1 ≤ 0 等) は **throw**、データ不足
(β のサンプル < 30 営業日、配当履歴 2 件未満等) は **null + 理由** で返す。
「それっぽい近似値」「とりあえず β=1」のような代替は禁止 (ルール1/2 帰結)。

### FCF ベース DCF は未実装 — 配当ベースのみ

実装済みは Gordon 成長モデルと 2 段階 DDM (いずれも配当ベース)。
**無配銘柄は理論株価を直接計算できない**。FCF ベースを実装する場合は
明示的な別モジュールとして追加し、配当ベースの結果と混ぜない。

### core_* / swing_* テーブルは読み取り専用

書き込みは 004 所有の `finmath_price_snapshot` / `finmath_daily_ohlcv` のみ。
`src/db/core-schema.ts` / `swing-readonly.ts` は参照専用の定義。

## 技術スタック

- Runtime: Cloudflare Workers + Hono v4
- DB: Cloudflare D1 (SQLite) + Drizzle ORM (drizzle-orm/d1 + sqlite-core)。
  単一 DB `kabulab-cf` に接頭辞テーブル `finmath_*` で同居 (ADR-0001)。
  読取は Worker の `c.env.DB` バインディング (`createDb(c.env.DB)`)。
- Validation: Zod
- Language: TypeScript (strict)
- **JSX 禁止** (mono-repo 共通) — ビューは `src/views/*.ts` の template literal

## DB スキーマ

D1 は名前空間が無いため、旧 PG スキーマ名 (core/swing/finmath) は廃止し、
接頭辞テーブルで同居させる。

| テーブル接頭辞 | 所有 | 用途 |
|---|---|---|
| `core_*` | 001/002 が更新 | 銘柄マスタ `core_stocks` (読み取り専用で参照) |
| `swing_*` | 003 が更新 | 日足 OHLCV `swing_daily_ohlcv` 等 (読み取り専用で参照) |
| `finmath_*` | 004 のみ | `finmath_price_snapshot` / `finmath_daily_ohlcv` (Yahoo 取得キャッシュ) |

## コマンド

このサービスは kabulab mono-repo のサブアプリ。コマンドはすべて
**リポジトリルート** から実行する。

```bash
pnpm dev                   # ローカル開発サーバー起動 (wrangler dev)
pnpm db:generate:d1        # drizzle/d1/*.sql を生成 (全サービス共通)
# 実 DB 反映: wrangler d1 execute kabulab-cf --remote --file=drizzle/d1/<n>.sql
pnpm test / pnpm typecheck / pnpm lint
```

※ `db:push:finmath` / `db:studio:finmath` / `drizzle.financial-math.config.ts`
(pg dialect) は ADR-0001 で **obsolete**。スキーマは `pnpm db:generate:d1` →
`wrangler d1 execute` で反映する。

## ディレクトリ

```
services/financial-math/
├── app.ts / base-path.ts      # Hono サブアプリ本体 (BASE_PATH=/financial-math)
├── src/
│   ├── db/                    # finmath-schema.ts + core/swing 読み取り専用定義
│   │                          #   client.ts: createDb(c.env.DB) = D1 バインディング
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
