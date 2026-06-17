// TDnet 適時開示キャッチアップ CLI。日次オーケストレータから呼ぶ薄いラッパー。
import "dotenv/config";
import { runIrCatalogCatchup } from "../../src/cron/ir-catalog-tdnet.js";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not configured");
  const r = await runIrCatalogCatchup(url);
  console.info("[ir-tdnet]", JSON.stringify(r));
}
main().catch((e) => { console.error("[ir-tdnet] エラー:", e); process.exit(1); });
