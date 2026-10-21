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
pnpm biztag:monthly --runtime .runtime/mac-main554-20261020 --preflight
# 実処理は docs/mac-monthly-manual.md のコマンドを使う。
```

本番の原文取得は毎月10日10:30 JSTのActionsへ接続する。Macの自動起動2本は
停止済み。変更・未要約分の機械要約は[月次手動](../../docs/mac-monthly-manual.md)で
最大60群ずつ処理する。標準はモデルなしで、既存MLXは明示`--allow-model`時だけ。
原文・生成結果を公開ログへ出さず、共有契約の検証・Notion物理照合・銘柄単位の
原子適用を通す。判定不能は金額NULL・理由つき保留とし、未確定の適用を自動再送しない。

月次手動では既存runtime・private state・writer排他・未完記録を保全する。
旧日次receiptは更新せず、その日次期待の監視も廃止済み。有限処理の終了を
全件充足と扱わず、summaryの残件を確認する。毎月11日09:00 JSTのCalendar
メール案内は設定済みで、初回は2026-11-11。案内はコマンドを自動実行しない。

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

全文対応済みのQUOカード2期間だけは`version=4`・`holding-record-tiers-v1`で、
期間別の掲載円額・名簿定義・毎年の発送予定を保持する。原文SHAと順序を束縛し、
名簿の記載または記録回数を「同じ名義」「連続記録」や本人の権利取得回数へ読み替えない。
発送予定は権利月・基準日へ変換せず、評価額はNULL、本人適用は`unverified`のまま。
旧v1〜v3は同値で再読できる。他の期間・株数段階・併用は未解析を保つ。
既存の正常compilerとproducerが同じ全文parserを使う。既存行の自動更新・全件再生成は追加しない。
既存v1の1群/1行/1銘柄だけを明示する`prepare-upgrade-record-tier-v1` / `apply-upgrade-record-tier-v1`は、
通常の全列CAS・物理PRE/POST・canonical `.env`起点の専用once stateを使う。
scopeの`kind`は`holding-record-tiers-v1`。原文SHA・全recipient・旧v1全値の現在一致が必要で、
結果不明・既更新では再送しない。consumer配備とfresh scoped PREを受け入れてから実行する。

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
