import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * stock-sync.yml の target routing 契約 (CF scheduler 移行後)。
 *
 * - 旧株式 schedule cron (13 17) は廃止。macro/monthly は維持。
 * - dispatch target=scheduled-stocks は株式 only かつ moneyflow 全 sources
 *   (旧 scheduled と同じ空文字)。手動 stocks は sector-turnover 限定を維持。
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

  it("macro/monthly の schedule を維持する", () => {
    expect(yml).toContain('"0 21 * * 1-5"');
    expect(yml).toContain('"30 1 10 * *"');
  });

  it("scheduled-stocks target と scheduled_date input がある", () => {
    expect(yml).toContain("- scheduled-stocks");
    expect(yml).toContain("scheduled_date:");
  });

  it("moneyflow selector: scheduled-stocks は全 sources、手動 stocks は限定維持", () => {
    expect(yml).toContain(
      "daily|all|scheduled-stocks|context|monthly) ONLY=\"\""
    );
    expect(yml).toContain('stocks) ONLY="sector-turnover"');
  });

  it("daily step は scheduled-stocks で動き日付と target を渡す", () => {
    expect(yml).toContain("github.event.inputs.target == 'scheduled-stocks'");
    expect(yml).toContain(
      "SCHEDULED_DATE: ${{ github.event.inputs.scheduled_date }}"
    );
    expect(yml).toContain("STOCK_SYNC_TARGET: ${{ github.event.inputs.target }}");
  });
});
