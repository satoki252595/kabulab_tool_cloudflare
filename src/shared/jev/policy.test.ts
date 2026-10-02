import { SEMIF_MODEL } from "../semif/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createJevClient } from "./client.js";
import { assertTypeSafeEnabled, TypeSafeDisabledError } from "./policy.js";
import { runBiztag } from "../../../services/yuho-quant/src/biztag/pipeline.js";
import { runCompetitors } from "../../../services/yuho-quant/src/biztag/competitors/pipeline.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("TypeSafe 全停止 (実 policy)", () => {
  it("停止理由を明示し、既存結果を消去する処理を持たない", () => {
    expect(assertTypeSafeEnabled).toThrow(TypeSafeDisabledError);
    expect(assertTypeSafeEnabled).toThrow("新規銘柄の初回事業タグ");
  });

  it("キーと fetch を渡しても工場入口で停止し、引数の値も読まない", () => {
    const externalFetch = vi.fn();
    const keyRead = vi.fn(() => "unused-test-key");
    const modelRead = vi.fn(() => "unused-test-model");
    vi.stubGlobal("fetch", externalFetch);
    expect(() =>
      createJevClient({
        get apiKey() { return keyRead(); },
        get model() { return modelRead(); },
        fetch: externalFetch,
      })
    ).toThrow(TypeSafeDisabledError);
    expect(externalFetch).not.toHaveBeenCalled();
    expect(keyRead).not.toHaveBeenCalled();
    expect(modelRead).not.toHaveBeenCalled();
  });

  it.each(["", "unused-test-key"])("キー設定有無にかかわらず通信しない (%s)", (apiKey) => {
    const externalFetch = vi.fn();
    expect(() => createJevClient({ apiKey, model: "unused", fetch: externalFetch })).toThrow(TypeSafeDisabledError);
    expect(externalFetch).not.toHaveBeenCalled();
  });

  it("事業タグは開始日未設定ならD1/Notion/判定APIより前に停止する", async () => {
    const externalFetch = vi.fn();
    vi.stubGlobal("fetch", externalFetch);
    for (const key of ["BIZTAG_NEW_LISTING_FROM", "TYPESAFE_API_KEY", "CLOUDFLARE_API_TOKEN", "NOTION_TOKEN"]) vi.stubEnv(key, "");
    await expect(runBiztag({ budgetMs: 1, model: SEMIF_MODEL, thresholds: { yesMin: 0.8, noMax: 0.2 } })).rejects.toThrow("BIZTAG_NEW_LISTING_FROM");
    expect(externalFetch).not.toHaveBeenCalled();
  });

  it.each([undefined, "jev"] as const)("競合判定 judge=%s も保存先に触れる前に停止する", async (judge) => {
    const externalFetch = vi.fn();
    vi.stubGlobal("fetch", externalFetch);
    vi.stubEnv("TYPESAFE_API_KEY", "");
    await expect(runCompetitors({ budgetMs: 1, judge })).rejects.toThrow(TypeSafeDisabledError);
    expect(externalFetch).not.toHaveBeenCalled();
  });

  it("semif 明示は TypeSafe に切り替えず、既存のローカル設定を要求する", async () => {
    const externalFetch = vi.fn();
    vi.stubGlobal("fetch", externalFetch);
    vi.stubEnv("SEMIF_PYTHON", "");
    await expect(runCompetitors({ budgetMs: 1, judge: "semif" })).rejects.toThrow("SEMIF_PYTHON");
    expect(externalFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["gate"],
    ["golden"],
    ["competitors"],
    ["competitors", "--judge=jev"],
    ["competitors-eval"],
    ["competitors-eval", "--judge=jev"],
  ])("CLI %j は env/保存先に触れる前に停止理由を返す", (...args) => {
    // 資格情報/.env を渡さず、fetch が到達しても通信させない子プロセス。
    const forbidFetch = "data:text/javascript,globalThis.fetch=()=>{throw new Error('NETWORK_REACHED')}";
    const cli = fileURLToPath(new URL("../../../services/yuho-quant/data-scripts/biztag.ts", import.meta.url));
    const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), "--import", forbidFetch, cli, ...args], {
      env: { DOTENV_CONFIG_PATH: fileURLToPath(new URL("./nonexistent-test.env", import.meta.url)) },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("TypeSafeDisabledError: TypeSafe の外部判定は停止中");
    expect(result.stderr).not.toContain("NETWORK_REACHED");
    expect(result.stdout).toBe("");
  });

  it("旧新規用途を明示しても工場入口で停止し、通信しない", () => {
    const externalFetch = vi.fn();
    expect(() => createJevClient({ usage: "new-stock-biztag", apiKey: "test-key", model: "test-model", fetch: externalFetch })).toThrow(TypeSafeDisabledError);
    expect(externalFetch).not.toHaveBeenCalled();
  });
});
