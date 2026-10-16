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
pnpm yutai:fetch          # 月次Actionsと同じ原文取得・物理保管・取込
pnpm exec tsx --env-file=.env scripts/biztag-local/main.ts run yutai-summary
# Mac21時jobと同じ変更・未要約分のローカル要約。private stateは入口で選ぶ。
```

本番の原文取得は毎月10日10:30 JSTのActionsへ接続する。変更・未要約分はMacの
`com.kabulab-cf.yutai-summary` が毎日21時に最大60件ずつ処理する。Macが稼働して
いることが必要。既存の固定MLXモデルだけを使い、新規の有料APIへ切り替えない。
原文・生成結果を公開ログへ出さず、共有契約の検証・Notion物理照合・銘柄単位の
原子適用を通す。判定不能は金額NULL・理由つき保留とし、未確定の適用を自動再送しない。

20時の事業タグ・21時の優待要約は、開始/終了の実行receiptを既存vwap R2へ
CAS保存し全文を読戻す（通常1処理あたり2PUT・3GET）。本文や処理件数は含めない。
既存`ops_check`が毎日の予定開始から5分・終了30分の窓、未完、実HEADと
`BIZTAG_LOCAL_ACCEPTED_REVISION`の一致、終了codeを検査し、既存SLO通知へ渡す。
GitHub SecretにもMac `.env`と同じ承認済みSHA・既存R2資格を登録する。
code0はプロセス終了の記録であり、データpendingが0という意味ではない。
Mac停止やmirror失敗はreceipt未取得/未完として検出し、過去の成功で補わない。
同じ予定時刻の未完runを重複起動で置換しない。前日の未完はprivate stateへ
全文を保全・照合し、警告を残せた場合だけ次の予定へ進む。

原文の権利月は各表の明示範囲を使う。行全体が単一の「金額円相当」と
独立した末尾「（n月のみ）」である確認済み形式では、その行を表の月の部分集合に
限定する。本文・株数・備考は保持し、利用・開催・申込・発送の月や複数商品の注記から
権利月を推定しない。表と行の月が矛盾する場合や随時との混在は取込前に停止する。

## 内部API

銘柄詳細SSRは、既存本文から純計算した `public_facts` を使い、期間表記・選択・
抽選・申込の記載、併用可否の掲載表記、金額が確定できない理由、掲載出典と受信日時を表示する。
これらの検出は適用対象や必要条件の確認ではない。`holdingPeriods` は掲載の期間表記で、
保有条件や株数との対応は未確定。`application=true` は希望者限定の申込も含み、
全員必須を意味しない。`combination` は対象未確認の併用表記であり、券の利用と
複数特典の同時受取を読み替えない。同じ意味はprivate JSSのDTOにも適用する。
本文自体は取得・表示しない。掲載URLと会社の公式URLを区別し、未照合・未記録を
明示する。条件の異なる優待を同じ要約だけで統合せず、銘柄全体の金額を合計しない。
認定額は既存の厳密判定と保存額の両方が一致した場合だけ表示する。

通常の全量取込でDTOを保存する。本文修正時は旧DTOを無効化し、再生成までは
未確認と表示する。既存行の再生成では、同一本文の全株数・権利月を判定対象に含める。
追加のモデル実行や外部通信は不要である。認証付きJSS `/v1/yutai/:code` も同じDTOを
読むが、無認証JSONの新経路は設けない。公式照合の有無は再配布権の確認を意味しない。

初回の既存行保守は `backfill-public-facts.ts prepare <private-source.json> <private-dir>`
で完全PRE・期待値・SQLを作る。0029の追加列がNULLの状態で、同じ引数の `apply` を
使うと、共有NotionへPREを物理保管・照合してから1回だけ送信し、全行・全列を照合する。
更新するのは `public_facts` だけで、`updated_at` は変更しない。既存DTOを上書きする
機能や結果不明時の自動再送は無い。実行は `nix develop --command pnpm exec tsx
--env-file=.env services/otakara-yutai/data-scripts/backfill-public-facts.ts ...` を使う。

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
