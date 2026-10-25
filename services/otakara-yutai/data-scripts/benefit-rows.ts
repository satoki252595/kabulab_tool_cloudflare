/**
 * 要約タスクの書き出し / 取り込みが共有する D1 の読み取り。
 *
 * 書き出しと取り込みで同じ射影を使うのは、内容キー
 * `benefitKey(銘柄コード, 掲載文)` の計算元を 1 か所にするため
 * (片方だけ列や結合を変えるとキーが一致しなくなり、全件 stale ではじかれる)。
 */
import "dotenv/config";
import { assertRecordDate } from "../src/record-date.js";
import { activeEquityCondition } from "../../../src/shared/db/active-equity.js";
import { and, eq, inArray } from "drizzle-orm";
import { parseStockCode } from "../../../src/shared/jpx/stock-code.js";
import { createD1HttpDb } from "../../../src/shared/db/d1-http-client.js";
import * as schema from "../src/db/schema.js";
import { stocks, yutaiBenefits } from "../src/db/schema.js";
import type { BenefitRow } from "./summary-tasks.js";

export type OtakaraD1 = ReturnType<typeof createD1HttpDb<typeof schema>>;

export function openOtakaraD1(): OtakaraD1 {
  return createD1HttpDb(schema);
}

/** 要約consumerはactive-equityを明示する。全行退避はallで母集団外の履歴も読む。 */
export async function loadBenefitRows(
  db: OtakaraD1,
  scope: "all" | "active-equity" = "all",
  codes?: readonly string[],
): Promise<BenefitRow[]> {
  if (codes !== undefined && (scope !== "active-equity" || codes.length === 0 || codes.length > 60 ||
    new Set(codes).size !== codes.length || codes.some(code => parseStockCode(code) !== code)))
    throw new Error("invalid_summary_code_scope");
  const query = db
    .select({
      id: yutaiBenefits.id,
      stockId: yutaiBenefits.stockId,
      stockCode: stocks.code,
      stockName: stocks.name,
      description: yutaiBenefits.description,
      shortSummary: yutaiBenefits.shortSummary,
      estimatedValue: yutaiBenefits.estimatedValue,
      estimateValueSource: yutaiBenefits.estimateValueSource,
      minShares: yutaiBenefits.minShares,
      recordMonth: yutaiBenefits.recordMonth,
      recordDate: yutaiBenefits.recordDate,
      updatedAt: yutaiBenefits.updatedAt,
    })
    .from(yutaiBenefits)
    .innerJoin(stocks, eq(yutaiBenefits.stockId, stocks.id));
  const rows = scope === "active-equity" ? await query.where(codes === undefined ? activeEquityCondition()
    : and(activeEquityCondition(), inArray(stocks.code, [...codes]))) : await query;
  return rows.map((r) => {
    assertRecordDate(r.recordDate);
    return { ...r, updatedAt: Math.floor(r.updatedAt.getTime() / 1000) };
  });
}
