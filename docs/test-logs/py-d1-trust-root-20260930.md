# Python D1 trust root 最小修正 + sector snapshot gate (2026-09-30)

`D1Store` の応答・bind 信頼境界を厳格化し、sector job の current active
snapshot に完全性 gate を追加する。API 形・default retry は不変。
offline 検証のみ。D1 実送・source・Notion・R2・dispatch 0。

## `query` 応答の厳密検査

- body は dict 必須。top `success` は literal `True` のみ
  (1・"true"・欠落は `D1 エラー`)。
- `result` は list exact 1 必須。entry は dict + `success is True` 必須。
- `results` は list 必須。各行は dict 必須。
- 空 `results` は正常 (行なし SELECT・書込の空応答)。欠落とは区別する。
- entry の拡張 key (meta 等) は許す。

## bind の有限スカラー検査 + max100

- 許すのは None・str・int・有限 float のみ。送信前に検査し sends 0。
- bool は実呼び出しが 0/1 の int で渡すため拒否する
  (int subclass の黙殺をしない)。NaN/inf・複合型も拒否。
- 件数上限 100 は維持 (ちょうど 100 は送る)。
- params 容器は list か None が必須。dict・str・tuple は
  scalar loop を素通しして JSON params の形を崩すため送らず弾く
  (実呼び出しは list のみ)。

## `upsert` の全行事前検査

- 既存の全行幅検査に加え、全行×全列の有限検査を最初の chunk 送信より
  前に行う。`query` と同じ helper を再利用する。
- 後半 chunk の NaN でも sends 0 (前半 chunk の部分送信なし)。
- rows 全体・各行は list 形が必須。str 行は幅一致でも文字 flatten
  するため幅検査より先に弾く (sends 0)。

## `database_file_size` 兄弟も同格

- dict 応答・literal True・result dict を必須にする。
  file_size/num_tables の既存検査 (非 bool・非負 int) は維持。

## sector job の snapshot gate

- current active snapshot の空・非 dict 行・code/sector33 欠落・
  非正準 code・phantom・sector33 非 str/非 None・code 重複は
  `invalid-current-stop` の prewrite STOP (書込 0)。
- code は標準 `parse_stock_code` の正準形と一文字ずつ一致が必須
  (5 桁 source 形・trim 差・表記揺れは STOP)。重複は正準 ID で見る。
  `0000` は標準 helper が通す phantom のため明示除外する。
- sector33 は str/None の構造型のみ許す (dict/list の hash 不能・
  数値の不正 DB 形を writer 前に STOP)。未知文字列・None は
  retain + gap (partial) のまま (NULL 消去しない方針は維持)。
- 診断 taxonomy に `invalid-current-stop` を追加。

## 検証 (offline)

- `pipeline: ruff + pytest` 全緑 (1571 passed / 0 failed / 58 skipped)。
- 既存 double の非現実形 (`result: []`・entry success 欠落) を実 API 形
  (`result: [{success: true, results: []}]`) へ是正。
- 新規: 応答異常 15 形・bind 8 形 (sends 0)・境界 100・upsert 後半 NaN
  (sends 0)・upsert 非 scalar 3 形・容器異常 9 形 (params 4・rows 5、
  sends 0)・file_size 厳格 5 形・sector gate
  (空・重複・空/不正 code 5 形・非正準 code 5 形・sector33 構造型 5 形・
  不完全行 5 形・retain 対照)。
- 既存 1 件の seed を新契約へ更新 (`test_unmapped_nontarget_hold` に
  active 行を追加。空 snapshot は STOP が正のため。assert 内容は不変)。
