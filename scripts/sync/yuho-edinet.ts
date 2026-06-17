// 有報(EDINET)キャッチアップ CLI。日次オーケストレータから呼ぶ薄いラッパー。
import "dotenv/config";
import { runYuhoEdinetCatchup } from "../../src/cron/yuho-edinet.js";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not configured");
  const r = await runYuhoEdinetCatchup(url);
  console.info("[yuho-edinet]", JSON.stringify(r));
}
main().catch((e) => { console.error("[yuho-edinet] エラー:", e); process.exit(1); });
