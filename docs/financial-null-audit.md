# 財務NULLの有限診断

③の空欄は修復件数ではない。固定コードの現在行を読取し、exact⑤snapshotと同SHAのlocal全原本がある行だけ、既存converter/normalizerで理由を確認する。新しいparser・モデル・原本API取得・Notion/D1/R2書込は追加しない。

## コード別に③を固定する

`audit:financial:null`は必須引数を省略できない。コードファイルは正準4文字コードの重複なしJSON配列。全bytesのSHAを先に確認する。current active集合を使う場合は、別途承認した既存`loadActiveEquityCodes`のcode-only結果を固定する。universe syncや全財務先読みをこのCLIで呼ばない。

```sh
nix develop --command pnpm audit:financial:null \
  --codes='<固定JSON配列>' --codes-sha256='<全bytes SHA256>' \
  --offset=0 --max-codes=1 --max-pages=1 --max-http=2 \
  --deadline='<明示された未来のISO UTC絶対期限>' --out='<新しいprivate directory>' \
  --env-file='<canonical .env>' --python='<既存pipeline/.venv/bin/python>'
```

環境/依存はプロジェクトNixとlockを使う。`.env`は所有者/0600を検査して明示loadし、DB IDと31列（19数値・4キー・source/raw relation等）は既存Python settings/schemaから得る。schema1GETの後、各codeを先にfilterし、更新日時降順・page_size100で読む。`max-http`はschemaを含む全native要求、`max-pages`は1codeごとの上限。新規要求は絶対期限前だけ、各要求も残期限/60秒で中断し、single-attemptで自動再送しない。

出力directoryは新規0700・各fileは0600。HTTP intent、完全/部分応答bytes、受信clock・SHA・状態を解析前に保存する。signed URL/認証値・金融原文は標準出力に出さない。出力`capture.json`は、受入済pageのfile/SHA/行数/cursorと、code別のcomplete/partial/stopped/unstartedを保持する。

`request_status=incomplete`・未知状態・通信/shape不明は共有strict guardでSTOP。`has_more=true`はそのcodeの未完としてcursorを保存し、全件扱いしない。offset前後のcodeもこのrunでは未観測とする。続きは同じ固定codeファイル/SHAと別の有限予算で明示選択する。現在の入口は前runのcursorを自動再送しないため、page上限に達したcodeは必要量を確認して別の有限runで先頭から再検査する。旧STOPや応答を上書きしない。code集合内の自然終端も、廃止等の集合外履歴や全③・全NULL理由の完了とは別である。時点をまたぐ逐次読取で、原子的snapshotではない。

## exact原本をlocalで診断する

`source-map.json`はversion1と`sources`配列を持つ。各要素には`raw_page_id`, `snapshot_file`, `snapshot_sha256`, `original_file`, `original_sha256`を明示する。snapshotはexact⑤pageの保存JSON、originalは同じfull SHAの全ZIP。期限付きURLの再取得や別原本探索は行わない。必要なmetadata/物理原本の有限読取は別の明示RO操作とし、根拠がなければHOLDのまま進める。

```sh
nix develop --command env PYTHONPATH=pipeline/src \
  pipeline/.venv/bin/python pipeline/scripts/reparse_financials_from_notion.py \
  --diagnose-capture '<capture.json>' --capture-sha256 '<全bytes SHA256>' \
  --source-map '<固定source-map.json>' --source-map-sha256 '<全bytes SHA256>' \
  --max-rows 100 --journal '<新しいprivate診断.jsonl>'
```

このmodeは旧全量journalを読まず、Notion clientを起動しない。③page/親/active・4キー・source・完全単一raw relationと、⑤page/親/active・code/source/license/data date・datatype・size/full SHA・単一物理添付名を照合する。既存cached入口と同じ64MiB ZIP/展開128MiB上限、converter、normalizerを使う。原本なし・不一致・keyの変化・型不明はHOLD。診断journalはapply/sync用の修復journalではない。

normalizerの任意sinkは実際に通った候補・単位/全社・actual/forecast/year・連結/累計/本表・数値/多値のterminalを19destination別に記録する。通常呼出しの戻り値/計算順序は不変。四半期ROA等の明示対象外、非数値、選択scope内候補なし、原本不足、同key/source/full SHAで旧NULL→新非NULLの実抽出差候補を区別する。単位不明・多値・key不成立は5分類へ押し込めずHOLDにする。候補なしを公式非開示とは呼ばない。CSVの平坦化で失われたROA表を別type1の値で埋めず、その資格確認は通常EDINETの同文書/6DEI契約へ残す。

## 検証範囲

保存済み634A/S100Z4Z3の③projectionは数値を変えず回帰に使う。個人情報/Notion URL/期限付きURLはfixtureから除外し、取得clockと元応答SHAを記す。元ZIPはlocal-only fixtureとして、未配置環境は明示SKIPする。既存の公開EDINET実原本ではsinkあり/なしの全record・入力不変、19destination、単位欠落/多値HOLD、ROA肯定/拒否を常に検証する。本番の全対象分類・修復をこの回帰から宣言しない。
