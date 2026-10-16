/** Real saved9273 text with filesystem protocol projections; no new business facts or network. */
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSupplementPublicationJournal } from "./publication-journal.js";
import { buildSupplementProperties } from "../../src/shared/notion-archive/stock-supplement.js";
import native from "../../src/shared/notion-archive/fixtures/9273-s100z2z6-notion-zero-width.json";

const failures = vi.hoisted(() => ({ filename: "" }));
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
    if (failures.filename && String(args[0]).endsWith("/" + failures.filename)) throw new Error("filesystem write interrupted");
    return fs.writeFileSync(...args);
  } };
});
const temporary: string[] = [];
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const snapshot = JSON.stringify({ page: { id: native.provenance.textPageId, properties: buildSupplementProperties({ docId: native.provenance.docId }) }, children: [], expectedProperties: buildSupplementProperties({ docId: native.provenance.docId, texts: { [native.provenance.property]: native.rawText } }) });
const input = { pageId: native.provenance.textPageId, nextDocId: native.provenance.docId, archiveKey: `biztag-pre/${native.provenance.textPageId}/${sha(snapshot)}`, snapshot };
const output = { archivePageId: native.provenance.textPageId, postPageSha256: sha(native.notionReadbackText) };
function state() { const root = realpathSync(mkdtempSync(join(tmpdir(), "publication-journal-"))); temporary.push(root); return root; }
function directory(root: string) { const path = join(root, "supplement-publications"); return join(path, readdirSync(path)[0]); }
afterEach(() => { failures.filename = ""; for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true }); vi.unstubAllGlobals(); });

describe("normal publisher durable journal", () => {
  it("closed replace and create records retain their distinct source identities across startup", () => {
    const root = state(), journal = createSupplementPublicationJournal(root); journal.reserve(input).complete(output);
    const target = { dbId: native.provenance.textPageId, stockCode: native.provenance.stockCode, nextDocId: null };
    const request = JSON.stringify({ parent: { database_id: target.dbId }, properties: buildSupplementProperties({ stockCode: target.stockCode, docId: null }) });
    const creation = journal.reserveCreate!({ ...target, snapshot: request });
    creation.complete({ pageId: native.provenance.textPageId, postPageSha256: sha(native.notionReadbackText) });
    createSupplementPublicationJournal(root).assertReady(); expect(readdirSync(join(root, "supplement-publications"))).toHaveLength(2);
  });
  it.each(["request.json", "intent.json", "completed.json"])("create filesystem interruption at %s is sticky before another run", filename => {
    const root = state(), journal = createSupplementPublicationJournal(root);
    const target = { dbId: native.provenance.textPageId, stockCode: native.provenance.stockCode, nextDocId: native.provenance.docId };
    const request = JSON.stringify({ parent: { database_id: target.dbId }, properties: buildSupplementProperties({ stockCode: target.stockCode, docId: target.nextDocId }) });
    if (filename === "completed.json") {
      const exchange = journal.reserveCreate!({ ...target, snapshot: request }); failures.filename = filename;
      expect(() => exchange.complete({ pageId: native.provenance.textPageId, postPageSha256: sha(native.notionReadbackText) })).toThrow();
    } else { failures.filename = filename; expect(() => journal.reserveCreate!({ ...target, snapshot: request })).toThrow(); }
    failures.filename = ""; const network = vi.fn(); vi.stubGlobal("fetch", network);
    expect(() => createSupplementPublicationJournal(root)).toThrow(); expect(network).not.toHaveBeenCalled();
  });
  it("retains exact PRE/intent and verified closure with both identities and hashes", () => {
    const root = state(), journal = createSupplementPublicationJournal(root), exchange = journal.reserve(input), path = directory(root);
    expect(readFileSync(join(path, "pre.json"), "utf8")).toBe(snapshot);
    const raw = readFileSync(join(path, "intent.json")); exchange.complete(output);
    expect(readFileSync(join(path, "intent.json"))).toEqual(raw);
    const completed = JSON.parse(readFileSync(join(path, "completed.json"), "utf8"));
    expect(completed).toMatchObject({ pageId: input.pageId, oldDocId: input.nextDocId, nextDocId: input.nextDocId, intentSha256: sha(raw), preSha256: sha(snapshot), ...output });
    for (const name of readdirSync(path)) expect(statSync(join(path, name)).mode & 0o777).toBe(0o600);
    expect(statSync(path).mode & 0o777).toBe(0o700); createSupplementPublicationJournal(root).assertReady();
  });
  it("unclosed intent blocks changed PRE and unrelated source across runs without modifying old bytes", () => {
    const root = state(), journal = createSupplementPublicationJournal(root); journal.reserve(input);
    const path = directory(root), raw = readFileSync(join(path, "intent.json")), pre = readFileSync(join(path, "pre.json"));
    const network = vi.fn(); vi.stubGlobal("fetch", network);
    expect(() => journal.reserve({ ...input, snapshot: snapshot + "\n" })).toThrow();
    expect(() => createSupplementPublicationJournal(root)).toThrow();
    expect(network).not.toHaveBeenCalled(); expect(readFileSync(join(path, "intent.json"))).toEqual(raw); expect(readFileSync(join(path, "pre.json"))).toEqual(pre);
  });
  it.each(["pre.json", "intent.json", "completed.json"])("missing %s is never accepted as a fresh operation", name => {
    const root = state(), exchange = createSupplementPublicationJournal(root).reserve(input); exchange.complete(output);
    unlinkSync(join(directory(root), name)); expect(() => createSupplementPublicationJournal(root)).toThrow();
  });
  it.each(["pre-bytes", "intent-hash", "source-identity", "record-clock", "permissions"])("corrupt %s fails closed", fault => {
    const root = state(), exchange = createSupplementPublicationJournal(root).reserve(input); exchange.complete(output);
    const path = directory(root), file = join(path, "completed.json"), before = readFileSync(join(path, "intent.json"));
    if (fault === "pre-bytes") writeFileSync(join(path, "pre.json"), snapshot + "\n");
    else if (fault === "permissions") chmodSync(join(path, "pre.json"), 0o644);
    else { const record = JSON.parse(readFileSync(file, "utf8")); if (fault === "intent-hash") record.intentSha256 = sha(snapshot); else if (fault === "source-identity") record.nextDocId = native.provenance.stockCode; else record.at = 0; writeFileSync(file, JSON.stringify(record)); }
    expect(() => createSupplementPublicationJournal(root)).toThrow(); expect(readFileSync(join(path, "intent.json"))).toEqual(before);
  });
  it.each(["pre.json", "intent.json", "completed.json"])("filesystem interrupted %s keeps partial state sticky across processes", filename => {
    const root = state(), journal = createSupplementPublicationJournal(root);
    if (filename === "completed.json") {
      const exchange = journal.reserve(input); failures.filename = filename; expect(() => exchange.complete(output)).toThrow();
    } else { failures.filename = filename; expect(() => journal.reserve(input)).toThrow(); }
    failures.filename = "";
    expect(() => journal.assertReady()).toThrow();
    expect(() => createSupplementPublicationJournal(root)).toThrow();
    expect(readdirSync(join(root, "supplement-publications"))).toHaveLength(1);
  });
  it("double closure and unresolved directory cannot create a replacement key", () => {
    const root = state(), exchange = createSupplementPublicationJournal(root).reserve(input); exchange.complete(output);
    expect(() => exchange.complete(output)).toThrow();
    const journal = createSupplementPublicationJournal(root); expect(() => journal.reserve(input)).toThrow();
    expect(readdirSync(join(root, "supplement-publications"))).toHaveLength(1);
  });
});
