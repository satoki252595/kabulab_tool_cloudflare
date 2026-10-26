/** 実原本はprivateのみ。変更前と2027年拡充後を年次4行へ保持する。 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ROOT } from "../../../../src/shared/db/tests/source-scan.js";
import { extractPdfText } from "../../../ir-catalog/src/services/pdf-sentiment/extract-text.js";
import { renderBenefitFacts } from "../../app.js";
import { parsePublicBenefitFacts } from "../public-facts.js";
import { adoptKawasakiOfficialSource, compileKawasakiOfficialLiteral, KAWASAKI_LISTING_URL, KAWASAKI_OFFICIAL_URL, KAWASAKI_NOTICE_URL } from "../../data-scripts/kawasaki-source.js";
import { fetchStockDetail, main, parseMusashinoAdoptionArgs, readSavedKawasakiSource } from "../../data-scripts/fetch-yutai-full.js";
import { benefitRowsOf, carryKey, planCarry } from "../../data-scripts/yutai-full-import.js";
import { checkSummary, isSummaryNumbersGrounded, missingSummaryConditions } from "../../data-scripts/summary-contract.js";
import { companyValue, compileSimpleSummary } from "../../data-scripts/summary-local.js";
import { selectSummaryTasks, type BenefitRow } from "../../data-scripts/summary-tasks.js";
import { planSummaryImport } from "../../data-scripts/summary-import.js";
import { extractYenAmounts, splitHeadedDescription } from "../../data-scripts/estimated-value-guard.js";
import { buildPublicBenefitFacts } from "../../data-scripts/public-facts.js";
import metadata from "./fixtures/kawasaki-source-saved4.json";

const dir = join(ROOT, metadata.privateFixtureDir), packetPath = join(dir, "SAVED-SOURCE-PACKET.private.json");
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const packetSha = metadata.files.find(file => file.path === "SAVED-SOURCE-PACKET.private.json")!.sha256;

it("未資格の3045原本・未知の定型句は保留し、unknown stateへ再送しない", async () => {
  expect(() => adoptKawasakiOfficialSource({ code: "3045", name: null, market: null, category: null, benefits: [] }, "", new Uint8Array(), "", "")).toThrow("kawasaki_official_source_changed");
  expect(compileKawasakiOfficialLiteral("")).toBeNull();
  expect(isSummaryNumbersGrounded("", "カワサキ公式:100株以上", { minShares: [100], recordMonths: [2], recordDates: [null] })).toBe(false);
  expect(() => parseMusashinoAdoptionArgs(["--adopt-kawasaki-source", "--add-musashino-initial-event"])).toThrow();
  const state = mkdtempSync(join(ROOT, "tmp/kawasaki-unknown-control-"));
  const body = JSON.stringify({ status: "unknown_control" }); writeFileSync(join(state, "INTENT.private.json"), body, { mode: 0o600 });
  const args = ["--adopt-kawasaki-source", "--saved-source=/not-read-control", `--saved-source-sha256=${"0".repeat(64)}`,
    "--expected-pre=/not-read-control", `--expected-pre-sha256=${"0".repeat(64)}`, `--state-dir=${state}`];
  try {
    for (let i = 0; i < 2; i++) await expect(main(args)).rejects.toThrow("musashino_adoption_state_already_started");
    expect(readFileSync(join(state, "INTENT.private.json"), "utf8")).toBe(body);
  } finally { rmSync(state, { recursive: true }); }
});

it.skipIf(!existsSync(packetPath))("保存全2ページのセルとphaseを通常2群/4行・DTO・翌月carryへ保つ", async () => {
  for (const file of metadata.files) expect(digest(readFileSync(join(dir, file.path)))).toBe(file.sha256);
  const { data, packet } = await readSavedKawasakiSource(packetPath, packetSha), planned = benefitRowsOf(data);
  expect(planned.heldBenefits).toBe(0);
  expect(planned.rows.map(row => ({ minShares: row.minShares, recordMonth: row.recordMonth, recordDate: null, descriptionSha256: digest(row.description) }))).toEqual(metadata.expectedRows);
  expect(data.sourceFetchedAt).toBe("2026-10-21T16:16:52.221Z"); expect(packet.providerBatchFetchedAt).toBe("2026-10-21T16:56:22.538Z");
  expect(packet.pages.map(page => page.receivedAt)).toEqual(["2026-10-21T16:16:52.221Z", "2026-10-25T20:29:30.806839+00:00", "2026-10-25T20:29:41.991941+00:00"]);
  const original = JSON.parse(readFileSync(join(dir, "SAVED-ROWS.private.json"), "utf8")) as BenefitRow[];
  expect(original.every(row => row.description.includes("確定日6月末"))).toBe(true);
  const rows: BenefitRow[] = original.map((row, i) => ({ ...row, description: planned.rows[i].description }));
  const tasks = selectSummaryTasks(rows), results = tasks.map(task => {
    const result = compileSimpleSummary(task); if (result === null) throw new Error("kawasaki_actual_compile_missing");
    const expected = metadata.canonical.find(row => row.minShares === task.recipients[0].minShares)!;
    expect(digest(result.shortSummary)).toBe(expected.summarySha256); expect(result.shortSummary.length).toBe(expected.summaryCharacters);
    expect([...new Set(extractYenAmounts(task.description))]).toEqual(expected.minShares === 100 ? [1500, 3000] : [5000, 4500, 10000, 9000]);
    expect(task.description).toContain("【半年以上（注1）】\n"); expect(task.description).toContain("【3年以上（注2）・新設】\n");
    expect(task.description).not.toContain("半年以上※1"); expect(task.description).not.toContain("確定日6月末");
    expect(companyValue(task)).toEqual({ value: null, reason: "multi_month_amounts" }); expect(result.estimatedValue).toBeNull();
    expect(checkSummary(result.shortSummary)).toEqual([]); expect(missingSummaryConditions(task.description, result.shortSummary)).toEqual([]);
    const facts = buildPublicBenefitFacts({ code: data.code, description: task.description,
      context: { minShares: [expected.minShares], recordMonths: [2, 8] }, fetchedAt: data.sourceFetchedAt!, batchFetchedAt: packet.providerBatchFetchedAt, official: data.official });
    expect(facts).toMatchObject({ version: 7, holding: true, holdingPeriods: ["半年以上", "3年以上"], qualifiedAmount: null,
      conditionStructure: { applicability: "unverified", ast: { beforeHoldingPeriod: "not_stated", fromRecordDate: "2027-02-28", afterHoldingPeriods: ["半年以上", "3年以上"] } } });
    expect(parsePublicBenefitFacts(facts, "3045")).toEqual(facts);
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 9, 26));
    try {
      const html = renderBenefitFacts(facts, null); now.mockReturnValue(Date.UTC(2027, 5, 1));
      expect(renderBenefitFacts(facts, null)).toBe(html);
      expect(html).toContain("変更前表に保有期間の記載なし（不要と確認したものではありません）");
      expect(html).toContain("2027-02-28基準からの拡充後"); expect(html).not.toContain("掲載の期間表記 半年以上・3年以上");
      expect(html).not.toContain("継続保有期間の定めなし"); expect(html).toContain("2026-10-21T16:16:52.221Z");
    } finally { now.mockRestore(); }
    return result;
  });
  const resultsText = results.map(result => JSON.stringify(result)).join("\n"), plan = planSummaryImport({ tasks, currentRows: rows, resultsText });
  expect(plan.rejections).toEqual([]); expect(plan.updates.flatMap(update => update.ids).sort()).toEqual([57774, 57775, 57776, 57777]);
  const after = rows.map(row => {
    const update = plan.updates.find(update => update.ids.includes(row.id))!;
    return { ...row, code: row.stockCode, shortSummary: update.shortSummary, estimatedValue: update.estimatedValue, estimateValueSource: update.estimateValueSource };
  });
  expect(selectSummaryTasks(after)).toEqual([]); expect(planSummaryImport({ tasks, currentRows: after, resultsText })).toMatchObject({ updates: [], skippedEquivalent: 2 });
  const headings = new Map<string, string[]>(), groups = new Map<string, { minShares: number[]; recordMonths: number[] }>();
  for (const row of after) {
    const source = splitHeadedDescription(row.description); if (source.heading === null) throw new Error("heading_missing");
    headings.set(carryKey(row.code, source.body, row.minShares, row.recordMonth), [source.heading]);
    const group = groups.get(source.body) ?? { minShares: [], recordMonths: [] }; group.minShares.push(row.minShares); group.recordMonths.push(row.recordMonth); groups.set(source.body, group);
  }
  const carry = planCarry(after, headings, new Map([["3045", groups]]));
  expect(carry.carried.size).toBe(4); expect(carry.nulledKeys.size).toBe(0); expect([...carry.carriedRecordDates.values()]).toEqual([null, null, null, null]);
  const requests = vi.spyOn(globalThis, "fetch").mockImplementation(async url => {
    const page = packet.pages.find(page => page.url === url); if (page === undefined) throw new Error("unexpected_source_request");
    return new Response(Buffer.from(page.bodyBase64, "base64"), { headers: { "Content-Type": page.contentType } });
  });
  try {
    const collected = await fetchStockDetail("3045"); if (collected.status !== "ok") throw new Error("kawasaki_normal_fetch_failed");
    expect(benefitRowsOf(collected.data).rows).toEqual(planned.rows);
    expect(requests.mock.calls.map(([url]) => url)).toEqual([KAWASAKI_LISTING_URL, KAWASAKI_OFFICIAL_URL, KAWASAKI_NOTICE_URL]);
  } finally { requests.mockRestore(); }
});

it.skipIf(!existsSync(packetPath))("全文・phase・旧6月・recipientの変形を拒否し、変更前を保有不要へ確定しない", async () => {
  const { data, packet } = await readSavedKawasakiSource(packetPath, packetSha), planned = benefitRowsOf(data);
  const pdf = new Uint8Array(Buffer.from(packet.pages[2].bodyBase64, "base64")), text = await extractPdfText(pdf);
  if (text === null) throw new Error("pdf_missing");
  const badPdf = Uint8Array.from(pdf); badPdf[badPdf.length - 1] ^= 1;
  expect(() => adoptKawasakiOfficialSource(data, "", pdf, text, data.official!.verifiedAt)).toThrow();
  expect(() => adoptKawasakiOfficialSource(data, Buffer.from(packet.pages[1].bodyBase64, "base64").toString("utf8"), badPdf, text, data.official!.verifiedAt)).toThrow();
  const original = JSON.parse(readFileSync(join(dir, "SAVED-ROWS.private.json"), "utf8")) as BenefitRow[];
  const rows = original.map((row, i) => ({ ...row, description: planned.rows[i].description })), tasks = selectSummaryTasks(rows);
  for (const task of tasks) {
    const result = compileSimpleSummary(task)!;
    const context = { minShares: task.recipients.map(row => row.minShares), recordMonths: [2, 8], recordDates: [null, null] };
    for (const description of [task.description + "追加条件", task.description.replace("2027年2月28日", "2026年2月28日")])
      expect(isSummaryNumbersGrounded(description, result.shortSummary, context)).toBe(false);
    for (const shortSummary of [result.shortSummary.replace("2027年2月28日基準から拡充し、", ""), result.shortSummary.replace("変更前は", ""), result.shortSummary.replace("拡充後の保有判定:", "保有判定:"), result.shortSummary.replace("8月末", "6月末")]) {
      expect(isSummaryNumbersGrounded(task.description, shortSummary, context)).toBe(false);
      expect(planSummaryImport({ tasks, currentRows: rows, resultsText: JSON.stringify({ ...result, shortSummary }) }).updates).toEqual([]);
    }
    for (const changed of [{ ...task, stockCode: "5243" }, { ...task, rowCount: 1 }, { ...task, recipients: task.recipients.slice(1) },
      { ...task, recipients: task.recipients.map(row => ({ ...row, minShares: row.minShares + 1 })) },
      { ...task, recipients: task.recipients.map(row => ({ ...row, recordMonth: 6 })) },
      { ...task, recipients: task.recipients.map(row => ({ ...row, recordDate: "2027-02-28" })) }]) expect(compileSimpleSummary(changed)).toBeNull();
    const input = { code: "3045", description: task.description, context: { minShares: [task.recipients[0].minShares], recordMonths: [2] },
      fetchedAt: data.sourceFetchedAt!, batchFetchedAt: packet.providerBatchFetchedAt, official: data.official };
    const facts = buildPublicBenefitFacts(input); if (facts.version !== 7) throw new Error("phase_facts_missing");
    for (const invalid of [{ ...facts, holding: false, holdingPeriods: [] },
      { ...facts, conditionStructure: { ...facts.conditionStructure, ast: { ...facts.conditionStructure.ast, beforeHoldingPeriod: "not_required" } } },
      { ...facts, conditionStructure: { ...facts.conditionStructure, ast: { ...facts.conditionStructure.ast, fromRecordDate: "2026-02-28" } } },
      { ...facts, conditionStructure: { ...facts.conditionStructure, ast: { ...facts.conditionStructure.ast, afterHoldingPeriods: ["半年以上"] } } },
      { ...facts, conditionStructure: { ...facts.conditionStructure, applicability: "verified" } }]) expect(() => parsePublicBenefitFacts(invalid, "3045")).toThrow();
    for (const invalid of [{ ...input, code: "5243" }, { ...input, official: undefined }, { ...input, context: { minShares: [500], recordMonths: [2] } }])
      expect(() => buildPublicBenefitFacts(invalid)).toThrow("kawasaki_source_context_changed");
  }
});
