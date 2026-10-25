import { createHash } from "node:crypto";
import type { StockYutaiData } from "./yutai-full-import.js";

export const MUSASHINO_LISTING_URL = "https://minkabu.jp/stock/8336/yutai";
export const MUSASHINO_OFFICIAL_URL = "https://www.musashinobank.co.jp/ir/stock/benefits.html";
export const MUSASHINO_NOTICE_URL = "https://www.musashinobank.co.jp/info/pdf/info_260316_02.pdf";
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const text = (value: string) => value.replace(/<[^>]*>/gu, "").normalize("NFKC").replace(/\s+/gu, "");

/** 8336の公式全文だけを採用する。提供元の省略条件へ公式の一部だけを混ぜない。 */
export function adoptMusashinoOfficialSource(data: StockYutaiData, html: string, pdf: Uint8Array, pdfText: string, verifiedAt: string, initialEvent = false): StockYutaiData {
  const sections = [...html.matchAll(/<h2\b[^>]*>株主優待制度の概要<\/h2>([\s\S]*?)<h2\b[^>]*>株主優待制度に関するお問合せ先<\/h2>/gu)];
  const notice = text(pdfText);
  // ponytail: 2026年導入資料の全文1型のみ。制度変更時は原本全条件を再確認して更新する。
  if (data.code !== "8336" || sections.length !== 1 ||
      digest(text(sections[0][1])) !== "fc47e6f6fd68e69f74bda36a99205a23faad2dfe3b634039989ded15524e6f9f" ||
      digest(pdf) !== "61ce48d586a3b4a86eca2588f72d4cb2b25ce76244a9c88188c59dd616aa2af6" ||
      digest(notice) !== "5306eb45542fafc8755efb9aab471c65af0598f7af1d996be93c71f7d33805f9") throw new Error("musashino_official_source_changed");
  const section = sections[0][1];
  const fields = (name: string) => [...section.matchAll(new RegExp(`<div class="${name}">([\\s\\S]*?)<\\/div>`, "gu"))].map(match => text(match[1]));
  const shares = fields("benefit-card__stock-value"), gifts = fields("benefit-card__gift-name"), amounts = fields("benefit-card__gift-value");
  const table = /<table\b[^>]*id="table__holding-period"[^>]*>([\s\S]*?)<\/table>/u.exec(section);
  if (table === null || shares.length !== 3 || gifts.length !== 3 || amounts.length !== 3) throw new Error("musashino_official_table_missing");
  const periods = [...table[1].matchAll(/<tr>([\s\S]*?)<\/tr>/gu)].map(row => [...row[1].matchAll(/<td>([\s\S]*?)<\/td>/gu)].map(cell => text(cell[1]))).filter(row => row.length > 0);
  const footnotes = [...section.matchAll(/<p class="indent-2">([\s\S]*?)<\/p>/gu)].map(match => text(match[1]).replace(/^※[12]/u, ""));
  const deposit = [...section.matchAll(/<p class="deposit-benefit__description">([\s\S]*?)<\/p>/gu)].map(match => text(match[1]));
  const annual = /\(1\)基準日[^。]+以降、([^。]+。)/u.exec(notice);
  const delivery = /なお、([^。]+。)/u.exec(notice);
  const split = /([0-9]+年[0-9]+月[0-9]+日)を効力発生日とする株式の分割/u.exec(notice);
  if (periods.length !== 3 || periods.some(row => row.length !== 4) || footnotes.length !== 2 || deposit.length !== 3 ||
      annual === null || delivery === null || split === null) throw new Error("musashino_official_conditions_missing");
  // 初回だけを別の明示INSERT modeへ渡す。通常collectorは従来どおり3月3行のみ。
  const common = ["■基準日", initialEvent ? `初回${periods[0][1]}の単発。` : annual[1], `対象株数は${split[1]}効力の株式分割後。`, "■継続保有期間について",
    ...(initialEvent ? periods.slice(0, 1) : periods.slice(1)).flatMap(row => [`${row[1]}：${row[2]}`, row[3]]), "■株主優待定期預金",
    `預入金額${deposit[0]}、適用金利${deposit[1]}、預入期間${deposit[2]}`, footnotes[1], "■配送", delivery[1]];
  const benefits = shares.map((range, index) => {
    const minimum = /^([0-9,]+)株以上/u.exec(range);
    if (minimum === null) throw new Error("musashino_official_shares_missing");
    const gift = gifts[index].replace(/※1$/u, "");
    return { minShares: Number(minimum[1].replaceAll(",", "")), localRecordMonths: [initialEvent ? 9 : 3], heading: `${gift}・株主優待定期預金（武蔵野銀行公式制度${initialEvent ? "・初回単発" : ""}）`,
      description: `【${range}】\n${gift} ${amounts[index]}`, notes: [...common, ...(index === 0 ? [] : ["■カタログギフト", footnotes[0]])].join("\n") };
  });
  return { ...data, benefits, official: { url: MUSASHINO_OFFICIAL_URL, verifiedAt } };
}

/** 公式採用後の3全文だけ。現在tierと200株の歴史保有条件を分けて定型化する。 */
export function compileMusashinoOfficialLiteral(description: string): { shortSummary: string; minShares: number; listedYen: number; recordMonth: number; recordDate: string | null } | null {
  const hash = digest(description);
  const initialShares = hash === "51526c6d54f3796fc3cc76cc422a5622215cc17aa0857eb460f12cfd408dbc54" ? 200 : hash === "335537d00f3bd5acb80b730c5042af98e16defead0f94e3cbe9c0b6285a98f73" ? 600 : hash === "f705b2ae0ecae5f3f72a784cb4683bd5451922d942f4a1a38e15159b548fae3f" ? 2000 : null;
  const minShares = initialShares !== null ? initialShares : hash === "49a2446d3ba8b1ed79f725ef10af91c809554c3d275eabc4c62e0fe70d307fac" ? 200 : hash === "71e76bc764de416ba635979493dbba0fbf76f19f64e3a6072f4c24bd236a3ac2" ? 600 : hash === "5e91dd8a2163b4ba66bbd4ddff8862fbc0b767139aef6ee93125daf007411d11" ? 2000 : null;
  if (minShares === null) return null;
  const lines = description.split("\n"), range = /^【(.+)】$/u.exec(lines[1]), gift = /^(QUOカード|カタログギフト) ([0-9,]+)円(分|相当)$/u.exec(lines[2]);
  if (range === null || gift === null) return null;
  const listedYen = Number(gift[2].replaceAll(",", ""));
  const benefit = `${range[1]}は${gift[1]}${gift[2]}円${gift[3]}${minShares === 200 ? "" : "(埼玉県産品・寄付等から1点選択)"}`;
  if (initialShares !== null) return { minShares, listedYen, recordMonth: 9, recordDate: "2026-09-30", shortSummary: `武蔵野銀行公式:${benefit}。初回2026年9月30日限り(同日株主名簿に200株以上記載/記録、継続保有期間の定めなし)。定期預金優待券(優待品と同封発送予定・店頭窓口持参・10万円以上100万円以内・1年・基準金利+0.3%)。優待品は国内配送。株数は2026年4月1日分割後` };
  return { minShares, listedYen, recordMonth: 3, recordDate: null, shortSummary: `武蔵野銀行公式:${benefit}。3月31日年1回。継続条件:2027年3月31日は半年以上保有(2026年9月30日と2027年3月31日に同一株主番号200株以上2回連続記載/記録)、2028年3月31日以降は1年以上保有(毎年3月31日/9月30日同一株主番号200株以上3回以上連続記載/記録)。定期預金優待券(店頭持参・10万円以上100万円以内・1年・基準金利+0.3%)。優待品は国内配送。株数は2026年4月1日分割後` };
}
