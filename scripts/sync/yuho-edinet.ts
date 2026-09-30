/** EDINET 日次取込。Node から既存 D1 HTTP/atomic sender で共通処理を直接 await。 */
import "dotenv/config";
import { fileURLToPath } from "node:url";
import { createD1HttpDb, createD1HttpBatchSender } from "../../src/shared/db/d1-http-client.js";
import { notionEnv } from "../../src/shared/notion-archive/env.js";
import { yuhoEnv } from "../../services/yuho-quant/src/env.js";
import * as yuhoSchema from "../../services/yuho-quant/src/db/schema.js";
import type { Database } from "../../services/yuho-quant/src/db/client.js";
import { runYuhoEdinetCatchup, catchupHttpStatus, type ShardOpts } from "../../src/cron/yuho-edinet.js";

export function parseShard(args: readonly string[]): ShardOpts | undefined {
  if (args.includes("--part") || args.includes("--of")) throw new Error("part/of は --part=N --of=N で指定してください");
  const values = (key: string) => args.filter(a => a.startsWith(`--${key}=`)).map(a => a.slice(key.length + 3));
  const parts = values("part"), ofs = values("of");
  if (parts.length === 0 && ofs.length === 0) return undefined;
  if (parts.length !== 1 || ofs.length !== 1 || !/^\d+$/.test(parts[0]) || !/^\d+$/.test(ofs[0])) {
    throw new Error("part/of は各1個の非負整数で指定してください");
  }
  const part = Number(parts[0]), of = Number(ofs[0]);
  if (!Number.isSafeInteger(part) || !Number.isSafeInteger(of) || of <= 0 || part >= of) {
    throw new Error("part/of は 0<=part<of の安全な整数で指定してください");
  }
  return { part, of };
}

export async function main(args = process.argv.slice(2)): Promise<0 | 1> {
  const shard = parseShard(args);
  // 全必須設定を最初の読取・取得・書込より前に検査。Worker/cron 認証は不要。
  yuhoEnv.EDINET_API_KEY();
  notionEnv.NOTION_TOKEN();
  notionEnv.NOTION_ARCHIVE_PAGE_ID();
  notionEnv.NOTION_YUHO_TEXT_DB_ID();
  const db = createD1HttpDb(yuhoSchema) as unknown as Database;
  const sender = createD1HttpBatchSender();
  const result = await runYuhoEdinetCatchup(db, shard, sender);
  console.info("[yuho-edinet]", JSON.stringify(result));
  return catchupHttpStatus(result) === 200 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = 2;
  try {
    process.exitCode = await main();
  } catch {
    // 上流例外にキーやURLが含まれ得るため本文を標準出力へ転記しない。
    console.error("[yuho-edinet] 失敗: 完了せず停止しました（再送なし）");
  }
}
