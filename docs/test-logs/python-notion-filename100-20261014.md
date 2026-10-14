# Python通常原本アップロードの添付名上限

2026-10-14。隔離Git worktreeで実装・Nix offline検証した候補。本番更新・通信は行っていない。

実8303の物理PREでは、File Upload create/sendが200だった後、ページ作成が
`Files.files[0].name.length`の上限100に対する118文字で400となった。
`pipeline/tests/fixtures/notion/native-filename-118.json`は、その保存済み要求名と
native validation応答だけの投影。原典path/SHAを同JSONに記録する。
旧送信の成否・原clockを変更せず、失敗した本番処理を再実行していない。

Pythonの通常callerは`jobs/runner.py → upload_raw_artifact → upload_file →
single/multipart → _create_upload`。`files_prop`のproduction callerは同じraw行だけ。
共有validatorで添付名を変更せず検査し、通常upload_fileのHTTP前とfiles payloadへ適用した。
100上限はFiles.nameの契約であり、別契約のupload API filenameへ無条件に適用しない。
新規原本+全変換版は、ZIP化後の最終名を最初のuploadより前に検査する。
SHA既存行は従来どおり旧原本の全添付を読み戻して再利用し、再uploadしない。

ASCII118文字のnative違反は実測。Unicodeのnative計数は実証していないため、
TypeScript `string.length`と同じUTF-16 code unit上限100へ保守的にそろえる。
100/101、ZIP追加4文字、非BMP文字の境界は明示offline制御であり、実原典名の短縮や
native Unicode受入を証明する入力ではない。

Nix既存flake/lockからPython3.12.13を使い、`uv sync --offline --locked
--no-python-downloads`でworktree内venvへ既存依存を用意した。追加依存・envキーなし。

```text
pytest test_file_upload.py test_upsert.py test_jobs_smoke.py test_local_store.py
       test_notion_client.py test_notion_create_race.py
441 passed / 2 existing skipped (tdnet/yanoshin_list_recent.json未取得)
ruff check owned4 Python files: PASS
git diff --check: PASS
```

actual118添付名の通常public拒否でupload HTTP0、ZIP後101文字でHTTP0、
後半変換版の長名でも前半原本を送らないことを確認した。100文字の最終名とfiles payloadは
同じ文字列を保持し、単体upload APIへ118文字を送る既存契約も対照で保持する。
型・readback・unknown停止・取得頻度・モデル経路は変更しない。
