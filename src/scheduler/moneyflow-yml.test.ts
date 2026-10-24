import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const yml = readFileSync(new URL("../../.github/workflows/moneyflow.yml", import.meta.url), "utf8");
it("両producerは旧rateで直列取得し、別joinが同run両summaryの正常完了を待つ", () => {
  const first = yml.split("  ingest-non-yahoo:\n")[1].split("  ingest-yahoo:\n")[0];
  const second = yml.split("  ingest-yahoo:\n")[1].split("  join:\n")[0];
  const join = yml.split("  join:\n")[1];
  expect(first).not.toContain("concurrency:");
  expect(first).not.toContain("needs:");
  expect(first).toContain("--lane=non-yahoo");
  expect(first).toContain("moneyflow-non-yahoo-${{ github.run_attempt }}");
  expect(second).toContain("needs: ingest-non-yahoo");
  expect(second).toContain("'yahoo-source' || 'moneyflow-non-yahoo-join'");
  expect(second).toContain("--lane=yahoo");
  expect(second).toContain("moneyflow-yahoo-${{ github.run_attempt }}");
  expect(second).toContain("actions/download-artifact");
  expect(second).toContain("--predecessor-summary=.moneyflow-summaries/non-yahoo.json");
  expect(second).toContain("needs.ingest-non-yahoo.outputs.summary_closed == 'true'");
  expect(first).toContain("steps.non-yahoo.outputs.summary_closed == 'true'");
  expect(join).toContain("needs: [ingest-non-yahoo, ingest-yahoo]");
  expect(join).toContain("moneyflow-non-yahoo-${{ github.run_attempt }}");
  expect(join).toContain("moneyflow-yahoo-${{ github.run_attempt }}");
  expect(join).not.toContain("if: always()");
  expect(join).not.toContain("continue-on-error");
  expect(join).not.toContain("concurrency:");
  expect(join).toContain("- name: moneyflow source join");
  expect(join).toContain("scripts/moneyflow/join-summaries.ts");
  expect(first).toContain('NOTION_MAX_RPS: "1.0"');
  expect(second).toContain('NOTION_MAX_RPS: "1.6"');
  expect(yml).toContain("scheduled_date:");
  expect(yml).not.toContain('ARGS="$ARGS --only=${{');
  expect(yml).toContain('args+=("--as-of=$TRADE_DATE")');
  expect(yml.match(/timeout-minutes: 120/g)).toHaveLength(2);
  expect(readFileSync(new URL("../../.github/workflows/stock-sync.yml", import.meta.url), "utf8")
    .split("  moneyflow:\n")[1]).toContain("    permissions:\n      actions: read");
});
