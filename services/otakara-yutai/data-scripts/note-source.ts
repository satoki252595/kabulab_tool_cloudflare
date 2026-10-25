import { createHash } from "node:crypto";
import type { StockYutaiData } from "./yutai-full-import.js";

export const NOTE_LISTING_URL = "https://minkabu.jp/stock/5243/yutai";
export const NOTE_OFFICIAL_URL = "https://ir.note.jp/faq";
export const NOTE_NOTICE_URL = "https://contents.xj-storage.jp/xcontents/AS05592/cfc73e41/f98e/4d15/bf53/387bd77a4ad2/140120250819544024.pdf";
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const compact = (value: string) => value.normalize("NFKC").replace(/\s+/gu, "");

/** 5243の公式導入資料全体だけを採用する。5月は継続名簿日で、優待行にしない。 */
export function adoptNoteOfficialSource(data: StockYutaiData, faq: string, pdf: Uint8Array, pdfText: string, verifiedAt: string): StockYutaiData {
  const sections = [...faq.matchAll(/<dt class="IRfaq_que">株主優待制度はありますか？<\/dt>\s*<dd class="IRfaq_ans">([\s\S]*?)<\/dd>/gu)];
  const notice = compact(pdfText);
  // ponytail: 2025年導入資料の全文1型のみ。変更時は公式全条件を確認して更新する。
  if (data.code !== "5243" || sections.length !== 1 ||
      digest(compact(sections[0][1])) !== "ff3a4a0df59e205d400d031c28b6f27f1d249a7209564bc0e0a3ca5ee7faa5ea" ||
      !sections[0][1].includes(`href="${NOTE_NOTICE_URL}"`) ||
      digest(pdf) !== "8b1f1b1f7a2001a7b18b88e5f05b11be55fda069a8d53b3cc933a230f330bc46" ||
      digest(notice) !== "ac84211fc8d0a56cd36085808eb1259fcafeacc6886def1201a2beeedfba0a89") throw new Error("note_official_source_changed");
  const clause = (pattern: RegExp) => {
    const match = pattern.exec(notice);
    if (match === null) throw new Error("note_official_conditions_missing");
    return match[1];
  };
  const eligibility = clause(/\(1\)対象となる株主(.+?)\(2\)株主優待の内容/u);
  const use = clause(/\(2\)株主優待の内容(.+?)・100株以上200株未満/u);
  const tiers = [...notice.matchAll(/・(100株以上200株未満|200株以上):([0-9,]+)ポイント\(([0-9,]+)円相当\)/gu)];
  const dispatch = clause(/\(3\)贈呈の時期(.+?)\(4\)ご利用方法等/u);
  const methods = clause(/\(4\)ご利用方法等(.+?)3\.株主優待の開始時期/u);
  const start = clause(/3\.株主優待の開始時期(.+?)4\.その他/u);
  if (tiers.length !== 2) throw new Error("note_official_tiers_missing");
  const notes = ["■対象となる株主", eligibility, "■利用用途・サービス内レート", use, "■贈呈時期", dispatch,
    "■利用方法", methods, "■開始時期・初回歴史条件", start].join("\n");
  const benefits = tiers.map(tier => ({ minShares: tier[1].startsWith("100") ? 100 : 200, localRecordMonths: [11],
    heading: "noteポイント（note公式制度・長期保有者向け）", description: `【${tier[1]}】\n${tier[2]}ポイント(${tier[3]}円相当)`, notes }));
  return { ...data, benefits, official: { url: NOTE_OFFICIAL_URL, verifiedAt } };
}

/** 公式採用後の2全文だけ。現在200株と継続名簿100株、初回歴史日付を分ける。 */
export function compileNoteOfficialLiteral(description: string): { minShares: number; shortSummary: string } | null {
  const hash = digest(description);
  const minShares = hash === "93485d24fa4a630083500a269930187b580a20b72a1c46ea42e569edd7bbe261" ? 100 :
    hash === "cd8742e3c42473b5d02959a2c57a81db19a523e627a430b19cf08d86b18ffee1" ? 200 : null;
  if (minShares === null) return null;
  const range = minShares === 100 ? "100株以上200株未満" : "200株以上", points = minShares === 100 ? "3,000" : "6,000";
  return { minShares, shortSummary: `note公式:${range}は${points}ポイント(${points}円相当)、noteの有料記事購入用(1ポイント=1円)。毎年11月30日年1回、1年以上継続保有。継続条件:毎年5月末/11月末の同一株主番号で100株以上3回以上連続記録。2025年11月30日開始、初回は2024年11月30日/2025年5月31日/2025年11月30日に同一番号100株以上継続記載。毎年2月中に招集通知へ同封送付予定、利用詳細は同封案内` };
}
