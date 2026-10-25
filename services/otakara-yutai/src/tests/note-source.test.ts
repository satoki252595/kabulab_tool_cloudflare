/** 実原本はprivateのみ。11月2段階と5月の名簿日を区別して通常経路へ通す。 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { ROOT } from "../../../../src/shared/db/tests/source-scan.js";
import { extractPdfText } from "../../../ir-catalog/src/services/pdf-sentiment/extract-text.js";
import { adoptNoteOfficialSource, compileNoteOfficialLiteral, NOTE_LISTING_URL, NOTE_OFFICIAL_URL, NOTE_NOTICE_URL } from "../../data-scripts/note-source.js";
import { fetchStockDetail, main, parseMusashinoAdoptionArgs, readSavedNoteSource } from "../../data-scripts/fetch-yutai-full.js";
import { benefitRowsOf, carryKey, planCarry } from "../../data-scripts/yutai-full-import.js";
import { checkSummary, isSummaryNumbersGrounded, missingSummaryConditions } from "../../data-scripts/summary-contract.js";
import { companyValue, compileSimpleSummary, runLocalSummary } from "../../data-scripts/summary-local.js";
import { selectSummaryTasks, type BenefitRow } from "../../data-scripts/summary-tasks.js";
import { planSummaryImport } from "../../data-scripts/summary-import.js";
import { splitHeadedDescription } from "../../data-scripts/estimated-value-guard.js";
import { buildPublicBenefitFacts } from "../../data-scripts/public-facts.js";
import metadata from "./fixtures/note-source-saved2.json";

const dir = join(ROOT, metadata.privateFixtureDir), packetPath = join(dir, "SAVED-SOURCE-PACKET.private.json");
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const packetSha = metadata.files.find(file => file.path === "SAVED-SOURCE-PACKET.private.json")!.sha256;

it("未資格の5243原本とnote公式の定型句は保留し、unknown stateへ再送しない", async () => {
  expect(() => adoptNoteOfficialSource({ code: "5243", name: null, market: null, category: null, benefits: [] }, "", new Uint8Array(), "", "")).toThrow("note_official_source_changed");
  expect(compileNoteOfficialLiteral("")).toBeNull();
  expect(isSummaryNumbersGrounded("", "note公式:6,000ポイント", { minShares: [200], recordMonths: [11], recordDates: [null] })).toBe(false);
  expect(() => parseMusashinoAdoptionArgs(["--adopt-note-source", "--adopt-musashino-source"])).toThrow();
  const state = mkdtempSync(join(tmpdir(), "note-unknown-control-"));
  const body = JSON.stringify({ status: "unknown_control" }); writeFileSync(join(state, "INTENT.private.json"), body, { mode: 0o600 });
  const args = ["--adopt-note-source", "--saved-source=/not-read-control", `--saved-source-sha256=${"0".repeat(64)}`,
    "--expected-pre=/not-read-control", `--expected-pre-sha256=${"0".repeat(64)}`, `--state-dir=${state}`];
  try {
    for (let i = 0; i < 2; i++) await expect(main(args)).rejects.toThrow("musashino_adoption_state_already_started");
    expect(readFileSync(join(state, "INTENT.private.json"), "utf8")).toBe(body);
  } finally { rmSync(state, { recursive: true }); }
});

it.skipIf(!existsSync(packetPath))("保存provider/FAQ/PDFの全条件を11月2段階へ採用し、通常取込/selector/翌月carryで保持する", async () => {
  for (const file of metadata.files) expect(digest(readFileSync(join(dir, file.path)))).toBe(file.sha256);
  const { data, packet } = await readSavedNoteSource(packetPath, packetSha), planned = benefitRowsOf(data);
  expect(planned.heldBenefits).toBe(0);
  expect(planned.rows.map(row => ({ minShares: row.minShares, recordMonth: row.recordMonth, recordDate: null, descriptionSha256: digest(row.description) }))).toEqual(metadata.expectedRows);
  expect(data.sourceFetchedAt).toBe("2026-10-21T16:30:29.082Z");
  expect(packet.providerBatchFetchedAt).toBe("2026-10-21T16:56:22.538Z");
  expect(packet.pages.map(page => page.receivedAt)).toEqual(["2026-10-21T16:30:29.082Z", "2026-10-25T20:29:07.105213+00:00", "2026-10-25T20:29:07.337103+00:00"]);
  expect(data.official).toEqual({ url: NOTE_OFFICIAL_URL, verifiedAt: "2026-10-25T20:29:07.337Z" });
  const original = JSON.parse(readFileSync(join(dir, "SAVED-ROWS.private.json"), "utf8")) as BenefitRow[];
  const rows: BenefitRow[] = original.map((row, i) => ({ ...row, description: planned.rows[i].description, shortSummary: null }));
  const tasks = selectSummaryTasks(rows), results = tasks.map(task => {
    const result = compileSimpleSummary(task); if (result === null) throw new Error("note_actual_compile_missing");
    const expected = metadata.canonical.find(row => row.minShares === task.recipients[0].minShares)!;
    expect(digest(result.shortSummary)).toBe(expected.summarySha256); expect(result.shortSummary.length).toBe(expected.summaryCharacters);
    expect(companyValue(task)).toEqual({ value: null, reason: "no_per_grant_face" }); expect(result.estimatedValue).toBeNull();
    expect(checkSummary(result.shortSummary)).toEqual([]); expect(missingSummaryConditions(task.description, result.shortSummary)).toEqual([]);
    const facts = buildPublicBenefitFacts({ code: data.code, description: task.description, context: { minShares: [task.recipients[0].minShares], recordMonths: [11] },
      fetchedAt: data.sourceFetchedAt!, batchFetchedAt: packet.providerBatchFetchedAt, official: data.official });
    expect(facts).toMatchObject({ holding: true, holdingPeriods: ["1年以上"], qualifiedAmount: null, valueStatus: "unresolved", source: { officialStatus: "verified", officialUrl: NOTE_OFFICIAL_URL } });
    return result;
  });
  const resultsText = results.map(result => JSON.stringify(result)).join("\n"), plan = planSummaryImport({ tasks, currentRows: rows, resultsText });
  expect(plan.rejections).toEqual([]); expect(plan.updates.flatMap(update => update.ids).sort()).toEqual([59703, 59704]);
  const after = rows.map(row => {
    const update = plan.updates.find(update => update.ids.includes(row.id))!;
    return { ...row, shortSummary: update.shortSummary, estimatedValue: update.estimatedValue, estimateValueSource: update.estimateValueSource };
  });
  expect(selectSummaryTasks(after)).toEqual([]); expect(planSummaryImport({ tasks, currentRows: after, resultsText })).toMatchObject({ updates: [], skippedEquivalent: 2 });
  for (const row of after) {
    const source = splitHeadedDescription(row.description), key = carryKey("5243", source.body, row.minShares, 11);
    expect(source.heading).not.toBeNull();
    const groups = new Map([["5243", new Map([[source.body, { minShares: [row.minShares], recordMonths: [11] }]])]]);
    const carry = planCarry([{ ...row, code: "5243" }], new Map([[key, [source.heading!]]]), groups);
    expect(carry.carried.get(key)).toEqual({ shortSummary: row.shortSummary, estimatedValue: null, estimateValueSource: null });
    expect(planCarry([{ ...row, code: "5243" }], new Map([[key, ["別見出し"]]]), groups).nulledKeys.has(key)).toBe(true);
  }
  const state = mkdtempSync(join(ROOT, "tmp/note-summary-test-")); let current = structuredClone(rows);
  try {
    const report = await runLocalSummary({ limit: 60, stateDir: state }, { loadRows: async () => structuredClone(current),
      generate: async () => { throw new Error("model_must_not_run"); }, archive: async () => {},
      apply: async (_fresh, imported) => { current = current.map(row => {
        const update = imported.updates.find(update => update.ids.includes(row.id))!;
        return { ...row, shortSummary: update.shortSummary, estimatedValue: update.estimatedValue, estimateValueSource: update.estimateValueSource, updatedAt: row.updatedAt + 1 };
      }); } });
    expect(report).toMatchObject({ selected: 2, accepted: 2, rejected: 0, pendingAfter: 0, modelCalls: 0, deterministic: 2 });
  } finally { rmSync(state, { recursive: true }); }
  const requests = vi.spyOn(globalThis, "fetch").mockImplementation(async url => {
    const page = packet.pages.find(page => page.url === url); if (page === undefined) throw new Error("unexpected_source_request");
    return new Response(Buffer.from(page.bodyBase64, "base64"), { headers: { "Content-Type": page.contentType } });
  });
  try {
    const collected = await fetchStockDetail("5243"); expect(collected.status).toBe("ok");
    if (collected.status !== "ok") throw new Error("note_normal_fetch_failed");
    expect(benefitRowsOf(collected.data).rows).toEqual(planned.rows);
    expect(requests.mock.calls.map(([url]) => url)).toEqual([NOTE_LISTING_URL, NOTE_OFFICIAL_URL, NOTE_NOTICE_URL]);
  } finally { requests.mockRestore(); }
});

it.skipIf(!existsSync(packetPath))("公式全文/歴史日付/サービス用途/現tier/基準月/単発への変更を拒否する", async () => {
  const { data, packet } = await readSavedNoteSource(packetPath, packetSha), rows = benefitRowsOf(data).rows;
  const faq = Buffer.from(packet.pages[1].bodyBase64, "base64").toString("utf8"), pdf = new Uint8Array(Buffer.from(packet.pages[2].bodyBase64, "base64"));
  const text = await extractPdfText(pdf); if (text === null) throw new Error("note_actual_pdf_unreadable");
  for (const changed of [faq.replace(NOTE_NOTICE_URL, NOTE_OFFICIAL_URL), faq.replace("2025年8月", "2026年8月")])
    expect(() => adoptNoteOfficialSource(data, changed, pdf, text, data.official!.verifiedAt)).toThrow();
  const badPdf = Uint8Array.from(pdf); badPdf[badPdf.length - 1] ^= 1;
  expect(() => adoptNoteOfficialSource(data, faq, badPdf, text, data.official!.verifiedAt)).toThrow();
  expect(() => adoptNoteOfficialSource(data, faq, pdf, text + "追加条件", data.official!.verifiedAt)).toThrow();
  const tasks = selectSummaryTasks(rows.map((row, i) => ({ id: 59703 + i, stockId: 871, stockCode: "5243", stockName: "note", ...row,
    shortSummary: null, estimatedValue: null, estimateValueSource: null, recordDate: null, updatedAt: 0 })));
  for (const task of tasks) {
    const result = compileSimpleSummary(task)!;
    const context = { minShares: [task.recipients[0].minShares], recordMonths: [11], recordDates: [null] };
    for (const description of [task.description + "追加条件", ...task.description.split("\n").map((_, i, lines) => lines.filter((__, j) => i !== j).join("\n")),
      ...["2024", "2025", "3回", "100株", "1年以上", "2月中", "有料記事"].map(term => task.description.replace(term, "別条件"))]) {
      expect(description).not.toBe(task.description); expect(compileNoteOfficialLiteral(description)).toBeNull();
      expect(isSummaryNumbersGrounded(description, result.shortSummary, context)).toBe(false);
    }
    for (const recipient of [{ ...task.recipients[0], minShares: task.recipients[0].minShares === 100 ? 200 : 100 }, { ...task.recipients[0], recordMonth: 5 },
      { ...task.recipients[0], recordDate: "2025-11-30" }]) expect(compileSimpleSummary({ ...task, recipients: [recipient] })).toBeNull();
    for (const changed of [{ ...task, stockCode: "8336" }, { ...task, rowCount: 2 }, { ...task, recipients: [] }, { ...task, recipients: [...task.recipients, ...task.recipients] }])
      expect(compileSimpleSummary(changed)).toBeNull();
    for (const summary of [result.shortSummary + "追加条件", ...["2024", "2025", "3回", "100株", "2月中", "有料記事"].map(term => result.shortSummary.replace(term, "別条件"))])
      expect(isSummaryNumbersGrounded(task.description, summary, context)).toBe(false);
  }
});
