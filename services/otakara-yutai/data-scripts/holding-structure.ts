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

/** 掲載全文が一致する電子ギフトだけ。掲載額・換算・交換先・贈呈期限を保持する。 */
export function compilePointExchangeLiteral(description: string): { shortSummary: string; listedYen: number } | null {
  const source = splitHeadedDescription(description);
  if (source.malformed || source.heading?.normalize("NFKC").trim() !== "電子ギフト") return null;
  const match = /^([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)円相当\n※電子ギフトは1ポイント1円相当の各種電子マネーやポイントと交換することが可能です。\n■贈呈時期\n基準日から3カ月以内$/u.exec(source.body.normalize("NFKC").trim());
  if (match === null) return null;
  const listedYen = Number(match[1].replaceAll(",", ""));
  if (!Number.isSafeInteger(listedYen) || listedYen <= 0) return null;
  return { shortSummary: `電子ギフト ${listedYen.toLocaleString("en-US")}円相当(1ポイント1円相当、電子マネー・ポイント交換、基準日から3か月以内贈呈)`, listedYen };
}

/** 既知の残全文に束縛した各回ポイントと繰越両条件だけ。約換算は金額にしない。 */
export function compilePremiumClubCarryLiteral(description: string): string | null {
  const source = splitHeadedDescription(description);
  if (source.malformed || source.heading?.normalize("NFKC").trim() !== "プレミアム優待倶楽部ポイント") return null;
  const match = /^([1-9][0-9]{0,2}(?:,[0-9]{3})+|[1-9][0-9]*)ポイント\(年間([1-9][0-9]{0,2}(?:,[0-9]{3})+|[1-9][0-9]*)ポイント\)\n([\s\S]+)$/u.exec(source.body.normalize("NFKC").trim());
  if (match === null || createHash("sha256").update(match[3]).digest("hex") !== "6b92867c4e0cbff43b79fefe5faba333a26a353727b739f78a5ea3938686ac8c") return null;
  const count = Number(match[1].replaceAll(",", "")), annual = Number(match[2].replaceAll(",", ""));
  // 掲載された2数量の整合確認だけ。年額や換算額を生成しない。
  if (!Number.isSafeInteger(count) || !Number.isSafeInteger(annual) || annual !== count * 2) return null;
  return `${count}ポイント(商品選択/WILLsCoin交換、繰越:同株主番号2回以上連続記載・1000株以上継続保有)`;
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
