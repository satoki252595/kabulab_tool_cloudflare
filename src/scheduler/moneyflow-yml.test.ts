import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const yml = readFileSync(new URL("../../.github/workflows/moneyflow.yml", import.meta.url), "utf8");
it("非Yahoo producerは全量source排他外で先行し、Yahoo producerだけが共通排他を取得する", () => {
  const first = yml.split("  ingest-non-yahoo:\n")[1].split("  ingest-yahoo:\n")[0];
  const second = yml.split("  ingest-yahoo:\n")[1];
  expect(first).not.toContain("concurrency:");
  expect(first).toContain("--lane=non-yahoo");
  expect(first).toContain("moneyflow-non-yahoo-${{ github.run_attempt }}");
  expect(second).toContain("needs: ingest-non-yahoo");
  expect(second).toContain("'yahoo-source' || 'moneyflow-non-yahoo-join'");
  expect(second).toContain("--lane=yahoo");
  expect(second).toContain("- name: moneyflow source join");
  expect(second).toContain("scripts/moneyflow/join-summaries.ts");
  expect(yml).toContain("scheduled_date:");
  expect(yml).not.toContain('ARGS="$ARGS --only=${{');
  expect(yml).toContain('args+=("--as-of=$TRADE_DATE")');
  expect(yml.match(/timeout-minutes: 120/g)).toHaveLength(2);
});
