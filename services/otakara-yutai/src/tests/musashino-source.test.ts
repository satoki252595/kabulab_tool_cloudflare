import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { ROOT } from "../../../../src/shared/db/tests/source-scan.js";
import { extractPdfText } from "../../../ir-catalog/src/services/pdf-sentiment/extract-text.js";
import { adoptMusashinoOfficialSource, compileMusashinoOfficialLiteral, MUSASHINO_LISTING_URL, MUSASHINO_OFFICIAL_URL, MUSASHINO_NOTICE_URL } from "../../data-scripts/musashino-source.js";
import { parseStockDetail, fetchStockDetail, readSavedMusashinoSource, parseMusashinoAdoptionArgs, main } from "../../data-scripts/fetch-yutai-full.js";
import { benefitRowsOf, carryKey, planCarry, type StockYutaiData } from "../../data-scripts/yutai-full-import.js";
import { checkSummary, isSummaryNumbersGrounded } from "../../data-scripts/summary-contract.js";
import { compileSimpleSummary } from "../../data-scripts/summary-local.js";
import { selectSummaryTasks, SummaryTask, type BenefitRow } from "../../data-scripts/summary-tasks.js";
import { planSummaryImport } from "../../data-scripts/summary-import.js";
import { SUMMARY_CONTRACT_VERSION } from "../../data-scripts/summary-contract.js";
import { benefitKey } from "../../data-scripts/benefit-key.js";
import { buildPublicBenefitFacts } from "../../data-scripts/public-facts.js";
import { parsePublicBenefitFacts } from "../public-facts.js";
import { renderBenefitFacts } from "../../app.js";
import metadata from "./fixtures/musashino-source-saved3.json";

const privateDir = join(ROOT, metadata.privateFixtureDir);
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const empty: StockYutaiData = { code: "8336", name: null, market: null, category: null, benefits: [] };

it("未資格の8336公式sourceと要約scopeを一般照合へ降格させない", () => {
  expect(() => adoptMusashinoOfficialSource(empty, "", new Uint8Array(), "", "")).toThrow("musashino_official_source_changed");
  expect(compileMusashinoOfficialLiteral("")).toBeNull();
  expect(() => parseMusashinoAdoptionArgs(["--adopt-musashino-source"])).toThrow("musashino_fixed_inputs_required");
  expect(() => parseMusashinoAdoptionArgs(["--adopt-musashino-source", "--code=8336"])).toThrow();
  expect(isSummaryNumbersGrounded("", "武蔵野銀行公式:200株", { minShares: [200], recordMonths: [3], recordDates: [null] })).toBe(false);
});

it.each(["--adopt-musashino-source", "--add-musashino-initial-event"])("限定mode %s の既存unknown制御stateは原本読取/送信前に停止し再送しない", async mode => {
  const dir = mkdtempSync(join(tmpdir(), "musashino-unknown-control-")), path = join(dir, "INTENT.private.json");
  const body = JSON.stringify({ status: "unknown_control" }); writeFileSync(path, body, { mode: 0o600 });
  const args = [mode, "--saved-source=/not-read-control", `--saved-source-sha256=${"0".repeat(64)}`,
    "--expected-pre=/not-read-control", `--expected-pre-sha256=${"0".repeat(64)}`, `--state-dir=${dir}`];
  try {
    for (let i = 0; i < 2; i++) await expect(main(args)).rejects.toThrow("musashino_adoption_state_already_started");
    expect(readFileSync(path, "utf8")).toBe(body);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it.skipIf(!existsSync(join(privateDir, "official-8336.pdf")))("同じ公式全原本から初回9月だけを日付付き3段階へ定型化し、年次化や条件改変を拒否する", async () => {
  const packet = metadata.files.find(file => file.path === "SAVED-SOURCE-PACKET.private.json")!;
  const { data, annual, packet: captured } = await readSavedMusashinoSource(join(privateDir, packet.path), packet.sha256, true);
  const rows = benefitRowsOf(data).rows;
  expect(rows.map(row => ({ minShares: row.minShares, recordMonth: row.recordMonth, recordDate: "2026-09-30", descriptionSha256: digest(row.description), descriptionChars: row.description.length }))).toEqual(metadata.expectedInitialRows);
  expect(benefitRowsOf(annual).rows.map(row => digest(row.description))).toEqual(metadata.expectedRows.map(row => row.descriptionSha256));
  for (const row of rows) {
    const task = SummaryTask.parse({ taskId: benefitKey("8336", row.description), contractVersion: SUMMARY_CONTRACT_VERSION, stockCode: "8336", stockName: "武蔵野銀行",
      description: row.description, reason: "missing", violations: [], rowCount: 1, recipients: [{ minShares: row.minShares, recordMonth: 9, recordDate: "2026-09-30" }] });
    const result = compileSimpleSummary(task);
    expect(result).not.toBeNull();
    const canonical = metadata.initialCanonical.find(value => value.minShares === row.minShares)!;
    expect(digest(result!.shortSummary)).toBe(canonical.summarySha256);
    expect(result!.shortSummary.length).toBe(canonical.summaryCharacters);
    expect(result!.estimatedValue).toBeNull();
    expect(checkSummary(result!.shortSummary)).toEqual([]);
    expect(result!.shortSummary).toContain("継続保有期間の定めなし");
    expect(result!.shortSummary).not.toContain("年1回");
    const facts = buildPublicBenefitFacts({ code: data.code, description: row.description, context: { minShares: [row.minShares], recordMonths: [9] },
      fetchedAt: data.sourceFetchedAt!, batchFetchedAt: captured.providerBatchFetchedAt, official: data.official });
    expect(facts).toMatchObject({ version: 6, holding: false, holdingPeriods: [], valueStatus: "unresolved", qualifiedAmount: null,
      conditionStructure: { ast: { recordDate: "2026-09-30", minimumRegistryShares: 200, holdingPeriod: "not_required" } } });
    const html = renderBenefitFacts(facts, null);
    expect(html).toContain("初回2026-09-30は継続保有期間の定めなし");
    expect(html).not.toContain("保有に関する記載あり（期間未確定）");
    expect(html).not.toContain("掲載に記載なし（不要と確認したものではありません）");
    expect(() => parsePublicBenefitFacts({ ...facts, holding: true }, data.code)).toThrow();
    if (facts.version !== 6) throw new Error("initial_holding_structure_missing");
    expect(() => parsePublicBenefitFacts({ ...facts, conditionStructure: { ...facts.conditionStructure, sourceSha256: "0".repeat(64) } }, data.code)).toThrow();
    for (const ast of [{ ...facts.conditionStructure.ast, holdingPeriod: "1年以上" }, { ...facts.conditionStructure.ast, recordDate: "2026-09-29" }])
      expect(() => parsePublicBenefitFacts({ ...facts, conditionStructure: { ...facts.conditionStructure, ast } }, data.code)).toThrow();
    for (const recipient of [{ ...task.recipients[0], recordDate: null }, { ...task.recipients[0], recordDate: "2026-09-29" },
      { ...task.recipients[0], recordMonth: 3 }, { ...task.recipients[0], minShares: 100 }]) expect(compileSimpleSummary({ ...task, recipients: [recipient] })).toBeNull();
    for (const term of ["初回", "定めなし", "200株", "0.3%", "100万円", "日本国内", "店頭窓口"]) {
      const description = task.description.replace(term, "変更条件");
      expect(description).not.toBe(task.description);
      expect(compileSimpleSummary({ ...task, description })).toBeNull();
    }
    for (const description of [task.description + "\n追加条件", ...task.description.split("\n").map((_, i, lines) => lines.filter((__, j) => i !== j).join("\n"))])
      expect(compileSimpleSummary({ ...task, description })).toBeNull();
    expect(compileSimpleSummary({ ...task, recipients: [...task.recipients, ...task.recipients] })).toBeNull();
    expect(compileSimpleSummary({ ...task, rowCount: 2 })).toBeNull();
  }
  expect(() => parseMusashinoAdoptionArgs(["--adopt-musashino-source", "--add-musashino-initial-event"])).toThrow();
});

it.skipIf(!existsSync(join(privateDir, "official-8336.pdf")))("実体2原本・提供元から3月3段階を通常取得/要約/翌月carryへ通す（CIはprivate不在skip）", async () => {
  for (const file of metadata.files) expect(digest(readFileSync(join(privateDir, file.path)))).toBe(file.sha256);
  const provider = JSON.parse(readFileSync(join(privateDir, "PROVIDER-8336-RAW.private.json"), "utf8")) as { selectedRecord: { bodyBase64: string; receivedAt: string } };
  const html = readFileSync(join(privateDir, "official-8336.html"), "utf8"), pdf = new Uint8Array(readFileSync(join(privateDir, "official-8336.pdf")));
  const pdfText = await extractPdfText(pdf);
  if (pdfText === null) throw new Error("actual_notice_unreadable");
  const parsed = parseStockDetail("8336", Buffer.from(provider.selectedRecord.bodyBase64, "base64").toString("utf8"));
  if (parsed.status !== "ok") throw new Error("actual_provider_unreadable");
  parsed.data.sourceFetchedAt = provider.selectedRecord.receivedAt;
  const capture = JSON.parse(readFileSync(join(privateDir, "OFFICIAL-CAPTURE.private.json"), "utf8")) as { sources: { receivedAt: string }[] };
  const data = adoptMusashinoOfficialSource(parsed.data, html, pdf, pdfText, capture.sources[1].receivedAt), planned = benefitRowsOf(data);
  expect(planned.heldBenefits).toBe(0);
  expect(planned.rows.map(row => ({ minShares: row.minShares, recordMonth: row.recordMonth, recordDate: null, descriptionSha256: digest(row.description) }))).toEqual(metadata.expectedRows);
  expect(data.sourceFetchedAt).toBe(provider.selectedRecord.receivedAt);
  const savedPacket = metadata.files.find(file => file.path === "SAVED-SOURCE-PACKET.private.json")!;
  expect((await readSavedMusashinoSource(join(privateDir, savedPacket.path), savedPacket.sha256)).data).toEqual(data);
  expect(data.official).toEqual({ url: MUSASHINO_OFFICIAL_URL, verifiedAt: capture.sources[1].receivedAt });
  const originals = JSON.parse(readFileSync(join(privateDir, "SAVED-ROWS.private.json"), "utf8")) as BenefitRow[];
  const rows = originals.map((row, index) => ({ ...row, description: planned.rows[index].description }));
  const tasks = selectSummaryTasks(rows), results = tasks.map(compileSimpleSummary);
  expect(tasks).toHaveLength(3); expect(results.every(result => result !== null)).toBe(true);
  expect(results.map(result => result!.shortSummary.length).sort()).toEqual([235, 250, 256]);
  const importPlan = planSummaryImport({ tasks, currentRows: rows, resultsText: results.map(result => JSON.stringify(result)).join("\n") });
  expect(importPlan.rejections).toEqual([]); expect(importPlan.updates).toHaveLength(3);
  expect(results.every(result => result!.estimatedValue === null)).toBe(true);
  for (const task of tasks) {
    const result = compileSimpleSummary(task)!;
    const context = { minShares: task.recipients.map(row => row.minShares), recordMonths: [3], recordDates: [null] };
    expect(checkSummary(result.shortSummary)).toEqual([]);
    expect(isSummaryNumbersGrounded(task.description, result.shortSummary, context)).toBe(true);
    expect(originals.some(row => row.description === task.description)).toBe(false);
    const lines = task.description.split("\n");
    for (const description of [task.description + "\n追加条件", ...lines.map((_, index) => lines.filter((_, i) => i !== index).join("\n")),
      ...["2027", "2028", "2回", "3回以上", "200株", "0.3%", "日本国内"].map(term => task.description.replace(term, "別条件"))]) {
      expect(description).not.toBe(task.description);
      expect(compileSimpleSummary({ ...task, description })).toBeNull();
      expect(isSummaryNumbersGrounded(description, result.shortSummary, context)).toBe(false);
    }
    for (const recipient of [{ ...task.recipients[0], minShares: 100 }, { ...task.recipients[0], recordMonth: 9 }, { ...task.recipients[0], recordDate: "2027-03-31" }])
      expect(compileSimpleSummary({ ...task, recipients: [recipient] })).toBeNull();
    expect(compileSimpleSummary({ ...task, rowCount: 2 })).toBeNull();
    expect(compileSimpleSummary({ ...task, recipients: [...task.recipients, ...task.recipients] })).toBeNull();
    expect(isSummaryNumbersGrounded(task.description, result.shortSummary.replace("2回", "3回"), context)).toBe(false);
    const benefit = data.benefits.find(value => value.minShares === task.recipients[0].minShares)!;
    const body = `${benefit.description}\n${benefit.notes}`, key = carryKey("8336", body, benefit.minShares, 3);
    const carry = planCarry([{ ...rows.find(row => row.minShares === benefit.minShares)!, code: "8336", shortSummary: result.shortSummary }], new Map([[key, [benefit.heading]]]), new Map([["8336", new Map([[body, { minShares: [benefit.minShares], recordMonths: [3] }]])]]));
    expect(carry.carried.get(key)?.shortSummary).toBe(result.shortSummary);
  }
  for (const changed of [html.replace("2027年", "2029年"), html.replace("200株以上", "100株以上")]) {
    expect(() => adoptMusashinoOfficialSource(parsed.data, changed, pdf, pdfText, capture.sources[1].receivedAt)).toThrow();
  }
  const changedPdf = Uint8Array.from(pdf); changedPdf[changedPdf.length - 1] ^= 1;
  expect(() => adoptMusashinoOfficialSource(parsed.data, html, changedPdf, pdfText, capture.sources[1].receivedAt)).toThrow();
  expect(() => adoptMusashinoOfficialSource(parsed.data, html, pdf, pdfText + "追加条件", capture.sources[1].receivedAt)).toThrow();
  const received: { url: string; bodyBase64: string }[] = [];
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async url => {
    if (url === MUSASHINO_LISTING_URL) return new Response(Buffer.from(provider.selectedRecord.bodyBase64, "base64"), { headers: { "Content-Type": "text/html" } });
    if (url === MUSASHINO_OFFICIAL_URL) return new Response(html, { headers: { "Content-Type": "text/html" } });
    if (url === MUSASHINO_NOTICE_URL) return new Response(pdf, { headers: { "Content-Type": "application/pdf" } });
    throw new Error("unexpected_source_request");
  });
  try {
    const collected = await fetchStockDetail("8336", page => received.push(page));
    expect(collected.status).toBe("ok");
    if (collected.status !== "ok") throw new Error("normal_fetch_failed");
    expect(benefitRowsOf(collected.data).rows).toEqual(planned.rows);
    expect(received.map(page => page.url)).toEqual([MUSASHINO_LISTING_URL, MUSASHINO_OFFICIAL_URL, MUSASHINO_NOTICE_URL]);
    expect(fetcher).toHaveBeenCalledTimes(3);
    fetcher.mockImplementation(async url => new Response(url === MUSASHINO_LISTING_URL ? Buffer.from(provider.selectedRecord.bodyBase64, "base64") : html.replace("200株以上", "100株以上"), { headers: { "Content-Type": "text/html" } }));
    expect(await fetchStockDetail("8336")).toMatchObject({ status: "unknown", code: "8336" });
  } finally { fetcher.mockRestore(); }
});
