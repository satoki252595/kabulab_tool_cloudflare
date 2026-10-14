# 保有株価格の計算列を含む本番読戻し

2026-10-14。197A / S100Z3TCの保存済み提出会社明細1行を、accepted main `a4326f4be41b5695de480628245db2b3190a2629` の隔離Nix runtimeで通常source→price経路に通した。原本株数47,592株と4512の同期期末終値269円から、期末参考時価12,802,248円を保存した。

本番pilotはbusiness mutation 6送信・6ACK後、価格の読戻しで停止した。価格照合済checkboxがfalseからtrueになると、Notionの「価格状態」formulaも既存定義に従って「未取得」から「期末参考時価」へ変わる。従来の他props不変検査がこの正常変化を誤って拒否していた。原本完了は保持、価格完了markerは未送信、原ラッチを残して再送しない。

共通writerを修正し、書込前後で「価格状態」のschema/property ID、formula型、checkbox型・boolean値、およびcheckboxに対応する計算結果全文を検証する。その1列の検証済み再計算だけを期待値に反映し、他formula・旧列・原本列・その他property fieldは完全一致を維持する。全formulaを比較から外さない。新しい通信・依存・モデル処理は増えない。

Nix上で共有writer suite 48 tests、全repo型検査、変更2ファイルのESLintが通過。通常の価格確定と価格欠測での再計算に加え、旧計算値・新計算値・property ID・別formulaの不整合が停止し、価格markerをunknownのまま保全することを確認した。

private `holdings-normal-pilot-isolated-v3/` のstartup SHAは `14e459813c9f802a4a7ef4468250d617ffa085076a504e5eb4a225fc5333e395`。物理PREはNotion page `3f9d74ff-84cd-81a0-91e7-d90e8edeb976`、gzip SHA `c981ad8cd22765bf15c97f0a9c0ddd5d61bfc2c4bb4e3080c7aa2e6095ad7172`。terminalはexit1で確定し、原本API・モデル・旧27,587行へのPATCH・原本再uploadは0。

別scopeのfresh5readでは、source全16propsと新明細全34props・時計・自然キー1行・両DBschemaの一致を確認した。reconcile plan SHA `fda95dc8d9ed0405ac35c0d95aad97d6f5e0928ece22f00454fcaaa54b83263f`。残る価格完了3propsだけの反映・物理POST・独立検証は別受入とし、この修正のマージだけでpilot全完了とは扱わない。使用snapshotの取得日は2026-10-04、価格原本の対象日は2026-10-02であり、当日の全銘柄価格更新完了を示さない。

19:21 JST受入: PR385は全CI緑でmain `8aaa8797c2e2d24ce8ac69c371dfef93b9f6accc`へマージ済み。別scope completion-v2を固定し、fresh5read→物理PRE→fresh3read/CAS→残3propsのみ1PATCH→全読戻し→物理POSTまで25要求・96.485秒で完了した。価格PATCH/source phase/R2/取得元API/モデル/旧行PATCHは0。source完了・対象外13props・新明細全34propsと時計を保持した。

さらに別processのread4/書込0で、source全16props・価格完了/原本完了、新明細全34props/時計、POST物理全SHAを独立確認した。POST page `3f9d74ff-84cd-81db-bf34-e5cce315b1e1`、gzip SHA `edd0053701e18bb953c6ad2533817cc83b48572668dd14d87e3d69f2c3c329c7`。新startup SHAは `86d734c4e5f0106d9477f2295fef09601f7713e63096f383905bfcde590ddca1`、原v3の6ACK/STOP/ラッチは保持。全保有明細の一括反映完了はこの1社受入に含めない。
