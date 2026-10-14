import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VWAP_DISPATCH_CRON, VWAP_READCHECK_CRON } from "../shared/vwap-schedule.js";

describe("通常VWAPのCF移管と既存Yahoo直列契約", () => {
  const yml = readFileSync(new URL("../../.github/workflows/vwap-ingest.yml", import.meta.url), "utf8");
  const config = readFileSync(new URL("../../wrangler.toml", import.meta.url), "utf8");
  it("日足/5分足のGH cronだけを廃止して同MWF17時CFと期限照会へ移す", () => {
    expect(yml).not.toContain("0 8 * * 1,3,5");
    expect(yml).toContain('cron: "0 8 * * 1-5"'); // 信用残は変更しない
    expect(config).toContain(`"${VWAP_DISPATCH_CRON}"`);
    expect(config).toContain(`"${VWAP_READCHECK_CRON}"`);
    expect(yml).toContain("- scheduled-daily-intra");
    expect(yml).toContain('daily_args+=("--scheduled-date=$SCHEDULED_DATE")');
    expect(yml).toContain('intra_args+=("--scheduled-date=$SCHEDULED_DATE")');
    expect(yml).toContain('pnpm ingest:vwap-intra "${intra_args[@]}"');
  });
  it("通常direct/明示保存原本・source lock/上限/ABORT出口を維持する", () => {
    expect(yml).toContain('"$DAILY_SESSION_SOURCE" != "yahoo-direct"');
    expect(yml).toContain('"$DAILY_SESSION_SOURCE" = "archived-jp-leg"');
    expect(yml).toContain("group: yahoo-source");
    expect(yml).toContain("queue: max");
    expect(yml).toContain('CONC: "1"');
    expect(yml).toContain("timeout-minutes: 300");
    expect(yml).toContain('[ "$daily_rc" -ne 0 ] && [ "$daily_rc" -ne 1 ]');
  });
});
