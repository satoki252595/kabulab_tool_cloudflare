# 005 yuho-quant — kabulab

**kabulab** プロジェクト群の 005 番。金融庁 **EDINET** の有価証券報告書から
「**受注高 / 受注残高**」(セグメント別 + 全社合計) と
「**海外（地域別）売上高 / 海外売上高比率**」を構造化し、最大 5 年の推移を
可視化する定量情報検索サービス。**同じ有報 1 通**から受注・海外売上に加え
投資判断用の**開示テキスト 39 項目**（定性 6 + 株主・資本・資産・体制の細目。
`edinet/text-sections.ts` の TEXT_SECTIONS が正本。項目名は CSV 実測値）を
並行抽出する（XBRL は 1 回だけ取得、開示テキストは CSV のみ）。

仕様の正本は [docs/005-yuho-quant.md](../../docs/005-yuho-quant.md)。
本ファイルは実装時の規約のみを持つ。

## このサービス固有の絶対ルール (mono-repo CLAUDE.md に追加)

### 受注データは「構造化できた時だけ」出す

有報の受注開示は会社ごとに表構造がバラバラ。**確信を持って構造を判定
できた表のみ**数値化する。判定できない表は数値を作らず `parse_status` に
事実を記録し、UI では「未対応」「データなし」と正直に出す
(ルール1/2 の帰結)。新しい開示パターンに対応するときも「とりあえず
それっぽい数値を拾う」実装は禁止。fixture を足してテストで固定してから
パターンを追加する。

### 金額欠損は NULL。0 で埋めない

有報で「－」「―」等の非開示セルは `null`。`order_facts` の
`*_raw` / `*_yen` も NULL。UI 表示は「—」。0 と区別する。

### EDINET API キーは yuhoEnv 経由のみ

`process.env.EDINET_API_KEY` 直参照禁止。`src/env.ts` の
`yuhoEnv.EDINET_API_KEY()` を使う (未設定なら throw)。`.env` のみが
正のソース。Worker ランタイムでは Cloudflare の Secrets が正
(`nodejs_compat` 経由で `process.env` に注入される)。

### 帯域を無駄にしない (CSV 事前判定)

`ingestDocument` は先に軽量な CSV(type=5) を取り、全文に受注語 **も** 海外語 **も**
無ければ重い XBRL(type=1) を**落とさない**。これは推測ではなく「CSV は全テキスト
ブロックを平坦化して含む」事実に基づく確定判定。XBRL は受注・海外どちらかの語が
あれば **1 回だけ**取得し、受注と海外売上を並行構造化する（二重ダウンロードしない）。

### 海外売上は「構造化できた時だけ」出す + 当期・連結を選ぶ (overseas-parser)

海外（地域別）売上の開示も会社ごとに表構造がバラバラ（新収益認識基準の地域別
収益分解・地域ごとの情報・所在地別・営業収益建ての地域別営業概況）。確信を持って
判定できた表のみ数値化し、判定できない表は `overseas_parse_status` に事実を記録して
UI で「未対応」と出す（ルール1/2）。**海外売上高 = 開示された海外地域行の合計**
（`total − 国内` ではない。「その他の収益」等の非地域分を混ぜない）。同一有報の
複数表からは **当期・連結・地域注記** に最も近い候補を採点で選ぶ（前期・個別を
出さない）。「うち、米国」内訳行は二重計上回避で除外。地域行の合計が開示集計行と
1% 超ずれる表は誤読として却下。スクリーニングの国・地域別フィルタは同義地域語を
`REGION_BUCKETS` で束ね、その地域を明示開示する会社だけを対象に丸めている会社は
除外する（架空の比較可能性を作らない）。新パターン対応も **実 fixture を足して
テストで固定してから**。旧基準「海外売上高」注記は現行有報からほぼ消滅（調査280件で
0件）のため対象外。`pnpm audit:overseas` で全銘柄の取りこぼし署名を集計できる。

> 本サービスは Cloudflare D1 で本番稼働中。DB は **D1(`c.env.DB` バインディング)**、
> 取込は **Worker の認証ルート + GitHub Actions トリガ**。
> 旧 `pnpm yuho:backfill` CLI は D1 移行で無効化（fail-fast）し、Worker バルク取込へ再実装予定。

### 事業タグ(biztag)固有のルール

有報の「事業の内容」「セグメント情報」から単語帳(語彙)に沿って業種タグを付ける
`src/biztag/` 配下の機能。設計の正本は
[docs/005-yuho-quant-business-tags.md](../../docs/005-yuho-quant-business-tags.md)、
kabulabAgents 向け契約は
[docs/005-yuho-quant-business-tags-contract.md](../../docs/005-yuho-quant-business-tags-contract.md)。
mono-repo CLAUDE.md のルール1/2/3/6 に加え、以下を厳守する(違反は commit 前に直す):

- **AI に事業内容を作文させない・LLM の生文を保存しない**。Notion へ書くのは
  「単語帳の語(ID・名前)」「判定の確率と帯」「有報からコードで抜き出した原文の文
  (書類ID・会計期末つき)」の3つだけ。jev(判定モデル)の応答からそれ以外の自由文を
  そのまま保存する経路を作らない。
- **状態は正直に記録する**(ルール2の帰結)。`未判定`・`本文なし`・`読込失敗`・
  `判定不能` を「該当なし」や既定のタグで埋めない。タグ列が空でも
  `事業タグの状態 = 判定済` でなければ「業種の該当が無い」と確定させない
  (契約書 §4)。
- **しきい値・モデルは `calibration.json` からのみ読む**
  (`services/yuho-quant/src/biztag/thresholds.ts` の `loadCalibration()`)。
  未較正のマジックナンバーをコードに埋め込まない。`calibration.json` はゴールデン
  セット(`src/biztag/golden/`)で精度を測ってから運営が用意する(このリポジトリの
  ソースにダミー値を先置きしない)。
- **単語帳(語彙)の変更経路は2つだけ**: (1) Cursor Automation の提案 →
  `pnpm biztag gate` の自動審査(形式・出典実在・jev ゴールデンセット再評価・変更量
  上限)を通した版の更新、(2) `pnpm biztag rollback`。**それ以外の方法で
  `v1.json` 以降の版データを手で書き換えない**(台帳 DB が正本。手で作った版は
  ハッシュ照合で弾かれる)。単語帳の型(`vocabulary/schema.ts`)自体を変える場合のみ
  通常の PR(ルール5)で良い。
- Notion への書込は `src/shared/notion-archive/` 経由のみ(ルール6)。
  `api.notion.com` を biztag から直接叩かない。

## ディレクトリ

```
services/yuho-quant/
├── app.ts / base-path.ts
└── src/
    ├── index.ts                  # Hono サブアプリ本体
    ├── env.ts                    # 型付き env アクセサ (ルール3)
    ├── db/{client,schema}.ts     # yuho_* 接頭辞テーブル + Drizzle(d1)
    ├── routes/{pages,admin}.ts   # SSR + JSON API / 認証取込ルート
    ├── services/
    │   ├── edinet/{client,types,zip,csv,html-table,order-parser,text-sections}.ts
    │   ├── ingest.ts             # 1 通取り込み (catchup 共用)
    │   ├── text-sections-query.ts  # 定性セクション読み (銘柄最新)
    │   ├── order-query.ts / overseas-query.ts  # UI クエリ (L2 投影読み)
    │   ├── overseas-parser.ts    # 海外売上の構造化
    │   └── projection.ts         # L2 投影 p_yuho_growth の再生成
    ├── views/                    # layout/home/stock-detail/screening/overseas-*
    └── tests/                    # parser/order/projection/universe テスト + fixtures
└── data-scripts/{backfill,backfill-overseas,backfill-text-sections,backfill-missing-docs,audit-overseas}.ts
```

## コマンド

すべて **リポジトリルート** から実行する (一覧は root README 参照):

```bash
pnpm ingest:yuho-edinet     # Worker /yuho-quant/admin/catchup を叩く (要 WORKER_BASE_URL + CRON_SECRET)
pnpm backfill:overseas      # 既存有報の海外埋め戻し (D1 HTTP)
pnpm yuho:backfill:text     # 既存有報の開示テキスト埋め戻し (CSV のみ・D1 HTTP)
pnpm yuho:backfill:missing  # 期間指定の取りこぼし回収 (日次上限で欠けた分。無制限・再開可能)
pnpm audit:overseas         # 全銘柄の取りこぼし署名を集計
pnpm biztag run             # 事業タグ判定 (差分処理。catchup.yml が平日実行)
pnpm biztag gate            # 単語帳の見直し提案の審査 (通常は run の冒頭が呼ぶ)
pnpm biztag golden          # ゴールデンセットで精度測定 (しきい値較正用)
pnpm biztag rollback        # 単語帳を過去の版へ巻き戻す (--to=vN --reason=...)
pnpm test / pnpm typecheck / pnpm lint
```

事業タグ(biztag)のコマンド詳細・運用手順は
[docs/005-yuho-quant-business-tags.md](../../docs/005-yuho-quant-business-tags.md) §11
「運用手順(runbook)」を参照。
