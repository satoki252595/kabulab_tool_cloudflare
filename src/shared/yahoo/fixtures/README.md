# Yahoo保存原本の回帰用fixture

`stock-daily-scopes-20261014.json.gz`は株式run38539360030.1の保存原典から作った
最小必要projection。元HTTP応答bytesではない。全原bodyはprivate物理保管物に保持し、
公開Gitには含めない。provenanceは元sourceSHA/bytesとprojectionSHA/bytesを分離する。

- 8303 Chart: 実在する過去の負adj1行と直近130行だけを元indexで選択。
- 7203 Chart: 正常な最終2行のみ。全5年の新旧同値はprivate原本で別途検査。
- 8303 QuoteSummary: 日次の財務・株数尺度検査・年度売上で使う実raw fieldsだけ。

価格・時刻の生成/補正はない。削除したmeta/result/quote fields、選択index、用途を
provenanceへ固定した。CIのnegativeは実原典の負adj値を別列/直近位置へ置く明示fault injection。
元1221行/異常245行/全文SHAの検査はprivate receiptで固定し、projectionを全原本と偽らない。
署名URL・認証値・HTTP headersは含めず、公開APIや画面のデータ源には使わない。

Yahoo由来データの権利・利用制限をリポジトリのコードライセンスで変更しない。
共有governanceの`personal-only`分類を維持し、内部回帰検証の保存原本として扱う。
一般向けデータ配布、商用の公開データ源、CC0データとしての利用を許諾するものではない。
2026-10-14確認の一次資料: [Yahoo Financeデータ提供方針](https://sg.help.yahoo.com/kb/SLN2310.html)
は再配布禁止を明記し、[Yahoo利用規約](https://legal.yahoo.com/us/en/yahoo/terms/otos/index.html)
も商用reuseを制限する。`personal-only`はこの根拠を踏まえたprojectの運用分類で、
この回帰変更は利用許諾の取得・法的な適用範囲の判断を行うものではない。
