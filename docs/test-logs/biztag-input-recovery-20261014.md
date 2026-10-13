# 最新有報本文と事業タグの入力照合（2026-10-14）

## 根因と修正契約

`planWork` は「判定済」を最新書類との比較より先に skip していた。補足39本文も旧期に残り、`retag` はローカル判定へ進まず機械照合へ回っていた。最新文書IDと保存済み根拠IDが違うときは、保存済み値を新書類へ付け替えず、最新39本文と SemIf 専用の再判定を同期する。語彙だけの変更は再判定の理由にしない。

既存「判定入力」に docId・Notion 全文行ID・事業本文SHA・固定順4対象節SHA・実モデル入力SHA・使用モデル・語彙版を添える。新しい Notion 列・schema 変更はない。`loadSupplementRows` の取得列・戻り値形は無変更。同一docの既知pointerが変わった場合は実本文の4対象節SHAを比較し、同一なら39本文だけを同期して旧タグ・根拠・判定版・判定日を保持する。歴史的判定のSHAが無い場合は同一入力の証明には使わず、その未検証を理由に明記する。一斉再判定や全社追加全文GETは行わない。

ローカル判定が利用不可・応答欠落・結果不明なら、旧本文・タグ・根拠・版・判定日へのwriteを0にし、HOLD/失敗通知へ渡す。dry-run は本文GET・モデル推論・補足writeを0にする。候補語が無い場合は、その事実とモデル未実行を明記する。

既存行の書込は共有 `replaceEvidenceBlock` 一か所を直した。plan時の旧タグ・入力書類・判定版/日付等をfresh行と照合 → PRE全props/childrenを物理Notionへ保管して全bytes読戻し → fresh PRE照合 → 対象1社のD1 latest/doc/pointerを1 SELECTで書込直前再照合 → 新根拠append/全文verify → singleAttemptでproperties PATCH・全列読戻し → 旧根拠退役/読戻し。長いrich_text/relationはproperty paginationで照合する。同一PREの既存実行、新旧の根拠重複、unknownは自動再送を停止する。最終PATCHがunknownなら適用済みの可能性があるため「旧値不変」と扱わず、PRE page IDを含むエラーから現値を照合する。Notionには複数プロパティPATCHのサーバ側CAS/transactionが無いので、チャンク途中の停止もPREと照合して再開する。推論失敗による旧値保全とは区別する。

## 保存原本50社 pilot

pilot準備時に固定したD1母集団は有効3,686銘柄、最新有報3,664、文書なし22。code順の先頭50社すべてで、保存type5またはcanonical⑤の原本・全文SHA・文書キー/取得URL・CSV DEI issuer/期末を一致確認した。上流EDINET GET 0、新paid AI 0。後続の542A/646A取得後の最新3,666社分類と補足39本文prepareは、競合81社の確定後にfresh入力で作る。

連結注記の抽出修正とIFRS標準3要素を使うと、50社の本文は1,778節から1,875節へ増え、38社に本文/索引/補足の差分がある。残75セルは保存CSVに対象標準要素が無い。全有報での非開示と同義にはしない。旧年度を現行補足へ投影しない。

- 1382・1431: 補足の旧年度と最新年度で事業本文SHAが変わる。旧判定の値・版を保持し、最新入力を限定再判定する。
- 1414: 同じ期末の訂正有報へdocが変わる。事業本文SHAの一致だけで旧判定を新docへ付け替えない。
- 上記3社を含め先頭50社中8社が競合83社の固定入力と重なる。補足・タグ更新は競合81社のapply完了と130A/145AのHOLD確認後に進める。既存競合・タグ値はprepareで変更しない。

private `tmp/feature-audit-20261013/latest-text50-pilot/` に保存ZIP SHAと期待本文を固定した38操作を10/10/10/8社で置いた。market担当の `saved-parser-pilot/lib.mts` の `snapshot` / `columns` / `docGuards` / `verifyChange` を再利用し、rootがfresh latest文書/期末、全量PRE、物理保管/readback、atomic D1 CAS、本文/7props/索引/pointer読戻しを確認して本文のみ適用した。`completed-text.json` は2026-10-13T18:37:29.903Zに38件完了、sourceGets/rawUploads/supplementWrites/modelCallsすべて0、POST SHA256 `060226a9f092f5abeaec0d59cea8e81d7746cf34c03672829de6d96de39d4bd3`。補足は競合apply後にfresh PREを取り、再度latest/doc/期末を確認してから本文更新または上記専用再判定へ進む。

## 費用・検証

元50社の読取prepareは約81秒、ZIP合計約5.1MB。IFRS追加後の純ローカル50社再解析は約1.74秒。全3,664社への線形外挿は読取約99分/CSV約374MBだが、原本保存率・差分率はこのsampleだけで保証しない。50社ごとの上限付き実行で確認する。

通常runの同一doc/pointerは追加原本GET・全文GET・モデル0。変更対象だけが全文1読取、候補数に応じ既存SemIfの20語batch、PRE添付1とそのbytes検証、新根拠/プロパティ/退役の読戻しを行う。PREは旧補足全文を含むためサイズは対象実データで測る。新規外部価格GET・全件Yahoo GET・有料AI追加はない。

検証はNix開発環境から既存biztag全体と共有補足/raw-filesで37suite/510PASS、全体型検査PASS・対象12コードファイルのeslint warning0。新回帰は最新doc変更、既知SHAの同一/変更、歴史的SHA不明、モデル失敗/応答欠落/unknown時write0、dry-runモデル0、PRE/新根拠の失敗前旧値保全、階層を持つ根拠の全量物理PREと新根拠読戻し、最終PATCHunknown時の再送/旧根拠退役禁止を含む。根拠append・properties PATCH・旧根拠退役の結果不明はいずれもPRE page IDをエラーへ残し、照合前に再送しない。production applyはrootが実施し、CIと競合固定入力の解除gateを通す。
