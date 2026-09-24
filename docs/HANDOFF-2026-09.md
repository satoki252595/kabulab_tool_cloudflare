# 引き継ぎ文書（2026-09）: kabulab-cf 側の抜粋

本体は stockStock の [`docs/HANDOFF-2026-09.md`](https://github.com/satoki252595/stockStock/blob/main/docs/HANDOFF-2026-09.md)（台帳の公開版 `docs/HANDOFF-2026-09-LEDGER.md` も同じ場所）。
背景・台帳 68 件の全表・不変条件 A〜J の全文・実装計画（ウェーブ割り）・残タスクと判断待ち・チェックリストはそちらにある。本文書は kabulab-cf に関わる **決定・修正内容・本番手順・不変条件 C/D/G/H** だけを抜く。台帳 ID（L-xx）と不変条件 ID（C1〜H3）は本体と同じ。

## 1. kabulab-cf に関わる決定

| # | 日付 | 決定 | kabulab-cf で変わること |
|---|---|---|---|
| D-13-6 | 2026-09-13 | 公開面（スクリーニング・検索・一覧）から ETF・REIT・出資証券を外す。`instrument_type` は条件にだけ使い値は出さない | 述語は `src/shared/db/active-equity.ts` の 1 か所（#30）。`active-equity.ts` の「承認待ち」2 点はこれで回答済み（L-68 で記述を消す） |
| D-13-7 | 2026-09-13 | 非普通株 9 銘柄（reit_fund 8 / investment_certificate 1）を D1 から削除（16 表・1,058 行、実行済み） | 退避と戻し方は運用者の非公開手順書（Time Travel の保持は 2026-10-13 頃まで） |
| D-13-8 | 2026-09-13 | 取込（TDnet / EDINET）の母集団は案 B = `equity OR (is_active=0 AND instrument_type IS NULL)` | `ingestUniverseCondition()`（#31）。地域取引所単独上場の開示は取り込み続ける |
| D-13-10 | 2026-09-13 | 両リポ全般をリファクタリング。**D1 の構造を変えてよい**。本番 DDL は バックアップ → マージ → 手動 migration の順 | finmath 2 表 DROP（#26）が前例 |
| D-14-1 | 2026-09-14 09:30 JST | 移行計画 P4b〜P8 は中止。**銘柄マスタ・日足・③断面の writer は TS 側に固定** | `universe.ts` / `daily.ts` は writer のまま。P4b 第 2 段（非普通株 +733 行の INSERT）・詳細ページ 404・NULL 書換停止の判断は不要。`instrument-type.ts` の stockStock `universe_guards` への参照コメントは「共有文字列 'equity'」に書換 |
| D-14-3 | 2026-09-14 | 公開面の変更を許容: CSS 統合・Noto Sans JP 外し・rsi JSON API 2 本の撤去・EDINET 由来のみのページへの 5 分キャッシュ・zod/mini 移行 | L-59 / L-61 / L-43 / L-62 を実施。personal-only 値を含むページには public キャッシュを付けない |
| D-14-4 | 2026-09-14 | prettier は今も使っているので残す | L-39 の依存撤去から prettier を除く |
| D-14-5 | 2026-09-14 | stockStock の `prices_daily` を廃止 | D1 `core_stock_financials` の writer は `daily.ts` のまま（変更なし）。stockStock の鮮度データセットの writer 表記が `kabulab-cf daily.ts` に直る（L-27） |

恒久の制約（本体 §2.2）: ランニングコストを増やさない（PR に「コスト影響」節、実測必須）、新 cron / workflow 禁止、PUBLIC のまま、ライセンス境界（JPX・Yahoo・日証金 = personal-only、みんかぶ = no-store〔リポジトリ・Notion・Issue/PR・ログに保存せず、公開面に本文を再掲しない〕、TDnet = factual-cite、EDINET = commercial-ok。公開面の業種は EDINET 由来の 33 業種）、実在銘柄コードと区分の対応・掲載文を commit / PR / Issue に書かない（テストの合成コードは 1000〜1299）。

## 2. 修正する内容（kabulab-cf 30 件 + 両リポ 3 件 = 33 件）

状態: 実施 / 見送り。効果は台帳の推定（実測 2026-09-11〜14）。「本番」= §3 の手順番号。

| ID | 題名 | 何をするか | 本番 | 状態 |
|---|---|---|---|---|
| L-36 | 地図 `d1-license-map.json` を kabulab-cf にも同一バイト列で置き、`public-columns.test.ts` で `PERSONAL_ONLY_COLUMNS` と突合、`ci.yml` を 2 ファイル突合に | 両 main 同時マージ（K6） | K6 | 実施 |
| L-37 | 「[ジョブ失敗] Issue 1 本」を `.github/actions/notify-failure`（composite）に寄せ、Issue 探索を完全一致 jq に | catchup / stock-sync / vwap-ingest の 3 箇所 | — | 実施 |
| L-38 | 到達しない一度きりスクリプト 7 本と `yuho:investigate` を削除 | `export-benefit-descriptions.ts` / `fetch-yutai-full.ts` は残す | — | 実施 |
| L-39 | Neon 期の drizzle config 4 本・移行 SQL 15 本・scripts 12 本・`DATABASE_URL`・`@neondatabase/serverless` / `vercel` / `@hono/node-server` を撤去 | prettier は残す（D-14-4）。Neon 解約済みかは未確認 | — | 実施 |
| L-40 | `drizzle/d1/meta` の旧 snapshot 0000〜0011（26,822 行）を `git rm` | `_journal.json` と最新 snapshot は残す | — | 実施 |
| L-41 | otakara の未マウント middleware 2 本・旧 v1 スクレイパ一式・`core-repo.ts` を削除 | `yutai-stock-universe.test.ts` は契約 2 だけ残す | — | 実施 |
| L-42 | VPN ローテーション・`build_stocks.py`・`openvpn`・`sw.js`・`r2Delete`・重複 script を削除 | **`stocks.json` は触らない**（G3、本体 §8.2 U3） | — | 実施 |
| L-43 | rsi-screening の JSON API 2 本を撤去 | `/rsi-screening/api/screening` と `/api/stocks/:code` は 404 に | — | 実施 |
| L-44 | 互換シム 3 つ（yuho `metric=backlog`・otakara `?sort=&order=`・Notion 旧フラット DB 退避）を撤去 | Notion 側を目視確認してから | K5 | 実施 |
| L-45 | 冗長索引 4 本（同一列に UNIQUE + 通常索引）を DROP | `core_stock_financials(stock_id)`・otakara 2 表・`ir_disclosures(tdnet_id)` | K2 | 実施 |
| L-46 | 読み手の無い索引を DROP（swing 2 本・ir 2 本・`idx_rsi_percentile_min`） | L-48 で rsi の JOIN 順を直すなら `idx_rsi_percentile_min` は残す | K2 | 実施 |
| L-47 | 日次 sync の `swing_daily_ohlcv` フルスキャン 3 本を消す（Phase 6 投影は Phase 3 のメモリから、Phase 1 は `latest_date` LEFT JOIN、Phase 4 sweep は月曜のみ・同 run 内分岐） | rows_read 月 −約 2,000 万。`/emh` の数値は不変 | — | 実施 |
| L-48 | rsi / swing / emh の JOIN 順を派生表外側に固定 | EXPLAIN で確認。rsi 16,430 → 約 1,500/表示 | — | 実施 |
| L-49 | annual の毎日 15,900 行 upsert を週 1、TDnet 7 日窓 upsert を差分更新に | DDL なし。rows_written 月 −30 万 | — | 実施 |
| L-50 | ir-catalog の「高シグナル最新 25 件」を部分索引で | `CREATE INDEX … WHERE primary_tag IN (…)`。12,485 → 約 50/表示 | K2 | 実施 |
| L-51 | 投影表 `p_yuho_growth`（EDINET catchup の末尾で再生成、新 cron なし）、otakara scores に権利月・ジャンル集計列 | 表数 +1 は stockStock の地図を先に。地域バケット比率 4 列は投影に持つ（2026-09-14 決定） | K2 | 実施 |
| L-52 | `swing_stock_screening` を indicators の列に畳んで DROP、signals の無条件 DELETE を sweep 1 文に | 表 DROP は stockStock の地図を先に。取得失敗銘柄の前日シグナルは消す（鮮度のない値を出さない。2026-09-14 決定） | K2 | 実施 |
| L-53 | サロゲート id の撤去（1 銘柄 1 行の表）・`swing_sector_daily` 保持 30 日・`pct_5d` DROP・`operating_margin_ttm` 解消 | 表の作り直し SQL を手で読む。L-45 の後 | K2 | 実施 |
| L-54 | `otakara_stock_financials` 廃止 | 読取 +1,600/表示で制約に触れる | — | 見送り |
| L-55 | `swing_daily_ohlcv` 廃止（R2 日足を Worker から読む） | L-47 で十分。日足が最大 2 営業日古くなる | — | 見送り |
| L-56 | D1 REST 書込を表ごとの multi-row upsert に（案 A、DDL なし） | `/query` の複数文+params 可否を先に確認。日次 −12〜18 分 | — | 実施 |
| L-57 | stock-sync の失敗率 52% を下げる（回収を時間予算制、失敗率 ≤1% は成功 + Issue コメント、vwap の 404 は即 throw） | — | — | 実施 |
| L-58 | VWAP 母集団変更・日足二重取得の統合・5 分足シャード化 | 外部読者（G3 / G4）と衝突。`stocks.json` の判断と一緒に別途 | — | 見送り |
| L-59 | zod classic → zod/mini（20 ファイル） | `@hono/zod-validator` が mini を受けるか 1 ルートで先に確認 | — | 実施 |
| L-60 | Yahoo 取込プロキシ 2 系統と Yahoo クライアント 2 実装を 1 系統に、error-handler を `src/shared` に 1 本化、`core-schema` re-export シム撤去 | `YAHOO_PROXY_BASE` はパスだけ切替 | — | 実施 |
| L-61 | 7 ページ重複の layout CSS を `design.ts` に統合、Noto Sans JP を外す | 外部 CSS −459 KB/ページ | — | 実施 |
| L-62 | SSR 一覧に `Cache-Control`（EDINET 由来のみのページ、5 分）、`public/_headers`、`lightweight-charts` を同梱 | — | — | 実施 |
| L-63 | vitest 2 回実行を 1 回に、テストの migration 適用を `/^\d{4}_.*\.sql$/` に限定、lint 98 warnings をゼロに | `test:coverage` を残すかは未確認 | — | 実施 |
| L-64 | `SECTOR_DAILY_PUBLIC_KEY_SINCE` と日付ガードを、`swing_sector_daily` の 2026-09-14 未満の行を DELETE した上で撤去 | `PUBLISH_JPX_DERIVED_COLUMNS` は残す | K3 | 実施 |
| L-65 | ADR-0001 を 5 行要約に、README / overview / portal / deploy / drizzle README の経緯・誤記（vwap は月水金、Actions 4 本、サービス 7、Neon 節）を直す | Workers プランの記述は未確認（本体 §8.2） | — | 実施 |
| L-66 | docs/00N の関数名誤り・PR 記録・未追随機能を直す。`ci-typecheck-blind-spots.md` を 30 行に、rsi `docs/` と `final-quality-report.md` を削除 | — | — | 実施 |
| L-67 | サービス別 CLAUDE.md / README / docs/00N の三重化を 1 本に。CLAUDE.md ルール4（`.claude/agents` 不在）削除、ルール5 を「PR を作る」に。`AGENTS.md` の `.claude/agents` 参照も書換 | — | — | 実施 |
| L-68 | 経緯コメント約 1,000 行を現在形に圧縮。実装と食い違うコメント 6 箇所（`monthly.ts` 冒頭、`/api/cron/sync-*` 参照ほか）と死 URL の User-Agent 3 箇所を訂正 | — | — | 実施 |

台帳外（残タスク精査由来、本体 §5.8）: X-01 `yutai_benefits.estimate_value_source` / `estimate_source_url`（本番 0 行）と「WEB推定」UI の削除（DROP COLUMN は K2）、X-05 `ingestUniverseCondition` の命名、X-06 地図の `core_stocks.name` 出所と `universe.ts` の不一致、X-07 ライセンス系テストが `public/` を走査しない穴、X-10 `swing_sector_daily` 2026-09-11 の「機械」行欠落（不具合確認）。**2026-09-25 訂正**: X-01 の「本番 0 行」は `estimate_source_url` のみ正しい。`estimate_value_source` は 50 行が非 NULL の現役列と判明したため DROP せず、DROP したのは `estimate_source_url` だけ（詳細は HANDOFF-2026-09-stock.md の X-01 行）。

先行 PR（2026-09-14 01:19〜01:20 UTC に squash マージ済み）: #32 要約取込 dry-run の掲載文断片漏れ、#33 wrangler ログを既定で書かない、#34 共有テストの実在コードを合成コードへ置換（stockStock #57 と §3 K6 の順でマージ。両 main の共有ベクタは blob sha 一致、両 CI 緑）。

## 3. 本番で人が行う手順

| # | 何を | いつ | どう検証 | どう戻す |
|---|---|---|---|---|
| K1 | **優待要約の取込**（経路は本体 §8.2 U1 で判断）: 結果 JSONL を `services/otakara-yutai/data-scripts/data/summary-tasks/`（gitignore 済み）に置く → `pnpm yutai:summary:import --tasks services/otakara-yutai/data-scripts/data/summary-tasks/tasks-2026-09-13-violations.jsonl --results <結果>`（dry-run。手元の `.env` に D1 Edit 権限の `CLOUDFLARE_API_TOKEN` が要る）で「60 タスク / 85 行・はじいた 0」→ `--apply`。stockStock の `yutai_backup` を前後に流す | **`yutai_benefits` の列変更（X-01）と `pnpm sync:monthly` より前**（内容キーが変わると 60 件が全滅） | `short_summary` 列だけの契約違反集計が 0。公開面のカードで 1 行表示 | はじかれた行は前の値のまま。dry-run / apply の出力を Issue / PR / Notion に貼らない |
| K2 | **D1 DDL**（1 PR ずつ）: 対象をユーザーに示す → Time Travel の bookmark を控える → PR マージ → `pnpm db:generate:d1` の SQL を読んでから `wrangler d1 execute kabulab-cf --remote --file=…` → `sqlite_master` / EXPLAIN / stockStock の `ops_check` 緑（stockStock 側で `gh workflow run ops_check.yml` を dispatch すれば即時。定時は 14:30 UTC）。対象: L-45 `DROP INDEX` ×4、L-46 `DROP INDEX` ×4〜5、L-50 部分索引 CREATE、L-51 `CREATE TABLE p_yuho_growth` + scores に 2 列、L-52 indicators に列 ADD → `DROP TABLE swing_stock_screening`、L-53 表の作り直し + `DROP COLUMN` ×2、X-01 `DROP COLUMN` ×2 | 各 PR マージ直後、**21:00 UTC の日次 cron（stock-sync）より前**（`assertDailySchema` が未適用 migration で失敗する。間に合わなければ適用後に `gh workflow run stock-sync.yml -f target=daily`）。**表を足す/消すものは stockStock の地図（`TABLE_LICENSE` / `RETIRED_TABLES` / `d1-license-map.json`）を先に main へ** | `ops_check` の表数照合（現在 29）が緑 | Time Travel（**DB 全体が戻る**。戻した後は失われた時間帯の cron を dispatch で書き直す。表単位なら事前の export / JSONL から） |
| K3 | **`swing_sector_daily` の `date < '2026-09-14'` を DELETE**（L-64） | 2026-09-14 分の日次 cron が 34 行（33 業種 + 未分類）を書いたのを確認した後 | `SELECT date, COUNT(*) FROM swing_sector_daily GROUP BY 1` が 09-14 以降だけ。`/swing-trading/` に業種ランキングが出る | Time Travel（DB 全体。K2 と同じ注意） |
| K4 | **`stocks.json` の生成経路**（本体 §8.2 U3 で (B) を選んだ場合）: `scripts/vwap/build-stocks.ts` で D1 の active∧equity から `[code,name]` を月次生成して commit、取込 `loadCodes()` は「R2 `daily/` 既存キー ∪ D1」に切り離す。外部リポの参照先切替と旧 vwap リポの `build-stocks.yml` 停止はユーザー作業 | 判断後 | `vwap-ingest` を dispatch して summary の codes が 4,44x、日経225 連動 ETF の `daily/` が更新される | revert |
| K5 | **Notion 旧フラット DB の目視確認**（L-44）: 「バックアップ」配下に `適時開示｜ir-catalog` が無いこと | L-44 マージ前 | 目視 | — |
| K6 | **契約ファイルの 2 リポ同時マージ**（#34 / #57、L-36、以後の契約変更すべて）: 両 PR を同時 open → **kabulab-cf 側を先に squash** → stockStock 側の `cross-repo-contract` を Re-run → マージ → kabulab-cf main の失敗 run を Re-run。ブランチ保護は無い（2026-09-14 実測）ので赤のままマージしない | 契約を変えるとき | 両 main の `tests/fixtures/contracts/*.json` の blob sha 一致、両 CI 緑 | revert を同じ順で |

## 4. 壊してはいけない不変条件（C / D / G / H。全文は本体 §4）

### C. ライセンス境界（実効防御）
- **C1** `public-columns.ts`: `PUBLISH_JPX_DERIVED_COLUMNS=false` は 1 箇所のみ、`publicMarketColumn=NULL`、`publicSectorColumn=sector33`、`sector` へフォールバックしない。`SECTOR_DAILY_PUBLIC_KEY_SINCE` は一時ガードで K3 の後に撤去（L-64）。
- **C2** `core-stocks-license-boundary.test.ts` の 5 検査はパス・識別子ベース（`PUBLIC_SURFACE` 12 ファイル、`*[Ss]tocks` 接尾辞）。公開面ファイルの移動/改名は `PUBLIC_SURFACE` と `source-scan.ts` を同時更新。`public/` は走査対象外（X-07）。
- **C3** `activeEquityCondition()` は WHERE/ON のみ・select しない。`instrument_type` の書き手は `universe.ts` だけ、修飾参照は `universe.ts` と `active-equity.ts` だけ。取込は `disclosureIngestCondition()` (X-05 で改名)。
- **C4** `yutai_benefits.description`（出典サイトの掲載文）は公開面 `app.ts` で `name="description"` と `g.description` 以外に出さない。`src/routes`・`src/views` は存在してはならない。D1 の SELECT でも `description` を引かない。
- **C5** 業種集計は分母・分子 `activeEquityCondition`、キー `sector33`、カバレッジ <90% で書かない、当日分のみ delete→insert。
- **C6** `notion-archive` は ir-catalog 公開ページの `fetchPageFileUrl` が使う（消すと PDF リンクが死ぬ）。L-44 で消すのは旧フラット DB 退避コード（`archiveFlatDbOnce` / `obsoleteFlatTitle`）だけ。
- **C7** 公開 GET / 計算 POST は D1 に 1 文も書かない。`/emh?type=momentum` は `p_momentum` だけを読む。`p_momentum` に列を足さない。

### D. 母集団ガード
- **D1** `assertUniverseCoverage` (a)(b)(c)(d1)(d2) と定数 4 つ（`src/cron/universe.test.ts` 31 本、2026-09-14 実測）。(c) の分母は equity、部分充填は縮退。stockStock 側の対向 `test_universe_guards` は D-14-1 で撤去されるので、**このテストが唯一の固定**になる。
- **D2** `instrument_type` 語彙 6 値の正本は `src/shared/jpx/instrument-type.ts`、equity は `isListedEquity` と完全一致。
- **D3** `planInstrumentTypeUpdates` は行を増やさない・対象外化行は書かない・全計画後に書く。`UPSERT_CHUNK=16`。
- **D4** JPX 取得は `.xlsx`（`.xls` は 404）。月次 rebuild は active∧equity∧is_yutai。

### G. R2 契約と外部読者
- **G1** `vwap-data`: `daily/{code}.json`（`bars[].date,o,h,l,c,v,adj` / `splits`）、`intra/{code}.json`、`margin/{date}.json`（rows はちょうど 5 キー）、`weeks.json`（素の配列）は「1 バイトも変えない」。`/api/daily` `/api/intra` は素通し、`/api/margin` は行スプレッド → 運用メタをオブジェクトに入れない。
- **G2** `margin/` は削除しない、`weeks.json` を空にしない。`r2Delete` は呼び出し元 0（L-42 で撤去）。
- **G3** `daily/` の母集団は `public/vwap-analysis/data/stocks.json`（4,445 件・全種別・2026-06-18 凍結）であり `core_stocks` ではない。**日経225 連動 ETF 1 本の更新継続が外部読者（別リポジトリのブレイク検証）の前提。** K4 で取込母集団を D1 に切り替えるときは「R2 既存キー ∪ D1」にして非普通株のキーを落とさない。
- **G4** 別リポジトリ（動画制作用）が `daily/intra/margin` を R2 直読し、D1 REST で `core_stocks` / `core_stock_financials` / `core_stock_annual_financials` / `yuho_*` / `ir_disclosures` / `rsi_percentile` を読む。**列追加は耐える、改名・削除は壊れる**（L-52 / L-53 / L-54 の判断に効く）。
- **G5** `jp-stock-supply` と `jp-stock-raw` は stockStock の契約（本体 §4 G5）。kabulab-cf の Worker は bind しない。

### H. 公開 Worker
- **H3** `/api/ingest/yahoo` は `CRON_SECRET` + ホスト allowlist、Node 同期は `YAHOO_PROXY_BASE` 必須。Yahoo 429 サーキットブレーカと `stockStartGate`。L-60 で 2 系統を 1 つに寄せてもこの認証は変えない。
- H1 / H2（stockStock の `jss-api-public` と MCP）は本体参照。

## 5. テスト・作法（要点）

前提（手元に要るもの）: `pnpm install --frozen-lockfile`（devShell の node 22 / pnpm 9）。D1 の SELECT・手動 migration・要約取込には `.env` の `CLOUDFLARE_API_TOKEN`（D1 Edit）/ `CLOUDFLARE_ACCOUNT_ID` / `D1_DATABASE_ID`（`wrangler.toml` の値）。R2 の確認には R2 読取権限つきトークン。

```bash
nix develop -c pnpm typecheck && nix develop -c pnpm lint && nix develop -c pnpm test
nix develop -c pnpm db:generate:d1 && git status --short drizzle/d1     # 変更が無いこと
```

- PR 本文に「コスト影響」（D1 rows_read / rows_written を `wrangler d1 execute --remote --json` の `meta.rows_read` で実測。被覆索引では rows_read は下がらない）、「不変条件」（触れる ID とテスト名）、「本番手順」（§3 の番号）を書く。
- 実装は Sonnet、マージ前に反証レビュー（別担当がコード・`gh`・D1 の SELECT で主張を確かめる）、マージはユーザーの合図で squash。
- 題名は `type(scope): 日本語の要約`。`Co-Authored-By` トレーラーを付ける。CLAUDE.md のルール4（`.claude/agents` の多角精査。ディレクトリは存在しない）は L-67 で削除し反証レビューは本体 §6.4 に一本化、ルール5（push 必須）は「PR を作る」に書き換える。
- 実装の順序は本体 §6.6 のウェーブ割り（kabulab-cf は K1〜K6）。
- 実在銘柄コードと区分の対応・掲載文・秘密・ローカルパスを commit / PR / Issue に書かない。合成コードは 1000〜1299（#34 の静的ガードが allowlist 外の 1300 以上を拒む）。
