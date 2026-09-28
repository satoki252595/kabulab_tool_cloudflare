# F-01 / F-15 限定修復の準備（2026-09-28）

対象は [市場系監査](./data-audit-market-2026-09-28.md) の実保存破損。
正常値を推定して復元せず、主マスタ・正常履歴・Notion原本を保持する。

## 変更と範囲

- PR #149 の共有 Chart / R2 fetch 境界と対象日の実終値 gate を再利用する。
- QuoteSummary は発行株数と独立した cash / revenue の株数尺度を照合する。
  複数材料で株数尺度の矛盾を確認した時だけ EPS / PER / 時価総額を NULL とし、
  理由を固定文で通知する。材料不足・単独材料の場合は未検証であり、このguardでは拒否しない。
  他の既存指標・年次財務は維持する。TTM EPSや株数を推定して補正しない。
- 一回用 `scripts/sync/repair-market-20260928.ts` は既定 SELECT / GET のみ。
  1909 / 2180 の `swing_stock_indicators`、`rsi_percentile`、`p_momentum` 計6行を
  全列 CAS で削除し、1909 / 2180 / 7426 の `core_stock_financials` の3列のみ NULL 化。
- 同2銘柄の R2 日足は監査済み exact SHA に限定し、各22本の破損末尾と
  exact 分割イベント1件のみ除く。保持履歴・他プロパティは変更しない。
  `PutObject If-Match` で並行更新を拒否し、成功後に実バイト SHA を再読する。
- `swing_entry_signals` は対象2銘柄の既存監査で0行。otakara の1909は5月の正常行、
  2180は無しなので対象外。`swing_daily_ohlcv`、正常な他銘柄・財務列も対象外。

## 読取・ローカル検証（実適用ではない）

typed D1 reader による SELECT12回、R2 GET2回で私的 plan を作成した。
ディレクトリ0700 / ファイル0600、Notion / D1 / R2 書込0。

- plan SHA: `0701bed53a3dce652e1ba1ebdf81b1752973f270b16c8e4ab96f7820e54e9bd1`
- rows9、R2 objects2。財務日付は全3件2026-09-25。momentum は9/14、9/15。
- 1909: 2,523→2,501本、2180: 2,524→2,502本。各分割イベント1件除去。
  残る全履歴のJSON同値、その他プロパティ同値を確認した。
- Native SQLite に実マイグレーションを適用し、全列 CAS の競合拒否、部分失敗からの
  再開、2回目変更0、正常財務列・履歴・対象外行の保持を確認した。
- 物理アーカイブのバイト不一致は停止。trash 成功後のローカル receipt 消失は
  既存 exact key 探索→物理 SHA 再読で復元し、原本再記録・再移動0を確認した。
- installed SDK が native ETag / `IfMatch` を送信し、412を握りつぶさないことを確認。
  リモート条件付きPUTは未実施。対応は
  [公式 S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/) と
  [412定義](https://developers.cloudflare.com/r2/api/error-codes/) で確認した。
- focused5files60件PASS、型と対象ESLint PASS。新schema / API / 依存 / 環境変数0。
  既存 R2 env をtyped getterへ集約し、`R2_BUCKET` を必須にした。
  `.env.example` と vwap-ingest workflow は既にこのキーを設定している。

## 運用順序・未確認範囲

1. PRのCI確認→共有guardを含むmainのmerge→正規deploy。
   `CLAUDE.md` rule5 は feature PR / CI を要求し、mergeをユーザー判断に委ねるかは任意。
   source repoに staging経由・単独deploy禁止条項は無く、READMEは `pnpm deploy:cf`。
2. stock-sync / vwap-ingest に実行中・queuedジョブが無いことを再確認。
   今回のauthenticated GitHub照会は両状態とも0。workflow無効化の証明ではない。
   株式同期は平日17:13 UTC、VWAP日足は月水金08:00 UTC。旧チェックアウトのwriterを
   残して修復すると再汚染し得るため、writer不在とguard適用を先に確認する。
3. plan確認後 `--apply`。既存 `recordPrimaryData` / `moveToTrash` を使い、
   vwap-analysis のサービスDBへ確定バッチ実体を退避する。FilesのSHA一致までは
   sourceに触れない。私的receiptは0600で保持する。
4. `--verify` で6行不在、財務3列NULL / 正常列不変、R2のexact修復SHAを確認する。
   再度 `--apply` してD1 / R2変更0を確認してから利用側の日次・記事gateを再開する。

本書作成時点で merge / deploy / source修復は未実施。guardコードやCIの成功を
実保存データの修復完了と呼ばない。原本・トークン・診断本文はGitへ保存しない。
