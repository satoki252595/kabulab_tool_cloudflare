import { createHash } from "node:crypto";
import { splitHeadedDescription } from "./estimated-value-guard.js";

import type { BenefitRegistryDate as RecordDate, BenefitRegistryClause, BenefitRegistryStructure } from "../src/public-facts.js";
export type { BenefitRegistryClause, BenefitRegistryStructure } from "../src/public-facts.js";

const positive = (value: string): number | null => {
  const number = Number(value);
  return /^[1-9][0-9]*$/u.test(value) && Number.isSafeInteger(number) ? number : null;
};
const period = (value: string): boolean => value === "半年以上" ||
  /^(?:[1-9][0-9]*年|[1-9][0-9]*か月)以上$/u.test(value) && positive(value.replace(/(?:年|か月)以上$/u, "")) !== null;
const validDate = ({ month, day }: RecordDate): boolean => month >= 1 && month <= 12 &&
  (day === "month_end" || Number.isInteger(day) && day >= 1 && day <= [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]);

/** 独立した回数定義と全文一致した名簿条件だけ。名義と株主番号を同一視せず、未解析行を残す。 */
export function extractBenefitRegistryStructure(description: string): BenefitRegistryStructure | null {
  const source = splitHeadedDescription(description);
  if (source.malformed || source.heading === null) return null;
  const lines = source.body.normalize("NFKC").split(/\r?\n/u).map(line => line.trim());
  const starts = lines.flatMap((line, index) => line === "■継続保有期間について" ? [index] : []);
  if (starts.length !== 1) return null;
  const start = starts[0] + 1;
  const next = lines.findIndex((line, index) => index >= start && line.startsWith("■"));
  const end = next < 0 ? lines.length : next;
  const section = lines.slice(start, end).map((line, index) => ({ line, index: start + index })).filter(({ line }) => line.length > 0);
  const clauses: BenefitRegistryClause[] = [];
  const consumed = new Set<number>();
  const labels = new Set<string>();
  for (const { line, index } of section) {
    const match = /^((?:[1-9][0-9]*年|半年|[1-9][0-9]*か月)以上)継続保有:連続して([1-9][0-9]*)回以上$/u.exec(line);
    if (match === null) continue;
    const count = positive(match[2]);
    if (!period(match[1]) || count === null || labels.has(match[1])) return null;
    labels.add(match[1]);
    clauses.push({ kind: "holding_definition", holdingPeriod: match[1], minimumConsecutiveRecords: count, recordObject: "unspecified" });
    consumed.add(index);
  }
  // 名簿・名義条件は節全体が1文のときだけ。追加の例外や改定日を切り落とさない。
  if (section.length === 1) {
    const { line, index } = section[0];
    const dates = /^毎年([1-9][0-9]*)月([1-9][0-9]*)日および([1-9][0-9]*)月([1-9][0-9]*)日を基準日とする株主名簿に、同一の株主番号で連続して([1-9][0-9]*)回以上記録された株主といたします。$/u.exec(line);
    const shares = /^([1-9][0-9]*)月末日及び([1-9][0-9]*)月末日の株主名簿に、同一株主番号で([1-9][0-9]*)株以上の保有を連続([1-9][0-9]*)回以上記載された株主さまといたします。$/u.exec(line);
    const name = /^毎年([1-9][0-9]*)月末日の基準日時点において、継続して((?:[1-9][0-9]*年|半年|[1-9][0-9]*か月)以上)、同一名義で保有されている株主さま。$/u.exec(line);
    if (dates !== null) {
      const recordDates = [{ month: Number(dates[1]), day: Number(dates[2]) }, { month: Number(dates[3]), day: Number(dates[4]) }];
      const count = positive(dates[5]);
      if (count === null || !recordDates.every(validDate) || JSON.stringify(recordDates[0]) === JSON.stringify(recordDates[1])) return null;
      clauses.push({ kind: "registry_requirement", identity: "shareholder_number", recordDates, recurrence: "annual", minimumConsecutiveRecords: count, minimumShares: null, entryMeaning: "recorded" });
      consumed.add(index);
    } else if (shares !== null) {
      const recordDates: RecordDate[] = [{ month: Number(shares[1]), day: "month_end" }, { month: Number(shares[2]), day: "month_end" }];
      const minimumShares = positive(shares[3]), count = positive(shares[4]);
      if (minimumShares === null || count === null || !recordDates.every(validDate) || recordDates[0].month === recordDates[1].month) return null;
      clauses.push({ kind: "registry_requirement", identity: "shareholder_number", recordDates, recurrence: "unprovided", minimumConsecutiveRecords: count, minimumShares, entryMeaning: "listed" });
      consumed.add(index);
    } else if (name !== null) {
      const recordDates: RecordDate[] = [{ month: Number(name[1]), day: "month_end" }];
      if (!recordDates.every(validDate) || !period(name[2])) return null;
      clauses.push({ kind: "same_name_holding", identity: "registered_name", recordDates, holdingPeriod: name[2], recurrence: "annual" });
      consumed.add(index);
    }
  }
  if (clauses.length === 0 || clauses.length > 32) return null;
  return { status: "literal_extracted", rule: "holding-registry-clauses-v1", applicability: "unverified",
    sourceSha256: createHash("sha256").update(description).digest("hex"),
    ast: { clauses, remainingSectionLines: section.filter(({ index }) => !consumed.has(index)).length,
      remainingDescriptionLines: lines.filter((line, index) => line.length > 0 && !consumed.has(index)).length } };
}
