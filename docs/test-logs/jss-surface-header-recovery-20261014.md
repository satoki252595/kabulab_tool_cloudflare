# JSS の認証後レスポンス識別ヘッダ修復（2026-10-14）

## 確認できた不具合と修正

既存 `jss-api-private` の本番認証検証で、正しい Cloudflare 内部の鍵を使う REST は成功した一方、MCP `initialize` が `X-Surface: private` の配信契約に違反した。HTTP 200 と JSON-RPC の protocol/capabilities/serverInfo はローカル現行アプリで成功し、識別ヘッダだけが欠けることを再現した。

`private.ts` は `await next()` より前に `c.header()` を設定していた。Hono 4.6.14 はこの段階のヘッダを preparedHeaders に置くため、`handleMcp()` が直接返す `Response` に適用されない。認証済みの処理を終えてから同じヘッダを付けるよう、既存 middleware の1行を移動した。

全 caller を確認した。MCP の initialize/initialized/tools-list/tools-call/エラーと、共通の原本 content が raw `Response` を返す。公開面は既に `await next()` 後に識別ヘッダと CORS を付与しているため、公開面のコード修正は不要だった。認証拒否の早期 return と health の認証例外は既存のまま。

## 検証と範囲

`test/surface-header.test.ts` の1回帰で、MCP initialize の HTTP/JSON-RPC/規定 protocol・capabilities・serverInfo と識別ヘッダ、REST、無認証401、private/publicの原本 stream・Content-Type・Cache-Control・公開 CORS を確認する。試験は空の transport stream と一時的なローカル試験用資格情報を使い、市場データや上流通信を追加しない。

- Cloudflare の既存鍵を取得・表示・ローカル保存・ローテートしない。
- 新しい無認証 API、依存、D1/R2書込、モデル呼出しは追加しない。
- 通常リクエストの通信・CPU・保存の増分はない。
- 本番の全8 MCP tools と対応RESTの通し検証は、この修正の CI/main 受入・既存 Worker への反映後に行う。ローカル回帰の成功を本番完了と扱わない。

## 検証入口で見つかった別の条件

一時検証版は `versions upload` の無配分 version と固定宛先/固定 case、256bit nonce の hash と15分 expiryを使用する。値・header・生 body・例外本文は出力せず、失敗時は再送せず保全停止する。

`.env` の D1 用 `CLOUDFLARE_API_TOKEN` が既存 Wrangler OAuth を上書きすると、Worker metadata の入口で停止した。env-file 全変数を保持してこの token だけ子 process から除くと metadata 読取が成功し、auth context が単独原因と確認した。秘密値や権限を変更せず、既存 OAuth 経路を使用する。

installed Wrangler 3.99 の workerd では Worker 内の `redirect: "error"` が送信前に TypeError となった。実保存 health と通信を遮断したローカル再現で `manual` は200、Location付き302は追従せず厳密な status 検査で拒否することを確認した。一時検証 Worker だけを `manual` に固定し、外側 Node runner の `error` は維持した。この入口修正は本番アプリの変更ではない。

private evidence は `tmp/feature-audit-20261013/jss-auth-probe*/` の原稿/pins/移行/無配分版の停止 receipts と `jss-auth-probe-manual/local-mcp-header-diagnosis.json`。原文・鍵・nonce 値は Git に追加しない。

根拠: [Cloudflare Version URLs](https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/)、[Request の redirect と header 転送](https://developers.cloudflare.com/workers/runtime-apis/request/)、[同zone fetch の compatibility flag](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public)。
