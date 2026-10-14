# 通常Mac Clefの原応答保全・不明時停止

2026-10-14。隔離worktreeの変更候補を、既存Nix shellでoffline検証した。
本番runtimeの更新、モデル起動、金融source取得、Notion/D1通信・書込は行っていない。

通常CLIからだけ共有resident clientのoptional journalを接続する。送信前intent/要求原文と
受理前応答原文をwx/file-fsync/親directory-fsyncで確定する。同じ入力の完成済み記録は
全原文SHA・qid・質問・モデル・manifest・較正・語彙・39本文/4節SHA・doc/FY/pointerを
照合して再利用し、forwardを行わない。判定日は保存時の完了時計を維持する。
未完intentや不明応答は、次runの別銘柄を含め次forwardを停止する。
モデルのaccepted記録はpublisher/ジョブ成功の代用ではない。従来のPRE/CAS/全読戻しと
不明markerを維持し、旧SemIf履歴をClefへ付け替えない。

## 実値と制御入力

`scripts/biztag-local/fixtures/clef-native-1801-S100YDJC.json.gz`は保存済みgold87の
1801/S100YDJC実入力・検証済み確率の必要部分を投影したもの。原典path/SHAと投影範囲は
隣接するprovenance JSONに記録する。四節の原文は同docの保存fullsource itemと全文一致を確認した。
gold原典の四節SHAと現在のordered-tuple SHAはserialize方式が異なるため、混同せず双方を保持する。

応答JSONLは実確率を構造的に再serializeしたテスト入力で、歴史的な原wireとは呼ばない。
新journalの時計・recipe bindingはoffline制御であり、旧本番receiptへの後付けではない。
resident protocolのsplit/破断/異常応答は隔離したfake processで検証し、製品経路へ制御値を渡さない。

## 検証

- UTF-8の日本語途中chunk分割でも原response bytesを保存する。
- intent fsync失敗時はstdin送信0、raw応答fsync失敗/破断時はaccepted0、後続forward0。
- 未完intentは不変で、再起動後に別銘柄へ進むことも拒否する。
- 完成済み出力は実clientのspawnを禁止した状態で再利用できる。
- state/質問/39本文/語彙/model/manifest/較正の変更、raw/qid破損を拒否する。
- 1GiBを超えた保存量では新intentを作らず旧ファイルを保持する。
- publisher ACK不明時は後続モデルと通常review-packet tailを停止する。
- 保存出力再利用の判定日を再開日の前日に固定して保持する。
- 既存のモデル0同期、SemIf/競合caller、kernel排他・通常CLI回帰を維持する。
- 有効応答直後の子終了はjournal接続時だけ受理を止め、既定SemIfの応答契約を保持する。

Nix: 既存`.runtime/mac`のflake/lock、`--offline --no-write-lock-file`。
Node v22.22.2、pnpm 9.15.9。追加依存/環境変数なし。

```text
pnpm exec vitest run scripts/biztag-local src/shared/semif src/shared/jev/policy.test.ts
  services/yuho-quant/src/biztag/{pipeline,process,plan}.test.ts
  services/yuho-quant/src/biztag/competitors/{pipeline,process}.test.ts
  services/yuho-quant/data-scripts/recover-unjudged-competitors.test.ts
11 suites / 214 tests PASS
pnpm exec tsc --noEmit: PASS
owned 8 TypeScript files eslint --max-warnings=0: PASS
git diff --check: PASS
```

通常journalは1file 1MiB/1run 64MiB/全体1GiB、新要求前6MiB予約で停止する。
自動削除や旧出力の無条件取込はしない。900 native要求/90分/RSS等の有限回復予算は
別wrapperで受け入れる条件であり、この回帰はその本番完了や処理速度を保証しない。
