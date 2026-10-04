# jp-stock-data-pipeline

日本株のファンダメンタルズ・テクニカル情報を無料ソースから継続収集し、Notion「株式情報」配下に銘柄コード単位で構造化格納するパイプライン。設計の正本は [docs/DESIGN.md](../docs/DESIGN.md)。

## 開発環境 (nix 必須)

```bash
nix develop          # Python 3.12 + uv
uv sync              # 依存解決
uv run pytest        # テスト
```

## セットアップ

1. Notion インテグレーションを作成し、親ページ「株式情報」に接続（コネクト追加）
2. P0: スキーマ作成（冪等。DB ID を `db_ids.json` に出力）

   ```bash
   NOTION_TOKEN=secret_xxx uv run python -m jp_stock_pipeline.notion.schema
   ```

3. GitHub Secrets を設定: `NOTION_TOKEN` / `EDINET_API_KEY` / 各DB ID（`NOTION_DB_*`、`db_ids.json` の出力値）

## ジョブ（GitHub Actions cron / 手動実行可）

| ジョブ | 実行 |
|---|---|
| 銘柄マスタ同期 | `uv run python -m jp_stock_pipeline.jobs.master_sync` |
| TDnet開示 | `uv run python -m jp_stock_pipeline.jobs.tdnet_hourly` |
| EDINET書類 | `uv run python -m jp_stock_pipeline.jobs.edinet_daily` |
| 需給日次 | `uv run python -m jp_stock_pipeline.jobs.supply_daily` |

全ジョブ `--dry-run` 対応（Notion に書き込まない）。

### 原本から財務の期末・連結区分・中間期を再検証

2026-09-28 に、年度末 DEI を四半期末として使う経路、配当/メタ情報の既定連結が
単体実績を上書きする経路、EDINET `InterimDuration` を当期実績に含めない経路を
確認しました。③をそのまま運ぶだけではこの誤値は直りません。
`scripts/reparse_financials_from_notion.py` は③から⑤の原本をたどり、source・銘柄コード・
SHA256を照合して共有parserで再生成します。既定は **Notion/D1 とも読み取りだけ**です。

```bash
nix develop -c uv run --env-file .env --project pipeline python pipeline/scripts/reparse_financials_from_notion.py --journal /tmp/financial-audit.jsonl
# 先行確認だけなら --code 8154 / --future-after 2026-09-28 / --limit N
# を追加する。サンプルは全件合格として扱わない。
```

⑤をsource/データ基準日/原本種別で一括queryし、Notion APIは既定2.5rps、
保存済みファイルは4接続を再利用して並列取得します。ファイルはstreamで圧縮64MiB、展開128MiBを
上限とし、超過・ハッシュ不一致・期末/連結区分未確定は失敗をjournalへ残します。
期限付きファイルURLはログやjournalへ出しません。原本をSHA名でcacheし、同じ
journalで再実行すると成功済みを省略し、失敗だけ再試行します。
parserのSHAも記録し、parserが変わった場合は旧成功を省略せず全件を再解析します。
原本cacheを使うため同じファイルを再ダウンロードする必要はありません。

原本再解析・差分確認とPR/CI/マージを終えてから、`--apply-journal` で **Notion③だけ**を
更新できます。検証済みの部分集合を優先修復する場合も全体合格とは扱いません。
対象コード群の正本を直前にまとめて読み、監査後の変更を検出してから更新→再読し、
成功行だけを `--receipts`（省略時はjournal名の `.applied.jsonl`）へ記録します。
新しい開示を守り、正しい行の再読一致後だけ旧誤キーをarchiveします。

既存D1 322行にも同根の誤値があり得るため、未登録だけを挿入する旧backfillを品質
修正の代わりに実行してはいけません。再読成功の記録を確認後、`--sync-d1 --receipts FILE`
を別実行します。正本を再確認し、監査・再読・最新parserが一致する行だけ設定先D1へ
同期します。監査済みNULLは誤値を消し、新しいD1開示や厳しいライセンスは守ります。
旧キーは同じsource・開示日時・原本hashの行だけ、正しいキーのD1再読後に除きます。
原本不一致の旧キーは件数を明示して保持するため、別途再監査が必要です。

Notion修復→再読→**隔離D1**の同期・選定差分→stagingの順で確認してから本番へ進みます。
`CF_D1_DATABASE_ID` の設定先を必ず確認し、本番の同期は承認済みリリース作業内だけで
実行します。これらは一度きりの修復用で、日次サービスに処理や保存先を追加しません。

### EDINETの対象日（2026-09-11）

`edinet_daily` の既定の対象日は **cron の予定日**であり、起動時刻の JST 日付ではない。予定は毎営業日 21:00 JST（`cron: "0 12 * * 1-5"`）なので、21:00 JST より前に始まった実行は「前日分の遅延実行」として前日を対象にする。GitHub Actions のスケジュール遅延（実測 +3.5h〜+9.5h）で起動が翌日 JST へずれても、対象日はずれない。任意の日を処理するには `--date YYYY-MM-DD` を渡す。

書類一覧の **検証済み0件は正常な空観測**として記録する。[公式API v2仕様書](https://disclosure2dl.edinet-fsa.go.jp/guide/static/disclosure/download/ESE140206.pdf)（2026-06-03更新、本文54頁）は `count=0` / `results=[]` の正常応答を定義している。HTTP 200、要求した日付とtype、成功status/message、件数一致・処理時刻形式を検証し、原本の実体保管・索引保存後にだけ正常終了する。不正応答・保管不明・索引失敗は引き続き非0終了する。

空観測は警告ログと `processed=0 / failed=0` の実行履歴に残し、既存の `ops_check` は直近5実行中3件の成功0件を通報する。SLO・空振り検知のSQL/閾値と過去の失敗履歴は変更しない。その観測で提出が無かったという意味であり、対象日全体の確定や書類収集の鮮度を証明するものではない。

## ローカル API（端末B・任意）

Notion への格納と同時に、別端末（端末B）の PostgreSQL へ dual-write し、
FastAPI(REST + APIキー)で逐次アクセスできる。`LOCAL_DB_HOST` を設定すると有効化
（未設定なら Notion のみ＝従来動作）。接続情報は全て `.env`（[.env.example](.env.example) 参照）。

接続プロファイルは 2 系統で、収集ジョブの `--db-target` で選ぶ（**既定 cloud**）:
- **cloud（既定）**: `LOCAL_DB_HOST` + `sslmode=require`。**クラウド(GitHub Actions 等)から端末B へ格納**。`require` は経路を暗号化するが**サーバ認証はしない**ため直公開は能動的 MITM に弱い → **VPN(Tailscale 等)経由を強く推奨**（VPN を使わないなら `sslmode=verify-full` + ルートCA を設定）。GitHub Actions は同名 Secrets を設定すれば cron 実行で自動 dual-write。
- **lan**: `LOCAL_DB_LAN_HOST`(既定 localhost) + `sslmode=prefer`。同一 LAN で手動実行するとき `--db-target lan`。

- **双方向フェールセーフ**。Notion とローカルへ独立に書き、**片方の保存が失敗してももう片方は必ず試み、どちらか一方にでも残ればその取得単位は成功扱い**（可用性最大化）。設計上の正本は Notion だが、ローカル API の可用性のため対称化。失敗は隠さず `notion_failed`/`mirror_failed` に計上し warning 記録、**両系統とも失敗した分だけ** failed に数える（§3-2）。原本 ⑤ のみ両系統失敗でその取得単位を中止（原本ゼロ＝トレーサビリティ喪失 §3-3）。実行履歴は D1 `jss_job_runs`。
- 株価はローカルでは `(code, data_date)` を主キーに**時系列を蓄積**（Notion の②株価テクニカルは廃止）。
- 株価は personal-only（yfinance/stooq）。**ローカル自己利用に限り、公開しないこと**。

```bash
# 端末B: PostgreSQL に DB/ユーザーを用意（テーブルは初回ジョブ実行時に自動作成）
createuser jp_stock --pwprompt && createdb -O jp_stock jp_stock

# 端末A: クラウド(GitHub Secrets)or .env に LOCAL_DB_* を設定してジョブ実行（Notion と同時ミラー）
nix develop -c uv run python -m jp_stock_pipeline.jobs.edinet_daily                  # cloud（既定）
nix develop -c uv run python -m jp_stock_pipeline.jobs.edinet_daily --db-target lan  # 同一LAN

# 端末B: API を起動（X-API-Key 認証は LOCAL_API_KEY）
nix develop -c uv run uvicorn jp_stock_pipeline.local_store.api:app --host 0.0.0.0 --port 8000
```

| エンドポイント | 内容 |
|---|---|
| `GET /stocks` `GET /stocks/{code}` | ① 銘柄マスタ |
| `GET /prices/{code}?from=&to=` | 株価（時系列・data_date 降順） |
| `GET /financials/{code}` | ③ 財務サマリ |
| `GET /disclosures?code=&doc_type=&from=&to=` | ④ 開示書類 |
| `GET /raw` `GET /jobs` | ⑤原本メタ / ジョブログ |
| `GET /facts?doc_id=&code=&element=&text_only=` | ⑧ XBRL 全ファクト（数値＋定性 textBlock・ローカル専用） |
| `GET /facts/search?q=&code=` | ⑧ 定性 textBlock の日本語全文検索（PGroonga、無ければ ILIKE） |
| `GET /health` | 死活確認（認証不要） / `GET /docs` Swagger UI |

- **⑧ XBRL 全ファクト**は Notion に無いローカル専用の派生ストア。有報/短信 XBRL の全ファクト（事業等のリスク等の定性 textBlock 含む）を保持し横断クエリ＋全文検索できる。`factual-cite`（短信原文）も含むため公開用途では `license_tag` で要フィルタ。
- 全文検索を使うなら端末B で `CREATE EXTENSION pgroonga;`（未導入なら `/facts/search` は自動で `ILIKE` にフォールバック）。

```bash
# 利用例（端末B の IP が 192.168.1.50 の場合）
curl -H "X-API-Key: $LOCAL_API_KEY" "http://192.168.1.50:8000/prices/7203?from=2026-01-01"
# 定性情報の全文検索（例: 為替変動リスクに言及する開示を横断検索）
curl -H "X-API-Key: $LOCAL_API_KEY" "http://192.168.1.50:8000/facts/search?q=為替変動リスク"
```

### 本番サーバ運用（収集=GitHub Actions / サーバ=DB+API）

サーバ上で PostgreSQL + FastAPI を常駐させ、収集は GitHub Actions（cloud 経路）から
**Tailscale 経由**で dual-write する構成。systemd ユニット・PostgreSQL 初期化・日次
バックアップ・Tailscale 接続・GitHub Secrets 配線の手順は
**[deploy/README.md](https://github.com/satoki252595/stockStock/blob/main/deploy/README.md)**（端末 B 用サーバ手順。`deploy/` は stockStock 側に残置）にまとめてある。

## kabuMCPへの原本引渡し（2026-09-05追加・任意）

既存収集後のEDINET type5 CSV ZIPを、kabuMCPの既存パーサが読める `{docID}.zip` でローカルキャッシュへ追加する。Notionの財務要約をもう一度取り出したり、新しいAI・DB・R2・常駐サーバを作る必要はない。

```bash
# 既存全社分を保持した累積キャッシュを指定する。通常の収集ジョブのオプション。
nix develop -c uv run python -m jp_stock_pipeline.jobs.edinet_daily \
  --kabumcp-cache-dir /絶対パス/累積EDINETキャッシュ
```

- 指定なしは従来動作。`--dry-run` は引渡し先にも書き込まない。
- 原本が既存Notion／ローカルの少なくとも一方に保存された後だけ引き渡す。
- EDINET・type5 CSV・`commercial-ok`、docID／原本URL／SHA-256／ZIPを検査。同一原本は変更せず、異内容の既存ファイル・symlink・不正入力は拒否する。
- 非上書きのatomic追加で途中のファイルを見せない。出力はローカルの通常ファイルシステム（hard-link対応）を使う。
- type1 XBRL fallbackはこの連携では未対応。連携失敗・type1スキップはジョブログの部分失敗に計上し、保存済みNotion／ローカルデータは維持する。既存runnerは部分失敗でも終了コード0なので、ジョブログと `kabumcp:` の失敗項目も確認する。
- このオプションによる追加API呼出しはない。ただしコマンド本体の通常収集は実行される。検証目的で過去の日付を何度も再収集しない。
- **日次の差分だけでkabuMCP全社データを再生成しない。** 既存全社分を含む累積キャッシュへ追加し、kabuMCPで索引→既存パーサ→golden／原典照合→既存Cloudflareデプロイの順に進める。
- GitHub ActionsからCloudflareへの常設転送・自動デプロイは今回未配線。既存workflowの頻度・費用・Secrets、Notionの内容は変更していない。
- TDnet・株価はこの経路に流さない。内部タグは商用許諾の証明ではなく、既存trackAにもTDnet財務数値が含まれるため丸ごと公開禁止。TDnetの商用配信条件と株価ベンダー契約を先に確認する。[JPX利用条件](https://www.jpx.co.jp/term-of-use/)

## 重複保存の保護（2026-09-05）

[作業・検証記録 #12](https://github.com/satoki252595/stockStock/issues/12)。既存のキー・原本・財務分類は維持し、再実行と並行保存の安全性を補強した。既存ページの自動削除・統合はしない。

- `save_raw` は同じ命名単位・同じSHAなら一時ファイルも作らず同じパスを再利用し、既存ファイルのinode・mtimeを変えない。異内容は従来のSHA付き別名で残す。一時ファイルを完成後に非上書き公開するため、並行実行でも旧原本を上書きしない。短縮SHA付き別名まで異内容なら保全してエラーにする。
- 原本保存先はhard-link対応の通常ファイルシステムが必要。これは一時ファイルから同じ保存先への公開に使うもので、別プロジェクトの原本とinodeを共有する仕組みではない。新規原本の権限は0600（既存ファイルは変更なし）。定義済みの変換・Notion送信・キャッシュ引渡しは同じ収集プロセスで読み、API／バックアップはPostgreSQLを参照する。別OSユーザーによる原本直接読込を追加する際は権限の運用確認が必要。追加API・DB・有料サービスは不要。
- Notionの作成・追記・File Uploadは、タイムアウト／5xxなどで結果が不明なら自動再送せず、既存の例外・部分失敗経路へ返す。既に作成されたか確認してから再実行すること。検索・照会・プロパティ上書きの再試行と、429/529の`Retry-After`待機は維持する。[Notion公式の再試行方針](https://developers.notion.com/reference/request-limits)（2026-09-05確認）。
- 片系統で保存できれば成功扱いの既存方針は維持。終了コード0だけでNotion保存成功と判断せず、`notion_failed`／`mirror_failed`と警告ログも確認する。応答不明の書込みを自動復旧する機能は追加していない。
- **Notionの全体一意性は未保証**。複数writerの検索→作成の競合は、書込み一本化の運用判断が必要（[#13](https://github.com/satoki252595/stockStock/issues/13)）。財務サマリの主キーが一意でも、古い報告を再実行すると訂正後の値を巻き戻せる既存課題は残る（[#14](https://github.com/satoki252595/stockStock/issues/14)）。どちらも本変更では解消したと扱わない。

## 更新記録

| 日付・時間帯 | 更新者／依頼者 | 目的・変更内容 |
|---|---|---|
| 2026-09-11 JST | Claude Opus 5／satoki252595の依頼 | `edinet_daily` が 2026-08-27〜09-10 の11営業日連続で0件収集していた事故の是正。対象日を起動時刻依存から cron 予定日基準へ変更し、24時間未満のスケジュール遅延を吸収。一覧0件を success で黙って終えず失敗として記録する。収集ロジック・Notionスキーマ・他ジョブ・Secretsは変更なし。 |
| 2026-09-07 JST | Cursor Grok 4.6／satoki252595の依頼 | ②の洗い替えで消える日次テクニカル・バリュエーションを、①銘柄ページ配下の履歴子DBへ毎営業日追記。8,000行で次シャード。③④⑤は子DB化しない。 |
| 2026-09-05 JST | Codex（OpenAI）／satoki252595の依頼 | kabuMCPへの低コスト原本再利用。edinet_dailyに任意のキャッシュ引渡しと安全性テストを追加。通常収集・Notion・workflow・公開範囲は維持。 |
| 2026-09-05 12:15 JST | Codex（OpenAI）／satoki252595の依頼 | EDINETの期中報告を利用するため、一覧収集のみだった訂正四半期（150）・訂正半期（170）をCSV/XBRL財務抽出・任意kabuMCPキャッシュ引渡しにも追加。有報・四半期・半期と各訂正の計6種を既存経路で処理。Notion分類・TDnet・workflowは変更せず、実取得／Notion書込みは未実施。 |
| 2026-09-05 16時台 JST | Codex（OpenAI）／satoki252595の依頼 | 原本の並行上書きとNotion作成後の応答欠落による二重登録を防ぐため、原子的な非上書き保存・安全な再試行分類と障害注入テストを追加。通常のキー・財務内容・workflow設定は維持。AGENTS.mdにユーザー確定のnix／GitHub／専用フォルダ規則を継承。 |

正確な更新時刻・更新者・差分は `git log --format=fuller --stat` を参照。コミット本文にも目的と依頼者を残す。

検証記録: 新規キャッシュ連携テスト11件合格。INPEXの実EDINET原本 `S100XU9L` をkabuMCPへ渡して再解析し、現行JSONの19指標と完全一致。テストと実原本のコピーだけを行い、収集API再実行・Notion更新・本番配信は行っていない。

期中訂正対応の検証: EDINET・ジョブ・キャッシュ関連59件合格、既存の実APIフィクスチャ未取得2件skip、変更ファイルのruff合格。6書類種別の永続化前引渡し禁止と、訂正四半期／訂正半期のtype5優先・type1 fallback・財務保存経路を確認。type1のkabuMCPキャッシュ未対応は引き続き部分失敗として記録する。

一意性補強の検証（2026-09-05）: 全体pytest **502件合格・8件skip**、`ruff check src tests`・差分チェック合格。同内容／異内容の同時保存、同内容再実行の追加書込みなし、短縮SHA別名衝突時の旧原本保持を確認。Notionの通信障害はモックし、作成・追記の送信1回、429/529の待機と再試行、検索・照会・プロパティ上書きの回復、原本送信の既存失敗経路を確認した。実収集・Notion書込み・既存データ削除は実施していない。workflow・Secretsは未変更だが、mainへのpush後の通常スケジュール実行は更新コードを使用する。

## 不変条件

- 取得単位ごとに原本を ⑤原本ファイルDB へ必ず保存（失敗時は構造化データを書かない）
- ダミー・推定・補間データの生成禁止。欠損は欠損のまま
- 全行にソース・ライセンスタグ（`commercial-ok`/`factual-cite`/`personal-only`）・来歴を付与
- yfinance・stooq・JPX統計は **personal-only**（公開・商用利用禁止）

## テストフィクスチャ

実APIレスポンスの保存物のみ使用（捏造禁止）。未取得分は skip される。`scripts/capture_*.py` で取得。

## 免責

本基盤が提供するのは情報のみであり、投資助言ではない。
# stockStock
