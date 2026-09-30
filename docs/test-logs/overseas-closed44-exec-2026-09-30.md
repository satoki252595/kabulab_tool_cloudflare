# 海外 closed-44 修復 PREP (2026-09-30・実データ WRITE 0)

## SOL が修正した境界

初版の DELETE/UPDATE 部分 WHERE と unique 衝突による競合判定は不十分だった。
文書だけ変わった場合や一部 fact だけ変わった場合に、削除と新規挿入が
混在し得るため採用しない。修正版は各 atomic batch の先頭で full16 文書と
all12 facts (runtime id / documentId / stockId 含む) を frozen JSON に対して
件数と両方向 EXCEPT で照合する。不一致は JSON1 エラーを投げ、DML 前に停止。
その後は通常の DELETE / 全 INSERT / UPDATE。旧 facts の再検査はしない。

own-key 不足や undefined を NULL に補完しない。観測した NULL はそのまま保存。
送出の HTTP / batch / UNIQUE エラーは ABORT を伝播し、no-op や継続へ置換しない。
成功後は全 business fields と文書保護項目を比較する。実際の NEWPOST に同じ
`applyOneDoc` を再入すると MATCH・送信 0 になる。

## 通常 producer とパーサー

通常 ingest、missing-backfill、backfill-overseas は既に文書更新と
DELETE / 全 INSERT を 1 atomic batch に含む。今回の部分ガードは修復 executor
のみの問題であり、通常経路を不要に改造しない。全経路の canonical 保存変換は
既存 `toOverseasSaveRows` を共用する。

既保存 actual ZIP 44 通を通常 `parseOverseasData` で再抽出した。
資格化した numeric12 の62factsと同じ canonical business rows を出力し、
unknown32 も同じ status / honbunFile / facts空で一致した。
YBHC の古い production-table locator は引用メタデータの問題で、現在の
共通パーサーの売上数値選択は資格化済み sales table と一致する。
追加の推測パーサー修正は行わない。32 件の旧値全てが誤りとは主張しない。

## LOCAL 検証

Nix Node22 / Vitest、actual44 private fixture を使い17 tests PASS。
原本再抽出、numeric/unknown 原子適用、実 NEWPOST 再入0、文書/一部fact/
fact runtime id/集合件数の競合時 rollback、HTTP unknown ABORT を検証。
値や会社を捏造した positive seed は使用しない。financial値はログ/Gitへ出さず
件数/正準SHAで比較する。SQLite のテストは doc/fact CAS を対象とし、core親行を
捏造しないため外部 core FK を無効化する（本番 FK 無効化ではない）。
CI に private fixture が無ければ actual 部分を明示 skip。fixture が存在するが
壊れている場合は skip にせず失敗する。

## 未完了の operational scope

CLI は LOCAL PREP のみ。`--live` は送信前に明示 STOPする。
既知59原本/74READ/保管の再実行なし。現時点で live READY / 全適用 0。
bounded D1 target/method/body/counters、全文HTTP保存、physical PRE archive、
scoped10stocks の既存 L2 producer と全 post 検証は次の fixed packet で閉じる。
Node HTTP drizzle から既存 L2 関数を使えるため、Worker 専用が必要とは断定しない。
新しい live grant はこの文書/CLIから発生しない。
