/**
 * 745 select-proof の import 副作用 regression (child-process・offline)。
 *
 * 2026-09-30 の price40 ONE live は本 module の import 時
 * global-fetch 置換 (budget-36 SELECT-only guard) により batch POST と
 * Notion 到達が ban され outcome-unknown STOP した
 * (receipt abortReason `chunk-0:SELECT proof: batch envelope 禁止 ...`。
 * 原本 wrapper/path/content SHA は local 0600 証拠として保持)。
 * guard 設置は直接 CLI のときだけ。import 側の fetch は置き換えない。
 *
 * child driver が 2 phase を offline で検証する:
 * importer: merged adapter import 後の fetch 同一性 + caller guard
 *   intact (stub calls 2・native HTTP 0)。
 * cli: 直接 CLI 相当 (argv[1]=745) では guard 設置 + main() は
 *   env 不在 HOLD (送信 0・exit 1) + 設置後 guard の ban。
 * (旧 tree の ban 再現は private actual-old proof
 * `/tmp/745-actualold-proof-20260930/` で行う。repo 外。)
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "../../..");
const DRIVER = join(HERE, "overseas-745-import-sideeffect.driver.mts");
const TSX = join(REPO_ROOT, "node_modules", ".bin", "tsx");

describe("745 import sideeffect (child-process, offline)", () => {
  it("import は fetch を置き換えない + 直接 CLI guard 維持", () => {
    const importer = execFileSync(TSX, [DRIVER, "importer"], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(importer).toContain("IMPORTER-OK");
    const tmpOut = mkdtempSync(join(tmpdir(), "745-cli-guard-"));
    const cli = execFileSync(TSX, [DRIVER, "cli", tmpOut], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(cli).toContain("CLI-GUARD-OK");
  }, 120_000);
});
