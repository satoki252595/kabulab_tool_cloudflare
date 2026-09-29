# EDINET observability 最小設定 — 検証記録 (2026-09-30)

## 背景

Cloudflare ダッシュボードの kabulab-cf Workers Observability が無効のため、
9/29 EDINET POST 276s ECONNRESET の履歴トレースは取得不可。
本変更は将来の標準呼出ステータス + 既存 console ログを残す最小構成のみ。

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
- `docs/release-notes.md` の 2026-09-30 に 1 行追記。

## 検証

- `nix develop -c wrangler deploy --dry-run`: 成功 (tail logs 出力あり)。
- `pnpm vitest run src/observability-config.test.ts`: 2 件 PASS。
- `pnpm typecheck` / `pnpm lint`: 成功。
- 既存の関連テスト (`src/routes/ingest-proxy.test.ts`、`src/shared/auth.test.ts`):
  PASS (全体 `pnpm test` は CI で確認)。
