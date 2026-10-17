# jss-api — 配信 Worker

正本（R2 + D1）を REST と MCP で読むための Cloudflare Worker。**読み取り専用**
（唯一の例外は内部面の鮮度 upsert）。設計は [docs/CF-CANONICAL-DESIGN.md](../../docs/CF-CANONICAL-DESIGN.md)。

## Worker は2本

| Worker | 用途 | bind | 認証 |
|---|---|---|---|
| `jss-api-public` | 公開 REST。`commercial-ok` 全量と `factual-cite` のメタのみ | `DB` / `RAW` | 無認証 |
| `jss-api-private` | 内部 REST + **MCP**。`personal-only` を含む全量 | `DB` / `RAW` / `SUPPLY` / `VWAP` | APIキー必須 |

**公開面に `jp-stock-supply` と `vwap-data` を bind していないのは意図的**で、
コードにバグがあっても personal-only のオブジェクトへ物理的に到達できないようにする
第0層の防御。`test/bindings.test.ts` が設定ファイルごと固定している。

`kabulab-cf`（7サービスの SSR 配信）にも `kabuMCP`（Stripe/Cookie 認可を持つ課金
Worker）にも相乗りしない。D1 は1個のまま両方が読むだけで、データは複製しない。

## 防御の層

| 層 | 内容 |
|---|---|
| L0 | 公開 Worker が personal-only の R2 を bind しない（物理的到達不能） |
| L1 | 公開面は GET / HEAD 以外を 405 で拒否（書込面が存在しない） |
| L2 | 行の `license_tag` で判定。**未知のタグは出さない側に倒す** |
| L3 | 列単位の伏字（`core_stocks` の JPX 由来列、`yutai_benefits` の掲載文） |
| L4 | 内部面は `JSS_API_KEYS` 未設定なら 503 で **fail-closed**（素通しにしない） |

## 開発

```bash
nix develop -c bash -c 'cd services/jss-api && pnpm install'
nix develop -c bash -c 'cd services/jss-api && pnpm typecheck && pnpm test'
```

## デプロイ

```bash
nix develop -c bash -c 'cd services/jss-api && pnpm deploy:public'
nix develop -c bash -c 'cd services/jss-api && wrangler secret put JSS_API_KEYS -c wrangler.private.jsonc'
nix develop -c bash -c 'cd services/jss-api && pnpm deploy:private'
```

`JSS_API_KEYS` はカンマ区切りで複数指定できる。**入れるまで内部面は全リクエストを
503 で拒否する**ので、鍵を入れ忘れたまま personal-only が漏れることはない。

## MCP

内部面の `POST /mcp`（Streamable HTTP・ステートレス）。ツールは `jp_*` 名前空間で、
kabuMCP の `edinet_*` とは分けてある（クライアントに両方登録できるので統合は不要）。

| ツール | 内容 |
|---|---|
| `jp_supply_latest` | 需給の最新断面 |
| `jp_supply_series` | 1銘柄の需給時系列 |
| `jp_ohlcv_range` | 日足 OHLCV（提供元の OHLCV（分割調整済み）。adj_* は配当込 total-return 価格 (adj_volume は常に null)。係数不明は null。出来高の現株数補正なし。REST と束ねた edge キャッシュ、TTL 6h） |
| `jp_indicators_latest` | 株価テクニカルの最新断面（複数銘柄可、旧 Notion「②株価テクニカル」の代替） |
| `jp_valuation` | バリュエーションの最新断面（複数銘柄可、旧 Notion「②株価テクニカル」バリュエーション欄の代替） |
| `jp_dataset_freshness` | 各データセットの鮮度 |
| `jp_job_runs` | 収集ジョブの最新実行状況（ジョブごとに1件、旧 Notion「⑦収集ジョブログ」の代替） |
| `jp_raw_file` | ⑤原本のメタを SHA256 で引く |

`jp_indicators_latest` / `jp_valuation` は `codes` (配列、最大50件) で複数銘柄を
まとめて引ける。見つからない銘柄コードは結果を捏造せず `data.not_found` に列挙する
(ルール2: 欠損は欠損のまま返す)。REST 側は1銘柄ずつ `GET /v1/indicators/:code` /
`GET /v1/valuation/:code`（いずれも内部面のみ、Yahoo 由来＝personal-only）。

`jp_job_runs` は `/v1/meta/jobs`（直近N件の履歴列挙）と違い、ジョブ名ごとに
最新1件へ畳んで返す。頻度の高いジョブに埋もれて低頻度ジョブの最新行が見えなくなる
問題を避けるため、鮮度確認 (freshness guard) にはこちらを使う。

内部RESTの `/v1/yutai/:code` は、権利時期・株数と、原文を含まない
`public_facts`（期間表記、選択・抽選・申込の記載、併用可否の掲載表記、金額を確定できない理由、
掲載出典・受信時計・公式照合状態）を全行返す。`can_aggregate: false` のため、
株数段階や選択肢の額を合計しない。個別受信時計の欠落はバッチ時計で埋めない。
`holdingPeriods` は掲載中の期間表記。v3で全文対応を確認した掲載特典以外との対応、本人・株数の適用条件は未確認。
`application=true` は希望者限定も含む申込・応募表記の検出であり、全員必須ではない。
`combination` は対象未確認の併用表記を返し、券の利用と特典の同時受取を同義にしない。
掲載URLを公式出典として扱わず、公式未照合と再配布権の未確認も維持する。
新規producerの `public_facts.version=2` は `conditionStructure` に正規化前原文の全文SHAと、対応済み全文文法の `take: 1`・選択肢の連続番号・掲載円額・`相当`/`分` を持つ。商品ラベル・原文は含まない。掲載円額は `qualifiedAmount` や合計額ではなく、評価額はNULLを保つ。未対応は `status: unparsed`・`ast: null`・理由を返し、保有期間別・併用の構造は未解析のまま。旧v1も変更せず再読できる。既存v1を全件書き換える処理は追加しない。
厳密な全文2文法だけは `version=3`・`single-holding-period-v1` で掲載期間と円相当額または入場券枚数の対応を返す。原文・施設名は含めず、`applicability: unverified` とする。旧資格済み掲載額・理由・時計は保持し、券枚数から円評価しない。本人、株数段階、同株主番号・記録回数、複数期間、併用は未確認。共有strict parserを使うprivate JSS consumerを配備してからv3実データを採用する。コード配備だけで既存行を更新する処理はない。
応答は `personal-only`。公開Workerの同経路は引き続き404である。

## 需給の出典契約

REST（`/v1/supply/latest`・`/v1/supply/:code`）と MCP（`jp_supply_latest`・
`jp_supply_series`）の4経路は、`meta.attribution` を**フィルタ適用後に
実際に返す行・非空系列だけ**から算出する（`src/shared/supply.ts` が共有境界）。
種類は writer 契約どおり3種のみ：`jsf_zandaka` / `jsf_shina` → 日証金の文言、
`jpx_margin` → JPX の文言（文言自体は `envelope.ts` の `ATTRIBUTION` が正本）。
返すデータが空なら `attribution: []` で、`licenses: ["personal-only"]` は維持する。

- `data_type` / `series` フィルタは既知3種のみ。`from` / `to` は
  `YYYY-MM-DD`（ohlcv と同一書式）。`undefined` だけが省略扱いで、
  `null`・非文字列・空文字列は不正。
- 不正フィルタは REST 400（`invalid_data_type` / `invalid_series` /
  `invalid_range`）、MCP は `isError`。
- 返却データ側の未知種類・非文字列・`series` 欠損は成功扱いしない。
  REST 500、MCP は `isError`。`series` の `?? {}` 黙殺はしない。
  系列の各 point は非 null オブジェクトかつ `d: string YYYY-MM-DD` で、
  1件でも外れたら日付 filter の前に失敗する（既知の空系列は正常 empty）。
- filter 検証は取得より前。不正 filter はオブジェクト欠損時も 404 に、
  壊れ payload 時も 500 に変化せず 400 / `isError` を返す。
- MCP の `data_type` / `series` の enum は3種（`jpx_margin` 含む）。
  説明文で日証金の貸借と JPX の信用を区別する。

## Release 2026-09-30

Public/private redeploy (nullable adj factor + standalone): health/licenses 200,
private nokey 401, 100% active.

- public `9b6d5c8c-70f6-4b8f-9733-dca97fc726b8` exit 0 — `/health`・licenses 200。
- private `b48fdc77-45d6-4d15-b94c-cc95e80b1e3d` exit 0 — `/health` 200、
  無キー 401 `unauthorized` (unauth 契約どおり)。
- 各 ONE deploy (`--keep-vars`, OAuth 正規 account)。再実施なし。

### 日次JPX信用残・逆日歩の実体

内部面だけが既存 `vwap-data` を `VWAP` として参照する。`jpx_margin` は
`margin/dates.json` と `margin/daily/<基準日>.json` を検証し、株数 `shares` と
円金額 `amounts`、一般/制度別の買残・売残を原定義のまま返す。
`loan_bal` / `stock_bal` への置換はしない。`source` は原本SHA・保管ページ・
基準日・公表日を含む。元snapshotに取得時計がないため `fetched_at` と、
JPX単独seriesの `updated` は `null`。公表日を取得時計に転用しない。

JPX時系列は基準日indexの新しい順20日で区切る。`meta.cursor` が非nullなら
次回に同じ `series` / `from` / `to` と `cursor=<その値>` を渡す。
REST/MCPは共通readerを使用し、終端は `cursor: null`。
種類省略の混在応答ではJSFも同じ日付窓へ絞り、ページ間で同日を重複させない。
4文字コードに加えJPX原文の5文字コードで種類株等を区別できる。
日付は実在する暦日、cursorは同じJPX基準日indexに存在する値のみを受け付ける。
indexは128KiB、日次snapshot/既存JSF seriesは8MiB、日次明細は10,000行を上限に、
bodyを読みながらsize・総計・銘柄同定を検証する。超過/破損時は部分成功にしない。

`jsf_shina` latestは定期 `supply_daily` が保存する全体CSVを、既存D1原本索引から
1SELECT＋RAW 1GETで読み、全bytes SHAを照合してCP932をfatal復号する。
貸株超過株数・最高/当日/前日料率・品貸日数・備考・制限・応札倍率・取引所を
返す。同一コードの取引所を集約せず、`limit` は明細行数である。
実保存CSVの2行目注記に従い、最高/前日料率は1日1株・口当り、
当日料率は品貸日数を乗じた元値として返し、単日料率へ換算しない。
掲載対象外コードの不在を逆日歩0とは解釈しない。空欄/マスクは `null`。
基準日はCSVの貸借申込日、原本取得時計は `source.first_fetched_at` /
`last_fetched_at`（Unix秒）、索引日付は `index_data_date` として区別する。
時系列は同じ定期producerの既存 `jp-stock-supply` を参照し、貸借残高とは別定義を保つ。
追加の外部データ取得・複製・新しいDB列・公開面のbindingはない。
