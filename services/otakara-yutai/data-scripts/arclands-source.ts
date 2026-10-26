import { createHash } from "node:crypto";
import { headedDescription } from "./estimated-value-guard.js";
import type { StockYutaiData } from "./yutai-full-import.js";

export const ARCLANDS_SOURCES = [{"url": "https://minkabu.jp/stock/9842/yutai", "suffix": "provider", "contentType": "text/html", "maxBytes": 4194304}, {"url": "https://www.arclands.co.jp/ja/ir/stock/yuutai.html", "suffix": "official", "contentType": "text/html", "maxBytes": 524288}, {"url": "https://www.arclands.co.jp/ja/ir/stock/yuutai/main/0/teaserItems1/01/binaryNodeName/yuutaikijyun.png", "suffix": "tiers", "contentType": "image/png", "maxBytes": 524288}, {"url": "https://www.arclands.co.jp/ja/ir/stock/yuutai/main/01/teaserItems1/0/link/Shareholder%20Benefit%20Coupon%20Store%20List_2026-10.pdf", "suffix": "stores", "contentType": "application/pdf", "maxBytes": 4194304}, {"url": "https://www.arclands.co.jp/ja/ir/news.html", "suffix": "news", "contentType": "text/html", "maxBytes": 524288}, {"url": "https://www.arclands.co.jp/ja/ir/news/auto_20231114589037/pdfFile.pdf", "suffix": "introduction", "contentType": "application/pdf", "maxBytes": 4194304}, {"url": "https://www.arclands.co.jp/ja/ir/news/auto_20260703587339/pdfFile.pdf", "suffix": "integration", "contentType": "application/pdf", "maxBytes": 4194304}] as const;
export const ARCLANDS_OFFICIAL_URL = ARCLANDS_SOURCES[1].url;
export const ARCLANDS_OLD_SOURCE_SHA256 = ["9877946258e0180c0e41b7d8f60845876c878eea46ed35cd4a3a1b286b365f82", "f29a0926f386deb4207a1817d1360d4a74fe8ecd49e78bc143085cab1219998d", "5c1722e91870855720aa2c72c35153497433492b4aebd29be00dd89e4a2c2436"] as const;
export const ARCLANDS_OLD_200_SUMMARY_SHA256 = "2ca29a452e59d463131265a42561a130619e8058a67cb7fbd0b5969de6de1624";
const tiers = [{"minShares": 100, "ticketCount": 2, "listedGrantYen": 1100, "sourceSha256": "3681da0679e56f60a3fbbf414700d2ab842e060a231c29429a7561c3ac0d609b"}, {"minShares": 200, "ticketCount": 4, "listedGrantYen": 2200, "sourceSha256": "ddc9d02ac4ffa263071fbae0197a06535db3dc63e287501866fc5d3234c687fa"}, {"minShares": 1000, "ticketCount": 20, "listedGrantYen": 11000, "sourceSha256": "798b0a7367ceb12a726aa5cf11bd44aceba2b0833eae533a47a38fa25c5c1c24"}] as const;
const notes = "■対象・利用範囲\n2月末及び8月末の当社の株主名簿に記載又は記録された単元株式（100株）以上を保有する株主の皆様に対して、アークランズグループの小売店及び飲食店共通で利用できるご優待券を贈呈。海外店舗及び券売機店等の一部店舗を除く。エバーアクション株式会社の※印店舗はテイクアウトのみ優待券を利用可能。\n■発送時期\n2月末の権利分は同年5月下旬頃、8月末の権利分は同年10月下旬頃を目安に発送。\n■制度導入の経緯・初回\n2023年9月1日を効力発生日としてアークランドサービスホールディングスとの株式交換を実施。最初の贈呈は2024年2月29日現在の株主名簿に記載又は記録された100株以上保有の株主が対象。以降は2月末及び8月末。\n■ジョイフル本田との経営統合・共同株式移転の日程\n2026年7月3日公表の日程変更により、共同持株会社設立の効力発生日は未定。旧予定の2027年3月1日は確定日ではなく、実現可能性を改めて検討する予定。統合実現に向けて引き続き協議。\n■今回の贈呈分だけの有効期限\n2026年8月末日現在の株主を対象とした贈呈分として、2027年5月31日まで利用可能。他年度又は2月末権利分の期限を表すものではない。利用方法等は優待券裏面を参照。店舗は休業・閉店等もあるため公式店舗案内を確認。";
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const compact = (value: string) => value.normalize("NFKC").replace(/\s+/gu, "");
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

/** 本文・実tierだけ。株式交換/旧予定日/今回8月分の期限を年次条件へ転用しない。 */
export function compileArclandsOfficialLiteral(description: string) {
  const tier = tiers.find(value => value.sourceSha256 === digest(description));
  if (tier === undefined) return null;
  return { ...tier, shortSummary: `アークランズ共通優待券550円×${tier.ticketCount}枚(${tier.listedGrantYen.toLocaleString("en-US")}円分)。` + `2/8月末名簿に記載又は記録、${tier.minShares.toLocaleString("en-US")}株以上、小売店/飲食店共通(海外店/券売機店等除外、エバーアクションの印付き店は持帰りのみ)。2月分は同年5月下旬頃、8月分は同年10月下旬頃発送。2023/9/1アークランドSHD株式交換後、初回2024/2/29。ジョイフル本田との共同株式移転統合は2026/7/3公表で効力発生日未定(2027/3/1は旧予定)。2026/8月末権利分だけ期限2027/5/31、利用詳細は券裏面/公式店舗案内` };
}

/** 9842の7応答に由来する全条件だけ。変更時はHOLDし、提供元へ戻さない。 */
export function adoptArclandsOfficialSource(data: StockYutaiData, sources: readonly { url: string; bytes: Uint8Array }[], pdfTexts: readonly string[], verifiedAt: string): StockYutaiData {
  assert(data.code === "9842" && data.benefits.length === 3 && data.sourceFetchedAt !== undefined && Number.isFinite(Date.parse(data.sourceFetchedAt)) && Number.isFinite(Date.parse(verifiedAt)), "arclands_provider_identity_changed");
  for (const [i, benefit] of data.benefits.entries()) {
    assert(benefit.minShares === tiers[i].minShares && typeof benefit.heading === "string" &&
      JSON.stringify([...benefit.localRecordMonths].sort((a, b) => a - b)) === "[2,8]" &&
      digest(headedDescription(benefit.heading, [benefit.description, benefit.notes].filter(value => value.length > 0).join("\n"))) === ARCLANDS_OLD_SOURCE_SHA256[i], "arclands_provider_conditions_changed");
  }
  assert(sources.length === 6 && sources.every((source, i) => source.url === ARCLANDS_SOURCES[i + 1].url && source.bytes.byteLength > 0 && source.bytes.byteLength <= ARCLANDS_SOURCES[i + 1].maxBytes), "arclands_official_source_incomplete");
  const expectedBytes = [null, "dac48004ca4bbbe5bf59f9d96c06a8b081cbc2777eb7d59b349c456e9c6fbc15", "214bd9cc4991bd87c3c4ebff32004b2a0f942bb4fdabef3fbe0543512c96af4b", null, "ea834ede2120895a7bc785a313c80fa4e832373d601c2e439dd538039eaafd07", "903626e70961cab5f5126137166ac2f2199389ecaabe0e30a7fafd8053747b89"];
  assert(sources.every((source, i) => expectedBytes[i] === null || digest(source.bytes) === expectedBytes[i]), "arclands_official_bytes_changed");
  const decode = (i: number) => new TextDecoder("utf-8", { fatal: true }).decode(sources[i].bytes), html = decode(0), news = decode(3);
  const sections = [...html.matchAll(/<h2>株主優待について<\/h2>([\s\S]*?)<\/div><!-- end main -->/gu)];
  assert(sections.length === 1 && digest(compact(sections[0][1])) === "87dd884e5ba136017e88c11639f7949fbdbde190344bdeee5676d33a24c4e5fa", "arclands_official_html_changed");
  const links = [...sections[0][1].matchAll(/(?:src|href)="([^"]+)"/gu)].map(match => new URL(match[1], ARCLANDS_OFFICIAL_URL).href);
  assert(links.filter(url => url === ARCLANDS_SOURCES[2].url).length === 1 && links.filter(url => url === ARCLANDS_SOURCES[3].url).length === 1, "arclands_official_links_changed");
  const related: string[][] = [];
  for (const match of news.matchAll(/<li\b[^>]*entrydate="([^"]+)"[^>]*>([\s\S]*?)<\/li>/gu)) {
    const title = /<span class="news_tx">([\s\S]*?)<\/span>/u.exec(match[2]);
    if (title === null || !/株主優待|共同持株会社|株式移転|経営統合/u.test(title[1])) continue;
    const link = /<a href="([^"]+)"/u.exec(match[2]);
    assert(link !== null, "arclands_related_notice_link_missing");
    related.push([match[1], link[1], compact(title[1])]);
  }
  assert(digest(JSON.stringify(related)) === "cb692ae2c613239b260c5d9500d2857958a8a34fee3909b671d493b5aa9449b7" && [ARCLANDS_SOURCES[5].url, ARCLANDS_SOURCES[6].url].every(url => related.some(row => new URL(row[1], ARCLANDS_OFFICIAL_URL).href === url)), "arclands_related_notices_changed");
  const expectedTexts = ["c0f58aef3646db7faad09842dc9145cb0810b07cca40573e83952abe97aafe45", "8a9d208db28f6a320549ca93fa521096af9498d5eaefbe556d0e426affd715fe", "d04ec245c1c1f8d1955b462dcf54dac9400c9e50f74c6619108c5e176365d625"];
  assert(pdfTexts.length === 3 && pdfTexts.every((text, i) => typeof text === "string" && digest(compact(text)) === expectedTexts[i]), "arclands_official_notes_changed");
  assert(tiers.every(tier => compact(pdfTexts[1]).includes(`${tier.minShares.toLocaleString("en-US")}株以上${tier.listedGrantYen.toLocaleString("en-US")}円分のご優待券550円×${tier.ticketCount}枚`)), "arclands_official_table_changed");
  const benefits = tiers.map(tier => ({ minShares: tier.minShares, localRecordMonths: [2, 8], heading: "食事・優待券",
    description: `${tier.minShares.toLocaleString("en-US")}株以上：ご優待券550円×${tier.ticketCount}枚（合計${tier.listedGrantYen.toLocaleString("en-US")}円分）`, notes }));
  return { ...data, benefits, official: { url: ARCLANDS_OFFICIAL_URL, verifiedAt } };
}
