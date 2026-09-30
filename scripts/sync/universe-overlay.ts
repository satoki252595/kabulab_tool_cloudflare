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
import { createD1HttpDb } from "../../src/shared/db/d1-http-client.js";
import { rootCauseMessage } from "../../src/shared/errors.js";
import { runDateKeys } from "../../src/cron/daily.js";
import { collectUniverseOfficialEvents } from "../../src/cron/universe-official-events.js";
import {
  ensureUniverseOverlay,
  withBasicEvidence,
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

async function main(): Promise<void> {
  const eligibilityAsOf = parseAsOf(process.argv.slice(2));
  const db = createD1HttpDb({});
  const out = await ensureUniverseOverlay(db, {
    eligibilityAsOf,
    collect: withBasicEvidence((input) => collectUniverseOfficialEvents(input)),
  });
  if (!out.applied || out.result === null) {
    console.info(`[universe-overlay] no-op (elig=${eligibilityAsOf} 適用済み)`);
    return;
  }
  console.info(
    `[universe-overlay] 適用: events=${out.result.eventsUpserted} ` +
      `delist=${out.result.deactivated} transfer=${out.result.marketUpdated} ` +
      `listed=${out.result.listed} held=${out.result.heldListingCodes.length}`
  );
}

main().catch((e) => {
  console.error("[universe-overlay] エラー:", rootCauseMessage(e));
  process.exit(1);
});
