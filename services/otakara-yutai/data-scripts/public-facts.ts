import { parseBenefitChoiceStructure } from "./choice-structure.js";
import { benefitKey } from "./benefit-key.js";
import { extractYenAmounts, qualifyCompanyPerGrantValue } from "./estimated-value-guard.js";
import { sourceSummaryConditions } from "./summary-contract.js";
import { parsePublicBenefitFacts, type PublicBenefitFacts as Facts } from "../src/public-facts.js";

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
  const facts = parsePublicBenefitFacts({
    version: 2,
    conditionStructure: parseBenefitChoiceStructure(input.description),
    sourceGroup: benefitKey(input.code, input.description),
    ...conditions,
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
