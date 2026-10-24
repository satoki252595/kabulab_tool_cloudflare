# 補足39本文の有限・読取専用診断

`audit:supplement:texts` は、明示した1〜50銘柄について**現在の補足39列**と、同じ最新有報の**保存済みtype5 CSV**を機械照合する。修復・モデル判定・EDINETからの新規取得は行わない。通常の夜間処理へCSV再解析を追加せず、初回分類や限定診断に使用する。

```bash
nix develop -c pnpm audit:supplement:texts --codes=6963 --budget-min=3 --max-requests=100 --out-dir=tmp/supplement-text-audit-6963
```

リポジトリルートの`.env`をCLI起動時に明示ロードする。通常の型付きD1/Notion設定と、既存の補足DB・有報テキストDBが必要。`--out-dir`は毎回新しいディレクトリを指定し、原文入りの`report.json`は0700ディレクトリ・0600ファイルで保存する。stdoutは件数・report SHA・固定の診断情報だけ。reportやログをGit・公開artifactへ追加しない。

初回HTTPより前に、`CLOUDFLARE_API_TOKEN`・`CLOUDFLARE_ACCOUNT_ID`・`D1_DATABASE_ID`、`NOTION_TOKEN`・`NOTION_ARCHIVE_PAGE_ID`・`NOTION_YUHO_TEXT_DB_ID`を型付きgetterで確認する。補足は`NOTION_STOCK_SUPPLEMENT_DB_ID`、または既存DBを発見するための`NOTION_STOCK_INFO_PAGE_ID`が必要。不足/不正なら設定値を表示せず、`failure.stage=configuration`・`code=configuration_invalid`とキー名だけを残してHTTP0で停止する。既存envを自動変更したりDBを新設したりしない。

対象コードをSQLへ渡してから文書metadataを読み、共有の現役・最新有報・reported-HOLD資格を用いる。補足の全長property pagination、旧判定入力内と新独立列の本文receiptを共通helperで読み、doc/pointerを照合する。保存原本は共有`readSavedEdinetZip`で所属・物理添付・全文SHA/長さ・存在するmanifestを確認し、主体・期末・提出日時metadataが一致する場合だけ通常CSVパーサへ渡す。現pointerの7プロパティと保存全文も通常readerで照合する。最後に最新docと現在39列を再読し、途中変更を時点差として保持する。これは有限の逐次観測であり、全DBの原子的snapshotではない。

| 区分 | 確認したこと | 空欄を埋めたか |
|---|---|---|
| `matched` | 同じ適格原本・保存本文にある値と現在値が一致 | いいえ、既存値の照合だけ |
| `source_value_missing_in_notion` | 同じ適格原本に値があり、現在の補足セルが空 | いいえ、機械修復候補 |
| `source_target_absent` | 同じ適格CSVの全行に、通常パーサが対象とする要素/ラベルがない | いいえ。PDF/XBRL全体の非開示を証明しない |
| `source_or_identity_insufficient` | 原本/主体/最新有報/同期来歴の資格が足りない | いいえ、根拠不足を保持 |
| `time_difference` | doc/pointerの世代差、または診断中の最新doc/現在値の変更 | いいえ、別時点を混ぜない |
| `unverified` | 読取失敗、候補要素はあるが抽出値なし、保存本文と現パーサの差、非空不同など | いいえ、原因未確定を保持 |

HTTPはNotionのGET/読取query/search、Notion-hosted添付GET、D1の単一SELECTだけを送信直前に許可する。時間・要求数の上限到達では未着手コードをreportへ残す。`cellCounts`は全観測セル、`blankCounts`は現在空欄のセルだけの区分件数。既知分類が付いてもデータ充足とは数えない。未確認・時点差・不足・修復候補がある実行はexit1、引数/出力先などの起動失敗はexit2。

読取異常も`failure`の固定stage/codeを記録する（D1最新選択、Notion DB発見/schema/行、保存ZIP、保存本文、現在値の再照合など）。codeは読取失敗・契約不正・read-only guard・期限/要求数上限を区別し、生error・SQL・署名URL・設定値はstdoutへ出さない。設定修正後も旧reportは保存し、新しい出力先の有限runとして観測する。

既存DBに必要な列がなければ`stage=existing_schema_missing`と固定の不足キーを残し、行query前に停止する。旧`judgeInput`形式の来歴は読めるが、物理schemaの新3列（`textSyncReceipt`・`textInputSha256`・`tagInputSha256`）不存在を実空値へ補作しない。通常の機械同期bootstrap/`ensureSupplementDb`で列を準備してから、新しい有限診断を行う。診断CLI自身はschemaを書き換えない。

10/20の旧7,074空欄のうち6,251セルは、当時のper-code doc/SHA/空欄mapが残っていない。その個別対応を現在の再読から逆算しない。新しい診断のコード・doc・pointer・39列SHA・原本SHA・観測時刻を別の母集団として保存する。既存根拠は[10/20復旧記録](test-logs/recovery-functional-status-20261020.md)を参照。本CLIの本番実行・現在件数は、実行後の私有reportと別の受入記録で確定する。

保存原本の不足は[EDINET ZIPの有限復旧](edinet-archive-repair.md)で、明示した一次日付一覧receiptと同doc/主体/期を確認してから対応する。診断CLI自身のread-only契約は変わらない。
