import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { riskFormSchema } from "../validators/risk.js";
import { calcPositionSize } from "../services/risk.js";
import { riskPage } from "../views/risk.js";

/** API & cron ルーター */
export const apiRoute = new Hono();

// -----------------------------------------------------------------------------
// POST /api/risk/calc — リスク計算機 (form submit → HTML 再レンダ)
// -----------------------------------------------------------------------------
apiRoute.post("/risk/calc", zValidator("form", riskFormSchema), (c) => {
  const input = c.req.valid("form");
  try {
    const result = calcPositionSize({
      accountYen: input.accountYen,
      riskPct: input.riskPct,
      entryPrice: input.entryPrice,
      stopLoss: input.stopLoss,
      target1: input.target1,
    });
    return c.html(
      riskPage({
        preset: {
          accountYen: input.accountYen,
          riskPct: input.riskPct,
          entryPrice: input.entryPrice,
          stopLoss: input.stopLoss,
          target1: input.target1 ?? null,
        },
        result,
        error: null,
      })
    );
  } catch (e) {
    return c.html(
      riskPage({
        preset: {
          accountYen: input.accountYen,
          riskPct: input.riskPct,
          entryPrice: input.entryPrice,
          stopLoss: input.stopLoss,
          target1: input.target1 ?? null,
        },
        result: null,
        error: e instanceof Error ? e.message : String(e),
      }),
      400
    );
  }
});

// NOTE: 旧 /api/cron/sync-daily と /api/cron/sync-light は廃止された。
// 日次/月次の統一 cron は root app (/api/cron/sync-{daily,monthly}) に集約している。
// 昼休みの intraday マクロ更新機能 (sync-light) はシンプル化のため削除した。
// 詳細は src/index.ts / src/cron/{daily,monthly}.ts を参照。
