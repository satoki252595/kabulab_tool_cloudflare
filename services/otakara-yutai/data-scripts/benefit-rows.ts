/**
 * 要約タスクの書き出し / 取り込みが共有する D1 の読み取り。
 *
 * 書き出しと取り込みで同じ射影を使うのは、内容キー
 * `benefitKey(銘柄コード, 掲載文)` の計算元を 1 か所にするため
 * (片方だけ列や結合を変えるとキーが一致しなくなり、全件 stale ではじかれる)。
 */
import "dotenv/config";
import { assertRecordDate } from "../src/record-date.js";
import { eq } from "drizzle-orm";
import { createD1HttpDb } from "../../../src/shared/db/d1-http-client.js";
import * as schema from "../src/db/schema.js";
import { stocks, yutaiBenefits } from "../src/db/schema.js";
import type { BenefitRow } from "./summary-tasks.js";

export type OtakaraD1 = ReturnType<typeof createD1HttpDb<typeof schema>>;

export function openOtakaraD1(): OtakaraD1 {
  return createD1HttpDb(schema);
}

export async function loadBenefitRows(db: OtakaraD1): Promise<BenefitRow[]> {
  const rows = await db
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
  return rows.map((r) => {
    assertRecordDate(r.recordDate);
    return { ...r, updatedAt: Math.floor(r.updatedAt.getTime() / 1000) };
  });
}
