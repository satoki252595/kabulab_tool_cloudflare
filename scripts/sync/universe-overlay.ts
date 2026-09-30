/**
 * 母集団 overlay 単独実行エントリ (Issue #196)。
 *
 * JPX 公式 3 頁を収集・保管 (collector) して core_stocks へ適用する。
 * HOLD 残があれば不完全失敗で非ゼロ終了する (株価 fetch へ進まない)。
 * 本番 LIVE 収集は Root grant があるときにだけ実行すること。
 *
 * 実行:
 *   pnpm sync:universe-overlay [--as-of=YYYY-MM-DD]
 */
import "dotenv/config";
import { fileURLToPath } from "node:url";
import {
  createD1HttpBatchSender,
  createD1HttpDb,
} from "../../src/shared/db/d1-http-client.js";
import { rootCauseMessage } from "../../src/shared/errors.js";
import { runDateKeys } from "../../src/cron/daily.js";
import { collectUniverseOfficialEvents } from "../../src/cron/universe-official-events.js";
import {
  ensureUniverseOverlay,
  withBasicEvidence,
  type OverlayBatchSender,
  type OverlayCollectFn,
} from "../../src/cron/universe-overlay.js";

function parseAsOf(argv: string[]): string {
  const hit = argv.find((a) => a.startsWith("--as-of="));
  if (hit !== undefined) {
    const v = hit.slice("--as-of=".length);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      throw new Error(`--as-of は YYYY-MM-DD: ${v}`);
    }
    return v;
  }
  return runDateKeys(Date.now()).runDate;
}

/** CLI 本体 (daily/monthly と同一 seam。deps 注入で test する)。 */
export async function runUniverseOverlaySync(
  db: ReturnType<typeof createD1HttpDb>,
  input: {
    eligibilityAsOf: string;
    collect?: OverlayCollectFn;
    sendBatch?: OverlayBatchSender;
  }
): Promise<{ applied: boolean; summary: string }> {
  const out = await ensureUniverseOverlay(db, {
    eligibilityAsOf: input.eligibilityAsOf,
    collect:
      input.collect ??
      withBasicEvidence((entry) => collectUniverseOfficialEvents(entry)),
    sendBatch: input.sendBatch ?? createD1HttpBatchSender(),
  });
  if (!out.applied || out.result === null) {
    return {
      applied: false,
      summary: `[universe-overlay] no-op (elig=${input.eligibilityAsOf} 適用済み)`,
    };
  }
  return {
    applied: true,
    summary:
      `[universe-overlay] 適用: events=${out.result.eventsUpserted} ` +
      `delist=${out.result.deactivated} transfer=${out.result.marketUpdated} ` +
      `listed=${out.result.listed} held=${out.result.heldListingCodes.length}`,
  };
}

async function main(): Promise<void> {
  const eligibilityAsOf = parseAsOf(process.argv.slice(2));
  const db = createD1HttpDb({});
  const out = await runUniverseOverlaySync(db, { eligibilityAsOf });
  console.info(out.summary);
}

// 直接実行のときだけ main (import 時は実行しない。test が import する)。
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error("[universe-overlay] エラー:", rootCauseMessage(e));
    process.exit(1);
  });
}
