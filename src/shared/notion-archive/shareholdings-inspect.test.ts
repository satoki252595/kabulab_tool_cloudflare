import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { inspectHoldingPatch, holdingProperties } from "./shareholdings.js";
import { notionRequest } from "./client.js";
import { parseShareholdingsData } from "../../../services/yuho-quant/src/services/edinet/shareholdings.js";

vi.mock("./client.js", async original => ({ ...await original<typeof import("./client.js")>(), notionRequest: vi.fn() }));
vi.mock("./env.js", async original => ({ ...await original<typeof import("./env.js")>(), notionEnv: {
  NOTION_STOCK_HOLDINGS_DB_ID: () => "5ad4d311b06f42b4b78ab3801cd509e2",
} }));
const base = new URL("../../../services/yuho-quant/src/tests/fixtures/holdings-pending1911/", import.meta.url);
const bytes = (name: string) => readFileSync(new URL(name, base));
const read = (name: string) => JSON.parse(bytes(name).toString());
const proof = read("provenance.json"), schema = read("schema.json");
beforeEach(() => vi.clearAllMocks());

describe("normal read-only unknown holding PATCH observation", () => {
  it("保存1911全ZIPと実31/32行の意図全値を通常producerへ束縛する", () => {
    for (const file of proof.files) expect(createHash("sha256").update(bytes(file.fixture)).digest("hex")).toBe(file.fixtureSha256);
    const parsed = parseShareholdingsData(bytes("1911-S100Y1XP.zip"), proof.source);
    expect(parsed.status).toBe("ok"); expect(parsed.holdings).toHaveLength(45);
    for (const name of ["known-request.json", "unknown-request.json"]) {
      const actual = read(name).properties, holding = parsed.holdings.find(v => v.name === actual["銘柄名"].rich_text[0].text.content)!;
      expect(holding).toBeDefined();
      expect(actual).toMatchObject(holdingProperties(proof.source, proof.ownerName, holding));
    }
  });
  it("実32行目のPRE一致は観測だけで遅延適用/再送を許可しない", async () => {
    const before = read("unknown-before.json"); vi.mocked(notionRequest).mockResolvedValue(before);
    const result = await inspectHoldingPatch({ before, changed: read("unknown-request.json").properties, schema });
    expect(result).toEqual({ status: "observed_pre", current: before, replayAuthorized: false });
    expect(notionRequest).toHaveBeenCalledExactlyOnceWith("GET", `/pages/${before.id}`, undefined, { singleAttempt: true });
  });
  it("実31行目の意図全props/式/旧値一致もsource完了へ昇格しない", async () => {
    const before = read("known-before.json"), current = read("known-after.json"); vi.mocked(notionRequest).mockResolvedValue(current);
    expect(await inspectHoldingPatch({ before, changed: read("known-request.json").properties, schema })).toEqual({ status: "observed_intended", current, replayAuthorized: false });
    expect(notionRequest).toHaveBeenCalledTimes(1);
  });
  it.each(["old-number", "visible-select"])("実POSTの%sが1値でも変わればunknownを保持", async fault => {
    const current = read("known-after.json");
    if (fault === "old-number") current.properties["旧抽出株数（単位未確認）"].number++;
    else current.properties["区分"].select.name += "変";
    vi.mocked(notionRequest).mockResolvedValue(current);
    expect(await inspectHoldingPatch({ before: read("known-before.json"), changed: read("known-request.json").properties, schema })).toMatchObject({ status: "unknown", replayAuthorized: false });
  });
  it("network不明は1 GETから再送せず停止", async () => {
    vi.mocked(notionRequest).mockRejectedValue(new TypeError("fetch failed"));
    await expect(inspectHoldingPatch({ before: read("unknown-before.json"), changed: read("unknown-request.json").properties, schema })).rejects.toThrow("fetch failed");
    expect(notionRequest).toHaveBeenCalledTimes(1);
  });
});
