# 週次信用残の空アップロードと EDINET catchup 切断の修正（2026-09-28）

対象: #117（vwap-ingest の `空ファイルはアップロードできません: margin-2026-09-18.pdf`）、
#98（catchup の EDINET `fetch failed` / `ECONNRESET`）。追跡 Ref #132。
JPX 信用残の日次化・投資部門新様式は 9/29 へ延期のため触らない。
本 wave は実機検証のみで本番 Notion / D1 へ書き込まない（共有 writer 稼働中のため保留）。

## #117 根因（実証済み）

失敗 run36245100733 のスタックは `ingest-margin.ts:22 recordPrimaryData` →
`file-upload.ts:169 uploadFile` の空判定。連鎖は以下（すべて実コード・実 PDF で追跡）:

1. `services/vwap-analysis/lib/margin.ts` の `fetchMargin()` が取得直後の `bytes` を
   `getDocumentProxy(bytes)` へ直接渡していた。
2. unpdf（pdf.js）は渡された `Uint8Array` の `ArrayBuffer` を worker へ transfer して
   **detach** する。実 PDF（#117 と同一週の `syumatsu2026091800.pdf`、873,311 bytes、
   SHA256 `21c99f4e…c52131d`）で再現スクリプトを実行し、
   `len 873311 → 0`、`sha 21c99f4e… → e3b0c442…`（空の SHA256）になることを確認。
   解析自体は成功する（`week=2026-09-18 rows=4230`）ため、R2 書き込みまでは進み、
   Notion 実体アップロードだけが空で落ちる。これが CI の失敗文と完全一致した。
3. `pdfBytes: bytes`（detach 済み）が `marginArchiveInput()` 経由で `uploadFile` に
   渡り、「空ファイルはアップロードできません」で throw。

HTTP/PDF 検証の不足も疑ったが、失敗 run は解析・R2 書き込みの後（22 行目）で
落ちており、取得・解析は成功していたため今回の実原因ではない（修正対象外）。

## #117 修正

`margin.ts` に `parseMarginPdf(bytes)` を抽出し、`getDocumentProxy` へは
`bytes.slice()` のコピーを渡す。moneyflow の `pdf-text.ts` /
`scripts/moneyflow/lib/run-spec.ts` と同じ detach 対策パターンの再利用。
`fetchMargin()` は同関数経由に変更（1 行の根因修正 + テスト用の抽出のみ）。
`ingest-margin.ts` の変更は不要（呼び出し形は不変）。

回帰（`lib/margin.test.ts`、計 3 件追加）:

- 合成 PDF（常時実行）: 解析後も入力が nonzero かつ SHA 不変。
- 合成 PDF（常時実行）: `marginArchiveInput().files[0].bytes` が原本と同一参照で
  nonzero（`uploadFile` の空判定を通過できる）。
- 実 PDF（`services/vwap-analysis/tests/fixtures/`、未取得環境は skip。
  personal-only のため repo へ commit しない。moneyflow と同じ運用）:
  `bytes=873311`・SHA256・`week=2026-09-18`・`rows=4230` が解析後も不変で、
  アップロード引数（`margin-2026-09-18.pdf`）と一致する。

陰性対照: `bytes.slice()` を外すと 3 件とも `expected +0 to be 873311` 等で
失敗することを確認（detach 症状そのものを検出する）。修正後は全 8 件通過。

運用: R2 の `margin/2026-09-18.json` は書き込み済みだが、Notion 一次データが
未記録。修正後に `ingest:vwap-margin` の再実行（または当該週の再保管）が必要。
#117 は実体保管の再読確認まで open 維持。

## #98 根因（実証済み）

失敗 caller はいずれも `scripts/sync/yuho-edinet.ts:27` の Worker への POST
（EDINET API への GET ではない）。EDINET 側 GET（`listDocuments` /
`downloadDocument`）は Worker 内で日・文書単位に catch され、60 日窓 +
docId 冪等で翌日以降に自己回収されるため、Actions を赤にできない。

- run36022119851: `TypeError: fetch failed` ＋ `HeadersTimeoutError`。
  要求開始 15:57:20 → 発火 16:02:22（約 302 秒）。Node（undici）の既定
  headersTimeout 300 秒と一致する。Worker の `TIME_BUDGET_MS`=300000 は
  文書の合間でしか確認されず、文書単位の Notion 保管や末尾の投影再生成で
  超過し得る。応答は全 catchup の完了後に 1 回だけ返るため、作業量の多い
  日は 300 秒超が正当であり、系統的に発火する。
- run36156111106: `TypeError: fetch failed` ＋ `read ECONNRESET`。
  要求開始 15:57:19 → 発火 16:01:28（約 249 秒）。peer/ネットワーク側の
  一過性切断であり、timeout とは別の失敗経路として可視のまま残す。
  完全復旧は主張しない。

`edinet/client.ts` への GET 再試行は観測された失敗経路を直さず、Worker 内の
backoff は `TIME_BUDGET_MS` を消費して headers timeout を悪化させるため
採用しない。

## #98 修正（単発要求。再送は撤去）

当初はトリガに限定再試行を入れていたが、レビューで unsafe と判定し撤去した。
Worker 側に永続リース/要求冪等が無く、docId SELECT→取込・Notion key照会→
作成は競合し得る。D1 書込が保管より先なので、D1 存在スキップは Notion 完了を
証明しない。二重 POST は二重取込・二重保管を起こし得る。

`postCatchup()` は node:https による単発要求のみ送る。`agent: false`（都度接続）、
ヘッダ＋本文全体に `AbortSignal.timeout(600000)` の明示期限をかけ、
本文を最後まで受ける。undici 内部の import・依存追加・global dispatcher の
変更はしない。非 2xx（3xx の追従なし）・要求エラー・応答中断・不完全切断・
期限切れはすべて throw（成功化しない — ルール2）。切断は可視のまま残し、
運用（次回定期実行の 60 日窓による自己回収・手動再実行）に委ねる。
エラー文に URL・認証情報・ヘッダを含めず、https 層の元エラーはホスト名を
埋め込むことがあるため cause としても残さない（code/name のみ記録）。
CLI の env・引数・終了コードは不変。http は非対応（repo に localhost 規約なし）
で即失敗する。import 時の誤実行防止ガードは `scripts/moneyflow/ingest.ts`
と同方式。

回帰（`scripts/sync/yuho-edinet.test.ts`、6 件。実 TLS サーバに対する
transport チェック。CI で常時実行。openssl で自己署名を生成）：

- 期限内（300ms 遅延・期限 10 秒）の応答に成功し、要求回数が正確に 1。
- 期限切れ（無応答・期限 300ms）で `期限切れ` を throw し、要求回数が 1。
- 途中切断（ヘッダ＋部分本文後に destroy）で失敗し、要求回数が 1。
- HTTP 500 は status のみで失敗し（上流本文は untrusted のため載せない）、要求回数が 1。
- エラー文・cause に秘密・ホスト・パスを含めない。
- http URL は要求を送らず即失敗する（要求回数 0）。

陰性対照: 一時的に再送を注入すると要求回数が 2 になり検出されることを確認。
3 回連続実行で全件安定（flaky なし）。

#98 は後続の同一ジョブ成功と実体保管の再読確認まで open 維持。
ECONNRESET 系の一過性切断は本修正後も可視のまま失敗し得る（運用残件）。

## 検証記録

- `nix develop -c pnpm vitest run services/vwap-analysis/lib/margin.test.ts
  scripts/sync/yuho-edinet.test.ts`: 14 passed（実 PDF 1 件・transport 6 件含む）。
  全スイート 187 files / 2576 passed / 0 failed。
- `nix develop -c pnpm typecheck`: clean。`pnpm lint`: clean。
- 再現スクリプト（`/tmp/repro-margin-detach.ts`、commit 外）:
  修正前の呼び出し順で `len 873311 → 0` となり `空ファイルはアップロード
  できません: margin-2026-09-18.pdf` を再現。修正後は実 PDF の回帰テストで
  `len・SHA 不変` とアップロード引数の一致を確認。
- 依存追加なし。本番 Notion / D1 への書き込みなし（fixture・再現はローカルのみ）。
