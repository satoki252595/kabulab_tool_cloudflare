/** Normal order parser → saved rows. Identity columns are added by the caller. */
import type {
  OrderExtraction,
  OrderFact,
  ParseStatus,
} from "./edinet/order-parser.js";
import { toYen } from "./overseas-save-rows.js";

function requireOrder(
  condition: unknown,
  message = "invalid order repair set",
): asserts condition {
  if (!condition) throw new Error(message);
}

export type OrderSaveStatus = ParseStatus | "parse_error";
export function orderPatternOf(status: OrderSaveStatus): string {
  requireOrder(
    [
      "ok_pattern_a",
      "ok_pattern_b",
      "ok_pattern_c",
      "ok_total_only",
      "orders_only",
      "table_unrecognized",
      "no_order_table",
      "parse_error",
    ].includes(status),
    "unknown order save status",
  );
  if (status === "ok_pattern_b") return "pattern_b";
  if (status === "ok_pattern_c") return "pattern_c";
  if (status === "ok_total_only") return "total_only";
  return "pattern_a";
}
export function toOrderSaveRows(facts: OrderFact[], status: OrderSaveStatus) {
  const pattern = orderPatternOf(status);
  return facts.map((f) => ({
    fiscalYearEnd: f.fiscalYearEnd,
    segmentName: f.segmentName,
    segmentKind: f.segmentKind,
    isConsolidated: f.isConsolidated,
    unitLabel: f.unitLabel,
    ordersReceivedRaw: f.ordersReceived,
    orderBacklogRaw: f.orderBacklog,
    ordersReceivedYen: toYen(f.ordersReceived, f.unitYenFactor),
    orderBacklogYen: toYen(f.orderBacklog, f.unitYenFactor),
    pattern,
  }));
}

/** Saved repair accepts only a positive, unique normal parser result. HOLD never deletes old facts. */
export function validateOrderRepairSet(
  parsed: OrderExtraction,
  periodEnd: string,
): void {
  requireOrder(
    ["ok_pattern_a", "ok_pattern_b", "ok_pattern_c", "ok_total_only"].includes(
      parsed.status,
    ),
  );
  requireOrder(
    typeof parsed.honbunFile === "string" && parsed.honbunFile.length > 0,
  );
  requireOrder(parsed.holdReason === undefined);
  requireOrder(
    parsed.facts.length > 0 &&
      parsed.facts.some((f) => f.fiscalYearEnd === periodEnd),
  );
  const keys = new Set<string>(),
    scopes = new Set<boolean>();
  for (const f of parsed.facts) {
    requireOrder(
      /^\d{4}-\d{2}-\d{2}$/.test(f.fiscalYearEnd) &&
        f.fiscalYearEnd <= periodEnd,
    );
    requireOrder(typeof f.isConsolidated === "boolean");
    scopes.add(f.isConsolidated);
    requireOrder(
      typeof f.segmentName === "string" && f.segmentName.trim().length > 0,
    );
    requireOrder(
      ["segment", "subtotal", "total", "elimination"].includes(f.segmentKind),
    );
    requireOrder(typeof f.unitLabel === "string" && f.unitLabel.length > 0);
    requireOrder(Number.isFinite(f.unitYenFactor) && f.unitYenFactor > 0);
    for (const value of [f.ordersReceived, f.orderBacklog])
      requireOrder(value === null || Number.isFinite(value));
    const key = JSON.stringify([f.fiscalYearEnd, f.segmentName]);
    requireOrder(
      !keys.has(key),
      "duplicate order natural key; do not drop a row",
    );
    keys.add(key);
  }
  requireOrder(scopes.size === 1, "mixed order scope");
}
