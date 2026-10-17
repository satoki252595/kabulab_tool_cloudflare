import { createHash } from "node:crypto";
import type { BenefitRecordTierStructure } from "../src/public-facts.js";
import { splitHeadedDescription } from "./estimated-value-guard.js";

/** 既存の全文定型と同じ2期間・掲載額・名簿定義・発送予定だけ。本人の適用は未確認。 */
export function parseBenefitRecordTierStructure(description: string): BenefitRecordTierStructure | null {
  const source = splitHeadedDescription(description);
  if (source.malformed || source.heading === null || !/^(?:オリジナル)?QUOカード$/u.test(source.heading.normalize("NFKC").trim())) return null;
  const match = /^【([1-9][0-9]*)年未満保有株主】\n([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)円(相当|分)\n【([1-9][0-9]*)年以上保有株主】\n([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)円\3\n■継続保有期間について\n([1-9][0-9]*)年以上継続保有:株主名簿に([1-9][0-9]*)回以上記載または記録\n\n■贈呈時期\n毎年([1-9][0-9]*)月(上|中|下)旬発送予定$/u.exec(source.body.normalize("NFKC").trim());
  if (match === null) return null;
  const [years, below, aboveYears, above, definitionYears, entries, month] = [match[1], match[2], match[4], match[5], match[6], match[7], match[8]]
    .map(value => Number(value.replaceAll(",", "")));
  if (![years, below, aboveYears, above, definitionYears, entries, month].every(value => Number.isSafeInteger(value) && value > 0) ||
      years !== aboveYears || years !== definitionYears || below === above || month > 12) return null;
  return {
    status: "literal_parsed", rule: "holding-record-tiers-v1", applicability: "unverified",
    sourceSha256: createHash("sha256").update(description).digest("hex"),
    ast: {
      benefitKind: "quo_card",
      tiers: [
        { ordinal: 1, holdingPeriod: `${years}年未満`, listedYen: below, notation: match[3] as "相当" | "分" },
        { ordinal: 2, holdingPeriod: `${years}年以上`, listedYen: above, notation: match[3] as "相当" | "分" },
      ],
      registryDefinition: { continuousHoldingPeriod: `${years}年以上`, minimumEntries: entries, entryMeaning: "listed_or_recorded" },
      shipment: { month, part: `${match[9]}旬` as "上旬" | "中旬" | "下旬", frequency: "annual", status: "planned" },
    },
  };
}
