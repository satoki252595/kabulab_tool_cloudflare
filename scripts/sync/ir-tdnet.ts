// TDnet 適時開示キャッチアップ CLI（Node 実行 + D1 HTTP API 書込）。
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
import { resumeNotionByStock } from "../../services/ir-catalog/src/services/ingest.js";
import type { Database } from "../../services/ir-catalog/src/db/client.js";

async function main(): Promise<void> {
  // sqlite-proxy(D1 HTTP) と D1 バインディング版は同じ async SQLite クエリビルダ
  // API を持つ(共に BaseSQLiteDatabase)。型クラスのみ異なるためキャストで橋渡し。
  const db = createD1HttpDb(irSchema) as unknown as Database;
  const args = process.argv.slice(2);
  const dates = args.map((a) => /^--resume-(from|to)=(\d{4}-\d{2}-\d{2})$/.exec(a));
  let r;
  if (args.length > 0) {
    if (args.length !== 2 || dates.some((m) => m === null)
      || new Set(dates.map((m) => m![1])).size !== 2) {
      throw new Error("再開は --resume-from=YYYY-MM-DD --resume-to=YYYY-MM-DD の両方が必要です。");
    }
    const fromDay = dates.find((m) => m![1] === "from")![2]!;
    const toDay = dates.find((m) => m![1] === "to")![2]!;
    const from = new Date(`${fromDay}T00:00:00+09:00`);
    const to = new Date(`${toDay}T00:00:00+09:00`);
    if (new Date(from.getTime() + 9 * 3600_000).toISOString().slice(0, 10) !== fromDay
      || new Date(to.getTime() + 9 * 3600_000).toISOString().slice(0, 10) !== toDay) {
      throw new Error("TDnet 再開期間に存在しない日付があります。");
    }
    r = await resumeNotionByStock(db, from, new Date(to.getTime() + 86400_000));
  } else {
    r = await runIrCatalogCatchup(db);
  }
  console.info("[ir-tdnet]", JSON.stringify(r));
}

main().catch((e) => {
  console.error("[ir-tdnet] エラー:", e);
  process.exit(1);
});
