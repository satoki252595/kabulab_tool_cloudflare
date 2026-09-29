# EDINET observability 最小設定 — 検証記録 (2026-09-30)

## 背景

Cloudflare ダッシュボードの kabulab-cf Workers Observability が無効のため、
9/29 EDINET POST 276s ECONNRESET の履歴トレースは取得不可。
追加証拠 (Cloudflare 標準 Metrics 9/29 17:00–17:08 UTC): invocation 1、
Client Disconnected/Cancelled 1、wall 275.7s、CPU 4.9s、Worker errors 0。
run36600267379 の 276s ECONNRESET と一致 (Issue #98 へ記録済み)。
ただし切断主体・停止 await は未確定であり、本変更は 9/29 履歴の確定原因
ではなく次回標準実行の段階特定用である。

## 編集前の秘密監査 (HOLD なし)

- 全 inbound ルート (portal `/`、001〜007 サービス、`/api/ingest/*`) の
  query 引数は絞込・ページング・コード・日付のみ。認証はすべて
  `Authorization: Bearer` ヘッダ (`CRON_SECRET` / `VOCAB_REVIEW_TOKEN`)。
- 唯一の例外は `/api/ingest/yahoo` の `u` で、外部 URL (Yahoo API の素の
  URL) を取る。受理ホストは query1/2.finance.yahoo.com に allowlist され、
  crumb/cookie はエッジ側 (`yahooFetchDirect`) で付与するため `u` 自体に
  秘密は含まれない。
- Worker 到達の console 出力は docID/ticker/tdnetId/件数・時刻のみ。
  Yahoo 系エラー経路は `redactYahooDiagnostic` で redact 済み (既存テストあり)。
  EDINET エラー文にキーは含まれない。
- EDINET 外向き URL は `Subscription-Key` を query に含むため
  `[observability.traces]` は `enabled = false` のまま。

## 変更

- `wrangler.toml` に `[observability]` / `[observability.logs]` /
  `[observability.traces]` を追加 (依存追加なし)。
- `src/observability-config.test.ts` で上記 3 点を固定 (traces 無効が要点)。
- `src/cron/yuho-edinet.ts` の `runYuhoEdinetCatchup` に秘密なしの進捗
  checkpoint を 5 箇所追加 (開始 / 日ごとの list / custody 照会 / 通ごとの
  ingest / 投影再生成)。各 await 直前の入口のみで、日付・件数・docID だけを
  出し URL/キー/ヘッダ/本文は出さない。前段完了は次の checkpoint または
  既存の完了 summary で判る。retry/timeout/業務処理は不変。
- `src/cron/yuho-edinet.test.ts` に checkpoint の順序・秘密なしを固定する
  テストを 1 件追加 (外部は既存どおり mock、ライブ EDINET POST なし)。
- `docs/release-notes.md` の 2026-09-30 に 1 行追記 (#188 と共存)。

## 検証

- `nix develop -c wrangler deploy --dry-run`: 成功。
- `pnpm vitest run src/observability-config.test.ts src/cron/yuho-edinet.test.ts`:
  PASS (新 1 件含む)。
- `pnpm typecheck` / `pnpm lint`: 成功。
- 既存の関連テスト (`src/cron/ingest-universe.test.ts`、
  `src/routes/ingest-proxy.test.ts`、`src/shared/auth.test.ts`): PASS
  (全体 `pnpm test` は CI で確認)。
- ライブ EDINET POST は未実行 (次回標準実行で段階特定する)。
