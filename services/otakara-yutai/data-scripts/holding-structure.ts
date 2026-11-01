import { createHash } from "node:crypto";
import type { BenefitHoldingStructure } from "../src/public-facts.js";
import { splitHeadedDescription } from "./estimated-value-guard.js";

/** 保存全文1件の9券種だけ。枚数・各利用人数・季節・割引対象を全て保持する。 */
export function compileSkiTicketBundleLiteral(description: string): string | null {
  // ponytail: 保存全文1型のみ。別形式は全条件を確認した文法を追加するまでHOLD。
  if (createHash("sha256").update(description).digest("hex") !== "46692d4d1b2d2fde1726d52c92b2e2b59a25982940add4f8d398573e0113cabc") return null;
  return "割引券:日本スキー場開発グループ・アライアンスパートナーリゾートの通年ゴンドラ・アクティビティ5枚/冬期リフト7枚、スパイシーレンタル・白馬EXアドベンチャーのレンタル5枚、白馬岩岳マウンテンリゾート特別券2枚、白馬姫川温泉岩岳の湯2枚(以上各1枚5名利用可)、日本駐車場開発運営の時間貸駐車場1日料金30%引5枚、那須ハイランドパーク2枚・那須高原りんどう湖ファミリー牧場2枚(各1枚4名まで)、那須高原TOWAピュアコテージ朝食付きプラン50%引2枚";
}

/** 保存全文2件だけ。期間別額・株数毎加算・倍率と歴史保有条件を現在tierから分離する。 */
export function compileHotelHoldingLiteral(description: string): { shortSummary: string; minShares: number } | null {
  const hash = createHash("sha256").update(description).digest("hex");
  const minShares = hash === "d5ff2d37414fce803d49b749c5aeaaa02c74fb293fc11643963528b148514914" ? 200
    : hash === "7ebe977949d4bebdedab8563275eda0a38476a4c300a2b783609711d1ba83ea8" ? 4000 : null;
  if (minShares === null) return null;
  const body = splitHeadedDescription(description).body;
  const tiers = [...body.matchAll(/^【([1-4]年(?:未満|以上))保有】\n([^\n]+)/gm)];
  if (tiers.length !== 5) return null;
  // 末尾の4桁を「万」へ表記正規化するだけ。加算・倍率から金額を生成しない。
  const yen = (text: string) => text.replaceAll(",", "").replace(/0{4}$/u, "万");
  let benefit: string;
  if (minShares === 200) {
    const base = /^([0-9,]+)円相当分$/u.exec(tiers[0][2]);
    const step = /^以降([0-9]+)株ごとに([0-9,]+)円相当を追加進呈$/mu.exec(body);
    const multiples = tiers.slice(1).map(tier => /^初年度の ([0-9.]+) 倍$/u.exec(tier[2]));
    if (base === null || step === null || multiples.some(value => value === null)) return null;
    benefit = `${tiers[0][1]}${yen(base[1])}円相当、以降${step[1]}株毎${yen(step[2])}円相当追加。初年度比${tiers.slice(1).map((tier, i) => `${tier[1]}${multiples[i]![1]}倍`).join("/")}`;
  } else {
    const amounts = tiers.map(tier => /^([0-9,]+)円相当分$/u.exec(tier[2]));
    if (amounts.some(value => value === null)) return null;
    benefit = `保有${tiers.map((tier, i) => `${tier[1]}${yen(amounts[i]![1])}`).join("/")}円相当`;
  }
  return { minShares, shortSummary: `指定ホテル宿泊割引券:${benefit}。継続条件:毎年8月末まで同一株主番号100株以上継続保有。詳細はがき2026年11月上旬送付` };
}

/** 保存全文1件だけ。通常・特例の保有期間と歴史的名簿条件を現在tierへ転用しない。 */
export function compileBankHoldingHistoryLiteral(description: string): { shortSummary: string; listedYen: number } | null {
  if (createHash("sha256").update(description).digest("hex") !== "4482e903938f82100c0e98e972f9da38c00858e4ff2544b3456de6d5970c67d4") return null;
  const amount = /^【1年以上保有】\n([1-9][0-9]{0,2}(?:,[0-9]{3})+|[1-9][0-9]*)円相当\n/u.exec(splitHeadedDescription(description).body);
  if (amount === null) return null;
  const listedYen = Number(amount[1].replaceAll(",", ""));
  if (!Number.isSafeInteger(listedYen) || listedYen <= 0) return null;
  return { listedYen, shortSummary: `カタログ${listedYen}円相当(継続条件:通常1年以上保有:3月31日基準、9月30日/3月31日同一株主番号1000株以上3回以上連続記録。2027年3月31日基準は半年以上保有)` };
}

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

/** 保有期間別の両数量と、継続保有・記載・繰越・開始時期の既知全文だけを定型化する。 */
export function compileHoldingPointCarryLiteral(description: string): string | null {
  const source = splitHeadedDescription(description);
  if (source.malformed || source.heading?.normalize("NFKC").trim() !== "プレミアム優待倶楽部ポイント") return null;
  const match = /^【1年未満保有】\n([1-9][0-9]{0,2}(?:,[0-9]{3})+|[1-9][0-9]*)ポイント\n【1年以上保有】\n([1-9][0-9]{0,2}(?:,[0-9]{3})+|[1-9][0-9]*)ポイント\n([\s\S]+)$/u.exec(source.body.normalize("NFKC").trim());
  if (match === null || createHash("sha256").update(match[3]).digest("hex") !== "72495c8f4116e4a58389f02b24409d01561fffec516534b3333a1dd43d49781a") return null;
  const below = Number(match[1].replaceAll(",", "")), above = Number(match[2].replaceAll(",", ""));
  if (![below, above].every(value => Number.isSafeInteger(value) && value > 0)) return null;
  return `保有1年未満${below}/1年以上${above}ポイント(WEB商品選択/WILLsCoin交換)、1年以上/繰越条件:毎年12月末同一株主番号600株以上継続保有・記載、繰越次回1回、翌3月上旬開始`;
}

/** 買物利用枠の両期間と歴史的保有定義を、その他の条件全文へ束縛する。 */
export function compileDepartmentHoldingLiteral(description: string): string | null {
  const source = splitHeadedDescription(description);
  if (source.malformed || source.heading?.normalize("NFKC").trim() !== "大丸・松坂屋 買物優待カード 10%割引") return null;
  const match = /^【3年未満保有株主】\n利用限度額 ([1-9][0-9]*)万円\n【3年以上保有株主】\n利用限度額 ([1-9][0-9]*)万円\n([\s\S]+)$/u.exec(source.body.normalize("NFKC").trim());
  if (match === null || createHash("sha256").update(match[3]).digest("hex") !== "2f6025c9442eee30a8a56d84752967c165f5b92dce7d9ac16a82084a7018079b") return null;
  const below = Number(match[1]), above = Number(match[2]);
  if (![below, above].every(value => Number.isSafeInteger(value) && value > 0)) return null;
  return `大丸松坂屋10%引(一部除外/現金・指定カード等)、上限3年未満${below}万/3年以上${above}万円。3年判定:毎年2月末、2・8月末同一株主番号100株以上7回以上連続記載、8月末新規半額、大丸松坂屋等有料文化催事/パルコアートスペース入場無料`;
}

/** 掲載各回額・年額と終了時期を持つ既知全文だけ。歴史的保有定義を現在tierへ転用しない。 */
export function compileAnnualGiftHistoryLiteral(description: string): { shortSummary: string; listedYen: number } | null {
  const source = splitHeadedDescription(description);
  if (source.malformed || source.heading?.normalize("NFKC").trim() !== "デジタルギフト(長期保有者向け)※2027年8末限り") return null;
  const match = /^【1年以上保有】\n([1-9][0-9]{0,2}(?:,[0-9]{3})+|[1-9][0-9]*)円相当\(年間 ([1-9][0-9]{0,2}(?:,[0-9]{3})+|[1-9][0-9]*)円相当\)\n([\s\S]+)$/u.exec(source.body.normalize("NFKC").trim());
  if (match === null || createHash("sha256").update(match[3]).digest("hex") !== "8ce124842d80b5bebefe95e9827396a93fa3cdbab2f314f425393a19354f5fe5") return null;
  const listedYen = Number(match[1].replaceAll(",", "")), annual = Number(match[2].replaceAll(",", ""));
  if (![listedYen, annual].every(value => Number.isSafeInteger(value) && value > 0) || annual !== listedYen * 2) return null;
  return { listedYen, shortSummary: `デジタルギフト${listedYen}円相当(年${annual}円相当)、継続条件:1年以上・2月末/8月末同一株主番号100株以上3回以上連続記載、交換先選択、各基準日から3か月以内贈呈、現制度2027年8月末限り` };
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
