# EDINET 未割当年次書類の母集団判定（2026-10-18）

`edinet_daily` は、年次書類の `secCode=null/00000` を既存①マスタで解決できない場合、保存済み公式 FSA コードリストを最大2行ずつ確認する。必要な時点の保存原本が無い場合だけ、既存 collector と共通⑤物理 archive で1 ZIPを取得・保管する。1 run内で再取得・結果不明の再送はしない。

提出者EDINETコード・法人番号が双方一意に一致し、原文の上場区分が「非上場」、証券コードが空、原本基準日が提出日以後かつ未来でない場合だけ `excluded_nonlisted` と記録する。財務保存の成功件数には含めない。不在・重複・古い原本・主体不一致は未解決のまま止める。元書類のNULLや失敗履歴を書き換えない。

検証:

```sh
nix develop --offline -c bash -c 'cd pipeline && uv run --frozen pytest tests/test_edinet_codelist.py tests/test_saved_codelist.py tests/test_saved_edinet.py tests/test_edinet_nonlisted.py tests/test_edinet.py tests/test_jobs_smoke.py'
```

- 146 PASS / 4 SKIP。SKIPは既存の未取得実レスポンス fixture（EDINET一覧2、TDnet一覧2）。対象6ファイルの `ruff check` もPASS。
- 既存実FSA ZIPで、法人番号・issuer重複、上場行、証券コード競合、古い/未来原本、最新時計の競合・降順破損、全SHA不一致、分類前ローカル原本の変更を拒否。
- 共通⑤ archive の結果不明では次の文書へ進まず、文書本体取得・金融値書込を行わない。

実データ:

- fixture `pipeline/tests/fixtures/edinet/nonlisted-issuer.json` は、保存済み実 EDINET API `2026-10-16&type=2` 応答から `S100Z8OO` を無加工で射影したメタデータ。元一覧SHAは `4bab461637e7ac83181a2b521121244d1149821d7da228765288a242833d9522`、保管pageは `3fbd74ff-84cd-81c3-883f-c4d972e9ea06`。架空の書類・銘柄・金融値を作っていない。
- FSA原本1 ZIPは573,281 B、基準日2026-10-18、SHA `90098796af995c01bdf73e2c868b2dff425b17f89df4c220aea3e98b5908ce5a`。共通⑤ page `3fdd74ff-84cd-81ae-9389-fa10afa48ca8` へ物理保管・全bytes読戻し済み。
- 原本3481行の `E05633` / 法人番号 `1250001002936` を一意照合し、「非上場」を確認。現在の共通 `_process_document`（分類前SHA guard含む）でもHTTP 0で `excluded_nonlisted` を再生。本体取得・金融値書込・モデル実行はいずれも0。
- 同じ通常attemptのR2 mirrorは `HeadObject` の明示403で失敗。R2 PUT / D1原本索引書込は0で、完全なmirror成功とはしていない。既存の失敗ログ・この部分成功の記録を保持し、別bucket・新tokenへの迂回を行っていない。
- 同一key（SHA `7c13b979e65c0fe67920e1c27f38939fee45be99edbf4eca1e85a494862a24f1`）を既Node R2 readerでも単発GETし、`AccessDenied` / 403を確認。canonicalのaccount・credentials・bucketはPython設定と同値、Python signerもs3v4/autoであり、Python署名経路固有の問題とはしていない。この診断でもPUTは0。

- その後、既存SSH環境のRAW限定principalをプロセス内だけで再利用し、保存済みの同じFSA 1 ZIPを通常 `CloudSink` と既存の固定対象guardでmirror。条件付きPUT 1回、索引前の全bytes照合、D1 INSERT 1回、全17列readbackを完了。原本の再取得は0で、旧403の記録、canonical `.env`、本番の共通secretは変更していない。全RAW履歴の転送は再開していない。
- 本番設定は、実RAW78 run `39077502277`（500件照合・484 PUT成功）と同じ既存Secretから、account・R2 principal・RAW bucketを明示取得するよう `edinet_daily.yml` に `R2_BUCKET_RAW` の1行を追加。Secret値の読出し・変更は0。今回の保存証跡を根拠とし、この設定変更後の定期run自体の成功とは区別する。
- 同じ `JobContext.upload_raw` → `CloudSink.upsert_raw_artifact` を使う `master_sync`・`supply_daily`・`tdnet_hourly` も、各workflowへ同じ1行を追加。`ops_check` はD1読取、`sector33_sync` は共通Notion archive経由でR2原本SDKを呼ばないため変更しない。時系列・需給バケット設定は変更していない。

private実行証跡は `tmp/feature-audit-20261018/edinet-nonlisted-classification-v1/`。上記はコード・一次原本・機械的主体判定の確認であり、旧失敗run全体の再実行成功や20機能全体の完了を意味しない。
