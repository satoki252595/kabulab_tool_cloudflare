import { readFileSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LatestDoc } from "../../src/biztag/source.js";

const model = vi.hoisted(() => ({ gate: vi.fn(() => { throw new Error("TypeSafe forbidden"); }),
  client: vi.fn(() => { throw new Error("model forbidden"); }), key: vi.fn(() => { throw new Error("API key forbidden"); }),
  record: vi.fn(), verify: vi.fn(), latest: vi.fn() }));
vi.mock("../../../../src/shared/jev/index.js", async importActual => ({ ...await importActual<object>(),
  assertTypeSafeEnabled: model.gate, createJevClient: model.client, jevEnv: { TYPESAFE_API_KEY: model.key } }));
vi.mock("../../../../src/shared/semif/index.js", async importActual => ({ ...await importActual<object>(), createSemifClient: model.client }));
vi.mock("../../../../src/shared/db/d1-http-client.js", async importActual => ({ ...await importActual<object>(), createD1HttpDb: () => ({}) }));
vi.mock("../../src/biztag/source.js", async importActual => ({ ...await importActual<object>(), loadLatestDocs: model.latest }));
vi.mock("../../../../scripts/biztag-local/runtime.js", () => ({ withBiztagWriter: (callback: () => Promise<void>) => callback() }));
vi.mock("../../../../src/shared/notion-archive/index.js", async importActual => ({ ...await importActual<object>(),
  recordPrimaryData: model.record, verifyArchivedAttachments: model.verify }));

const fixtureBytes = readFileSync(new URL("../../src/biztag/competitors/fixtures/prepare-actual-20261017.json.gz", import.meta.url));
const provenance = JSON.parse(readFileSync(new URL("../../src/biztag/competitors/fixtures/prepare-actual-20261017.provenance.json", import.meta.url), "utf8"));
if (createHash("sha256").update(fixtureBytes).digest("hex") !== provenance.fixtureSha256) throw new Error("実保存入力fixture SHA不一致");
const fixture = JSON.parse(gunzipSync(fixtureBytes).toString()) as {
  dbId: string; pages: Array<{ id: string; parent: { type: string; database_id: string }; properties: Record<string, Record<string, unknown>> }>;
  latest: LatestDoc[];
};
let dir: string, pages: typeof fixture.pages, requests: number;
const dbPath = fixture.dbId.replaceAll("-", "");
const originalArgv = process.argv;

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), "competitor-prepare-")); pages = structuredClone(fixture.pages); requests = 0;
  vi.stubEnv("NOTION_TOKEN", "test-protocol-only"); vi.stubEnv("NOTION_STOCK_SUPPLEMENT_DB_ID", fixture.dbId);
  vi.stubEnv("NOTION_MAX_RPS", "2.0"); // 実pacingを通すがtransportは置換。実運用所要の測定ではない。
  model.latest.mockResolvedValue(structuredClone(fixture.latest));
  model.record.mockResolvedValue({ pageId: fixture.dbId, outcome: "recorded", fileTooLarge: false, manifestMatch: "written" });
  model.verify.mockResolvedValue(undefined);
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init: RequestInit) => {
    try {
    requests++;
    const url = new URL(String(input)); expect(url.origin).toBe("https://api.notion.com");
    if (init.method === "GET" && url.pathname === `/v1/databases/${dbPath}`) {
      return Response.json({ object: "database", id: fixture.dbId, properties: Object.fromEntries(Object.entries(pages[0].properties).map(([n,p]) => [n, { id: p.id, type: p.type }])) });
    }
    expect(init.method).toBe("POST"); expect(url.pathname).toBe(`/v1/databases/${dbPath}/query`);
    const body = JSON.parse(init.body as string);
    const wanted = body.filter?.or.map((f: { rich_text: { equals: string } }) => f.rich_text.equals);
    const selected = wanted === undefined ? pages : pages.filter(p => wanted.includes((p.properties["銘柄コード"].rich_text as Array<{ plain_text: string }>).map(v => v.plain_text).join("")));
    // 実native投影を使用。collectorが要求した列だけを返す（full39とcorpusの差も検査）。
    const requested = new Set(url.searchParams.getAll("filter_properties"));
    return Response.json({ results: selected.map(p => ({ ...p, properties: Object.fromEntries(Object.entries(p.properties).filter(([,v]) => requested.has(String(v.id)))) })), has_more: false, next_cursor: null });
    } catch {
      const { NotionConfigError } = await import("../../../../src/shared/notion-archive/env.js");
      throw new NotionConfigError("fixture transport route mismatch");
    }
  }));
});
afterEach(() => { process.argv = originalArgv; vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

const options = () => ({ codes: fixture.latest.map(r => r.stockCode), limit: 2, budgetMs: 120_000, outDir: dir, judge: "semif" as const });
async function run() { return (await import("./prepare-competitors.js")).prepareCompetitors(options()); }

it("受入済み実2社の全39/receipt→normal CLI prepareはモデル・認証・競合/schema書込0", async () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {}), exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  process.argv = ["node", "biztag.ts", "competitors", "--prepare-only", "--judge=semif", `--codes=${options().codes.join(",")}`,
    "--limit=2", "--budget-min=2", `--out=${dir}`];
  await import("../biztag.js");
  const summary = JSON.parse(info.mock.calls[0][0] as string);
  const captured = JSON.parse(gunzipSync(model.record.mock.calls[0][0].files[0].bytes).toString());
  expect(Object.values(captured.qualification).map(q => (q as { status: string; reason?: string }).reason)).toEqual([undefined, undefined]);
  expect(summary).toMatchObject({ mode: "prepare-only", ready: 2, holds: [], modelCalls: 0, competitorWrites: 0, schemaWrites: 0 });
  expect(exit).toHaveBeenCalledWith(0);
  expect(model.gate).not.toHaveBeenCalled(); expect(model.client).not.toHaveBeenCalled(); expect(model.key).not.toHaveBeenCalled();
  expect(model.record).toHaveBeenCalledOnce(); expect(model.verify).toHaveBeenCalledOnce();
  const record = model.record.mock.calls[0][0]; expect(record.requireExistingDatabase).toBe(true); expect(record.force).toBe(false);
  const manifest = JSON.parse(gunzipSync(record.files[0].bytes).toString());
  expect(manifest.prepared.every((p: { status: string; qids: string[] }) => p.status === "prepared" && p.qids.length === 1)).toBe(true);
  expect(manifest.fullRows.every((r: { texts: object }) => Object.keys(r.texts).length === 39)).toBe(true);
  expect(Object.values(manifest.qualification).every(q => (q as { historicalTagInputStatus: string }).historicalTagInputStatus === "unverified-legacy")).toBe(true);
  expect(requests).toBe(3); // schema + corpus1page + A/B full391page。archive transportは別途共通検証。
});

it("同入力は同一SHA/gzip/keyを共有archiveへ渡し、実skipの物理確認を省かない", async () => {
  const first = await run(); model.record.mockResolvedValue({ pageId: fixture.dbId, outcome: "skipped_existing", fileTooLarge: false, manifestMatch: "same" });
  const second = await run(); expect(second.inputSha256).toBe(first.inputSha256); expect(second.gzipSha256).toBe(first.gzipSha256);
  expect(second.archiveOutcome).toBe("skipped_existing"); expect(model.verify).toHaveBeenCalledTimes(2);
  expect(model.record.mock.calls[1][0].files[0].bytes).toEqual(model.record.mock.calls[0][0].files[0].bytes);
});

it("prepare CLIの明示0.3rpsは.envの2.0rpsより狭いnative開始間隔を保持する", async () => {
  vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
  const original = globalThis.fetch, starts: number[] = [];
  vi.stubGlobal("fetch", (input: string | URL, init: RequestInit) => { starts.push(performance.now()); return original(input, init); });
  const { prepareCompetitors } = await import("./prepare-competitors.js");
  const pending = prepareCompetitors({ ...options(), maxRps: 0.3 });
  await vi.runAllTimersAsync(); await pending;
  expect(starts).toEqual([0, 3334, 6668]);
  expect(model.client).not.toHaveBeenCalled();
});

it.each(["text", "receipt", "tag-doc", "latest-pointer"])("選出Bの%s不整合でAをHOLDし、候補/qidsは除外しない", async fault => {
  const b = pages[1];
  if (fault === "text") (b.properties["事業の内容"].rich_text as Array<{ plain_text: string }>)[0].plain_text += "\u200b";
  if (fault === "receipt") (b.properties["判定入力"].rich_text as Array<{ plain_text: string }>)[0].plain_text = "";
  if (fault === "tag-doc") (b.properties["事業タグの根拠書類"].rich_text as Array<{ plain_text: string }>)[0].plain_text = "";
  if (fault === "latest-pointer") { const latest = structuredClone(fixture.latest); latest[1].doc!.notionDocPageId = fixture.dbId; model.latest.mockResolvedValue(latest); }
  const result = await run(); expect(result.ready).toBe(0); expect(result.holds).toHaveLength(2);
  const manifest = JSON.parse(gunzipSync(model.record.mock.calls[0][0].files[0].bytes).toString());
  expect(manifest.prepared[0].candidates).toHaveLength(1); expect(manifest.prepared[0].qids).toEqual([`cp.${fixture.latest[1].stockCode}`]);
  expect(model.client).not.toHaveBeenCalled();
});

it("native長文has_moreを完全同値へ扱わず、archive前にSTOP", async () => {
  pages[0].properties["事業の内容"].has_more = true;
  await expect(run()).rejects.toMatchObject({ name: "NotionConfigError" }); expect(model.record).not.toHaveBeenCalled();
});
it("archive unknownの送信記録は保持し、同入力の再uploadを開始しない", async () => {
  model.record.mockRejectedValue(new Error("unknown archive")); await expect(run()).rejects.toThrow("unknown archive");
  expect(readdirSync(dir)).toHaveLength(1); await expect(run()).rejects.toMatchObject({ name: "NotionUnknownResultError" });
  expect(model.record).toHaveBeenCalledOnce(); expect(model.verify).not.toHaveBeenCalled();
});
it("有限パラメータ不正はnative前にSTOP", async () => {
  const { prepareCompetitors } = await import("./prepare-competitors.js");
  await expect(prepareCompetitors({ ...options(), limit: NaN })).rejects.toMatchObject({ name: "NotionConfigError" });
  expect(requests).toBe(0); expect(model.latest).not.toHaveBeenCalled();
});
