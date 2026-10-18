import { createHash } from "node:crypto";
import type { BenefitRecordTierStructure, BenefitTierLiterals } from "../src/public-facts.js";
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

/** 直後の独立した額面行だけを結合。注記・名義・名簿・年間額・選択肢は解釈せず残す。 */
export function extractBenefitTierLiterals(description: string): BenefitTierLiterals | null {
  const source = splitHeadedDescription(description);
  if (source.malformed) return null;
  const lines = source.body.normalize("NFKC").trim().split(/\r?\n/u).map(line => line.trim());
  const tiers: BenefitTierLiterals["ast"]["tiers"] = [];
  const combinationClauses: BenefitTierLiterals["ast"]["combinationClauses"] = [];
  const consumed = new Set<number>();
  for (let i = 0; i + 1 < lines.length; i++) {
    const period = /^【((?:[1-9][0-9]*|半)(?:年|か月)(?:以上|未満|以下|超))保有(?:株主)?】$/u.exec(lines[i]);
    const amount = /^([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)円(相当|分)$/u.exec(lines[i + 1]);
    if (period === null || amount === null) continue;
    const listedYen = Number(amount[1].replaceAll(",", ""));
    if (!Number.isSafeInteger(listedYen) || listedYen <= 0) return null;
    tiers.push({ ordinal: tiers.length + 1, holdingPeriod: period[1], listedYen, notation: amount[2] as "相当" | "分" });
    consumed.add(i); consumed.add(i + 1); i++;
  }
  for (const [index, line] of lines.entries()) {
    const clause = /^(?:※(?:[0-9]+[、,]?)?|・)?(?:他の|その他)(割引|割引券|サービス券|優待券|割引サービス)(?:等)?との?併用(?:は|が)?(可|可能|できる|不可|できない)(?:。)?$/u.exec(line);
    if (clause === null) continue;
    combinationClauses.push({ scope: "coupon_use", counterpart: /券/u.test(clause[1]) ? "other_coupon" : "other_discount", allowed: ["可", "可能", "できる"].includes(clause[2]) });
    consumed.add(index);
  }
  if (tiers.length + combinationClauses.length === 0 || tiers.length > 32 || combinationClauses.length > 32) return null;
  return { status: "literal_extracted", rule: "holding-tier-lines-v1", applicability: "unverified",
    sourceSha256: createHash("sha256").update(description).digest("hex"),
    ast: { tiers, combinationClauses, remainingConditionLines: lines.filter((line, index) => line.length > 0 && !consumed.has(index)).length } };
}
