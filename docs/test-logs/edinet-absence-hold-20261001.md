# EDINETコードリスト不在のHOLD化

## 原因と修正

月次master_syncは「上場区分=上場かつ証券コードがある」行だけを変換する。その集合にない既存コードを、Notion①とローカル①のlisted=Falseへ変更していた。証券コード欠損や上場区分の差が上場廃止の効力発生と同一視され、取得対象を誤って落とす経路だった。

不在集合は件数とコードごとのHOLD警告に変更し、既存listed/statusを保持する。既存マップ取得失敗時の診断省略、異常縮小のcoverage失敗、limit時の診断省略は維持。sole callerを確認し、不要になったNotion更新・runner・ローカルSQLのabsence専用helperとその鏡テストを削除した。

既存の開示由来status更新は変更しない。ただし、このPython経路の効力発生後の取得停止は未実装で、CSV不在をその代替にしない。JPX公式イベントを所有するcore_stocks.is_activeは変更していない。既に誤ってlisted=Falseとなった本番行の復旧は本変更では実施していない。

## 実原本による回帰

保存済の2026-06-10 Edinetcode.zipを使用。実在する上場行2件のうち1件の証券コードだけを空にし、他方の上場区分だけを非上場へ変えた。金融値や新規識別子は作成していない。

同じ正常master実行経路で原本保管→変換→候補検査→マスタ同期→不在診断を通し、両既存行への更新0・listed=True保持・HOLD2件と個別コード警告を確認。異常縮小によるcoverage失敗の既存回帰も維持した。

- Nix / uv offline: 関連232件PASS、未配置TDNET原本による2件skip。
- Nix / uv offline: パイプライン1510件PASS、未配置実原本による58件skip。
- 変更Python8ファイルのruff PASS、diff --check PASS。

外部取得・Notion・D1/R2書込・dispatchは0。新規上場の証券コードとEDINETコードの未確定対応を埋めた変更ではない。622AのFSA/JPX区分差と646Aの対応不足は引き続きHOLD。
