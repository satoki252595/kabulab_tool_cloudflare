# 原本索引の読取上限と独立読取の並列化（2026-10-14）

固定78,832件の原本索引回復は、保存原本・R2全文・D1全列・stateのCASを維持する。新サービス、依存ライブラリ、取得元アクセス、対象拡張は追加しない。現在runの取消・state変更・再dispatchは行わない。

直近の成功run `38545525664` は500件を2,911.493秒で処理し、cursor3,837・残74,995だった。同速度の残量外挿は121.304時間（約5日）だが、将来の完了保証ではない。Notion integration RESTは10要求、hosted原本は480GET。両者を同じレート枠へ数えない。R2はraw1,428GET/480PUTとreceipt1,463GET/1,460PUT、D1は1,460read/480insertだった。D1要求数は課金対象の読取行数を意味しない。

実summary行はprivate `tmp/feature-audit-20261013/raw-terminal-38545525664-readonly-v1.log`、SHA256 `d08bac605ea7f1981526230a540631de3bc2565d3f0c5c88849cb2866698d5ea`。原本・署名URL・実ログはGitへ保存しない。

変更は次の2点。

- 既RAW CLIの明示 `--notion-max-rps` で、共有clientの全native試行を開始前に制限する。workflowは0.25rpsを明記する。通常の未指定380ms queue・再試行契約は維持し、設定時は再試行にも上限を適用する。長いRetry-Afterは短縮しない。一般env/config/dispatch inputと継続予算・manifest/state schemaは増やさない。
- raw PUTのACK後、R2全文GET/SHAとD1 preinsert readの1組だけを並列化する。全結果を回収し、両方成功した後だけindex-inflight CAS→単発INSERT→全列読戻し→cursorへ進む。SHA不一致、欠測、索引不一致、片方失敗ではindex CAS/INSERTを行わず、元raw-inflightを保持する。

同じ要求を重ねる変更であり、原本照合・state読戻しは削らない。SHA一意のD1はUPDATE/UPSERTを使わず、競合INSERTは失敗して停止する。複数原本を同時inflightにしないため、大きな原本を複数展開する構成にも変えない。

50原本のmetadataは一括query1件で、今回500件のRESTは最大10cohortだった。10要求が全て隣接すると仮定した追加pacing待機は最大約32.58秒。実際は各cohort間に原本処理を挟むため、実増分時間は次の正常継続で測る。0.25rpsを常時占有した実測値とは扱わない。

直近runでは最大480組の独立readが対象となる。実RTTと新runの終了時間は未測定なので、短縮率を主張しない。次の継続のsource SHA・実引数・処理件数・bytes・既完了比率と合わせて確認する。現在稼働中の旧runへ新上限が適用されたとは扱わない。

Nix・通信拒否下の候補回帰117件がPASS。rootは候補5ファイルの全差分、7既存source pin、26private artifact pinを独立照合し、実適用後も5 suite / 117 tests、全repo TypeScript、所有ESLintをNixで確認した。通常380ms、全再試行のpacing、不正値・開始後設定拒否、長いRetry-After、独立readの片方失敗・SHA不一致・索引不一致と書込0を含む。新たな本番GET・PUT・モデル実行は0。

同時回復は、通常stock/catchup/Mac20時・21時の終端、新上限が有効な次RAW run、実active枠をrootが確認してから開始する。機械同期0.5＋本文0.75＋保有枠0.5＋RAW REST0.25＝最大2.0rpsは明示した予約枠の案であり、未変更の現runや他の通常writerをこの合計へ含めた保証ではない。
