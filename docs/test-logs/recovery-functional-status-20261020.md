# 復旧・定期設定の確認 — 2026-10-20

設定、自然起動、原本資格、保存後の受入を区別する。ユーザー指定の[補足DB](https://app.notion.com/p/kabu-labo2/3e6d74ff84cd8119a15ec61865c436a1)と[機能一覧](https://app.notion.com/p/kabu-labo2/205d74ff84cd809e92b4dd1adc5cf186)への対応状況。全列充足を宣言する記録ではない。

## 定期設定

全14 GitHub workflowと18 runner jobs、Cloudflare実配置、Mac2 label、SSHのcron/timerと環境キーを確認した。本番の各処理は[READMEの時刻表](../../README.md#本番の定期処理先行条件llm利用)と[担当・先行関係](../production-job-inventory.md)に整理した。

| 設定 | 確認結果 |
|---|---|
| Cloudflare | main552 `b6cd937edb2c7ea294b84a64af0d1cbec2c7efdd`、build `5225e127-9481-426a-b78c-dde6ac38d63b`、version `cfde0595-e29a-42ab-98b3-1c049fc31158`。01:54 JST配置成功、同じ10 trigger、公開home HTTP200 |
| GitHub Actions | 13 active。`raw_index_backfill.yml`だけ意図的disabled。定期処理の入口に欠落なし。CI・有限backfill・保存RAW公開は定期取得と分ける |
| Mac | 20時biztag／21時優待。main552への通常`install-next`・新旧plist全比較・loaded/PIDなし・旧receipt不変を確認。変更はWorkingDirectoryだけ、`RunAtLoad=false`。監視期待revisionもACK。次の自然calendarは未受入 |
| SSH nipogi | canonical cloneはmain552。Nix・通常CLI・lock同一。5分足と有報補完は固定runtimeで実行。CF用の日次cron/timerはなし。既存08時cronは別repoの売買支援用 |
| 取得負荷・公開資格 | Yahoo共通排他・永続429期限・Notion原本・writer停止条件を維持。公開repoへ常設self-hosted runnerを追加していない |

masterのcronは`timezone: Asia/Tokyo`を明示しており毎月1日06:00 JST。月次母集団は毎月10日10:30。競合準備は有限codes設定時・20時job正常終了・残予算成立時だけで、意味判定は行わない。

## 今回の追加受入

| 対象 | 結果 | 限界・残り |
|---|---|---|
| 空事業タグ | 元対象960社を全て再確認、累計227社へ肯定タグ。4599は01:38:35〜01:39:59、84秒・exit0・タグ追加0・要確認1で通常publisher閉鎖 | 全3タグ空764（00:35 COUNT）は採用なし733＋年次原本待ち21＋現役対象外10。再確認完了とタグありを区別 |
| Clef資源 | 4599通常CLIの最大RSS約20.9GB、swap前後0、外部判定API0、Notion25・429/再試行0 | MPS driver量の別測定はこの実runではしていない。旧6ファイル・拒否ACKを保持 |
| EDINET情報修正 | #552の全3 CI成功、mainへsquash merge。0034は空表として01:23に受入、旧表DML0。取下げ/不開示・別主体/FY・原本/全facts/全文不一致はHOLD | 修正配備を個別文書の解決と混同しない |
| 3776の原本 | S100WZGB正規type5欠測を通常検索で確認。02:05に共有download/archiveでtype5 121,555B・type1 666,008Bだけを復旧。2実体をNotionへ物理保管・全SHA照合。D1文書/進捗不変・LLM0・Notion15・429/再試行0 | 旧onceは保全。入力に原本が揃った後の別phaseだけを実行 |
| 3776の再資格化 | 02:07の通常shared qualifierは現parserと旧status/抽出元が不一致としてHOLD。progress revision10・inFlight閉鎖、既存文書不変、金融/本文writer0、LLM0、Notion17・429/再試行0 | 自動置換で解除していない。保存原本の現在parserは海外を`geo_present_unstructured`とし、旧`no_overseas_table`と不一致。honbunFile等2項目も異なる。現在採用数値は0だが旧facts全量一致は未証明 |
| 本文の空欄分類 | 旧7,074セルのうち822は年次/主体資格不足、1は634Aの同じqualified CSVに対象要素なし | 6,251は銘柄別currentmap未保存で未分類。4CSVの標本から全市場非開示と断定しない |
| 通常の欠測観測 | 銘柄・書類・本文pointer・39列SHA・空欄列を既存の完全GETから保存する修正を別PRで検証 | 処理前Notionの観測でありD1/修復後POSTの証明ではない。新API・再推論は増やさない |
| 不要作業tree | マージ・包含・clean・非稼働を確認した6 worktreeを通常remove。元branch/SHAは保持 | `.runtime`、原本、モデル、実venv、未完作業を一括削除しない |

### SSH 5分足

01:04:25 JSTからmain550の通常`ingest-intra --range=5d`を実行。母集団は現active普通株3,686で、前日の日足固定3,687とは別。最終受入待ち。書込ACKにはsourceMissingの状態更新を含むため、ACKとerrorを単純加算しない。

## データ上の残件

| 分類 | 残り | 対応 |
|---|---|---|
| 原本・主体 | 年次未選択21社、641A/648A、2683/3840、旧Node主体未解決16件、TDnet1279652原PDF | 正式な原本・主体が揃った対象だけ通常取込。未提出/取得漏れ/主体不明の全内訳は未確定 |
| 本文・財務 | 本文6,251セルの原因未分類、財務NULL、歴史財務マスタrelation1,649行、必要原本の過去master relation（件数未確定） | 対象/項目を先に絞り、保存物で分類。原本に値がある実漏れだけ修復 |
| 株価 | 10/19日足の保存3,636＋既知error50＋旧2198 unknown1＝3,687、未着手0。自然stockは45価格欠測＋8303 RSI1 | 新しい適格原本と権利/basisが成立した通常取得で回復。古いbarや別benchmarkで埋めない |
| 保有価格 | 固定2,822行中、採用/旧確定保持1,064・未資格1,758、未処理0 | 未資格内訳は権利/basis894・単位/期間204・同定418・原本価格82・株数非開示160。新しい根拠が成立した行だけ再資格化 |
| 意図的停止 | 全社競合意味判定、TypeSafe、語彙定期審査、歴史RAW全量ミラー | 自動再開しない。準備/一巡/判定済みを金融資格や全列充足へ読み替えない |
| 公開未資格 | TDnet予想配当による公開利回りの定義変更 | 公開資格・期間・株数basis成立が必要。#548のYahoo検算guardとは別 |

内部API/MCPの実認証通し確認も、既存キーがローカルにないため未受入。配置・schema確認と区別し、キーの無断変更や公開はしていない。

同じ入力の無差別再推論、全市場再取得、月次処理の再実行は行っていない。日次/月次は機械処理が基本で、事業タグの限定された意味判断だけローカルClefを使う。

## 根拠

機械監査の入力・全SHA・実logはprivateな`tmp/feature-audit-20261020/`で保持する。設定監査`production-schedule-mece-audit-v1`、4599独立受入`clef4599-independent-fs-acceptance-v1`、0034受入`edinet-information-edit-schema-v1`、原本/再資格化`edinet3776-normal-once-v1`、空欄分類`blank7074-saved-join-v1`、削除記録`worktree-cleanup-six-v1`。公開可能な結果は本記録と[Issue #348](https://github.com/satoki252595/kabulab_tool_cloudflare/issues/348)に残す。

過去の対象集合・異なる観測時点は合算しない。[10/18の列別監査](notion-field-coverage-20261018.md)、[10/19の復旧](recovery-functional-status-20261019.md)、[保有価格内訳](holdings-price-requalification-20261018.md)を参照。
