/** EDINET 日次取込。Node から既存 D1 HTTP/atomic sender で共通処理を直接 await。 */
import "dotenv/config";
import { fileURLToPath } from "node:url";
import { createD1HttpDb, createD1HttpBatchSender } from "../../src/shared/db/d1-http-client.js";
import { notionEnv } from "../../src/shared/notion-archive/env.js";
import { yuhoEnv } from "../../services/yuho-quant/src/env.js";
import * as yuhoSchema from "../../services/yuho-quant/src/db/schema.js";
import type { Database } from "../../services/yuho-quant/src/db/client.js";
import { runYuhoEdinetCatchup, catchupHttpStatus, type ShardOpts } from "../../src/cron/yuho-edinet.js";
import { sharedEnv } from "../../src/shared/env.js";
import { createHoldingPriceSourceLoader } from "./holdings-price-sources.js";
import { assertCatchupDeadline, validateCatchupLaunch } from "./catchup-launch.js";

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
  const deadline = validateCatchupLaunch("edinet");
  const shard = parseShard(args);
  // 定時だけ残時間を使う。最後の10分は開始済unitの閉鎖・checkpoint/L2/価格に残す。
  const sourceStartDeadlineMs = deadline === undefined ? undefined : deadline - 10 * 60_000;
  if (sourceStartDeadlineMs !== undefined && Date.now() >= sourceStartDeadlineMs) {
    console.info("[yuho-edinet]", JSON.stringify({ status: "deferred_time_budget", sourceStarted: false,
      sourceStartDeadlineMs, deadlineMs: deadline, complete: false }));
    return 1;
  }
  // 全必須設定を最初の読取・取得・書込より前に検査。Worker/cron 認証は不要。
  yuhoEnv.EDINET_API_KEY();
  notionEnv.NOTION_TOKEN();
  notionEnv.NOTION_ARCHIVE_PAGE_ID();
  notionEnv.NOTION_YUHO_TEXT_DB_ID();
  if (!shard) {
    sharedEnv.R2_ACCOUNT_ID(); sharedEnv.R2_ACCESS_KEY_ID(); sharedEnv.R2_SECRET_ACCESS_KEY(); sharedEnv.R2_BUCKET();
  }
  const db = createD1HttpDb(yuhoSchema) as unknown as Database;
  const sender = createD1HttpBatchSender();
  const loader = shard ? undefined : createHoldingPriceSourceLoader();
  const result = await runYuhoEdinetCatchup(db, shard, sender, loader, deadline,
    sourceStartDeadlineMs === undefined ? { observeIssuedShares: true } : { observeIssuedShares: true, sourceStartDeadlineMs });
  assertCatchupDeadline(deadline);
  console.info("[yuho-edinet]", JSON.stringify(result));
  return catchupHttpStatus(result) === 200 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = 2;
  try {
    process.exitCode = await main();
  } catch (error) {
    // 自前の固定文言だけを原因コードにする。任意例外の本文/URL/SQL/bindは出さない。
    const known = new Map([
      ["EDINET 未確定 in-flight が残っています。読取照合が必要です (再送なし)。", "checkpoint_inflight"],
      ["EDINET checkpoint CAS が不一致 (再送なし)", "checkpoint_cas"],
      ["EDINET checkpoint CAS ACK が不一致 (再送なし)", "checkpoint_ack"],
      ["EDINET日付一覧の実添付が不一致です。", "snapshot_attachment"],
      ["EDINET保存日付一覧の取得に失敗しました (再送なし)。", "snapshot_download"],
      ["EDINET日付一覧gzip SHA不一致。", "snapshot_gzip_sha"],
      ["EDINET日付一覧原HTTP本文のbytes/SHA不一致。", "snapshot_raw_sha"],
      ["EDINET保存日付一覧のdate/type/件数が不一致", "snapshot_list"],
      ["EDINET変更観測の原本/保存内容が不一致です（再送なし）", "reported_observation_mismatch"],
      ["EDINET変更観測の保存全量が不一致です（再送なし）", "reported_observation_count"],
    ]);
    const code = error instanceof Error ? known.get(error.message) : undefined;
    console.error(`[yuho-edinet] 失敗: code=${code === undefined ? "unknown" : code} 完了せず停止しました（再送なし）`);
  }
}
