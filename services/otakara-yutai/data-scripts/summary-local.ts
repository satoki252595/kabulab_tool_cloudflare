/** 標準は機械要約のみ。未対応は保留し、明示許可時だけローカル生成。金額・原子取込は共有契約を通す。 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { gzipSync, gunzipSync } from "node:zlib";
import { withBiztagWriter } from "../../../scripts/biztag-local/runtime.js";
import { currentPublishingWriter, publishingReadOnly, withSharedPublishingWriter } from "../../../scripts/mechanical-publishing/shared-writer.js";
import { parseStockCode } from "../../../src/shared/jpx/stock-code.js";
import { createD1HttpBatchSender } from "../../../src/shared/db/d1-http-client.js";
import { recordPrimaryData, verifyArchivedAttachments } from "../../../src/shared/notion-archive/index.js";
import { notionEnv } from "../../../src/shared/notion-archive/env.js";
import { setNotionMaxRps } from "../../../src/shared/notion-archive/client.js";
import {
  SEMIF_HF_MODEL,
  SEMIF_HF_REVISION,
  SEMIF_SOURCE_REVISION,
  SEMIF_MLX_VERSION,
  SEMIF_MLX_LM_REVISION,
} from "../../../src/shared/semif/client.js";
import { semifEnv } from "../../../src/shared/semif/env.js";
import { z } from "../../../src/shared/zod-mini.js";
import { parseBenefitChoiceStructure } from "./choice-structure.js";
import { compileAnnualGiftHistoryLiteral, compileBankDepositChoiceLiteral, compileBankHoldingHistoryLiteral, compileDepartmentHoldingLiteral, compileEqualAllocationHoldingLiteral, compileHoldingGiftChoiceLiteral, compileHoldingPointCarryLiteral, compileHotelHoldingLiteral, compileMealTicketSplitLiteral, compilePointExchangeLiteral, compilePremiumClubCarryLiteral, compileRegistryTierLiteral, compileSkiTicketBundleLiteral, compileVenueAdmissionLiteral, parseBenefitHoldingStructure } from "./holding-structure.js";
import { compileMusashinoOfficialLiteral } from "./musashino-source.js";
import { compileNoteOfficialLiteral } from "./note-source.js";
import { compileKawasakiOfficialLiteral } from "./kawasaki-source.js";
import { parseBenefitRecordTierStructure } from "./record-tier-structure.js";
import { benefitKey } from "./benefit-key.js";
import { loadBenefitRows, openOtakaraD1 } from "./benefit-rows.js";
import { evaluateCompanyValue } from "./public-facts.js";
import { splitHeadedDescription } from "./estimated-value-guard.js";
import { applyImportAtomically } from "./import-summary-results.js";
import { assertNotCommittable } from "./private-path.js";
import { SummaryResult, planSummaryImport, type ImportPlan } from "./summary-import.js";
import { checkSummary, isSummaryNumbersGrounded, missingSummaryConditions, SUMMARY_CONTRACT_VERSION } from "./summary-contract.js";
import {
  parseTaskFile,
  selectSummaryTasks,
  serializeTasks,
  type BenefitRow,
  type SummaryTask,
} from "./summary-tasks.js";

const sha = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const Generation = z.strictObject({
  taskId: z.string(),
  text: z.string(),
  finishReason: z.enum(["stop", "length"]),
  inputTokens: z.number().check(z.int(), z.positive()),
  outputTokens: z.number().check(z.int(), z.positive()),
  elapsedMs: z.number().check(z.int(), z.nonnegative()),
});
const InputRejected = z.strictObject({
  taskId: z.string(),
  error: z.literal("input_token_limit"),
  inputTokens: z.number().check(z.int(), z.minimum(16001)),
});
const Ready = z.strictObject({
  ready: z.literal(true),
  model: z.literal(SEMIF_HF_MODEL),
  revision: z.literal(SEMIF_HF_REVISION),
  sourceRevision: z.literal(SEMIF_SOURCE_REVISION),
  mlxVersion: z.literal(SEMIF_MLX_VERSION),
  mlxLmRevision: z.literal(SEMIF_MLX_LM_REVISION),
  maxInputTokens: z.literal(16000),
  maxOutputTokens: z.literal(512),
  promptSHA256: z.string().check(z.regex(/^[0-9a-f]{64}$/)),
  artifacts: z.record(z.string(), z.string().check(z.regex(/^[0-9a-f]{64}$/))),
});
const GeneratedSummary = z.strictObject({ shortSummary: z.string() });
type ReviewedFiles = { tasks: string; tasksSha256: string; results: string; resultsSha256: string };
export type LocalOptions = { limit: number; stateDir: string; allowModel?: boolean; reviewedInput?: ReviewedFiles };

export function parseLocalArgs(argv: readonly string[]): LocalOptions {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      limit: { type: "string", default: "60" },
      "state-dir": { type: "string" },
      "allow-model": { type: "boolean", default: false },
      "reviewed-tasks": { type: "string" }, "reviewed-tasks-sha256": { type: "string" },
      "reviewed-results": { type: "string" }, "reviewed-results-sha256": { type: "string" },
    },
  });
  if (!values["state-dir"] || !/^(?:[1-9]|[1-5][0-9]|60)$/.test(values.limit ?? "")) {
    throw new Error("--state-dir と1～60件の --limit が必要です。");
  }
  const reviewed = [values["reviewed-tasks"], values["reviewed-tasks-sha256"], values["reviewed-results"], values["reviewed-results-sha256"]];
  if (reviewed.some(value => value !== undefined) && (values["allow-model"] ||
    reviewed.some(value => typeof value !== "string" || value.length === 0) ||
    !/^[a-f0-9]{64}$/.test(reviewed[1]!) || !/^[a-f0-9]{64}$/.test(reviewed[3]!)))
    throw new Error("invalid_reviewed_input_arguments");
  return {
    limit: Number(values.limit),
    stateDir: resolve(values["state-dir"]),
    allowModel: values["allow-model"],
    ...(reviewed[0] === undefined ? {} : { reviewedInput: { tasks: resolve(reviewed[0]), tasksSha256: reviewed[1]!,
      results: resolve(reviewed[2]!), resultsSha256: reviewed[3]! } }),
  };
}

/** 保存レビューの全bytesを固定する。モデルprotocolへの変換や旧契約の読み替えはしない。 */
export function readReviewedInput(options: LocalOptions) {
  if (options.reviewedInput === undefined) return undefined;
  if (options.allowModel === true || !Number.isInteger(options.limit) || options.limit < 1 || options.limit > 60)
    throw new Error("invalid_reviewed_input_arguments");
  const read = (path: string, hash: string) => {
    assertNotCommittable(path);
    if (!/^[a-f0-9]{64}$/.test(hash) || realpathSync(path) !== resolve(path)) throw new Error("reviewed_file_unqualified");
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size === 0 || stat.size > 8 * 1024 ** 2)
        throw new Error("reviewed_file_unqualified");
      const bytes = readFileSync(fd);
      if (bytes.length !== stat.size || sha(bytes) !== hash) throw new Error("reviewed_file_sha_mismatch");
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } finally { closeSync(fd); }
  };
  const files = options.reviewedInput, tasksText = read(files.tasks, files.tasksSha256), resultsText = read(files.results, files.resultsSha256);
  const tasks = parseTaskFile(tasksText);
  if (tasks.length === 0 || tasks.length > options.limit || tasks.some(task => task.contractVersion !== SUMMARY_CONTRACT_VERSION ||
    parseStockCode(task.stockCode) !== task.stockCode)) throw new Error("reviewed_tasks_unqualified");
  let results: SummaryResult[];
  try { results = resultsText.split("\n").filter(line => line.trim() !== "").map(line => SummaryResult.parse(JSON.parse(line))); }
  catch { throw new Error("reviewed_results_unqualified"); }
  if (results.length !== tasks.length || new Set(results.map(result => result.taskId)).size !== tasks.length ||
    results.some(result => result.contractVersion !== SUMMARY_CONTRACT_VERSION || !tasks.some(task => task.taskId === result.taskId)))
    throw new Error("reviewed_results_unqualified");
  return { tasks, tasksText, resultsText, tasksSha256: files.tasksSha256, resultsSha256: files.resultsSha256,
    codes: [...new Set(tasks.map(task => task.stockCode))].sort(), reviewed: tasks.length };
}

/** 採用済みの cursor も元行で位置を確かめ、保留群の反復で未処理群を遅らせない。 */
export function selectFairBatch(
  tasks: readonly SummaryTask[], cursor: string | null, limit: number,
  rows: readonly Pick<SummaryTask, "stockCode" | "description">[],
): SummaryTask[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 60) throw new Error("invalid_limit");
  const previous = cursor === null ? undefined : rows.find(row => benefitKey(row.stockCode, row.description) === cursor);
  // 月次原本の変更で cursor 自体が消えた場合は、新しい対象の先頭から一巡する。
  const index = previous === undefined ? 0 : tasks.findIndex(task =>
    task.stockCode > previous.stockCode ||
    (task.stockCode === previous.stockCode && task.description > previous.description));
  const start = index < 0 ? tasks.length : index;
  return [...tasks.slice(start), ...tasks.slice(0, start)].slice(0, limit);
}

/** Never use an amount suggested by the generator. No maximum/tier/annual conversion. */
export function companyValue(task: SummaryTask): {
  value: number | null;
  reason: string;
} {
  const context = {
    minShares: task.recipients.map((r) => r.minShares),
    recordMonths: task.recipients.map((r) => r.recordMonth),
  };
  return evaluateCompanyValue(task.description, context);
}

export const DETERMINISTIC_SUMMARY_RULE = "simple-face-value-one-of-holding-record-tier-shipping-admission-point-exchange-v25";

/** 対応する種類＋額面・全文1点選択・全文対応の期間/名簿条件を定型化する。未対応条件を削らない。 */
export function compileSimpleSummary(task: SummaryTask): SummaryResult | null {
  const kawasaki = compileKawasakiOfficialLiteral(task.description);
  if (kawasaki !== null) {
    const amount = companyValue(task);
    if (task.stockCode !== "3045" || task.rowCount !== 2 || task.recipients.length !== 2 ||
        amount.value !== null || amount.reason !== "multi_month_amounts" || checkSummary(kawasaki.shortSummary).length > 0 ||
        !isSummaryNumbersGrounded(task.description, kawasaki.shortSummary, { minShares: task.recipients.map(row => row.minShares),
          recordMonths: task.recipients.map(row => row.recordMonth), recordDates: task.recipients.map(row => row.recordDate) })) return null;
    return SummaryResult.parse({ taskId: task.taskId, contractVersion: task.contractVersion, shortSummary: kawasaki.shortSummary, estimatedValue: null });
  }
  const registryTier = compileRegistryTierLiteral(task.description);
  if (registryTier !== null) {
    const amount = companyValue(task);
    if (task.stockCode !== registryTier.stockCode || task.rowCount !== registryTier.recordMonths.length ||
      task.recipients.length !== task.rowCount || amount.value !== registryTier.listedYen || amount.reason !== registryTier.valueReason ||
      checkSummary(registryTier.shortSummary).length > 0 || !isSummaryNumbersGrounded(task.description, registryTier.shortSummary, {
        minShares: task.recipients.map(r => r.minShares), recordMonths: task.recipients.map(r => r.recordMonth),
        recordDates: task.recipients.map(r => r.recordDate),
      })) return null;
    return SummaryResult.parse({ taskId: task.taskId, contractVersion: task.contractVersion,
      shortSummary: registryTier.shortSummary, estimatedValue: amount.value });
  }
  const note = compileNoteOfficialLiteral(task.description);
  if (note !== null) {
    const amount = companyValue(task);
    if (task.stockCode !== "5243" || task.rowCount !== 1 || task.recipients.length !== 1 ||
        amount.value !== null || amount.reason !== "no_per_grant_face" || checkSummary(note.shortSummary).length > 0 ||
        !isSummaryNumbersGrounded(task.description, note.shortSummary, { minShares: task.recipients.map(r => r.minShares),
          recordMonths: task.recipients.map(r => r.recordMonth), recordDates: task.recipients.map(r => r.recordDate) })) return null;
    return SummaryResult.parse({ taskId: task.taskId, contractVersion: task.contractVersion, shortSummary: note.shortSummary, estimatedValue: null });
  }
  const holdingGift = compileHoldingGiftChoiceLiteral(task.description);
  if (holdingGift !== null) {
    const amount = companyValue(task);
    if (task.stockCode !== "7856" || task.rowCount !== 1 || task.recipients.length !== 1 ||
      amount.value !== null || amount.reason !== "ambiguous_condition_tiers" || checkSummary(holdingGift).length > 0 ||
      !isSummaryNumbersGrounded(task.description, holdingGift, { minShares: task.recipients.map(r => r.minShares),
        recordMonths: task.recipients.map(r => r.recordMonth), recordDates: task.recipients.map(r => r.recordDate) })) return null;
    return SummaryResult.parse({ taskId: task.taskId, contractVersion: task.contractVersion, shortSummary: holdingGift, estimatedValue: null });
  }
  const equalAllocation = compileEqualAllocationHoldingLiteral(task.description);
  if (equalAllocation !== null) {
    const amount = companyValue(task);
    if (task.stockCode !== "2776" || task.rowCount !== 1 || task.recipients.length !== 1 ||
      amount.value !== null || amount.reason !== "ambiguous_condition_tiers" || checkSummary(equalAllocation).length > 0 ||
      !isSummaryNumbersGrounded(task.description, equalAllocation, { minShares: task.recipients.map(r => r.minShares),
        recordMonths: task.recipients.map(r => r.recordMonth), recordDates: task.recipients.map(r => r.recordDate) })) return null;
    return SummaryResult.parse({ taskId: task.taskId, contractVersion: task.contractVersion, shortSummary: equalAllocation, estimatedValue: null });
  }
  const mealTicket = compileMealTicketSplitLiteral(task.description);
  if (mealTicket !== null) {
    const amount = companyValue(task);
    if (task.stockCode !== "138A" || task.rowCount !== 2 || task.recipients.length !== 2 ||
      amount.value !== null || amount.reason !== "multi_month_amounts" || checkSummary(mealTicket.shortSummary).length > 0 ||
      !isSummaryNumbersGrounded(task.description, mealTicket.shortSummary, { minShares: task.recipients.map(r => r.minShares),
        recordMonths: task.recipients.map(r => r.recordMonth), recordDates: task.recipients.map(r => r.recordDate) })) return null;
    return SummaryResult.parse({ taskId: task.taskId, contractVersion: task.contractVersion, shortSummary: mealTicket.shortSummary, estimatedValue: null });
  }
  const bankDeposit = compileBankDepositChoiceLiteral(task.description);
  if (bankDeposit !== null) {
    const amount = companyValue(task);
    if (task.rowCount !== 1 || task.stockCode !== "8551" || amount.value !== null || amount.reason !== "choice" ||
      checkSummary(bankDeposit.shortSummary).length > 0 || !isSummaryNumbersGrounded(task.description, bankDeposit.shortSummary, {
        minShares: task.recipients.map(r => r.minShares), recordMonths: task.recipients.map(r => r.recordMonth),
        recordDates: task.recipients.map(r => r.recordDate),
      })) return null;
    return SummaryResult.parse({ taskId: task.taskId, contractVersion: task.contractVersion, shortSummary: bankDeposit.shortSummary, estimatedValue: null });
  }
  const musashino = compileMusashinoOfficialLiteral(task.description);
  if (musashino !== null) {
    const amount = companyValue(task);
    if (task.stockCode !== "8336" || task.rowCount !== 1 ||
      (amount.value !== null && amount.value !== musashino.listedYen) || checkSummary(musashino.shortSummary).length > 0 ||
      !isSummaryNumbersGrounded(task.description, musashino.shortSummary, { minShares: task.recipients.map(r => r.minShares),
        recordMonths: task.recipients.map(r => r.recordMonth), recordDates: task.recipients.map(r => r.recordDate) })) return null;
    return SummaryResult.parse({ taskId: task.taskId, contractVersion: task.contractVersion, shortSummary: musashino.shortSummary, estimatedValue: amount.value });
  }
  const skiTickets = compileSkiTicketBundleLiteral(task.description);
  if (skiTickets !== null) {
    const amount = companyValue(task);
    if (task.rowCount !== 1 || task.stockCode !== "6040" || amount.value !== null || amount.reason !== "no_source_yen_amount" ||
      checkSummary(skiTickets).length > 0 || !isSummaryNumbersGrounded(task.description, skiTickets, {
        minShares: task.recipients.map(r => r.minShares), recordMonths: task.recipients.map(r => r.recordMonth),
        recordDates: task.recipients.map(r => r.recordDate),
      })) return null;
    return SummaryResult.parse({ taskId: task.taskId, contractVersion: task.contractVersion, shortSummary: skiTickets, estimatedValue: null });
  }
  const hotelHolding = compileHotelHoldingLiteral(task.description);
  if (hotelHolding !== null) {
    if (task.rowCount !== 1 || companyValue(task).value !== null || checkSummary(hotelHolding.shortSummary).length > 0 ||
      !isSummaryNumbersGrounded(task.description, hotelHolding.shortSummary, { minShares: task.recipients.map(r => r.minShares),
        recordMonths: task.recipients.map(r => r.recordMonth), recordDates: task.recipients.map(r => r.recordDate) })) return null;
    return SummaryResult.parse({ taskId: task.taskId, contractVersion: task.contractVersion, shortSummary: hotelHolding.shortSummary, estimatedValue: null });
  }
  const bankHistory = compileBankHoldingHistoryLiteral(task.description);
  if (bankHistory !== null) {
    const amount = companyValue(task);
    if (amount.value !== bankHistory.listedYen || amount.reason !== "qualified_company_per_grant" || checkSummary(bankHistory.shortSummary).length > 0 ||
      !isSummaryNumbersGrounded(task.description, bankHistory.shortSummary, { minShares: task.recipients.map(r => r.minShares),
        recordMonths: task.recipients.map(r => r.recordMonth), recordDates: task.recipients.map(r => r.recordDate) })) return null;
    return SummaryResult.parse({ taskId: task.taskId, contractVersion: task.contractVersion, shortSummary: bankHistory.shortSummary, estimatedValue: amount.value });
  }
  const annualGift = compileAnnualGiftHistoryLiteral(task.description);
  if (annualGift !== null) {
    const amount = companyValue(task);
    if (amount.value !== annualGift.listedYen || amount.reason !== "qualified_company_per_grant" || checkSummary(annualGift.shortSummary).length > 0 ||
      task.recipients.some(r => r.recordDate !== null) ||
      !isSummaryNumbersGrounded(task.description, annualGift.shortSummary, { minShares: task.recipients.map(r => r.minShares), recordMonths: task.recipients.map(r => r.recordMonth) })) return null;
    return SummaryResult.parse({ taskId: task.taskId, contractVersion: task.contractVersion, shortSummary: annualGift.shortSummary, estimatedValue: amount.value });
  }
  const departmentHolding = compileDepartmentHoldingLiteral(task.description);
  if (departmentHolding !== null) {
    const amount = companyValue(task);
    if (amount.value !== null || amount.reason !== "multi_month_amounts" || checkSummary(departmentHolding).length > 0 ||
      task.recipients.some(r => r.recordDate !== null) ||
      !isSummaryNumbersGrounded(task.description, departmentHolding, { minShares: task.recipients.map(r => r.minShares), recordMonths: task.recipients.map(r => r.recordMonth) })) return null;
    return SummaryResult.parse({ taskId: task.taskId, contractVersion: task.contractVersion, shortSummary: departmentHolding, estimatedValue: null });
  }
  const holdingPointCarry = compileHoldingPointCarryLiteral(task.description);
  if (holdingPointCarry !== null) {
    const amount = companyValue(task);
    if (amount.value !== null || amount.reason !== "choice" || checkSummary(holdingPointCarry).length > 0 ||
      !isSummaryNumbersGrounded(task.description, holdingPointCarry, { minShares: task.recipients.map(r => r.minShares), recordMonths: task.recipients.map(r => r.recordMonth) })) return null;
    return SummaryResult.parse({ taskId: task.taskId, contractVersion: task.contractVersion, shortSummary: holdingPointCarry, estimatedValue: null });
  }
  const clubCarry = compilePremiumClubCarryLiteral(task.description);
  if (clubCarry !== null) {
    const amount = companyValue(task);
    if (amount.value !== null || amount.reason !== "approx" || checkSummary(clubCarry).length > 0 ||
      !isSummaryNumbersGrounded(task.description, clubCarry, { minShares: task.recipients.map(r => r.minShares), recordMonths: task.recipients.map(r => r.recordMonth) })) return null;
    return SummaryResult.parse({ taskId: task.taskId, contractVersion: task.contractVersion, shortSummary: clubCarry, estimatedValue: null });
  }
  const pointExchange = compilePointExchangeLiteral(task.description);
  if (pointExchange !== null) {
    const amount = companyValue(task);
    if (amount.reason !== "qualified_company_per_grant" || amount.value !== pointExchange.listedYen) return null;
    return SummaryResult.parse({ taskId: task.taskId, contractVersion: task.contractVersion,
      shortSummary: pointExchange.shortSummary, estimatedValue: amount.value });
  }
  const admission = compileVenueAdmissionLiteral(task.description);
  if (admission !== null) {
    const amount = companyValue(task);
    if (amount.value !== null || amount.reason !== "no_source_yen_amount") return null;
    return SummaryResult.parse({ taskId: task.taskId, contractVersion: task.contractVersion,
      shortSummary: admission, estimatedValue: null });
  }
  const choice = parseBenefitChoiceStructure(task.description);
  if (choice.status === "literal_parsed") return SummaryResult.parse({ taskId: task.taskId, contractVersion: task.contractVersion,
    shortSummary: "優待を1点選択", estimatedValue: null });
  const holding = parseBenefitHoldingStructure(task.description);
  if (holding !== null) return SummaryResult.parse({ taskId: task.taskId, contractVersion: task.contractVersion,
    shortSummary: holding.ast.benefit.kind === "coupon" ? "半年以上保有・クーポン優待" : `1年以上保有・施設入場招待券${holding.ast.benefit.quantity}枚`,
    estimatedValue: companyValue(task).value });
  const tier = parseBenefitRecordTierStructure(task.description);
  if (tier !== null) {
    const amount = companyValue(task);
    if (amount.value !== null || amount.reason !== "ambiguous_condition_tiers") return null;
    const [below, above] = tier.ast.tiers;
    const shortSummary = `保有${below.holdingPeriod}はQUOカード${below.listedYen.toLocaleString("en-US")}円${below.notation}、${above.holdingPeriod}は${above.listedYen.toLocaleString("en-US")}円${above.notation}（継続・株主名簿${tier.ast.registryDefinition.minimumEntries}回以上）`;
    if (checkSummary(shortSummary).length > 0) return null;
    return SummaryResult.parse({ taskId: task.taskId, contractVersion: task.contractVersion, shortSummary, estimatedValue: null });
  }
  const source = splitHeadedDescription(task.description);
  if (source.malformed) return null;
  const grammar = /^(QUOカードPay|QUOカード|クオカード|図書カードNEXT|図書カード|商品券|ギフトカード|自社商品|カタログギフト)[ \t]*(?:([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)円(分|相当))(?:を贈呈|贈呈)?[。]?$/u;
  const body = source.body.normalize("NFKC").trim();
  // 数量以外は保存済み全文のSHAへ束縛する。原文段落は公開せず、約換算から金額を作らない。
  if (source.heading?.normalize("NFKC").trim() === "プレミアム優待倶楽部ポイント") {
    const points = /^([1-9][0-9]{0,2}(?:,[0-9]{3})+|[1-9][0-9]*)ポイント\n/u.exec(body);
    if (points === null || sha(body.slice(points[0].length)) !== "302bbc296773a9bbe7f04971fe162d1272be78401e0c2d9ea27444589454eb06") return null;
    const count = Number(points[1].replaceAll(",", "")), amount = companyValue(task);
    if (!Number.isSafeInteger(count) || amount.value !== null || amount.reason !== "approx") return null;
    const shortSummary = `${count}ポイント(WEB商品選択・寄付・WILLsCoin交換、翌年12月末同番号継続記録2回以上で繰越1回のみ)`;
    if (checkSummary(shortSummary).length > 0) return null;
    return SummaryResult.parse({ taskId: task.taskId, contractVersion: task.contractVersion, shortSummary, estimatedValue: null });
  }
  // 保有・名簿・選択・贈呈時期の残全文を固定し、掲載額を受取額へ認定しない。
  if (source.heading?.normalize("NFKC").trim() === "株主優待商品(長期保有者向け)") {
    const catalog = /^【1年以上保有株主】\n([1-9][0-9]{0,2}(?:,[0-9]{3})+|[1-9][0-9]*)円相当\n([\s\S]+)$/u.exec(body);
    if (catalog === null || sha(catalog[2]) !== "7e419099cc02ad5e0b5630ad03ea918d0efb0b621b731167e34a792e59d743e4") return null;
    const count = Number(catalog[1].replaceAll(",", "")), amount = companyValue(task);
    if (!Number.isSafeInteger(count) || amount.value !== null || amount.reason !== "choice" ||
      task.recipients.some(recipient => recipient.recordMonth !== 12 || recipient.recordDate !== null)) return null;
    const shortSummary = `1年以上保有・毎年12月末同一株主番号継続記録、${count.toLocaleString("en-US")}円相当商品/寄付をカタログ/WEBで1点選択(2月下旬贈呈)`;
    if (checkSummary(shortSummary).length > 0) return null;
    return SummaryResult.parse({ taskId: task.taskId, contractVersion: task.contractVersion, shortSummary, estimatedValue: null });
  }
  // 掲載額と明示された両送付月を保持する。余分な注記・数量・保有条件は全文一致で拒否する。
  const shipment = /^([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)円(分|相当)\n【送付時期】\n(1[0-2]|[1-9])月~(1[0-2]|[1-9])月$/u.exec(body);
  if (source.heading?.normalize("NFKC").trim() === "自社製品詰合せ(アイス等)" && shipment !== null) {
    const amount = companyValue(task);
    if (amount.value === null || !Number.isSafeInteger(amount.value) || amount.value !== Number(shipment[1].replaceAll(",", ""))) return null;
    return SummaryResult.parse({ taskId: task.taskId, contractVersion: task.contractVersion,
      shortSummary: `自社製品詰合せ(アイス等) ${amount.value.toLocaleString("en-US")}円${shipment[2]}・${shipment[3]}月〜${shipment[4]}月送付`, estimatedValue: amount.value });
  }
  // 座席指定経路の残全文を同値確認する。私有原文を公開せず、数量だけを原文から読む。
  const cinema = /^毎月([1-9][0-9]*)回\n([\s\S]+)$/u.exec(body);
  if (source.heading?.normalize("NFKC").trim() === "あべのアポロシネマ映画鑑賞無料ご招待" && cinema !== null &&
    sha(cinema[2]) === "0bd4590313a989d9bb80ea81e8969e8849a8658eeded3d53d7d8f34c25d67db6") {
    const count = Number(cinema[1]), amount = companyValue(task);
    if (!Number.isSafeInteger(count) || amount.value !== null || amount.reason !== "no_source_yen_amount") return null;
    const shortSummary = `あべのアポロシネマ毎月${count}回無料(ネット又は招待カード利用の券売機・窓口で座席指定)`;
    if (checkSummary(shortSummary).length > 0) return null;
    return SummaryResult.parse({ taskId: task.taskId, contractVersion: task.contractVersion, shortSummary, estimatedValue: null });
  }
  let match = grammar.exec(body);
  // 種類だけの表見出し＋本文の額面も同じ全文文法で読む。金額は本文で認定する。
  if (match === null && source.heading !== null) match = grammar.exec(`${source.heading.normalize("NFKC").trim()} ${body}`);
  if (match === null || (source.heading !== null && source.heading.normalize("NFKC").trim() !== match[1])) return null;
  const amount = companyValue(task);
  if (amount.value === null || amount.value !== Number(match[2].replaceAll(",", ""))) return null;
  return SummaryResult.parse({ taskId: task.taskId, contractVersion: task.contractVersion,
    shortSummary: `${match[1]} ${amount.value.toLocaleString("en-US")}円${match[3]}`, estimatedValue: amount.value });
}

/** Entire protocol must correspond to the issued batch. Individual malformed summaries stay pending. */
export function buildLocalResults(
  tasks: readonly SummaryTask[],
  protocol: string,
): {
  resultsText: string;
  amountReasons: { taskId: string; value: number | null; reason: string }[];
  generationRejections: { taskId: string; reason: string }[];
  modelCalls: number;
} {
  let lines: unknown[];
  try {
    lines = protocol
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown);
  } catch {
    throw new Error("generation_protocol_json");
  }
  const ready = Ready.safeParse(lines[0]);
  if (!ready.success || Object.keys(ready.data.artifacts).length === 0 || lines.length !== tasks.length + 1) {
    throw new Error("generation_protocol_binding");
  }
  const results: SummaryResult[] = [];
  const amountReasons: {
    taskId: string;
    value: number | null;
    reason: string;
  }[] = [];
  const generationRejections: { taskId: string; reason: string }[] = [];
  let modelCalls = 0;
  for (let i = 0; i < tasks.length; i++) {
    const inputRejected = InputRejected.safeParse(lines[i + 1]);
    if (inputRejected.success) {
      if (inputRejected.data.taskId !== tasks[i].taskId) throw new Error("generation_protocol_binding");
      generationRejections.push({
        taskId: tasks[i].taskId,
        reason: "input_token_limit",
      });
      continue;
    }
    const g = Generation.safeParse(lines[i + 1]);
    if (!g.success || g.data.taskId !== tasks[i].taskId || g.data.inputTokens > 16000 || g.data.outputTokens > 512) {
      throw new Error("generation_protocol_binding");
    }
    const task = tasks[i];
    modelCalls++;
    if (g.data.finishReason !== "stop") {
      generationRejections.push({
        taskId: task.taskId,
        reason: "output_token_limit",
      });
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(g.data.text);
    } catch {
      generationRejections.push({
        taskId: task.taskId,
        reason: "generated_json",
      });
      continue;
    }
    const summary = GeneratedSummary.safeParse(raw);
    if (!summary.success) {
      generationRejections.push({
        taskId: task.taskId,
        reason: "generated_schema",
      });
      continue;
    }
    const missingConditions = missingSummaryConditions(task.description, summary.data.shortSummary);
    if (missingConditions.length > 0) {
      generationRejections.push({ taskId: task.taskId, reason: missingConditions.join(",") });
      continue;
    }
    const amount = companyValue(task);
    amountReasons.push({ taskId: task.taskId, ...amount });
    results.push(
      SummaryResult.parse({
        taskId: task.taskId,
        contractVersion: task.contractVersion,
        shortSummary: summary.data.shortSummary,
        estimatedValue: amount.value,
      }),
    );
  }
  return {
    resultsText: results.map((r) => JSON.stringify(r)).join("\n") + (results.length ? "\n" : ""),
    amountReasons,
    generationRejections,
    modelCalls,
  };
}

function writePrivate(path: string, bytes: string | Uint8Array): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function privateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const s = lstatSync(path);
  if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o077) !== 0 || s.uid !== process.getuid?.())
    throw new Error("private_state_required");
}

export type LocalDependencies = {
  loadRows: (codes?: readonly string[]) => Promise<BenefitRow[]>;
  generate: (tasksPath: string, runDir: string) => Promise<string>;
  archive: (bytes: Uint8Array, clock: string, phase: "pre" | "post", generation: { deterministic: number; modelTasks: number; reviewed?: number; tasksSha256?: string; resultsSha256?: string }) => Promise<void>;
  apply: (rows: readonly BenefitRow[], plan: ImportPlan) => Promise<void>;
};
export type LocalReport = {
  selected: number;
  accepted: number;
  rejected: number;
  held: number;
  pendingBefore: number;
  pendingAfter: number;
  equivalent: number;
  toNull: number;
  modelCalls: number;
  modelResidents: 0 | 1;
  deterministic: number;
  reviewed?: number;
  /** 通常の機械HOLDは最大60群。原文・要約・可変エラーdetailをログへ返さない。 */
  holds?: { stockCode: string; taskId: string; sourceSha256: string; reason: string }[];
  outcome: "empty" | "complete" | "partial_rejection";
};

export async function runLocalSummary(options: LocalOptions, deps: LocalDependencies): Promise<LocalReport> {
  const reviewed = readReviewedInput(options);
  if (reviewed !== undefined && currentPublishingWriter() === undefined) throw new Error("reviewed_shared_writer_required");
  const state = options.stateDir;
  assertNotCommittable(join(state, "progress.json"));
  privateDir(state);
  const pendingWrite = join(state, "pending-write.json");
  if (existsSync(pendingWrite)) throw new Error("previous_write_unresolved");
  const writer = currentPublishingWriter();
  if (reviewed !== undefined) await writer!.assertReady();
  const cursorPath = join(state, "progress.json");
  // R2がhost共通の正本。Macの旧cursorは初回移行時だけ取り込み、毎回上書きしない。
  const savedCursor = reviewed !== undefined ? null : writer === undefined
    ? (existsSync(cursorPath) ? readFileSync(cursorPath, "utf8") : null)
    : await writer.readCursor("yutai-summary");
  let cursor: string | null = null;
  if (savedCursor !== null) {
    let saved: unknown;
    try { saved = JSON.parse(savedCursor); } catch { throw new Error("invalid_progress"); }
    const parsed = z.strictObject({ cursor: z.string().check(z.regex(/^[0-9a-f]{16}$/)) }).safeParse(saved);
    if (!parsed.success) throw new Error("invalid_progress");
    cursor = parsed.data.cursor;
  }
  const readSelectedRows = () => publishingReadOnly(async () => {
    const current = await deps.loadRows(reviewed?.codes);
    if (reviewed !== undefined) {
      readReviewedInput(options);
      const currentTasks = selectSummaryTasks(current);
      if (!current.every(row => reviewed.codes.includes(row.stockCode)) || reviewed.tasks.some(task =>
        !currentTasks.some(candidate => isDeepStrictEqual(candidate, task)))) throw new Error("reviewed_input_stale_or_inactive");
    }
    return current;
  });
  const rows = await readSelectedRows();
  const allTasks = selectSummaryTasks(rows);
  if (allTasks.length === 0)
    return {
      selected: 0,
      accepted: 0,
      rejected: 0,
      held: 0,
      pendingBefore: 0,
      pendingAfter: 0,
      equivalent: 0,
      toNull: 0,
      modelCalls: 0,
      modelResidents: 0,
      deterministic: 0,
      outcome: "empty",
    };
  const tasks = reviewed === undefined ? selectFairBatch(allTasks, cursor, options.limit, rows) : reviewed.tasks;
  const clock = new Date().toISOString();
  const runDir = join(state, randomUUID());
  privateDir(runDir);
  const tasksText = reviewed === undefined ? serializeTasks(tasks) : reviewed.tasksText;
  // Validate our exact emitted task bytes with the same importer contract.
  parseTaskFile(tasksText);
  writePrivate(join(runDir, "tasks.jsonl"), tasksText);
  writePrivate(
    join(runDir, "selected-pre.json"),
    JSON.stringify(rows.filter((r) => tasks.some((t) => t.taskId === benefitKey(r.stockCode, r.description)))),
  );
  const deterministic = reviewed === undefined ? tasks.flatMap(task => { const result = compileSimpleSummary(task); return result === null ? [] : [result]; }) : [];
  const deterministicIds = new Set(deterministic.map(result => result.taskId));
  const unresolved = reviewed === undefined ? tasks.filter(task => !deterministicIds.has(task.taskId)) : [];
  const modelTasks = options.allowModel === true ? unresolved : [];
  const held = options.allowModel === true ? [] : unresolved.map(task => ({ taskId: task.taskId,
    reason: "mechanical_rule_unavailable_model_disabled" }));
  const generation = { deterministic: deterministic.length, modelTasks: modelTasks.length,
    ...(reviewed === undefined ? {} : { reviewed: reviewed.reviewed, tasksSha256: reviewed.tasksSha256, resultsSha256: reviewed.resultsSha256 }) };
  const modelTasksText = serializeTasks(modelTasks);
  parseTaskFile(modelTasksText);
  if (reviewed === undefined) writePrivate(join(runDir, "model-tasks.jsonl"), modelTasksText);
  writePrivate(join(runDir, "deterministic.json"), JSON.stringify({ rule: DETERMINISTIC_SUMMARY_RULE, results: deterministic,
    modelAllowed: options.allowModel === true, modelRequired: unresolved.map(task => task.taskId), held }));
  const protocol = modelTasks.length > 0 ? await deps.generate(join(runDir, "model-tasks.jsonl"), runDir) : "";
  if (reviewed === undefined) writePrivate(join(runDir, "generation.jsonl"), protocol);
  const model = modelTasks.length > 0 ? buildLocalResults(modelTasks, protocol)
    : { resultsText: "", amountReasons: [], generationRejections: [], modelCalls: 0 };
  const generated = { ...model, resultsText: reviewed === undefined ? deterministic.map(result => JSON.stringify(result) + "\n").join("") + model.resultsText : reviewed.resultsText,
    generationRejections: [...held, ...model.generationRejections],
    deterministicRule: DETERMINISTIC_SUMMARY_RULE, deterministicTaskIds: [...deterministicIds],
    amountReasons: [...deterministic.map(result => ({ taskId: result.taskId, value: result.estimatedValue,
      reason: "qualified_company_per_grant" })), ...model.amountReasons] };
  writePrivate(join(runDir, "results.jsonl"), generated.resultsText);
  writePrivate(join(runDir, "qualification.json"), JSON.stringify(generated));
  const fresh = await readSelectedRows();
  const plan = planSummaryImport({
    tasks,
    resultsText: generated.resultsText,
    currentRows: fresh,
  });
  writePrivate(join(runDir, "import-plan.json"), JSON.stringify(plan));
  const noWrite = options.allowModel !== true && reviewed === undefined && plan.updates.length === 0;
  const nextProgress = JSON.stringify({ cursor: tasks[tasks.length - 1].taskId });
  if (noWrite) await publishingReadOnly(async () => {
    const selected = (current: readonly BenefitRow[]) => current
      .filter(row => tasks.some(task => task.taskId === benefitKey(row.stockCode, row.description)))
      .sort((a, b) => a.id - b.id);
    if (!isDeepStrictEqual(selected(rows), selected(fresh))) throw new Error("summary_no_write_input_changed");
  });
  // One lossless file contains the exact tasks, model protocol, results, and both preimages.
  const plain = Buffer.from(
    JSON.stringify({
      version: 1,
      clock,
      tasksText,
      ...(reviewed === undefined ? { modelAllowed: options.allowModel === true, model: modelTasks.length > 0 ? SEMIF_HF_MODEL : null,
        revision: modelTasks.length > 0 ? SEMIF_HF_REVISION : null, protocol } : { reviewedInput: { tasksText: reviewed.tasksText,
        resultsText: reviewed.resultsText, tasksSha256: reviewed.tasksSha256, resultsSha256: reviewed.resultsSha256, reviewed: reviewed.reviewed } }),
      ...generated,
      plan,
      ...(noWrite ? { noWrite: { tasksSHA256: sha(tasksText), resultsSHA256: sha(generated.resultsText),
        cursorBefore: savedCursor, cursorNext: nextProgress } } : {}),
      selectedPre: reviewed === undefined ? rows.filter((r) => tasks.some((t) => t.taskId === benefitKey(r.stockCode, r.description))) : rows,
      freshPre: reviewed === undefined ? fresh.filter((r) => tasks.some((t) => t.taskId === benefitKey(r.stockCode, r.description))) : fresh,
    }),
  );
  const bundle = gzipSync(plain);
  if (!gunzipSync(bundle).equals(plain)) throw new Error("bundle_roundtrip");
  writePrivate(join(runDir, "pre-import.json.gz"), bundle);
  // Notion保管も結果不明になり得る。最初の外部書込みより前に再入を止める。
  if (!noWrite) writePrivate(
    pendingWrite,
    JSON.stringify({
      clock,
      bundleSHA256: sha(bundle),
      run: runDir.split("/").at(-1),
    }),
  );
  const publication = noWrite || writer === undefined ? undefined : await writer.reserve("yutai-summary",
    { clock, tasksSHA256: sha(tasksText), deterministicRule: DETERMINISTIC_SUMMARY_RULE, ...generation }, plain.toString("utf8"));
  if (!noWrite) await deps.archive(bundle, clock, "pre", generation); // No D1 mutation if physical/archive/readback fails.
  if (plan.updates.length > 0) {
    await deps.apply(fresh, plan);
  }
  const post = plan.updates.length > 0 || publication !== undefined ? await publishingReadOnly(() => deps.loadRows(reviewed?.codes)) : fresh;
  const updates = new Map(plan.updates.flatMap((u) => u.ids.map((id) => [id, u] as const)));
  if (post.length !== fresh.length || new Set(post.map((r) => r.id)).size !== post.length)
    throw new Error("summary_post_mismatch");
  for (const before of fresh) {
    const after = post.find((r) => r.id === before.id);
    const update = updates.get(before.id);
    if (!after) throw new Error("summary_post_mismatch");
    const expected =
      update === undefined
        ? before
        : {
            ...before,
            shortSummary: update.shortSummary,
            estimatedValue: update.estimatedValue,
            estimateValueSource: update.estimateValueSource,
            updatedAt: after.updatedAt,
          };
    if (
      !isDeepStrictEqual(after, expected) ||
      !Number.isSafeInteger(after.updatedAt) ||
      after.updatedAt < before.updatedAt
    ) {
      throw new Error("summary_post_mismatch");
    }
  }
  const rejected = tasks.length - plan.updates.length - plan.skippedEquivalent;
  const report: LocalReport = {
    selected: tasks.length,
    accepted: plan.updates.length,
    rejected,
    held: held.length,
    equivalent: plan.skippedEquivalent,
    toNull: plan.valueChanges.toNull,
    pendingBefore: allTasks.length,
    pendingAfter: selectSummaryTasks(post).length,
    modelCalls: generated.modelCalls,
    modelResidents: modelTasks.length > 0 ? 1 : 0,
    deterministic: deterministic.length,
    ...(reviewed === undefined ? {} : { reviewed: reviewed.reviewed }),
    ...(held.length === 0 ? {} : { holds: held.map((item, index) => ({
      stockCode: unresolved[index].stockCode, taskId: item.taskId,
      sourceSha256: sha(unresolved[index].description), reason: item.reason,
    })) }),
    outcome: rejected > 0 ? "partial_rejection" : "complete",
  };
  writePrivate(
    join(runDir, "post.json"),
    JSON.stringify(post.filter((r) => tasks.some((t) => t.taskId === benefitKey(r.stockCode, r.description)))),
  );
  writePrivate(join(runDir, "post-verified.json"), JSON.stringify(report));
  let postSHA256: string | null = null;
  if (plan.updates.length > 0 || publication !== undefined) {
    const postClock = new Date().toISOString();
    const postPlain = Buffer.from(
      JSON.stringify({
        version: 1,
        phase: "post",
        clock: postClock,
        preBundleSHA256: sha(bundle),
        report,
        post,
        updates: plan.updates,
      }),
    );
    const postBundle = gzipSync(postPlain);
    postSHA256 = sha(postBundle);
    if (!gunzipSync(postBundle).equals(postPlain)) throw new Error("bundle_roundtrip");
    writePrivate(join(runDir, "post-import.json.gz"), postBundle);
    await deps.archive(postBundle, postClock, "post", generation);
  }
  if (publication !== undefined) await publication.complete({ preBundleSHA256: sha(bundle), postSHA256, report });
  if (reviewed === undefined) {
    if (writer !== undefined) await writer.writeCursor("yutai-summary", nextProgress);
    const nextCursor = join(state, `progress-${randomUUID()}.json`);
    writePrivate(nextCursor, nextProgress);
    renameSync(nextCursor, cursorPath);
  }
  writePrivate(join(runDir, "complete.json"), JSON.stringify(report));
  if (!noWrite) unlinkSync(pendingWrite);
  return report;
}

function generate(tasksPath: string, runDir: string): Promise<string> {
  const python = semifEnv.SEMIF_PYTHON();
  return new Promise((ok, fail) => {
    execFile(
      python,
      [fileURLToPath(new URL("./generate-summary-local.py", import.meta.url)), "--tasks", tasksPath],
      {
        env: {
          ...process.env,
          HF_HUB_OFFLINE: "1",
          TRANSFORMERS_OFFLINE: "1",
          HF_HUB_DISABLE_TELEMETRY: "1",
        },
        timeout: 29 * 60_000,
        killSignal: "SIGKILL",
        maxBuffer: 16 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        try {
          writePrivate(join(runDir, "python-stdout.jsonl"), stdout);
          writePrivate(join(runDir, "python-stderr.log"), stderr);
          if (error !== null) {
            fail(new Error("local_generation_failed_no_retry"));
            return;
          }
          ok(stdout);
        } catch {
          fail(new Error("private_generation_save_failed"));
        }
      },
    );
  });
}

export function dependencies(): LocalDependencies {
  const db = openOtakaraD1();
  return {
    loadRows: codes => loadBenefitRows(db, "active-equity", codes),
    generate,
    async archive(bytes, clock, phase, generation) {
      const file = {
        filename: "summary-local.json.gz",
        contentType: "application/gzip",
        bytes,
      };
      const result = await recordPrimaryData({
        service: "otakara-yutai",
        key: `summary-local-${sha(bytes)}`,
        source: generation.reviewed === undefined ? "D1 current benefits / deterministic rules and optional pinned cached Qwen local generation"
          : "D1 current benefits / explicit saved reviewed summary results",
        fetchedAt: clock,
        force: false,
        metadata: {
          clock,
          phase,
          bytes: bytes.length,
          sha256: sha(bytes),
          deterministicRule: DETERMINISTIC_SUMMARY_RULE,
          ...generation,
          ...(generation.reviewed === undefined ? { model: generation.modelTasks > 0 ? SEMIF_HF_MODEL : null,
            revision: generation.modelTasks > 0 ? SEMIF_HF_REVISION : null } : {}),
        },
        files: [file],
      });
      if (result.fileTooLarge || result.manifestMatch === "unknown") throw new Error("summary_archive_unqualified");
      await verifyArchivedAttachments(result.pageId, [file], "優待ローカル要約");
    },
    async apply(rows, plan) {
      // Rejected/equivalent groups are not yield-repair targets; keep their previous values.
      const targetIds = plan.updates.flatMap((u) => u.ids);
      await applyImportAtomically(db, createD1HttpBatchSender(), {
        targetIds,
        updates: plan.updates,
        verifiedBenefits: new Map(rows.filter((r) => targetIds.includes(r.id)).map((r) => [r.id, r])),
      });
    },
  };
}

/** CLI入口。保存入力の資格後、通信しない設定検査を共有owner取得より先に済ませる。 */
export async function main(argv = process.argv.slice(2)) {
  const options = parseLocalArgs(argv);
  readReviewedInput(options); // Invalid saved input must not acquire remote ownership or construct DB dependencies.
  let run: () => Promise<LocalReport>;
  if (options.reviewedInput !== undefined) {
    const deps = dependencies(); // D1の型付き設定とquery builder構築だけ。SELECTはrun内で行う。
    notionEnv.NOTION_TOKEN(); notionEnv.NOTION_ARCHIVE_PAGE_ID();
    const rps = notionEnv.NOTION_MAX_RPS();
    if (rps !== undefined) setNotionMaxRps(rps);
    run = () => runLocalSummary(options, deps);
  } else {
    // Mac通常入口はwithBiztagWriterのcanonical .envロード後に依存を構築する。
    run = () => runLocalSummary(options, dependencies());
  }
  const report = await (options.reviewedInput === undefined ? withBiztagWriter(run) : withSharedPublishingWriter(run));
  console.info(`[yutai:summary:local] ${JSON.stringify(report)}`);
  if (report.rejected > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    // Shared exceptions may contain company text/private paths; keep terminal logs aggregate-only.
    console.error("[yutai:summary:local] STOP。私有証跡を確認してください。再試行しません。");
    process.exitCode = 1;
  });
}
