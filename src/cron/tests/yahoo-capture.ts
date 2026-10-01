/** Yahoo client境界のtest double。取得hookの契約を本体と同じ入力symbolで通す。 */
import type { fetchChart, fetchStockRawData } from "../../shared/yahoo/client.js";
import type { StockRawData } from "../../shared/types.js";

export function chartWithRaw(value: Awaited<ReturnType<typeof fetchChart>>) {
  return async (...[symbol, , options]: Parameters<typeof fetchChart>) => {
    await options?.onRaw?.({ symbol, status: 200, bytes: new TextEncoder().encode(JSON.stringify(value)),
      url: `https://test.invalid/chart/${symbol}`, receivedAt: new Date(Date.now()).toISOString(), headers: {} });
    return value;
  };
}
export function stockWithRaw(value: StockRawData) {
  return async (...[symbol, , options]: Parameters<typeof fetchStockRawData>) => {
    const capture = { symbol, status: 200, bytes: new TextEncoder().encode(JSON.stringify(value)),
      url: `https://test.invalid/yahoo/${symbol}`, receivedAt: new Date(Date.now()).toISOString(), headers: {} };
    await options?.onChartRaw?.(capture);
    await options?.onSummaryRaw?.(capture);
    return value;
  };
}
