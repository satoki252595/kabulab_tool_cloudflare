# 保存済みROA表3原本のraw-only公開入口（2026-10-14）

ROAの表原典はtype1全体を財務サマリの単一原本として採用する。先に保存済みtype1を通常の⑤/R2/`jss_raw_files`へ確定し、財務3行のCAS更新は別の承認・fresh PREで実施する。CSV原本relationへtype1のROA値を混在させない。

## 固定対象と来歴

`pipeline/scripts/manifests/roa-type1-saved-20261014.json`は6963/S100YF41/E01953、8014/S100YBIN/E02509、8593/S100YF4V/E04788のFY2026-03-31連結3通に限定する。metadataは既存Notion保存type1の読取資格から機械転記した。`data_date`は保存済み`submitDateTime`を既存EDINET変換器で解析した提出日で、`fetched_at`は旧アーカイブ時計を保持する。今回の復旧時計で補わない。

全ZIP SHA/サイズ・元Notionページ・取得URL・提出metadata・直接ROAをmanifestへ記載し、同一全ZIPのnative DEI（主体/証券コード/年度/FY/連結）と既存direct ROA parserで再照合する。原本本文はGitやGHA artifactへ追加しない。CIの実原典部分fixtureは全ZIPの代替として使わない。

## 通常処理の再利用と停止境界

専用manual workflowは既存Nix/`pipeline/uv.lock`と正常RAW workflowのGitHub Secretsを使い、`read_saved_type1` → `xbrl_zip_to_tidy` / `write_tidy` → `JobContext.upload_raw` / `CloudSink`へ接続する。原本の外部再取得、モデル、財務SQL、全EDINET再取込は実行しない。

旧ローカル実行は6963の⑤3添付まで保存後、最初のR2 S3 HEADで403停止した。旧attempt/STOP/source/pinsを保全し再送しない。今回の入口は別のraw-only承認単位で、既存6963の⑤3添付を全bytes照合して再利用する。R2現物があればHEADだけで再利用せず、全bytesを確認し、不一致や不明は停止する。旧ローカルS3 HEADは再試行せず、正常GHAに既存の資格情報を使う。秘密値の移送・export・rotationは行わない。

`GITHUB_REF=refs/heads/main`、CI受入main SHA、レビュー済manifest SHAがすべて一致した場合だけ開始する。専用`ops/roa-type1-saved-20261014/{attempt,complete,STOP}.json`を既存R2へ保存・全bytes読戻しする。既存attemptは成功/停止/不明を問わず再実行を拒否する。元のRAW有限chain/state/cursorには接続しない。

Notionは通常publisherを使い、固定原本のmetadata・親DB・活動状態・原本/CSV/parquet（NotionのZIPラップを含む）全bytesを確認する。queryの重複・打切り・旧source metadataの変更は停止する。Notion APIと添付GETを合計0.5rpsで制限し、API最大60・添付GET最大12にする。再送を行わない。

R2は`total_max_attempts=1`、固定キー/固定bodyのみ、全PUTに`IfNoneMatch='*'`を強制する。412/unknownは再送せず停止する。D1は固定3SHAの原本索引のみを許し、既存全17列は一致時に保存を省略、不一致は上書きしない。PRE後のraceは`ON CONFLICT DO NOTHING`で保全し、全17列readbackの不一致を停止する。同SHAへのmutation再送も拒否する。

完了は3原本すべての⑤全9添付・R2全9実体・D1全17列を照合し、専用complete receiptも全bytes読戻し一致した場合だけ。ログは固定phase/error class/status/件数/SHAのみで、秘密・署名URL・原文は出さない。raw-only成功は財務ROA更新の完了を意味しない。

## 費用・容量と検証

実原本3ZIPは5,218,763B、通常変換を含む9filesは22,894,118B。新規保存上限は⑤3行/9添付、R2 raw9 PUT＋専用receipt2 PUT、D1原本索引3 INSERTで、6963の⑤保存分は再利用する。R2読取は上限12 HEAD＋21 GET程度、Notion API/添付の合計上限72回を0.5rpsで実行する。依存の取得を除いた定期処理の追加はこのmanual復旧1回だけ。新paid API/リソース/依存はない。CPU・GHA経過時間は本番実行前のため未計測。

検証はNix/lock環境で実施。固定実原典部分3件の資格・提出日、固定scope拒否、R2条件付きPUTの412/403/再送拒否・既存body不一致、D1他表/再送拒否・race保全、既存attempt拒否・Notion親DB拒否を非通信で確認する。ローカルに保存済みの全type1 ZIP3件と通常再変換6filesは旧保存SHA/サイズと全一致した。全ZIP不在のCIでは当3件の全体試験のみ明示skipし、同梱実部分原典3件と停止回帰を常時実行する。

実行はrootによるコードレビュー、PR/CI/main受入、manifest/main SHAの限定release後に一度だけ行う。作成時点のraw/財務write・上流GET・モデル実行は0。

作成時の最終check: `nix develop -c uv run --project pipeline --frozen --offline pytest -o addopts=-rs -q pipeline/tests/test_publish_saved_roa_raw.py pipeline/tests/test_saved_edinet.py pipeline/tests/test_direct_roa_table.py pipeline/tests/test_fixture_policy.py` は69 PASS（全ZIPを保持する当ローカル環境ではskip0）。owned2 Python filesのRuffとowned5 filesのdiff checkもPASS。追加のYAML parserは既存直接依存に無く、依存追加はせずworkflowはソースレビューとPRのActions構文検証で確認する。

## 本番原本公開と財務反映の受入

[run38534023380](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/38534023380)はmain `96064903779baedc617dd8def79f5614eb14b117`で成功。公開stepは98秒、Notion32要求/保存添付12読取、原本9ファイルの全bytesと索引3件17列を確認した。既存の本番権限を使い、キーのexport・公式source再GET・モデル・財務writeは0。complete receipt SHA `c0107b6eb70f43aaaf9057b9a122603074e9853d0f83f6d82d11d3ee77f1e832`。

独立のローカルNix読取で全9Notion/R2実体のSHA/bytesをpinned normal originalsと照合し、財務25行/Notion3全props・clockが未変更と確認した。途中の検証は誤ったderived key組立とhosted keepalive socket切断で停止し、業務write0の旧receiptを保全。実索引のderived_keyを使い、hosted限定Connection:closeで別namespaceの全読取が成功した。

別のfinancial-only namespaceで旧原本publisherを実行せず、物理PRE/MATERIALIZED→29SQL単発全34列CAS→Notion3限定PATCH→全25行/全props→物理POSTを確認した。初回は検証gateがNotion検索POSTを誤ってmutation扱いし、native送信前に安全停止（財務write0）。検索・正規DBqueryだけをreadへ分類し、未知要求の送信0/ACK object/id/失敗後再送0の8通信なし回帰と、実25行SQLiteのatomic/stale拒否を確認して新namespaceで完了した。

ROAは6963=-11.6、8014=8、8593=1.3。変化は3行のroa_pct/raw_sha256/fetched_at/raw_page_idだけで、他22行は不変。NotionもROA・取得日時・原本relation以外の全propsを保持。Notion29要求、財務D1 write1 HTTP、原本write/再publisher/source GET/model0。独立した最終読取でもD1全25行/Notion3全props・clockと物理POST SHA `b4e55f0bb4e7806cce8b6a467a5c42606503a0a2aef1973b3115385bc90dcd7a` が一致した。旧時計は原本の取得時計として保持し、新しい確認時計へ塗り替えていない。
