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
  headersTimeout 300 秒と一致し、Worker が全 catchup（`TIME_BUDGET_MS`=300 秒の
  走査＋無制限の投影再生成＋Notion 遅延）を終えて初めて応答するため、
  作業量の多い日は系統的に発火する。
- run36156111106: `TypeError: fetch failed` ＋ `read ECONNRESET`。
  要求開始 15:57:19 → 発火 16:01:28（約 249 秒）。一過性の TCP 切断。
  トリガに再試行が無いため、そのままジョブ失敗になっていた。

`edinet/client.ts` への GET 再試行は「必要なら」の条件付きだったが、観測された
失敗経路を直さず、Worker 内の backoff は `TIME_BUDGET_MS` を消費して
headers timeout を悪化させるため採用しない。再試行は失敗 caller（トリガ）の
共通 1 点にだけ置く。

## #98 修正

`postCatchup()` を抽出し、`fetch` 自体の throw（切断・タイムアウト等）に限り
最大 3 試行（待ち 10 秒・30 秒）で再試行する。catchup は docId/Notion 冪等で
再開可能であり、部分成果は文書単位で残るため、切り直しは残件から進む。
HTTP 応答が返った場合（5xx 含む）は再試行せず即 throw（従来どおり）。
上限到達時は試行回数と元エラーを残して throw（成功化しない）。
エラー文に URL・認証情報を含めない。CLI の env・引数・終了コードは不変。
テスト用に `fetchFn` / `sleep` を注入可能にし（jev クライアントと同方式）、
import 時の誤実行防止ガードは `scripts/moneyflow/ingest.ts` と同方式。

回帰（`scripts/sync/yuho-edinet.test.ts`、6 件。CI で常時実行）:

- 初回 200 は 1 回だけ叩く（従来どおり）。
- ECONNRESET×2 → 200 で成功（3 呼び出し・待ち `[10000, 30000]`）。
- HeadersTimeoutError → 200 で成功（2 呼び出し・待ち `[10000]`）。
- 3 回連続失敗で `3 回試行後も失敗` を throw（可視のまま）。
- HTTP 500 は再試行せず即 throw（マスクしない）。
- エラー文に URL・認証情報を含めない。

#98 は後続の同一ジョブ成功と実体保管の再読確認まで open 維持。

## 検証記録

- `nix develop -c pnpm vitest run services/vwap-analysis/lib/margin.test.ts
  scripts/sync/yuho-edinet.test.ts`: 14 passed（実 PDF 1 件含む）。
- `nix develop -c pnpm typecheck`: clean。`pnpm lint`: clean。
- 再現スクリプト（`/tmp/repro-margin-detach.ts`、commit 外）:
  修正前の呼び出し順で `len 873311 → 0` となり `空ファイルはアップロード
  できません: margin-2026-09-18.pdf` を再現。修正後は実 PDF の回帰テストで
  `len・SHA 不変` とアップロード引数の一致を確認。
- 依存追加なし。本番 Notion / D1 への書き込みなし（fixture・再現はローカルのみ）。
