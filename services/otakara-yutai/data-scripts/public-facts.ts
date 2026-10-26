import { parseBenefitChoiceStructure } from "./choice-structure.js";
import { parseBenefitHoldingStructure } from "./holding-structure.js";
import { extractBenefitTierLiterals, parseBenefitRecordTierStructure } from "./record-tier-structure.js";
import { benefitKey } from "./benefit-key.js";
import { extractYenAmounts, qualifyCompanyPerGrantValue } from "./estimated-value-guard.js";
import { sourceSummaryConditions } from "./summary-contract.js";
import { parsePublicBenefitFacts, type PublicBenefitFacts as Facts } from "../src/public-facts.js";
import { compileMusashinoOfficialLiteral } from "./musashino-source.js";
import { compileKawasakiOfficialLiteral, KAWASAKI_OFFICIAL_URL } from "./kawasaki-source.js";

/** モデルを起動せず既存の厳密額面判定を共用する。候補の最大値・合計を採らない。 */
export function evaluateCompanyValue(description: string, context: { minShares: readonly number[]; recordMonths: readonly number[] }) {
  const candidates = [...new Set(extractYenAmounts(description))];
  const verdicts = candidates.map(value => ({ value, verdict: qualifyCompanyPerGrantValue(description, value, context) }));
  const accepted = verdicts.filter(v => v.verdict.qualified);
  if (accepted.length === 1) return { value: accepted[0].value, reason: "qualified_company_per_grant" };
  return {
    value: null,
    reason: accepted.length > 1 ? "ambiguous_qualified_amounts" : candidates.length === 0 ? "no_source_yen_amount"
      : [...new Set(verdicts.map(v => v.verdict.qualified ? "qualified_company_per_grant" : v.verdict.code))].join(","),
  };
}

/** 原本保管・照合済みの入力だけを渡す。実受信時計が無い場合はnullを保持する。 */
export function buildPublicBenefitFacts(input: {
  code: string;
  description: string;
  context: { minShares: readonly number[]; recordMonths: readonly number[] };
  fetchedAt: string | null;
  batchFetchedAt: string | null;
  official?: { url: string; verifiedAt: string };
}): Facts {
  const conditions = sourceSummaryConditions(input.description);
  const source = input.description.normalize("NFKC");
  // 文末・区切りで確定した表記だけ採用する。「併用可能ではない」等を可にしない。
  const forbidden = /併用(?:は|が)?(?:不可|できません|できない|禁止)(?=$|[。、,;；)）]|\r?\n)/m.test(source);
  const allowed = /併用(?:は|が)?(?:可|可能|できます|できる)(?=$|[。、,;；)）]|\r?\n)/m.test(source);
  const evaluation = evaluateCompanyValue(input.description, input.context);
  const holdingStructure = parseBenefitHoldingStructure(input.description);
  const choiceStructure = parseBenefitChoiceStructure(input.description);
  const recordTier = parseBenefitRecordTierStructure(input.description);
  const qualifiedRecordTier = recordTier !== null && evaluation.value === null && evaluation.reason === "ambiguous_condition_tiers";
  const tierLiterals = holdingStructure === null && !qualifiedRecordTier && choiceStructure.status !== "literal_parsed" ? extractBenefitTierLiterals(input.description) : null;
  const initial = compileMusashinoOfficialLiteral(input.description)?.recordDate === "2026-09-30";
  const kawasaki = compileKawasakiOfficialLiteral(input.description);
  if (kawasaki !== null && (input.code !== "3045" || input.official?.url !== KAWASAKI_OFFICIAL_URL ||
      input.context.minShares.length === 0 || input.context.minShares.some(value => value !== kawasaki.minShares) ||
      input.context.recordMonths.length === 0 || input.context.recordMonths.some(value => value !== 2 && value !== 8))) throw new Error("kawasaki_source_context_changed");
  const facts = parsePublicBenefitFacts({
    version: kawasaki !== null ? 7 : initial ? 6 : qualifiedRecordTier ? 4 : holdingStructure !== null ? 3 : tierLiterals !== null ? 5 : 2,
    conditionStructure: kawasaki !== null ? { status: "literal_extracted", rule: "kawasaki-holding-period-transition-v1", sourceSha256: choiceStructure.sourceSha256,
      applicability: "unverified", ast: { beforeHoldingPeriod: "not_stated", fromRecordDate: "2027-02-28", afterHoldingPeriods: ["半年以上", "3年以上"] } } : initial ? { status: "literal_extracted", rule: "initial-event-no-holding-period-v1", sourceSha256: choiceStructure.sourceSha256,
      applicability: "unverified", ast: { recordDate: "2026-09-30", minimumRegistryShares: 200, holdingPeriod: "not_required" } } : qualifiedRecordTier ? recordTier : holdingStructure !== null ? holdingStructure : tierLiterals !== null ? tierLiterals : choiceStructure,
    sourceGroup: benefitKey(input.code, input.description),
    ...conditions,
    ...(initial ? { holding: false, holdingPeriods: [] } : {}),
    combination: allowed === forbidden ? "unverified" : forbidden ? "not_allowed" : "allowed",
    valueStatus: evaluation.value === null ? "unresolved" : "source_amount_qualified",
    qualifiedAmount: evaluation.value,
    valueReasons: evaluation.reason.split(","),
    source: {
      listingUrl: `https://minkabu.jp/stock/${input.code}/yutai`,
      fetchedAt: input.fetchedAt,
      batchFetchedAt: input.batchFetchedAt,
      officialStatus: input.official === undefined ? "not_verified" : "verified",
      officialUrl: input.official === undefined ? null : input.official.url,
      verifiedAt: input.official === undefined ? null : input.official.verifiedAt,
    },
  });
  if (facts === null) throw new Error("公開条件DTOが空です");
  return facts;
}
