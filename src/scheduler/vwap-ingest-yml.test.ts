import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VWAP_DISPATCH_CRON, VWAP_READCHECK_CRON } from "../shared/vwap-schedule.js";

describe("通常VWAPのCF移管と既存Yahoo直列契約", () => {
  const yml = readFileSync(new URL("../../.github/workflows/vwap-ingest.yml", import.meta.url), "utf8");
  const config = readFileSync(new URL("../../wrangler.toml", import.meta.url), "utf8");
  it("日足/5分足のGH cronだけを廃止して同MWF17時CFと期限照会へ移す", () => {
    expect(yml).not.toContain("0 8 * * 1,3,5");
    expect(yml).not.toContain("  schedule:"); // 信用残も同時刻のCFへ移管
    expect(yml).toContain("- scheduled-margin");
    expect(yml.match(/'vwap-margin/g)).toHaveLength(2); // workflowとsource両方をYahooから分離
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
    expect(yml).toContain("timeout-minutes: 360");
    expect(yml).toContain("uses: ./.github/actions/record-job-clock");
    expect(yml).toContain("daily_args=(--yahoo-direct)");
    expect(yml).toContain("intra_args=(--yahoo-direct)");
    expect(yml).toContain("budget_args=(--yahoo-direct)");
    expect(yml).toContain('pnpm ingest:vwap-intra --yahoo-direct "--scheduled-date=$SCHEDULED_DATE"');
    for (const job of [yml.split("  ingest:\n")[1].split("  ingest-intra:\n")[0], yml.split("  ingest-intra:\n")[1].split("  scheduled-result:\n")[0]]) {
      expect(job.indexOf("uses: ./.github/actions/record-job-clock")).toBeGreaterThan(0);
      expect(job.indexOf("uses: ./.github/actions/record-job-clock")).toBeLessThan(job.indexOf("--yahoo-direct"));
    }
    expect(yml).toContain('[ "$daily_rc" -ne 0 ] && [ "$daily_rc" -ne 1 ]');
  });
  it("定時だけdaily閉鎖artifactを同run/attemptの別Yahoo jobへ渡し、全0だけ最終成功", () => {
    expect(yml).toContain("needs.ingest.outputs.daily_closed == 'true'");
    expect(yml).toContain("steps.admission.outcome == 'success' && steps.prices.outputs.daily_closed");
    expect(yml.match(/name: vwap-admission-\$\{\{ github.run_id \}\}-\$\{\{ github.run_attempt \}\}/g)).toHaveLength(2);
    expect(yml).toContain("needs: [ingest, ingest-intra]");
    expect(yml).toContain("0:1|1:0|1:1) exit 1");
    expect(yml).not.toContain("continue-on-error:");
  });
  it.each([0, 1, 2, 137])("実workflow日足exit%dは既知0/1だけを閉鎖し、同jobで5分足を開始しない", rc => {
    const section=yml.split("      - name: VWAP daily + intra → R2\n")[1].split("      - name: 定時日足の同run受付記録を保存")[0];
    const script=section.split("        run: |\n")[1].split("\n").map(line=>line.startsWith("          ")?line.slice(10):line).join("\n");
    const dir=mkdtempSync(join(tmpdir(),"vwap-daily-workflow-")),output=join(dir,"output"),calls=join(dir,"calls");
    writeFileSync(output,"");writeFileSync(calls,"");
    writeFileSync(join(dir,"pnpm"),'#!/bin/bash\nprintf "%s\\n" "$1" >> "$CALLS"\nif [ "$1" = "ingest:vwap-daily" ]; then exit "$TEST_DAILY_RC"; fi\nexit 99\n');chmodSync(join(dir,"pnpm"),0o700);
    try {
      const child=spawnSync("bash",["-e","-c",script],{encoding:"utf8",timeout:15_000,env:{...process.env,PATH:`${dir}:${process.env.PATH}`,CALLS:calls,TEST_DAILY_RC:String(rc),
        GITHUB_OUTPUT:output,TARGET:"scheduled-daily-intra",SCHEDULED_DATE:"2026-10-14",DAILY_SESSION_SOURCE:"yahoo-direct",DAILY_SESSION_DATE:"",DAILY_ONLY:"false",DAILY_CODES:""}});
      expect(child.error).toBeUndefined();expect(child.status,child.stderr).toBe(rc===0?0:rc===1?1:2);
      expect(readFileSync(calls,"utf8")).toBe("ingest:vwap-daily\n");
      expect(readFileSync(output,"utf8")).toBe(rc===0||rc===1?`daily_exit=${rc}\ndaily_closed=true\n`:"");
    } finally { rmSync(dir,{recursive:true,force:true}); }
  });
});
