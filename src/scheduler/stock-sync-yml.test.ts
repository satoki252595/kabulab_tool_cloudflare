import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * stock-sync.yml の target routing 契約 (CF scheduler 移行後)。
 *
 * - 旧株式・macro schedule cronは廃止。monthlyは維持。
 * - stock-syncからのmoneyflow連鎖は価格依存のsector-turnoverだけ。
 *   他取得元はmoneyflowの既存only入口から独立更新する。
 * - daily step は SCHEDULED_DATE を producer へ渡す。
 */

const YML_PATH = new URL(
  "../../.github/workflows/stock-sync.yml",
  import.meta.url
);

describe("stock-sync.yml target routing", () => {
  const yml = readFileSync(YML_PATH, "utf8");

  it("旧株式 schedule cron を含まない", () => {
    expect(yml).not.toContain('"13 17 * * 1-5"');
    expect(yml).not.toContain("github.event.schedule == '13 17 * * 1-5'");
  });

  it("旧macro cronは廃止しmonthly scheduleを維持する", () => {
    expect(yml).not.toContain('"0 21 * * 1-5"');
    expect(yml).toContain('"30 1 10 * *"');
  });

  it("scheduled-stocks target と scheduled_date input がある", () => {
    expect(yml).toContain("- scheduled-stocks");
    expect(yml).toContain("scheduled_date:");
    expect(yml).toContain("- scheduled-context");
  });

  it("株式成功に依存するのはsector-turnoverのみで、他取得元を二重起動しない", () => {
    expect(yml).toContain("      only: sector-turnover");
    expect(yml).not.toContain("moneyflow_only:");
    expect(yml).toContain("if: needs.sync.outputs.trade_date != '' && needs.sync.outputs.tolerated_failures == ''");
  });

  it("daily step は scheduled-stocks で動き日付と target を渡す", () => {
    expect(yml).toContain("github.event.inputs.target == 'scheduled-stocks'");
    expect(yml).toContain(
      "SCHEDULED_DATE: ${{ github.event.inputs.scheduled_date }}"
    );
    expect(yml).toContain("STOCK_SYNC_TARGET: ${{ github.event.inputs.target }}");
  });

  it("価格非依存の33業種は株式失敗後も実行し、skipと取消では実行しない", () => {
    const sectorSteps = yml.slice(
      yml.indexOf("      - uses: DeterminateSystems/nix-installer-action@main"),
      yml.indexOf("      - name: market context sync")
    );
    const conditions = [...sectorSteps.matchAll(/^ {8}if: (.+)$/gm)].map((m) => m[1]);
    expect(conditions).toHaveLength(4);
    for (const condition of conditions) {
      expect(condition).toBe("always() && !cancelled() && (steps.daily.outcome == 'success' || steps.daily.outcome == 'failure')");
    }
    expect(sectorSteps).not.toContain("continue-on-error:");
    expect(sectorSteps).not.toContain("steps.daily.outputs.trade_date");
  });
});
