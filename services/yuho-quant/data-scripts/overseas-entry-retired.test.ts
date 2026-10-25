import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.each([
  ["audit-overseas.ts", [], "overseas_audit_retired_use_saved_prepare_or_inspect"],
  ["audit-overseas.ts", ["--limit=1"], "overseas_audit_retired_use_saved_prepare_or_inspect"],
  ["backfill-overseas.ts", [], "overseas_saved_cohort_required"],
  ["backfill-overseas.ts", ["--limit=1", "--offset=0", "--force"], "overseas_saved_cohort_required"],
  ["backfill-overseas.ts", ["--saved-mode=prepare"], "missing --after-code"],
])("旧海外入口 %s は暗黙取得せず、保存原本の明示引数だけを受け付ける (%j)", (script, args, diagnostic) => {
  const directory = mkdtempSync(join(tmpdir(), "overseas-retired-"));
  try {
    const marker = join(directory, "network-attempted");
    // 旧実装でも実通信させない。cache/監査dirの先行作成も検知する。
    const guard = `import {writeFileSync} from "node:fs"; globalThis.fetch = async () => { writeFileSync(${JSON.stringify(marker)}, "unexpected"); throw new Error("network_forbidden"); };`;
    const child = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"),
      "--import", `data:text/javascript,${encodeURIComponent(guard)}`,
      fileURLToPath(new URL(`./${script}`, import.meta.url)), ...args],
    { cwd: directory, env: {}, encoding: "utf8", timeout: 20_000 });
    expect(child.error).toBeUndefined(); expect(child.status).toBe(1);
    expect(child.stderr).toContain(diagnostic);
    expect(child.stderr).not.toMatch(/NOTION_TOKEN|EDINET_API_KEY|CLOUDFLARE_API_TOKEN|network_forbidden/);
    expect(existsSync(marker)).toBe(false);
    expect(readdirSync(directory)).toEqual([]);
  } finally { rmSync(directory, { recursive: true }); }
}, 30_000);
