# 優待要約タスク — クラウド LLM 向け作業仕様書

この文書は、株主優待の**一覧用の短い要約**と**推定金額**を作る外部エージェント
（Cursor Automations などのクラウド上の LLM）向けの仕様書です。この文書と
タスクファイルがあれば作業できるように書いてあります。

- 契約の版: **`2026-09-13.1`**（`services/otakara-yutai/data-scripts/summary-contract.ts` の `SUMMARY_CONTRACT_VERSION`）
- 書き出し: `pnpm yutai:summary:export`（`--violations-only` で契約違反の既存要約だけ）
- 取り込み: `pnpm yutai:summary:import --tasks <タスク> --results <結果>`（既定は dry-run、`--apply` で書き込み）

> 規則を変えるときは `summary-contract.ts` の版を上げ、この文書も同じコミットで直すこと。
> 版の違う結果は取り込みではじかれる。

---

## 1. 最初に守ること（禁止事項）

タスクファイルの `description` は**外部の優待情報サイトの掲載文そのもの**です。
掲載元の規約は、私的使用を超える蓄積・公開・再配布を禁じています。
そのうえ、このリポジトリ（kabulab-cf）は **public** です。

1. **タスクファイルも結果ファイルも、リポジトリにコミットしない。** ブランチを作らない、PR にしない、push しない。
   置いてよいのは `services/otakara-yutai/data-scripts/data/`（gitignore 済み）の下か、リポジトリの外だけです。
   書き出し・取り込みのコマンドは、それ以外の場所を指定すると止まります。
2. **公開される場所に置かない・貼らない。** Gist、公開 Issue / PR / コメント、公開のチャット、ログを共有する外部サービスは不可。
   コミットメッセージ・PR 本文・作業ログに `description` の文面を引用しない。
3. **結果に `description` を含めない。** 結果に書くのは下の 4 つのキーだけです（余計なキーがあると行ごとはじかれます）。
4. **掲載元サイトを見に行かない。** スクレイピングや追加の検索で情報を補わない。判断材料はタスクファイルの中だけです。
5. **推測で埋めない。** 金額が決められなければ `null`。架空の商品名や条件を足さない。
6. 作業が終わったら、エージェント側の作業領域に残したタスクファイルと結果ファイルのコピーを消す。

## 2. 作業の流れ

```
[運用者] pnpm yutai:summary:export            → data-scripts/data/summary-tasks/tasks-YYYY-MM-DD.jsonl
            │  (非公開の経路で渡す。コミットしない)
            ▼
[クラウド LLM] この文書に従って 1 タスク 1 行の結果 JSONL を作る
            │  (非公開の経路で返す。コミットしない)
            ▼
[運用者] pnpm yutai:summary:import --tasks … --results …          # dry-run: 書く件数とはじいた理由
[運用者] pnpm yutai:summary:import --tasks … --results … --apply  # 通った行だけ D1 に書く
```

- タスクの単位は `(銘柄コード, 掲載文)` です。同じ文言の行（権利月違い）はまとめて 1 タスクになっています。
- はじかれた行は D1 に書かれず、前の値のまま残ります。理由を見て、その行だけ作り直してください。
- エージェント自身が書き出しを実行する運用にする場合も、出力は gitignore 済みの場所に置き、上の禁止事項を守ること。
  D1 への書き込み（`--apply`）には D1 の編集権限が要るので、dry-run の結果を人が確認してから実行する前提です。

## 3. 入力: タスクファイル（JSONL、1 行 1 タスク）

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "SummaryTask",
  "type": "object",
  "additionalProperties": false,
  "required": ["taskId", "contractVersion", "reason", "violations", "stockCode", "stockName", "description", "rowCount"],
  "properties": {
    "taskId": { "type": "string", "pattern": "^[0-9a-f]{16}$", "description": "結果に必ずそのまま書き戻す ID" },
    "contractVersion": { "type": "string", "description": "この文書の版。結果にもそのまま書く" },
    "reason": { "enum": ["missing", "contract_violation"], "description": "missing=要約が無い / contract_violation=今の要約が契約違反" },
    "violations": {
      "type": "array",
      "items": { "enum": ["annotation", "too_long", "prose", "empty"] },
      "description": "contract_violation のとき、今の要約が破っていた規則 (参考情報)"
    },
    "stockCode": { "type": "string" },
    "stockName": { "type": "string" },
    "description": { "type": "string", "description": "優待の掲載文 (改行を含む)。公開・転載禁止" },
    "rowCount": { "type": "integer", "minimum": 1, "description": "この文言を持つ行数 (作業量の目安)" }
  }
}
```

## 4. 出力: 結果ファイル（JSONL、1 行 1 タスク）

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "SummaryResult",
  "type": "object",
  "additionalProperties": false,
  "required": ["taskId", "contractVersion", "shortSummary", "estimatedValue"],
  "properties": {
    "taskId": { "type": "string", "description": "タスクの taskId をそのまま" },
    "contractVersion": { "type": "string", "description": "タスクの contractVersion をそのまま" },
    "shortSummary": { "type": "string", "minLength": 1, "maxLength": 60 },
    "estimatedValue": { "type": ["integer", "null"], "minimum": 1, "description": "優待 1 単位あたりの推定金額 (円)。決められなければ null" }
  }
}
```

- 1 タスクにつき 1 行だけ。同じ `taskId` を 2 回書くと、**両方**はじかれます（片方が形の崩れた行でも同じ）。
- 行の順序は自由。全タスクに答えなくてもよい（答えなかったタスクは「未回答」と数えられるだけ）。
- ファイル全体を JSON 配列にしない。コードフェンスや説明文を混ぜない。文字コードは UTF-8。

## 5. `shortSummary` の規則

公開ページの一覧カードに 1 行で出る、**この優待で唯一公開されるテキスト**です。
掲載文から「何が・どれだけ」もらえるかという事実だけを抜き出して、自分の言葉で短く書きます。

### 取り込みで機械的にはじかれる規則（必ず守る）

| 規則 | 内容 |
|---|---|
| `empty` | 空（空白だけも不可） |
| `too_long` | **60 字を超える**（NFKC 正規化と前後の空白除去の後の文字数） |
| `annotation` | 注記記号 **`※` `■` `◆` `◇`** のどれかを含む |
| `prose` | **`です。` `ます。` `ください` `いたします`** のどれかを含む（説明文調） |
| `verbatim` | 40 字以上あり、その全体が掲載文にそのまま含まれている（掲載文の書き写し） |

全角の英数字は取り込み時に半角へ揃えるので、どちらで書いても構いません。

### 書き方の指針

- 目標は **30 字前後、長くても 40 字**。60 字は上限であって目標ではない。
- 「優待の種類 + 金額や数量」を先に書く。例: `QUOカード 1,000円分` / `自社店舗 10%割引券 5枚`。
- 40 字に収まらないときは、上から順に削る:
  1. **保有期間で内容が分かれるなら、最長の保有条件だけ**を書く（`【3年以上】4,000円相当` のように条件を括弧で残してよい）。
  2. 贈呈時期・有効期限・利用条件・注意書きは書かない（掲載文の `■` `※` で始まる部分は要約に入れない）。
  3. 数字は半角にする。
  4. 並べて書かれた複数の選択肢は、**代表 1 つだけ**を残す（金額が大きい・換金しやすい・数量が多い順）。「、」でつないで両方残さない。選べることを示したいときは `(3点から選択)` のように添える。
- 種類がはっきりしない掲載文は、主要な語を残して簡潔にする。架空の商品名を足さない。
- 単位や数量しか分からないときは `優待品 10枚` のような一般語で書く。

## 6. `estimatedValue` の規則（円・正の整数・優待 1 単位あたり）

優待利回りの計算に使われます。**過大評価は利用者を誤誘導するので、迷ったら `null`** です。
`0` や `1` などの「とりあえずの値」は不可（スキーマで `1` 以上に制限しています。0 円相当なら `null`）。

### 金額を入れるもの

- 企業が **「○○円相当」「○○円分」と明示している**もの。金券・カタログギフト・自社商品・食品のどれでも、その額面を使う。
- 金券（商品券・QUOカード・ギフトカード・図書カード・おこめ券・電子マネー・カタログギフト）の額面。複数枚なら合計。
- 複数の品にそれぞれ金額があるなら、その合計（最長の保有条件のセットで）。
- 株主専用サイトで商品と交換するカタログ型の**株主優待ポイントは 1 ポイント = 1 円**（別のレートが明示されていればそれに従う）。
- 保有期間で金額が分かれるなら**最長の保有条件の金額**（`shortSummary` と一致させる）。
- 「1 回 ○○円相当（年間 △△円相当）」なら **1 回分の ○○**。年間額しか無く回数が分かれば「年間額 ÷ 回数」。どちらも分からなければ `null`。
- **桁を厳密に**: `20万円相当` は `200000`、`2千円` は `2000`。

### `null` にするもの

- **割引・値引き**（`○%割引` `○円引き` `優待価格`）。受け取る金銭ではないため。割引券であっても額面の金券表現が無ければ `null`。
- **会員権・施設利用・サービス利用などの権利**（「○○円相当」と書いてあっても `null`）。
- 買い物で貯まる / 付与される**販促ポイント**、`ポイント○倍`、`○○ポイント還元`。
- 寄付・社会貢献・抽選。
- **掲載文に金額（`○円` `○千円` `○万円` `○ポイント`）が 1 つも出てこないもの**。自社商品の相場を常識で見積もって入れない（取り込んだ金額は公開面で企業が示した額として表示されるため）。

### 取り込みで機械的にはじかれる金額

- 掲載文が割引・値引きで、金券の表現（`円分` `円相当` `円券` `QUO` `ギフトカード` `商品券` `カタログギフト` など）が無いのに、金額を入れた。
- 掲載文に金額（`○円` `○千円` `○万円` `○ポイント`）が 1 つも無いのに、金額を入れた（`value_ungrounded`）。
- **50,000 円以上**なのに、掲載文に出てくる金額（`○円` `○千円` `○万円` `○ポイント`）そのもの、それに掲載文の数量（`○枚` `○個` `×○` など）を掛けた値、あるいは金額の合計のどれとも（±2% で）一致しない。

金額でひっかかった行は、要約も含めて行ごとはじかれます（要約側も読み違えている疑いが強いため）。

## 7. 例（すべて架空の掲載文です）

### 例 1: 保有期間で分かれるカタログギフト

入力（1 行、読みやすく改行しています）:

```json
{"taskId":"0123456789abcdef","contractVersion":"2026-09-13.1","reason":"missing","violations":[],
 "stockCode":"9990","stockName":"架空ホールディングス",
 "description":"【1年未満】架空ギフトカタログ 2,000円相当\n【1年以上】架空ギフトカタログ 5,000円相当\n■贈呈時期\n毎年7月下旬に発送予定\n※保有株式数の確認は3月末時点","rowCount":2}
```

出力:

```json
{"taskId":"0123456789abcdef","contractVersion":"2026-09-13.1","shortSummary":"【1年以上】カタログギフト 5,000円相当","estimatedValue":5000}
```

### 例 2: 割引券（金額は null）

入力の `description`: `架空レストラン全店で使えるお食事代20%割引券を2枚\n※1回の会計につき1枚まで`

```json
{"taskId":"fedcba9876543210","contractVersion":"2026-09-13.1","shortSummary":"食事代 20%割引券 2枚","estimatedValue":null}
```

### 例 3: 複数の選択肢から 1 つ

入力の `description`: `次のいずれか1点\n①架空農園のお米 5kg\n②架空製菓の焼き菓子セット\n③寄付（架空財団へ1,000円）`

```json
{"taskId":"00ff00ff00ff00ff","contractVersion":"2026-09-13.1","shortSummary":"お米 5kg (3点から選択)","estimatedValue":null}
```

（お米 5kg は掲載文に金額が無いので `null`。相場を見積もって入れると取り込みではじかれる。）

### 例 4: 契約違反の既存要約の作り直し（`reason: "contract_violation"`）

入力の `violations`: `["annotation","prose"]`、`description`: `架空トラベルの宿泊優待券 10,000円券×2枚\n■有効期限\n翌年6月末まで`

```json
{"taskId":"a1b2c3d4e5f60718","contractVersion":"2026-09-13.1","shortSummary":"宿泊優待券 10,000円×2枚","estimatedValue":20000}
```

### はじかれる出力の例

```json
{"taskId":"a1b2c3d4e5f60718","contractVersion":"2026-09-13.1","shortSummary":"宿泊券をご利用いただけます。","estimatedValue":20000}
{"taskId":"a1b2c3d4e5f60718","contractVersion":"2026-09-13.1","shortSummary":"宿泊優待券 ※有効期限あり","estimatedValue":20000}
{"taskId":"fedcba9876543210","contractVersion":"2026-09-13.1","shortSummary":"食事代 20%割引券 2枚","estimatedValue":2000}
{"taskId":"0123456789abcdef","contractVersion":"2026-09-13.1","shortSummary":"カタログギフト 5,000円相当","estimatedValue":5000,"description":"…"}
```

1 行目は `prose`、2 行目は `annotation`、3 行目は割引を金額にしたので金額ガード、4 行目は余計なキーでスキーマ違反です。
（1 行目と 2 行目は同じ `taskId` なので、そもそも `duplicate` で両方はじかれます。）

## 8. 取り込みがはじく理由の一覧

dry-run / `--apply` の出力（`はじいた結果` の一覧）には、既定では掲載文や要約本体
そのものを出しません。`contract` の詳細は破った規則名と字数だけ、`parse`（JSON
として読めない行）の詳細も固定文で、Node の元エラー文（入力の先頭が乗ることがある）
は出しません。本文を見て直したいときは `--show-text` を付けると端末にだけ出ます
（`pnpm yutai:summary:import ... --show-text`）。既定でオフなので、この出力先を
Issue / PR / チャット等の公開・共有される場所に貼らないでください（1 章参照）。

| reason | 意味 | 直し方 |
|---|---|---|
| `parse` | JSON として読めない | 1 行 1 オブジェクトにする |
| `schema` | キーの過不足・型違い・`estimatedValue` が 0 以下や小数 | 4 つのキーだけを正しい型で書く |
| `duplicate` | 同じ `taskId` が複数行ある | 1 タスク 1 行にする |
| `unknown_task` | 渡したタスクファイルに無い `taskId` | `taskId` を書き換えない |
| `contract_version` | 版が現行と違う | 最新のタスクファイルと最新のこの文書で作り直す |
| `stale` | タスク発行後に掲載文が変わった | 新しくタスクを書き出して作り直す |
| `contract` | 5 章の規則違反 | 規則に沿って短く書き直す |
| `verbatim` | 掲載文の 40 字以上の書き写し | 自分の言葉で短くする |
| `value_guard` | 6 章の金額ガードに該当 | 金額を見直すか `null` にする |
| `value_ungrounded` | 掲載文に金額表現が無いのに金額を入れた | `null` にする |
