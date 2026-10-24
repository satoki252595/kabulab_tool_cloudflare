# Notion非冪等書込の529停止（2026-10-25）

Pythonのcreate・append・raw uploadは、529を送信結果不明として1回で停止する。
`NotionUnknownResultError`は既存の`NotionRequestError`を継承し、原本保管では
`RawUploadUnknownResultError`が原本停止契約とunknown型の両方を保持する。
共通runnerはunknownを代替保存の成功に変換せず、EDINET／TDnetも次文書へ進まない。
読取529と明示拒否429の`Retry-After`待機は維持する。

Nix内で対象worktreeの`src`を明示して7suiteを実行し、363 passed / 2 skipped。
SKIPは未保有の実TDnetフィクスチャ。ruffと`git diff --check`も成功した。

```sh
nix develop -c bash -c 'cd pipeline && PYTHONPATH=src uv run --no-sync pytest -q -o addopts="" tests/test_notion_client.py tests/test_file_upload.py tests/test_financial_master_relation.py tests/test_jobs_smoke.py tests/test_edinet_nonlisted.py tests/test_tdnet_hourly.py tests/test_notion_create_race.py'
```

HTTP／保存先は既存の障害注入境界を使用し、本番通信・データ更新は行っていない。
SDK create／append、raw upload作成・送信・完了の529送信回数を検査した。
既存の保存EDINET原本を使うrelation回帰では、server側でPATCH適用後に529が
返る場合もR2のpendingを保持し、次runの再PATCHを拒否することを確認した。
過去のunknownやpendingを解除する変更はない。
