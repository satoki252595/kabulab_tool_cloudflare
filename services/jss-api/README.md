# jss-api — 配信 Worker

正本（R2 + D1）を REST と MCP で読むための Cloudflare Worker。**読み取り専用**
（唯一の例外は内部面の鮮度 upsert）。設計は [docs/CF-CANONICAL-DESIGN.md](../../docs/CF-CANONICAL-DESIGN.md)。

## Worker は2本

| Worker | 用途 | bind | 認証 |
|---|---|---|---|
| `jss-api-public` | 公開 REST。`commercial-ok` 全量と `factual-cite` のメタのみ | `DB` / `RAW` | 無認証 |
| `jss-api-private` | 内部 REST + **MCP**。`personal-only` を含む全量 | `DB` / `RAW` / `SUPPLY` | APIキー必須 |

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
