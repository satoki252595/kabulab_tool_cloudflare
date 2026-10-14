# 同じ原本の再取得と初回取得日の保持

追跡: [#348](https://github.com/satoki252595/kabulab_tool_cloudflare/issues/348)。

歴史原本の有限継続は3run成功後、4run目38495471611で⑤原本とD1索引の
`data_date`不一致を検出して停止した。固定stateはcursor2337/inflightなし。
再dispatchやstateの変更は行っていない。

現在のD1全4,821行・17列と固定78,832原本を読取り比較し、共通4,712の
不一致は13件（日証金meigara5/zandaka4/shina4）、全て`data_date`だけだった。
⑤はSHA冪等で初回metadataを保持する一方、通常CloudSinkが同SHAの後日再取得で
`data_date`を更新していた。初回取得時計だけを保持していたため日付が食い違った。

日証金のraw日付は通常producerが取得日として設定する値で、申込日とは異なる。
実停止原本191,433 bytesは⑤添付と既存R2の全文SHAが一致し、CP932の全4,336行に
native日付はなかった。⑤の日付を業務基準日とは扱わない。

共通CloudSinkは既存のD1 upsertの保持列へ`data_date`を追加する。
同SHAの初回日付（未知のNULLを含む）と初回時計を維持し、最終取得時計は更新する。
新規原本の日付・旧doc ID救済・通常のR2保存順は既存経路を利用する。
追加の照会・source取得・依存ライブラリはない。

Nix/固定uv.lockで関連114 testsと変更Pythonのruffを確認した。
実SQLiteに通常CloudSinkのSQLを流す回帰で、別日の同SHA再取得時の初回日付/NULL、
初回時計、最終時計の更新、旧NULL doc IDへの明示ID追加を確認した。

既存13行の整合は別の本番gateで、初回canonical取得日へ`data_date`だけを合わせる。
全17列CAS、旧R2 key/body・両取得時計・他4,808行の保持、物理PRE/POSTと全列読戻しを
必要とし、このコード変更だけで13行の訂正や全量原本索引の受入は主張しない。

private読取分類は`raw-finite200-date-analysis-v1`、13行CAS計画SHAは
`21146109ac16b32dda10cca2ca2ae4644a59c6fb06d03a09b4fa45e91da7a0e8`。
公式サイトの再GET・モデル・本番書込はこの検証で0。

## 17時台の本番反映と有限継続

PR377/main `d0fa20752eb743002845681e865446d7351d41b6` の通常修正をCI受入後、13行は27SQLを単一HTTPで送り、全4821行を読戻した。変更は13行のdata_dateだけで、他4808行・他16列・両clock・旧R2 key/bodyは保持した。PRE/POSTはNotion実体保存・全SHA読戻し済み。公式source GET・R2 body/state書込・モデル0。

PRE SHA `ae0c5a6810a112d68e26bd70bb878652ee21da0ae612fec4fb252ce085884384`、POST SHA `5f63d2aa889bdd772ba08588ce7cf56e6c7e99011c45a80482447f3c55b05188`。別の独立確認で全17列/13canonical/物理POST/旧state2337を再照合した後、[run38533846279](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/38533846279)へ一度だけdispatchした。旧200run予算で消費した4runを除き、残196run（continue_runs195）とした。stateのリセット、旧ラッチの消去、原本再取得は行っていない。

17:37 JSTのOAuth読取でcursor2523、実行中inflightを確認し、旧停止地点2337を通過した。これは全78832件完了ではない。以降も固定manifestとfinite budgetを使い、エラー/結果不明は継続停止、最終anti-join欠測0を別受入とする。
