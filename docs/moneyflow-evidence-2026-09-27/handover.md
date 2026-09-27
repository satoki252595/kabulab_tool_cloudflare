# 「お金の流れ」クラウドセッション引き継ぎプロンプト (2026-09-27 12:40 JST作成)

以下を Claude のクラウドセッションにそのまま貼って開始してください。

---

あなたは kabulab-cf リポジトリで、個人用「お金の流れ」ダッシュボードの Phase 2〜5 組み込み作業を引き継ぎます。前任セッションは週次クレジット上限に達して停止しました。作業ツリーはすべてリモートに push 済みです。

## 前提

- リポジトリ: `satoki252595/kabulab_tool_cloudflare`、ベースは `main` の `bae3ae7` です。`git fetch origin` してから始めてください。
- 開発ルールの正本は `CLAUDE.md` です。最初に読み、絶対ルール (1: ダミーデータ禁止、2: フォールバック禁止、3: 環境変数は型付きアクセサ経由、5: main 直 push 禁止・PR でマージ、6: 一次データは `src/shared/notion-archive/` 経由で Notion にアーカイブ、7: UI 専門用語に `src/shared/term-tip.ts` のバルーンヘルプ) に必ず従ってください。

## 引き継ぐブランチ (全18件、origin に push 済み・ローカルと一致確認済み)

土台:

- `feat/moneyflow-phase1` — Phase 0/1 実装 (R1 東証33業種: `jpx-sector-marketcap` / `jpx-short-selling` / `sector-turnover` + `scripts/moneyflow/ingest.ts` 取込)。反証レビューの確定指摘の修正までコミット済み (`ae05c41`)。`services/moneyflow` の 28 テストは全 pass 確認済み。

取得元部品 (17件、各ブランチに取得+パーサ+テスト):

- `feat/moneyflow-src-jpx-investor-equity` (株式・投資部門別)
- `feat/moneyflow-src-jpx-investor-etf-reit` (ETF・REIT 月次)
- `feat/moneyflow-src-jpx-derivatives-investor` (先物・オプション投資部門別)
- `feat/moneyflow-src-mof-portfolio-flows` (財務省・対外対内証券)
- `feat/moneyflow-src-bop-regional` (国際収支・地域別)
- `feat/moneyflow-src-imaj-fund-flows` (投信協会・公募投信/REIT) ※検証指摘ゼロ
- `feat/moneyflow-src-jsda-bonds` (公社債・発行/償還)
- `feat/moneyflow-src-boj-flow-of-funds` (日銀・資金循環)
- `feat/moneyflow-src-ffaj-otc-fx` (店頭FX月次)
- `feat/moneyflow-src-tfx-click365` (くりっく365) ※下記の運用判断のみ残
- `feat/moneyflow-src-jvcea-crypto` (JVCEA 暗号資産)
- `feat/moneyflow-src-coingecko-global` (CoinGecko グローバル)
- `feat/moneyflow-src-cftc-cot-jpy` (CFTC COT 円・日経先物)
- `feat/moneyflow-src-imf-cpis` (IMF CPIS) ※検証指摘ゼロ
- `feat/moneyflow-src-bis-banking` (BIS 国際銀行統計)
- `feat/moneyflow-src-worldbank-marketcap` (World Bank 時価総額)
- `feat/moneyflow-src-global-indices` (Phase 5 世界の概況: 指数・為替・金利・金・原油)

## 検証・修正の状態 (重要)

- 17件の実データ照合で計35件の問題が見つかり (15件の部品に分布)、コード修正が必要な14件はすべて各ブランチに fix コミット済みです。
- `ffaj-otc-fx` の fix (`d7662b5`) は停止時に未コミットだった作業を引き継ぎ者がコミットしたもので、**修正後の再検証 (テスト + 最新公表値との突き合わせ) は未実施**です。最優先で再検証してください。
- `tfx-click365` の残り1件はコードの問題ではなく「TFX サイトの商用利用可否が未確定のまま personal-only 運用を仮定している」(severity: low) という運用事項です。コード修正は不要ですが、本番投入前に TFX への個別確認か、公開経路からの除外設計のレビュー確認が必要です。
- 他13件の fix についても、修正ワークフローが上限到達で中断されたため**再検証の完了証跡がありません**。組み込み前に、各ブランチで (a) 同梱テストの実行 (b) 最新公表値との突き合わせ、の2点を必ずやり直してください。
- 検証証跡は `docs/moneyflow-verify-evidence` ブランチに push 済みです (`git fetch origin` で取得)。`docs/moneyflow-evidence-2026-09-27/` 配下に全17部品の検証結果正本 (`results/claude-mf-sources.json`: 35件の問題の詳細)、修正対象一覧 (`results/claude-mf-fix-targets.json`)、各部品の検証スクリプト (`scripts/`)、検証時の実ダウンロードファイル (`raw/`: FFAJ xls / JVCEA PDF / 日銀 xlsx / 各種 HTML)、検証ログ (`logs/`)、一時フィクスチャ (`fixtures-tmp/`) が入っています。再検証の際の問題内容の参照元として使ってください。なお前任セッションの作業フォルダ (`.claude/worktrees/`) 自体はローカル専用ですが、中身は上記18ブランチと同一なので不要です。

## 既知の不具合・制約

- `feat/moneyflow-phase1` の `scripts/moneyflow/ingest.test.ts` は vitest の include (`services/**`, `src/**`) 対象外のため `pnpm test` で実行されません (純関数自体は tsx スモークで動作確認済み)。テストが走る配置への移動か include 拡張をしてください。
- JPX 様式変更の予告あり: 投資部門別は 9/29、ETF・REIT は 10/13。変更日以降は部品が失敗検知する設計なので、新様式の実ファイルが出たら対応が必要です。
- 信用残は 9/28 16:00 の初回公表後に着手予定 (未着手)。
- CoinGecko 無料 API にキーが必要な場合は、ユーザに Demo キー取得の依頼が必要です。
- IMF・BIS・World Bank は「残高」であり流れそのものではないため、定義に「近似」と明記する方針です。

## やること (順序)

1. `feat/moneyflow-phase1` をチェックアウトし、テストが緑であることを確認。`ingest.test.ts` の実行対象問題を修正。
2. 17部品を各ブランチで再検証 (テスト + 最新公表値との突き合わせ)。`ffaj-otc-fx` から開始。
3. 全17部品を Phase 1 土台に組み込み (`scripts/moneyflow/ingest.ts` の SOURCES 追加、Notion 指標定義・取り込み処理への接続)。
4. 全体テストを緑にし、ルール5に従い PR を作成 (main への直 push は禁止)。

## ユーザへの確認事項 (Notion 連携に必要)

- Notion の「資金フロー (個人用)」ページの URL が未受領です。DB 作成と初回取り込みを進めるにはこれが必要です。作業開始時にユーザへリクエストしてください。
