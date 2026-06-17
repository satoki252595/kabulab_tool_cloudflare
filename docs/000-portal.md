# 000 Portal — kabulab

kabulab プロジェクト群の統合ポータル。各サービスへのハブとして機能し、配下のサービスを Hono サブアプリとしてマウントする。

## コンセプト

- 日本株投資を支援するツール群を **kabulab** ブランドの下に統合
- ポータルから各サービス (`/<slug>/*`) へ同一オリジンで遷移
- 全サービス共通の **Editorial Swiss Grid** デザインで一貫したブランド体験を提供
- 新サービスは `services/<slug>/` フォルダを作って `app.route()` で mount するだけで掲載可能

## 役割

ルート Hono アプリ `src/index.ts` は次の責務を持つ:

1. `/` でポータルホームを SSR
2. `services/<slug>/app.ts` をインポートし、`app.route("/<slug>", subapp)` で mount
3. `src/shared/design.ts` から共通デザイントークンを取り込み、ヘッダー / ヒーロー / サービスカード / フッターを描画
4. `SERVICES` 配列に各サービスのメタデータ (番号・slug・タイトル・説明・機能タグ・URL・ステータス) を保持

## ディレクトリ構成

```
api/
└── index.ts                 # Vercel 関数エントリ — handle(rootApp)
src/
├── index.ts                 # ルート Hono アプリ + ポータル HTML + サブアプリ mount + 統一 cron 2 本
├── cron/
│   ├── daily.ts             # 日次 sync オーケストレータ (全サービス分)
│   └── monthly.ts           # 月次 sync オーケストレータ
└── shared/
    ├── design.ts            # 共通デザイントークン (CSS 変数 / フォントリンク)
    ├── auth.ts              # 統一 cron Bearer token 検証
    ├── yahoo/ / jpx/ / indicators/
    └── ... (scoring / screener / patterns / macro / sector-aggregate / types)
```

ポータル単独でビルド/デプロイすることはなく、常に services/ 配下のサブアプリと一緒にビルドされる。

## 技術スタック

最小構成。DB アクセスもバリデーションも不要なので、ポータル本体は Hono のみで動作する。

| カテゴリ | 技術 |
|---|---|
| Backend | Hono v4 |
| Deploy | Vercel Serverless Functions (単一プロジェクト) |
| View | Hono が直接 HTML 文字列を返却 (JSX 不可) |
| Language | TypeScript |
| Package Manager | pnpm |

## サービス登録

`src/index.ts` の `SERVICES` 配列に Service オブジェクトを追加し、サブアプリを import して `app.route(BASE_PATH, ...)` で mount する。現状は 001〜006 の 6 サービス (001 RSI Screening / 002 お宝優待 / 003 Swing Trading / 004 金融数学 / 005 有報定量検索 / 006 IR Catalog) が登録済み。

```ts
import {
  otakaraYutaiApp,
  BASE_PATH as OTAKARA_BASE_PATH,
} from "../services/otakara-yutai/app.js";

const SERVICES: Service[] = [
  // ...
  {
    num: "002",
    slug: "otakara-yutai",
    title: "お宝優待",
    subtitle: "割安な株主優待を発見",
    desc: "...",
    features: ["Fundamental", "Technical", "Yutai Score"],
    url: `${OTAKARA_BASE_PATH}/`,
    status: "live",
  },
];

// === サブサービスのマウント ===
app.route(OTAKARA_BASE_PATH, otakaraYutaiApp);
```

`Service` 型:

```ts
type Service = {
  num: string;       // "001" など 3 桁ゼロ詰め
  slug: string;      // URL slug
  title: string;     // 表示名
  subtitle: string;  // 短いサブタイトル
  desc: string;      // 説明文 (1-2 文)
  features: string[]; // 機能タグ (uppercase mono バッジ)
  url: string | null; // 遷移先 URL ("/<slug>/" もしくは外部URL、null なら Coming Soon)
  status: "live" | "soon";
};
```

URL が `/` で始まる場合は同一タブ遷移、外部 URL の場合は新規タブで開く。

## デザイン

[overview.md](./overview.md) の「デザインシステム」セクションを参照。kabulab 全サービスで共有される **Editorial Swiss Grid**（白黒×ニューブルータリスト）を採用。共通トークンは `src/shared/design.ts` に集約。

### ポータル独自のUI要素

- **Hero**: 大型ディスプレイ見出し（最大 82px）+ Live/Total Services 統計
- **Service Card**: ヘッダー部に番号 + slug + Live/Soon ステータスバッジ、ボディに見出し + 説明 + 機能タグ + CTA ボタン
- **About box**: 上端に「ABOUT」ラベルバッジ
- **Footer**: ©表示 + サービスへのクイックリンク

## デプロイ

```bash
pnpm run deploy           # vercel deploy --prod
                      # ルート リポジトリから単一の kabulab プロジェクトを更新
```

Vercel プロジェクト名は `kabulab`、本番URLは `https://kabulab.vercel.app/`。旧 `otakara-yutai.vercel.app` は廃止済み (404)。

## ローカル開発

```bash
pnpm dev              # vercel dev でローカル起動
```

## トレーリングスラッシュ

サブアプリのマウントで `/foo` と `/foo/` の両方をマッチさせるため、ルート / サブアプリ共に `new Hono({ strict: false })` で生成している。

## 今後の拡張

- 各サービスの稼働状況（最終更新日・メトリクス）を表示するダッシュボード機能
- お知らせ・リリースノートセクション
- サービス間の共通認証 / SSO（必要になれば）
