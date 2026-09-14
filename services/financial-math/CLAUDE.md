# 004 financial-math — kabulab

**kabulab** プロジェクト群の 004 番。教科書レベルの金融工学
(**DCF / CAPM / EMH アノマリー / Black-Scholes**) を東証の実銘柄データと
組み合わせて使えるようにする計算ツール群。

仕様の正本は [docs/004-financial-math.md](../../docs/004-financial-math.md)。
本ファイルは実装時の規約のみを持つ。

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

004 は D1 に書き込まない (所有する表が無い。旧 `finmath_*` 2 表は
drizzle/d1/0012 で削除)。`src/db/swing-readonly.ts` と共有
`src/shared/db/core-schema.ts` / `projection-schema.ts` は参照専用の定義。

## ディレクトリ

```
services/financial-math/
├── app.ts / base-path.ts      # Hono サブアプリ本体 (BASE_PATH=/financial-math)
└── src/
    ├── index.ts               # Hono({ strict: false }) + routes + onError (共有 createErrorHandler)
    ├── db/                    # core/swing 読み取り専用定義 (所有する表は無い)
    │                          #   client.ts: createDb(c.env.DB) = D1 バインディング
    ├── routes/{pages,api}.ts  # SSR ページ + フォーム POST (応答も SSR HTML)
    ├── services/              # 純関数: dcf / capm / black-scholes / emh /
    │                          #   volatility / price-cache (唯一の I/O 層。読取専用)
    ├── views/                 # template literal ビュー (dcf/capm/bs/emh/home/layout)
    ├── validators/            # Zod スキーマ (zod/mini。dcf/capm/bs/emh)
    └── tests/
```

## コマンド

すべて **リポジトリルート** から実行する (一覧は root README 参照):

```bash
pnpm dev                   # ローカル開発サーバー起動 (wrangler dev)
pnpm test / pnpm typecheck / pnpm lint
```

004 は所有する表を持たないので、スキーマの生成・反映は発生しない。
