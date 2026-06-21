/**
 * 日次データ取得トリガ (CLI) — ADR-0001 Phase 3。
 *
 * 実体の取込は Worker 上で実行する (Yahoo エッジ直叩きで 429 回避・D1 binding +
 * db.batch)。本スクリプトは認証付きルート POST /admin/sync-daily を **シャード毎に
 * 叩く薄いトリガ** で、手動実行・バックフィル用。通常運用は Workers Cron が自動発火する
 * (wrangler.toml [triggers] crons → src/cron/scheduled.ts)。
 *
 * 母集団 (core_stocks) が空/古い場合は先に `pnpm sync:universe` を実行すること
 * (JPX の xlsx パースは Node 専用のため Worker 取込には含まれない)。
 *
 * 実行:
 *   pnpm sync:daily            # 全 4 シャードを順に叩く
 *   pnpm sync:daily --part=0   # 単一シャードのみ
 */

import "dotenv/config";

/** wrangler.toml の日次 cron 数 (= scheduled.ts の DAILY_OF) と一致させる */
const OF = 4;

async function main(): Promise<void> {
  const base = process.env.WORKER_BASE_URL;
  const secret = process.env.CRON_SECRET;
  if (!base) throw new Error("WORKER_BASE_URL が設定されていません (.env)");
  if (!secret) throw new Error("CRON_SECRET が設定されていません (.env)");

  const partArg = process.argv.find((a) => a.startsWith("--part="));
  const parts = partArg
    ? [Number(partArg.slice("--part=".length))]
    : Array.from({ length: OF }, (_, i) => i);

  for (const part of parts) {
    const url = `${base.replace(/\/$/, "")}/admin/sync-daily?part=${part}&of=${OF}`;
    console.info(`[sync-daily] POST ${url}`);
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
    });
    const body = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 500)}`);
    }
    console.info(`[sync-daily] shard ${part}/${OF}:`, body);
  }
}

main().catch((e) => {
  console.error("[sync-daily] エラー:", e);
  process.exit(1);
});
