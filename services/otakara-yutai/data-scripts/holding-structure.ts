import { createHash } from "node:crypto";
import type { BenefitHoldingStructure } from "../src/public-facts.js";
import { splitHeadedDescription } from "./estimated-value-guard.js";

/** 掲載全文が一致する2施設の優待券だけ。施設・各枚数・利用制限を省略しない。 */
export function compileVenueAdmissionLiteral(description: string): string | null {
  const source = splitHeadedDescription(description);
  if (source.malformed || source.heading?.normalize("NFKC").trim() !== "温浴施設「テルマー湯」優待券") return null;
  const match = /^新宿店 ([1-9][0-9]*)枚\n六本木・西麻布店 ([1-9][0-9]*)枚\n※1枚につき1名が入場できる。\n※土日、祝日および特定日は\n[ \t]*利用できない。$/u.exec(source.body.normalize("NFKC").trim());
  if (match === null) return null;
  const counts = [Number(match[1]), Number(match[2])];
  if (!counts.every(value => Number.isSafeInteger(value) && value > 0)) return null;
  return `テルマー湯優待券:新宿店${counts[0]}枚、六本木・西麻布店${counts[1]}枚(1枚1名、土日祝・特定日利用不可)`;
}

/** 保存全文にある単一期間と掲載額・枚数の対応だけを読む。本人の適用条件は未確認。 */
export function parseBenefitHoldingStructure(description: string): BenefitHoldingStructure | null {
  const source = splitHeadedDescription(description);
  if (source.malformed || source.heading === null) return null;
  const heading = source.heading.normalize("NFKC");
  const body = source.body.normalize("NFKC").trim();
  const sourceSha256 = createHash("sha256").update(description).digest("hex");
  const common = { status: "literal_parsed", rule: "single-holding-period-v1", sourceSha256, applicability: "unverified" } as const;
  if (heading === "オンラインショップ・クーポン(長期保有者向け)") {
    const match = /^【半年以上保有】\n([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)円相当$/u.exec(body);
    if (match === null) return null;
    const listedYen = Number(match[1].replaceAll(",", ""));
    if (!Number.isSafeInteger(listedYen) || listedYen <= 0) return null;
    return { ...common, ast: { holdingPeriod: "半年以上", benefit: { kind: "coupon", listedYen, notation: "相当" } } };
  }
  if (heading === "株主優待券※以下の優待券を贈呈(長期保有者向け)") {
    const match = /^【1年以上保有】\n「リトルワールド」、「日本モンキーパーク」\(遊園地部分のみ\)、「南知多ビーチランド&南知多おもちゃ王国」 共通 入場招待券 ([0-9]+)枚$/u.exec(body);
    if (match === null) return null;
    const quantity = Number(match[1]);
    if (!Number.isSafeInteger(quantity) || quantity <= 0) return null;
    return { ...common, ast: { holdingPeriod: "1年以上", benefit: { kind: "admission_tickets", quantity, unit: "枚" } } };
  }
  return null;
}
