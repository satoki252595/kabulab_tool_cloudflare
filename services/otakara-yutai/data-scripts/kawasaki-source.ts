import { createHash } from "node:crypto";
import type { StockYutaiData } from "./yutai-full-import.js";

export const KAWASAKI_LISTING_URL = "https://minkabu.jp/stock/3045/yutai";
export const KAWASAKI_OFFICIAL_URL = "https://kawasaki-corp.co.jp/2928/";
export const KAWASAKI_NOTICE_URL = "https://kawasaki-corp.co.jp/wp-content/uploads/2026/10/%E6%A0%AA%E4%B8%BB%E5%84%AA%E5%BE%85%E5%88%B6%E5%BA%A6%E3%81%AE%E6%8B%A1%E5%85%85%E3%81%AB%E9%96%A2%E3%81%99%E3%82%8B%E3%81%8A%E7%9F%A5%E3%82%89%E3%81%9B.pdf";
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const compact = (value: string) => value.normalize("NFKC").replace(/\s+/gu, "");

/** 3045の変更前表と2027年拡充表を丸ごと採用し、注番号と金額のセルを分ける。 */
export function adoptKawasakiOfficialSource(data: StockYutaiData, html: string, pdf: Uint8Array, pdfText: string, verifiedAt: string): StockYutaiData {
  const links = [...html.matchAll(/href=["']([^"']+)["']/gu)].map(match => new URL(match[1].replaceAll("&amp;", "&"), KAWASAKI_OFFICIAL_URL).href);
  const notice = compact(pdfText);
  // ponytail: この拡充資料の全文1型だけ。未知の改訂はHOLDして全条件を再確認する。
  if (data.code !== "3045" || !links.includes(KAWASAKI_NOTICE_URL) ||
      digest(pdf) !== "ebeb45c507737817853746da2f8ef06530d156fe85a3452747b0e547bf4fc27d" ||
      digest(notice) !== "3d7313b413075e4a74ad07c26cd3376ed741fd70caed29b70aa95c92d75f8aba") throw new Error("kawasaki_official_source_changed");
  const clause = (pattern: RegExp) => {
    const match = pattern.exec(notice);
    if (match === null) throw new Error("kawasaki_official_conditions_missing");
    return match[1];
  };
  const before = clause(/【変更前】(.+?)【変更後】/u);
  const after = clause(/【変更後】(.+?)※1「継続保有期間半年以上」とは/u);
  const tiers = (table: string) => [...table.matchAll(/(100|300)株以上(.+?)(?=(?:100|300)株以上|※いずれも年2回贈呈|$)/gu)];
  const oldTiers = tiers(before), newTiers = tiers(after);
  if (oldTiers.length !== 2 || newTiers.length !== 2 ||
      !before.endsWith("※いずれも年2回贈呈") || !after.endsWith("※いずれも年2回贈呈")) throw new Error("kawasaki_official_tiers_missing");
  const notes = ["■変更前の贈呈回数", "※いずれも年2回贈呈", "■変更後の贈呈回数", "※いずれも年2回贈呈",
    "■継続保有期間の定義", clause(/(※1「継続保有期間半年以上」とは.+?)3\.贈呈時期/u),
    "■贈呈時期", clause(/3\.贈呈時期(.+?)4\.株主優待制度拡充の時期/u),
    "■拡充開始と既保有の遡及・初回発送", clause(/4\.株主優待制度拡充の時期(.+?)以上$/u)].join("\n");
  const benefits = oldTiers.map((old, i) => {
    const tier = newTiers[i], cells = /^半年以上※1(.+?)3年以上※2新設(.+)$/u.exec(tier[2]);
    if (old[1] !== (i === 0 ? "100" : "300") || tier[1] !== old[1] || cells === null) throw new Error("kawasaki_official_cells_missing");
    return { minShares: Number(old[1]), localRecordMonths: [2, 8], heading: "カワサキ公式制度（変更前・2027年拡充後）",
      description: `【${old[1]}株以上】\n■変更前\n${old[2]}\n■変更後\n【半年以上（注1）】\n${cells[1]}\n【3年以上（注2）・新設】\n${cells[2]}`, notes };
  });
  return { ...data, benefits, official: { url: KAWASAKI_OFFICIAL_URL, verifiedAt } };
}

/** 変更前と拡充後の全セル・全注記が同じ2全文だけ。保有要件の適用を現在へ前倒ししない。 */
export function compileKawasakiOfficialLiteral(description: string): { minShares: number; shortSummary: string } | null {
  const hash = digest(description);
  const minShares = hash === "35f44c0d3fda10849092331a4435378e07aaeafb849a2fee17c96d5109607b0f" ? 100 :
    hash === "5229034fc6002dacee2b1b2d7df2392755c2d6bbd74bb5a1e0eef112ec1eab48" ? 300 : null;
  if (minShares === null) return null;
  const amounts = minShares === 100
    ? "100株以上:変更前はECクーポン・ホテル優待券各1,500円相当。2027年2月28日基準から拡充し、半年以上は同額、3年以上は各3,000円相当。"
    : "300株以上:変更前はECクーポン5,000円相当とホテル優待券4,500円相当。2027年2月28日基準から拡充し、半年以上は同額、3年以上はEC10,000円相当とホテル9,000円相当。";
  return { minShares, shortSummary: `カワサキ公式:${amounts}年2回、EC「直営オンラインショップ」と「ホテルレイクアルスター アルザ泉大津」の両方。拡充後の保有判定:2月末・8月末名簿の同一株主番号で半年2回以上/3年7回以上連続記載又は記録。既保有は取得時期に遡及。2月末分は5月中間報告書、8月末分は11月招集通知に同封予定。初回2027年5月中旬発送予定` };
}
