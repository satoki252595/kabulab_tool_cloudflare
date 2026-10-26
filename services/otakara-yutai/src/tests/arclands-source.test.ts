/** 保存実7原本だけ。株数・名簿月・今回期限・利用制限を落とさない。 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { ROOT } from "../../../../src/shared/db/tests/source-scan.js";
import { ARCLANDS_SOURCES, adoptArclandsOfficialSource, compileArclandsOfficialLiteral } from "../../data-scripts/arclands-source.js";
import { main, parseStockDetail, readSavedArclandsSource } from "../../data-scripts/fetch-yutai-full.js";
import { companyValue, compileSimpleSummary } from "../../data-scripts/summary-local.js";
import { checkSummary, isSummaryNumbersGrounded, missingSummaryConditions } from "../../data-scripts/summary-contract.js";
import { planSummaryImport } from "../../data-scripts/summary-import.js";
import { selectSummaryTasks, type BenefitRow } from "../../data-scripts/summary-tasks.js";
import { benefitRowsOf, carryKey, planCarry } from "../../data-scripts/yutai-full-import.js";
import { splitHeadedDescription, trustedCompanyYieldValue } from "../../data-scripts/estimated-value-guard.js";
import { buildPublicBenefitFacts } from "../../data-scripts/public-facts.js";
import { parsePublicBenefitFacts } from "../public-facts.js";
import { renderBenefitFacts } from "../../app.js";
import metadata from "./fixtures/arclands-source-saved6.json";
const dir = join(ROOT, metadata.privateFixtureDir), digest = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const packetPin = metadata.files.find(file => file.path === "SAVED-SOURCE-PACKET.private.json")!;

it("未資格の9842全文/旧prefixを一般金額照合へ戻さず、unknown stateは原本読取前に止める", async () => {
  expect(compileArclandsOfficialLiteral("")).toBeNull();
  expect(isSummaryNumbersGrounded("", "アークランズ共通優待券550円×2枚", { minShares: [100], recordMonths: [2], recordDates: [null] })).toBe(false);
  const state = mkdtempSync(join(tmpdir(), "arclands-unknown-control-")), body = JSON.stringify({ status: "unknown_control" });
  writeFileSync(join(state, "INTENT.private.json"), body, { mode: 0o600 });
  const args = ["--adopt-arclands-source", "--saved-source=/not-read-control", `--saved-source-sha256=${"0".repeat(64)}`,
    "--expected-pre=/not-read-control", `--expected-pre-sha256=${"0".repeat(64)}`, `--state-dir=${state}`];
  try {
    for (let i = 0; i < 2; i++) await expect(main(args)).rejects.toThrow("musashino_adoption_state_already_started");
    expect(readFileSync(join(state, "INTENT.private.json"), "utf8")).toBe(body);
  } finally { rmSync(state, { recursive: true }); }
});

it.skipIf(!existsSync(join(dir, packetPin.path)))("実3全文6recipientを会社額面/通常import/翌月singleton carryまで通す", async () => {
  for (const file of metadata.files) expect(digest(readFileSync(join(dir, file.path)))).toBe(file.sha256);
  const { data, packet } = await readSavedArclandsSource(join(dir, packetPin.path), packetPin.sha256), original = JSON.parse(readFileSync(join(dir, "SAVED-ROWS.private.json"), "utf8")) as BenefitRow[];
  const planned = benefitRowsOf(data); expect(planned.heldBenefits).toBe(0);
  expect(planned.rows.map(row => ({ minShares: row.minShares, recordMonth: row.recordMonth, recordDate: null, descriptionSha256: digest(row.description) }))).toEqual(metadata.expectedRows);
  const rows = original.map((row, i) => ({ ...row, description: planned.rows[i].description, shortSummary: null })), tasks = selectSummaryTasks(rows);
  expect(tasks).toHaveLength(3);
  const results = tasks.map(task => {
    const result = compileSimpleSummary(task); if (result === null) throw new Error("actual_arclands_compiler_held");
    const expected = metadata.canonical.find(value => value.minShares === task.recipients[0].minShares)!;
    expect(companyValue(task)).toEqual({ value: expected.estimatedValue, reason: "qualified_company_per_grant" });
    expect(result.estimatedValue).toBe(expected.estimatedValue); expect(digest(result.shortSummary)).toBe(expected.summarySha256); expect(result.shortSummary.length).toBe(expected.summaryCharacters);
    expect(checkSummary(result.shortSummary)).toEqual([]); expect(missingSummaryConditions(task.description, result.shortSummary)).toEqual([]);
    expect(result.shortSummary).toContain("エバーアクションの印付き店は持帰りのみ");
    expect(task.description).toContain("記載又は記録"); expect(task.description).toContain("他年度又は2月末");
    for (const recipient of task.recipients) {
      const input = { code: data.code, description: task.description, context: { minShares: [recipient.minShares], recordMonths: [recipient.recordMonth] },
        fetchedAt: data.sourceFetchedAt!, batchFetchedAt: packet.providerBatchFetchedAt, official: data.official };
      const facts = buildPublicBenefitFacts(input);
      expect(facts).toMatchObject({ choice: false, holding: false, qualifiedAmount: expected.estimatedValue, valueStatus: "source_amount_qualified" });
      expect(parsePublicBenefitFacts(JSON.stringify(facts), data.code)).toEqual(facts);
      expect(renderBenefitFacts(facts, expected.estimatedValue)).toContain("選択: 掲載に記載なし");
      expect(renderBenefitFacts(facts, expected.estimatedValue)).not.toContain("選択に関する記載あり");
      expect(buildPublicBenefitFacts({ ...input, description: task.description + "追加条件" }).choice).toBe(true);
      for (const changed of [{ ...input, code: "8242" }, { ...input, context: { minShares: [recipient.minShares + 1], recordMonths: [recipient.recordMonth] } },
        { ...input, context: { minShares: [recipient.minShares], recordMonths: [3] } }, { ...input, official: undefined }])
        expect(() => buildPublicBenefitFacts(changed)).toThrow("arclands_source_context_changed");
    }
    const context = { minShares: task.recipients.map(row => row.minShares), recordMonths: task.recipients.map(row => row.recordMonth), recordDates: task.recipients.map(row => row.recordDate) };
    expect(isSummaryNumbersGrounded(task.description, result.shortSummary, context)).toBe(true);
    for (const month of [2, 8]) expect(isSummaryNumbersGrounded(task.description, result.shortSummary, { minShares: [task.recipients[0].minShares], recordMonths: [month], recordDates: [null] })).toBe(true);
    for (const recipients of [[], [task.recipients[0], task.recipients[0]], task.recipients.map(row => ({ ...row, minShares: row.minShares + 1 })), task.recipients.map(row => ({ ...row, recordMonth: 3 })), task.recipients.map(row => ({ ...row, recordDate: "2024-02-29" }))]) expect(compileSimpleSummary({ ...task, recipients })).toBeNull();
    expect(compileSimpleSummary({ ...task, stockCode: "8242" })).toBeNull(); expect(compileSimpleSummary({ ...task, rowCount: 1 })).toBeNull();
    for (const description of [task.description + "追加条件", task.description.replace("550円", "500円"), task.description.replace("テイクアウトのみ", "店内でも")]) {
      expect(description).not.toBe(task.description); expect(compileSimpleSummary({ ...task, description })).toBeNull(); expect(isSummaryNumbersGrounded(description, result.shortSummary, context)).toBe(false);
    }
    return result;
  });
  const resultsText = results.map(result => JSON.stringify(result)).join("\n"), plan = planSummaryImport({ tasks, currentRows: rows, resultsText });
  expect(plan.rejections).toEqual([]); expect(plan.updates).toHaveLength(3); expect(plan.updates.flatMap(update => update.ids).sort((a, b) => a - b)).toEqual(metadata.ids);
  const after = rows.map(row => { const update = plan.updates.find(value => value.ids.includes(row.id)); return update === undefined ? row : { ...row, shortSummary: update.shortSummary, estimatedValue: update.estimatedValue, estimateValueSource: update.estimateValueSource }; });
  expect(selectSummaryTasks(after)).toHaveLength(0); expect(planSummaryImport({ tasks, currentRows: after, resultsText }).updates).toHaveLength(0);
  for (const row of after) {
    const split = splitHeadedDescription(row.description); if (split.heading === null) throw new Error("arclands_heading_missing");
    const key = carryKey(data.code, split.body, row.minShares, row.recordMonth), carry = planCarry([{ ...row, code: data.code }], new Map([[key, [split.heading]]]), new Map([[data.code, new Map([[split.body, { minShares: [row.minShares, row.minShares], recordMonths: [2, 8] }]])]]));
    expect(carry.carried.get(key)).toEqual({ shortSummary: row.shortSummary, estimatedValue: row.estimatedValue, estimateValueSource: row.estimateValueSource });
    expect(trustedCompanyYieldValue(row, { minShares: [row.minShares, row.minShares], recordMonths: [2, 8] })).toBe(row.estimatedValue);
  }
  expect(planSummaryImport({ tasks, currentRows: rows, resultsText: JSON.stringify({ ...results[0], contractVersion: "2026-10-26.11" }) }).updates).toHaveLength(0);
}, 15000);

it.skipIf(!existsSync(join(dir, packetPin.path)))("IRnews無関係更新を許し、関連開示/リンク/PNG/PDF/本文/notes変更をHOLDする", async () => {
  const packetBytes = readFileSync(join(dir, packetPin.path)); expect(digest(packetBytes)).toBe(packetPin.sha256);
  const packet = JSON.parse(packetBytes.toString()) as { pages: { url: string; bodyBase64: string; receivedAt: string }[] };
  const parsed = parseStockDetail("9842", Buffer.from(packet.pages[0].bodyBase64, "base64").toString("utf8"));
  if (parsed.status !== "ok") throw new Error("arclands_actual_provider_unreadable");
  const provider = { ...parsed.data, sourceFetchedAt: packet.pages[0].receivedAt };
  const pdfTexts = ["official-store-list-2026-10.private.txt", "official-introduction-2023-11-14.private.txt", "official-integration-date-2026-07-03.private.txt"].map(path => readFileSync(join(dir, path), "utf8"));
  const sources = packet.pages.slice(1).map(page => ({ url: page.url, bytes: new Uint8Array(Buffer.from(page.bodyBase64, "base64")) }));
  const data = adoptArclandsOfficialSource(provider, sources, pdfTexts, new Date(packet.pages[6].receivedAt).toISOString());
  const change = (i: number, text: string) => sources.map((source, j) => i === j ? { ...source, bytes: new TextEncoder().encode(text) } : source);
  const news = new TextDecoder().decode(sources[3].bytes), irrelevant = '<li entrydate="2026/07/03"><a href="/other"><span class="news_tx">決算説明資料</span></a></li>';
  expect(adoptArclandsOfficialSource(provider, change(3, news + irrelevant), pdfTexts, data.official!.verifiedAt)).toEqual(data);
  for (const changed of [change(3, news + irrelevant.replace("決算説明資料", "株主優待制度の変更")), change(3, news.replace("auto_20260703587339", "auto_20231114589037")), change(0, new TextDecoder().decode(sources[0].bytes).replace("2月末", "3月末")), sources.slice(1)]) expect(() => adoptArclandsOfficialSource(provider, changed, pdfTexts, data.official!.verifiedAt)).toThrow();
  for (const i of [1, 2, 4, 5]) { const bytes = Uint8Array.from(sources[i].bytes); bytes[bytes.length - 1] ^= 1; expect(() => adoptArclandsOfficialSource(provider, sources.map((source, j) => i === j ? { ...source, bytes } : source), pdfTexts, data.official!.verifiedAt)).toThrow(); }
  expect(() => adoptArclandsOfficialSource(provider, sources, pdfTexts.map(text => text + "追加条件"), data.official!.verifiedAt)).toThrow();
  expect(sources.map(source => source.url)).toEqual(ARCLANDS_SOURCES.slice(1).map(source => source.url));
});
