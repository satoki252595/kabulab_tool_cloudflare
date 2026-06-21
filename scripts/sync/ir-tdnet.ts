// TDnet 適時開示キャッチアップ CLI（ADR-0001: Node 実行 + D1 HTTP API 書込）。
//
// ir-catalog の取込は PDF センチメントが kuromoji(Node 専用)依存で Worker 化不可。
// そこで Node で実行し、D1 へは D1 HTTP API(drizzle sqlite-proxy)で書く。読取は
// Worker のバインディングが担う。
//
// 必要env(.env): EDINET 不要 / CLOUDFLARE_API_TOKEN・CLOUDFLARE_ACCOUNT_ID・
//                D1_DATABASE_ID(D1書込) / NOTION_*(ルール6) / 取込元 TDnet は鍵不要。
import "dotenv/config";
import { createD1HttpDb } from "../../src/shared/db/d1-http-client.js";
import * as irSchema from "../../services/ir-catalog/src/db/schema.js";
import { runIrCatalogCatchup } from "../../src/cron/ir-catalog-tdnet.js";
import type { Database } from "../../services/ir-catalog/src/db/client.js";

async function main(): Promise<void> {
  // sqlite-proxy(D1 HTTP) と D1 バインディング版は同じ async SQLite クエリビルダ
  // API を持つ(共に BaseSQLiteDatabase)。型クラスのみ異なるためキャストで橋渡し。
  const db = createD1HttpDb(irSchema) as unknown as Database;
  const r = await runIrCatalogCatchup(db);
  console.info("[ir-tdnet]", JSON.stringify(r));
}

main().catch((e) => {
  console.error("[ir-tdnet] エラー:", e);
  process.exit(1);
});
