# F-01 / F-15 限定修復の実施と検証（2026-09-28）

対象は [市場系監査](./data-audit-market-2026-09-28.md) の実保存破損。
正常値を推定して復元せず、主マスタ・正常履歴・Notion原本を保持する。

## 変更と範囲

- PR #149 の最新main `4fbdd2b`（2026-09-28 11:05 UTC）にある共有 Chart / R2 fetch
  境界と対象日の実終値 gate を再利用する。無効実数値の独立拒否・計算前の個別gateも保持する。
- QuoteSummary は発行株数と独立した cash / revenue の株数尺度を照合する。
  複数材料で株数尺度の矛盾を確認した時だけ EPS / PER / 時価総額を NULL とし、
  理由を固定文で通知する。材料不足・単独材料の場合は未検証であり、このguardでは拒否しない。
  他の既存指標・年次財務は維持する。TTM EPSや株数を推定して補正しない。
- 一回用 `scripts/sync/repair-market-20260928.ts` は既定 SELECT / GET のみ。
  1909の `swing_stock_indicators`、`rsi_percentile`、`p_momentum` と
  2180の `swing_stock_indicators`、`p_momentum` 計5行を
  全列 CAS で削除し、1909 / 2180 / 7426 の `core_stock_financials` の3列のみ NULL 化。
  2180のRSIは最新監査で破損由来未証明と訂正されたため、行全体を保全する。
- 同2銘柄の R2 日足は監査済み exact SHA に限定し、各22本の破損末尾と
  exact 分割イベント1件のみ除く。保持履歴・他プロパティは変更しない。
  `PutObject If-Match` で並行更新を拒否し、成功後に実バイト SHA を再読する。
- `swing_entry_signals` は対象2銘柄の既存監査で0行。otakara の1909は5月の正常行、
  2180は無しなので対象外。`swing_daily_ohlcv`、正常な他銘柄・財務列も対象外。

## 読取・ローカル検証（実適用ではない）

旧版は typed D1 reader による SELECT12回、R2 GET2回で私的9行 plan を作成した。
ディレクトリ0700 / ファイル0600、Notion / D1 / R2 書込0。

- plan SHA: `0701bed53a3dce652e1ba1ebdf81b1752973f270b16c8e4ab96f7820e54e9bd1`
- rows9、R2 objects2。**旧planは適用対象外であり、原本のまま私的に保持する。**
  最新監査の8行scopeは別planの新鮮な読取で確認する。
  財務日付は全3件2026-09-25。momentum は9/14、9/15。
- 最新mainの訂正後、2026-09-28 11:20 UTCに SELECT11回 / R2 GET2回で新8行planを作成。
  SHA: `bdfc11ac2a76bbdddc72fc418ad6676426b10c533eb06b61f70fcde85ae8ba5a`。
  対象8行は旧planの対応原本全列と一致、2180/RSIは含まない。書込0。
- 1909: 2,523→2,501本、2180: 2,524→2,502本。各分割イベント1件除去。
  残る全履歴のJSON同値、その他プロパティ同値を確認した。
- Native SQLite に実マイグレーションを適用し、全列 CAS の競合拒否、部分失敗からの
  再開、2回目変更0、正常財務列・履歴・対象外行の保持を確認した。
- 物理アーカイブのバイト不一致は停止。共通 `moveToTrash` が同keyの退避先を
  新鮮に照合し、POST成功後の元ページtrash未完了を再開で完了する。
  callerは保存済み元IDを再び渡し、既知退避IDの一致と物理SHAの再読を必須にする。
  同key複数・所有元/材料/添付不一致・退避欠落は推測せず停止する。
  元ID・Service・状態を新鮮に確認し、active元のPATCH前に退避実ファイルのSHAも照合する。
  既にtrashの元では再破壊操作をせず、今回callerが既知planの物理SHAを再確認する。
- 共有helperの厳密なService照合により、通常masterページを渡す非稼働の手動
  `scripts/notion/master-dedup-3681-7129.ts:1882` はService無しなら保全停止する。
  現行workflowからの呼出はなく、今回の `recordPrimaryData(vwap-analysis)` はService付き。
  legacy再利用には元全材料の所有確認が必要であり、推定stamp・黙った補完は追加しない。
- installed SDK が native ETag / `IfMatch` を送信し、412を握りつぶさないことを確認。
  この準備段階ではリモート条件付きPUTは未実施。対応は
  [公式 S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/) と
  [412定義](https://developers.cloudflare.com/r2/api/error-codes/) で確認した。
- 最終同一コードで focused7files98件PASS、型・全source lint・対象ESLint PASS。
  共通archive23件では実bytes不一致・Files欠損で元PATCH0、正しい空Filesは許可。
  8行scopeの2180/RSI全列保持、診断のCAS/412/Notion400保持と原文非露出を確認。
  新schema / API / 依存 / 環境変数0。
  既存 R2 env をtyped getterへ集約し、`R2_BUCKET` を必須にした。
  `.env.example` と vwap-ingest workflow は既にこのキーを設定している。

## 運用順序・未確認範囲

1. PRのCI確認→共有guardを含むmainのmerge→正規deploy。
   `CLAUDE.md` rule5 は feature PR / CI を要求し、mergeをユーザー判断に委ねるかは任意。
   source repoに staging経由・単独deploy禁止条項は無く、READMEは `pnpm deploy:cf`。
   Workerは配信/取込proxyだけでCronなし。株価writerはGitHub Actionsのmain checkoutを使う。
2. stock-sync / vwap-ingest に実行中・queuedジョブが無いことを再確認。
   今回のauthenticated GitHub照会は両状態とも0。workflow無効化の証明ではない。
   株式同期は平日17:13 UTC、VWAP日足は月水金08:00 UTC。旧チェックアウトのwriterを
   残して修復すると再汚染し得るため、writer不在とguard適用を先に確認する。
3. plan確認後 `--apply`。既存 `recordPrimaryData` / `moveToTrash` を使い、
   vwap-analysis のサービスDBへ確定バッチ実体を退避する。FilesのSHA一致までは
   sourceに触れない。私的receiptは0600で保持する。失敗時は同じ私的planの
   sidecarへphase・固定比較label・安全なAPI status/code/requestIdだけを記録する。
   原文応答・URL query・秘密値は診断にもconsoleにも保存しない。
4. `--verify` で5行不在、財務3列NULL / 正常列不変、R2のexact修復SHAを確認する。
   再度 `--apply` してD1 / R2変更0を確認してから利用側の日次・記事gateを再開する。

## 本番実施と独立再読

- PR [#152](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/152) は
  2026-09-28 11:49 UTCに main `bdaa217fa16eb400ac434f1bdc841bc68a4d673f` へマージ。
  mainの型・lint・CIは成功。Workers Build `a1cb4432-6e04-49c3-8d61-4a0cef594cf9` の
  当該commit出力と、11:50 UTCの100%配備 Version
  `8df9edc3-e97c-4069-8c16-aa4cb35cf26d` が完全一致した。
  source writerのGitHub Actionsは適用前後とも実行中0・queued0。定期実行の無効化はしていない。
- 上記8行planの実体を既存Notion原本保管とtrashへ物理ファイルとして退避し、
  元・退避の実バイトSHAがplan SHAと一致してから修復した。全phaseは成功した。
  新しい原本・保全ページのIDとreceipt、入力データ、秘密は私的0600ファイルだけに保存した。
- 最初の実 `--apply` は D1 write calls8 / native changes8 / RETURNING8、
  R2条件付きPUT2 / HTTP 200成功2。API metadataが読めない件数は0。
  指定の派生5行だけ削除し、財務3行の EPS / PER / 時価総額だけ NULL 化した。
- `--verify` の新鮮な読取が成功。2回目の実 `--apply` も成功し、
  D1 write calls / native changes / RETURNING と R2 PUT / 成功数はすべて0。
  実施カウンタは私的な一時hookで確認し、恒久的な計測コードは追加していない。
- 別担当がnative SELECT15回（書込0）とR2 / Notionを独立再読して確認した。
  対象5行の不在、財務3行の指定3列のみNULL・全正常列一致、2180のRSI全12列不変、
  正常対照8154の4表全列不変、1909 / 2180 / 7426 / 8154の財務履歴36行×既存33列不変。
  R2は両objectのexact修復SHAに一致し、Notion元・退避2コピーの物理plan SHAも一致した。
  財務履歴の比較は既存33列だけで、別途検証済みraw_page_idの全件検証とは混同しない。
- 独立検証proof SHA:
  `3cc1003b78882ec46b2d8fcbf6535e53695beb10174a7a5c42e0715e00cb1ea4`。
  所有者のsource配備証跡が追補された最終版を別ファイルへ不変保存して固定した。
  所有者と独立検証を合わせた私的最終proof SHA:
  `d7e15113859fe65c16b62d134e56010ac86caf5f3173eec617a0812bf98da30d`。

修復スクリプトと専用テストの2本は実完了後に削除した。実施コードはPR #152の上記commitへ
残る。通常のChart / QuoteSummary / R2境界と共通archiveの回帰は維持する。
削除後も既存QuoteSummary / R2 / 共通archiveの43件、型・全source lintが成功した。
正常対照・保持列・保持履歴を確認した範囲を超えて、全銘柄の安全性を主張しない。
QuoteSummaryの材料不足は依然未検証であり、旧9行plan・2180のRSIは適用していない。
原本・トークン・診断本文はGitへ保存しない。
