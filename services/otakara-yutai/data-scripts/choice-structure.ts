import { createHash } from "node:crypto";
import type { BenefitConditionStructure } from "../src/public-facts.js";
import { splitHeadedDescription } from "./estimated-value-guard.js";
import { sourceSummaryConditions } from "./summary-contract.js";

const label = '「薬クリエイト」買物優待券|買物優待券|カタログギフト|食事券|ジェフグルメカード|株主優待券|フジネットショップポイント|地域特産品';
const heading = new RegExp(`^(?:${label})(?:、)?または、?(?:${label})(?:等)?(?:\\(選択制\\))?$`, "u");
const option = new RegExp(`^([1-8])、[ \\t]*(${label})[ \\t]+([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)円(相当|分)$`, "u");

/** 実保存の全文文法だけを読む。原文SHAを保ち、掲載選択肢の額を評価額へ使わない。 */
export function parseBenefitChoiceStructure(description: string): BenefitConditionStructure {
  const sourceSha256 = createHash("sha256").update(description).digest("hex");
  const unparsed = (reason: "malformed_heading" | "additional_condition" | "unsupported_grammar"): BenefitConditionStructure =>
    ({ status: "unparsed", rule: "one-of-list-v1", sourceSha256, ast: null, reason });
  const source = splitHeadedDescription(description);
  if (source.malformed) return unparsed("malformed_heading");
  const conditions = sourceSummaryConditions(description);
  if (conditions.holding || conditions.lottery || conditions.application || /併用/.test(description)) return unparsed("additional_condition");
  if (source.heading === null || !heading.test(source.heading.normalize("NFKC").trim())) return unparsed("unsupported_grammar");
  const body = source.body.normalize("NFKC").trim();
  const prefix = "◆以下より1点を選択\n";
  if (!body.startsWith(prefix)) return unparsed("unsupported_grammar");
  const lines = body.slice(prefix.length).split("\n");
  if (lines.length < 2 || lines.length > 8) return unparsed("unsupported_grammar");
  const options: { ordinal: number; listedYen: number; notation: "相当" | "分" }[] = [];
  for (const [index, line] of lines.entries()) {
    const match = option.exec(line);
    if (match === null || Number(match[1]) !== index + 1) return unparsed("unsupported_grammar");
    const listedYen = Number(match[3].replaceAll(",", ""));
    if (!Number.isSafeInteger(listedYen) || listedYen <= 0) return unparsed("unsupported_grammar");
    options.push({ ordinal: index + 1, listedYen, notation: match[4] as "相当" | "分" });
  }
  return { status: "literal_parsed", rule: "one-of-list-v1", sourceSha256, ast: { take: 1, options } };
}
